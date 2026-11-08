import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ContractError } from '@t1/contracts';
import { ExtractionBudget, type ExtractionBudgetLimits, type ExtractionBudgetOptions } from '../../packages/agent/src/extraction-budget.js';

export const SUMMARY_RESUME_SECONDS = 11_520;
export const SUMMARY_RESUME_JOBS = ['L01-B0', 'L05-B0', 'L05-F', 'L05-R'] as const;
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export interface SummaryTimeAuthorization {
  schema_version: 'summary-replay-time-resume-1'; status: 'authorized'; extension_id: string;
  authorization_id: string; user_confirmation_source: string; approved_at: string;
  user_response: { verbatim: string; recorded_at: string; received_from: string };
  paused_at: string; original_deadline_utc: string; resume_at: string; deadline_utc: string;
  resume_seconds: 11520;
  ledger_anchor: { sha256: string; request_count: number; requests_sha256: string;
    experiment_started_at: string; limits: ExtractionBudgetLimits };
  experiment_scope: { replay_id: string; replay_manifest_sha256: string; original_driver_sha256: string;
    resumed_driver_sha256: string; time_module_sha256: string; pause_record_sha256: string; jobs: string[] };
}
export interface SummaryTimeRuntime {
  authorization_id: string; replay_id: string; replay_manifest_sha256: string; original_driver_sha256: string;
  resumed_driver_sha256: string; time_module_sha256: string; pause_record_sha256: string; paused_at: string;
  jobs: string[];
}
const validDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const validHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && Boolean(v.trim());
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A user-approved, absolute deadline is shared by every arm and restart. No clock or usage is reset. */
export function validateSummaryTimeAuthorization(value: unknown, expected: SummaryTimeRuntime, now = Date.now()): SummaryTimeAuthorization {
  const v = value as SummaryTimeAuthorization | undefined;
  if (!v || v.schema_version !== 'summary-replay-time-resume-1' || v.status !== 'authorized' ||
    !nonempty(v.extension_id) || !nonempty(v.user_confirmation_source) || !nonempty(v.user_response?.verbatim) ||
    !nonempty(v.user_response?.received_from) || !validDate(v.user_response?.recorded_at) || !validDate(v.approved_at) ||
    !validDate(v.paused_at) || !validDate(v.original_deadline_utc) || !validDate(v.resume_at) || !validDate(v.deadline_utc) ||
    v.resume_seconds !== SUMMARY_RESUME_SECONDS || v.authorization_id !== expected.authorization_id ||
    v.paused_at !== expected.paused_at || !v.ledger_anchor || !validHash(v.ledger_anchor.sha256) ||
    !validHash(v.ledger_anchor.requests_sha256) || !Number.isSafeInteger(v.ledger_anchor.request_count) ||
    v.ledger_anchor.request_count < 1 || !validDate(v.ledger_anchor.experiment_started_at)) {
    throw new ContractError('summary_resume_explicit_time_authorization_required');
  }
  const scope = v.experiment_scope;
  for (const key of ['replay_manifest_sha256', 'original_driver_sha256', 'resumed_driver_sha256', 'time_module_sha256', 'pause_record_sha256'] as const) {
    if (!scope || !validHash(scope[key]) || scope[key] !== expected[key]) throw new ContractError('summary_resume_runtime_revision_mismatch');
  }
  if (scope.replay_id !== expected.replay_id || !equal(scope.jobs, [...SUMMARY_RESUME_JOBS]) ||
    !expected.jobs.length || new Set(expected.jobs).size !== expected.jobs.length ||
    expected.jobs.some(job => !scope.jobs.includes(job))) throw new ContractError('summary_resume_jobs_outside_authorized_scope');
  const start = Date.parse(v.ledger_anchor.experiment_started_at), paused = Date.parse(v.paused_at);
  const originalDeadline = Date.parse(v.original_deadline_utc), resumed = Date.parse(v.resume_at), deadline = Date.parse(v.deadline_utc);
  if (!v.ledger_anchor.limits || originalDeadline !== start + v.ledger_anchor.limits.seconds * 1000 ||
    paused < start || originalDeadline - paused < SUMMARY_RESUME_SECONDS * 1000 ||
    Date.parse(v.approved_at) < paused || Date.parse(v.user_response.recorded_at) > Date.parse(v.approved_at) ||
    Date.parse(v.approved_at) > resumed || resumed > now || resumed <= originalDeadline ||
    deadline !== resumed + SUMMARY_RESUME_SECONDS * 1000 || now >= deadline) {
    throw new ContractError('summary_resume_absolute_deadline_invalid_or_expired');
  }
  return structuredClone(v);
}

interface ResumeAudit { authorization_sha256: string; recorded_in_ledger_at: string; record: SummaryTimeAuthorization }
type BudgetLedger = ExtractionBudget['ledger'] & { summary_resume_time_authorization?: ResumeAudit };

/** Only this experimental driver uses the extension. The 49 frozen runtime sources remain unchanged. */
export class SummaryTimeBudget extends ExtractionBudget {
  private readonly timeAuthorization: SummaryTimeAuthorization;
  constructor(path: string, endpoint: string, options: ExtractionBudgetOptions & {
    timeAuthorizationBytes: string; runtime: SummaryTimeRuntime;
  }, now: () => number = Date.now) {
    const record = validateSummaryTimeAuthorization(JSON.parse(options.timeAuthorizationBytes), options.runtime, now());
    const originalBytes = readFileSync(path, 'utf8'), original = JSON.parse(originalBytes) as BudgetLedger;
    const anchor = record.ledger_anchor, authorizationHash = sha256(options.timeAuthorizationBytes);
    if (original.schema_version !== 's4-call-ledger-1' || original.experiment_started_at !== anchor.experiment_started_at ||
      !equal(original.limits, anchor.limits) || !equal(original.limits, options.limits) ||
      !equal(original.authorization, options.authorization) || original.authorization?.id !== record.authorization_id ||
      !Array.isArray(original.requests) || original.requests.length < anchor.request_count ||
      original.requests.some(r => !r.finished_at || r.usage_status === 'reserved') ||
      sha256(JSON.stringify(original.requests.slice(0, anchor.request_count))) !== anchor.requests_sha256 || original.halted) {
      throw new ContractError('summary_resume_ledger_anchor_or_settlement_mismatch');
    }
    const prior = original.summary_resume_time_authorization;
    if (prior ? prior.authorization_sha256 !== authorizationHash || !equal(prior.record, record) :
      original.requests.length !== anchor.request_count || sha256(originalBytes) !== anchor.sha256) {
      throw new ContractError('summary_resume_authorization_already_bound_or_ledger_changed');
    }
    super(path, endpoint, now, options);
    this.timeAuthorization = record;
    if (!prior) {
      (this.ledger as BudgetLedger).summary_resume_time_authorization = { authorization_sha256: authorizationHash,
        recorded_in_ledger_at: new Date(now()).toISOString(), record };
      this.persist();
    }
  }
  override get wallClockSeconds(): number {
    return (Date.parse(this.timeAuthorization.deadline_utc) - Date.parse(this.timeAuthorization.ledger_anchor.experiment_started_at)) / 1000;
  }
  override begin(...args: Parameters<ExtractionBudget['begin']>) {
    const purpose = args[1], scope = this.timeAuthorization.experiment_scope;
    if (!scope.jobs.some(job => ['before', 'after'].some(arm => purpose === scope.replay_id + ':' + job + ':' + arm))) {
      throw new ContractError('summary_resume_request_purpose_outside_scope');
    }
    return super.begin(...args);
  }
  timeWindowEvidence() {
    return { extension_id: this.timeAuthorization.extension_id, original_experiment_started_at: this.ledger.experiment_started_at,
      resume_at: this.timeAuthorization.resume_at, deadline_utc: this.timeAuthorization.deadline_utc,
      resume_seconds: this.timeAuthorization.resume_seconds, original_limits_unchanged: true,
      authorization_sha256: (this.ledger as BudgetLedger).summary_resume_time_authorization!.authorization_sha256 };
  }
}
