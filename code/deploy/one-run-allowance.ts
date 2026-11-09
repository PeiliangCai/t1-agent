import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { ContractError, type RunInput, type Scope } from '@t1/contracts';
import { ExtractionBudget, S4_LIMITS, type ModelConfig, type ExtractionBudgetLimits } from '@t1/agent';
import { workbenchModelPolicy } from '../apps/server/src/model-policy.js';

export interface ContainerRunPlan {
  schema_version: 's7-one-container-run-1'; plan_id: string;
  authorization: { authorized_runs: 1; scope: 'S7_single_container_deployment_reverification'; observed_at: string };
  input: { document_id: string; sha256: string };
  model: { provider: 'agicto'; endpoint: 'https://api.agicto.cn/v1'; model_id: 'gpt-6-luna'; reasoning_effort: 'medium' };
  limits: ExtractionBudgetLimits; scope: Scope; code_sha256: Record<string, string>; hard_stop_utc: string; latest_admission_utc?: string;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function assertContainerPlan(value: ContainerRunPlan) {
  if (value.schema_version !== 's7-one-container-run-1' || !value.plan_id || value.authorization?.authorized_runs !== 1 ||
    value.authorization.scope !== 'S7_single_container_deployment_reverification' || !value.authorization.observed_at ||
    !/^[a-f0-9]{64}$/.test(value.input?.sha256) || !Number.isFinite(Date.parse(value.hard_stop_utc)) || value.model?.provider !== 'agicto' || value.model.endpoint !== 'https://api.agicto.cn/v1' || value.model.model_id !== 'gpt-6-luna' || value.model.reasoning_effort !== 'medium') throw new ContractError('invalid_container_verification_plan');
  for (const key of ['requests', 'input_tokens', 'output_tokens', 'seconds', 'document_seconds', 'batch_responses'] as const) {
    const limit = value.limits?.[key];
    const maximum = key === 'seconds' || key === 'document_seconds' ? 1800 : key === 'batch_responses' ? 16 : S4_LIMITS[key];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new ContractError('invalid_container_verification_limit');
  }
  if (value.latest_admission_utc && (!Number.isFinite(Date.parse(value.latest_admission_utc)) || Date.parse(value.latest_admission_utc) > Date.parse(value.hard_stop_utc))) throw new ContractError('invalid_container_latest_admission');
  for (const key of ['request_seconds', 'transient_retries', 'response_output_tokens'] as const) {
    const limit = value.limits[key];
    if (!Number.isSafeInteger(limit) || limit < (key === 'transient_retries' ? 0 : 1) || limit > S4_LIMITS[key]) throw new ContractError('invalid_container_verification_limit');
  }
  if (value.scope.cancers.mode !== 'all' || value.scope.cancers.ids.length || value.scope.image_types.mode !== 'all' || value.scope.image_types.ids.length || value.scope.features.mode !== 'all' || value.scope.features.binding_ids.length || !Object.keys(value.code_sha256).length) throw new ContractError('invalid_container_verification_scope_or_pins');
}

/** Operator-only one-run admission, using the same production budget and B0 executor.
 * It is not imported by main.ts and is never a product-user approval requirement. */
export class ContainerOneRunAllowance {
  readonly controller = new AbortController(); budget?: ExtractionBudget; admittedRunId?: string;
  private timer?: ReturnType<typeof setTimeout>; private runtimePins: Record<string, string> = {};
  readonly statePath: string;
  constructor(readonly plan: ContainerRunPlan, readonly planSha: string, readonly config: ModelConfig,
    readonly codeRoot: string, readonly dataDirectory: string, readonly now = Date.now) {
    assertContainerPlan(plan);
    if (config.provider !== plan.model.provider || config.baseUrl !== plan.model.endpoint || config.modelId !== plan.model.model_id) throw new ContractError('container_config_differs_from_plan');
    this.statePath = resolve(dataDirectory, 'allowance.json'); this.assertPins(plan.code_sha256);
  }
  private assertPins(pins: Record<string, string>) {
    for (const [path, digest] of Object.entries(pins)) {
      const absolute = resolve(this.codeRoot, path), rel = relative(this.codeRoot, absolute);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/^[a-f0-9]{64}$/.test(digest) || hash(readFileSync(absolute)) !== digest) throw new ContractError('container_verification_pin_changed');
    }
  }
  available = () => !existsSync(this.statePath) && !this.controller.signal.aborted && this.now() + 1000 <= Date.parse(this.plan.hard_stop_utc) &&
    (!this.plan.latest_admission_utc || this.now() <= Date.parse(this.plan.latest_admission_utc));
  prepare = (input: RunInput, directory: string) => {
    if (!this.available()) throw new ContractError('single_container_allowance_closed');
    this.assertPins(this.plan.code_sha256);
    if (input.file_sha256 !== this.plan.input.sha256 || JSON.stringify(input.scope) !== JSON.stringify(this.plan.scope)) throw new ContractError('container_input_or_scope_not_authorized');
    const rel = relative(this.dataDirectory, directory);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('container_run_outside_isolated_data');
    const started = new Date(this.now()).toISOString(), seconds = Math.min(this.plan.limits.seconds, Math.floor((Date.parse(this.plan.hard_stop_utc) - this.now()) / 1000));
    const effectiveLimits = { ...this.plan.limits, seconds, document_seconds: Math.min(this.plan.limits.document_seconds, seconds) };
    writeFileSync(this.statePath, JSON.stringify({ plan_id: this.plan.plan_id, plan_sha256: this.planSha, run_id: input.run_id,
      started_at: started, deadline: new Date(this.now() + seconds * 1000).toISOString(), hard_stop_utc: this.plan.hard_stop_utc, limits: this.plan.limits, effective_limits: effectiveLimits, closed: false, unused_allowance_closed: false }) + '\n', { flag: 'wx', mode: 0o600 });
    this.admittedRunId = input.run_id;
    const allowance = this;
    class PinnedBudget extends ExtractionBudget {
      override begin(...args: Parameters<ExtractionBudget['begin']>) { allowance.assertPins(allowance.plan.code_sha256); allowance.assertPins(allowance.runtimePins); return super.begin(...args); }
    }
    this.budget = new PinnedBudget(resolve(directory, 'request-ledger.json'), this.config.baseUrl, this.now, {
      limits: effectiveLimits, responseModelAliasPolicy: workbenchModelPolicy(this.config).responseModelAliasPolicy,
      authorization: { id: this.planSha, source: 'S7_new_one_container_verification_allowance', recorded_at: started } });
    this.budget.ledger.experiment_started_at = started; this.budget.persist();
    this.timer = setTimeout(() => this.close('container_verification_deadline'), seconds * 1000); this.timer.unref();
  };
  signal(signal: AbortSignal) { return AbortSignal.any([signal, this.controller.signal]); }
  remainingMs() { if (!this.budget) throw new ContractError('container_verification_not_admitted'); this.budget.check(); return Math.max(1, Math.floor((this.budget.wallClockSeconds - this.budget.totals().elapsed_seconds) * 1000)); }
  bindSource(pdf: string, ir: string) {
    if (hash(readFileSync(pdf)) !== this.plan.input.sha256) throw new ContractError('container_uploaded_pdf_changed');
    this.runtimePins[relative(this.codeRoot, pdf)] = this.plan.input.sha256; this.runtimePins[relative(this.codeRoot, ir)] = hash(readFileSync(ir)); this.assertPins(this.runtimePins);
  }
  close(reason: string) {
    clearTimeout(this.timer); this.controller.abort();
    if (this.budget) { this.budget.cancelEntries(this.budget.ledger.requests, reason); this.budget.ledger.halted ??= reason; this.budget.persist(); }
    if (existsSync(this.statePath)) {
      const old = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (!old.closed) writeFileSync(this.statePath, JSON.stringify({ ...old, closed: true, closed_at: new Date(this.now()).toISOString(), reason, unused_allowance_closed: true }) + '\n');
    }
  }
}
