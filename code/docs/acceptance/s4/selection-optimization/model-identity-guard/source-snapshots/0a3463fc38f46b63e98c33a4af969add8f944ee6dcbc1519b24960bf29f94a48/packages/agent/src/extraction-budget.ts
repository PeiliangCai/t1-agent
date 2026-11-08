import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ContractError } from '@t1/contracts';
import type { Usage } from '@earendil-works/pi-ai';

export const S4_LIMITS = { requests: 400, input_tokens: 2_000_000, output_tokens: 400_000, seconds: 7200,
  request_seconds: 120, document_seconds: 900, transient_retries: 2, response_output_tokens: 8192, batch_responses: 8 } as const;
export interface ExtractionBudgetLimits {
  requests: number; input_tokens: number; output_tokens: number; seconds: number;
  request_seconds: number; document_seconds: number; transient_retries: number; response_output_tokens: number; batch_responses: number;
}
export interface ExtractionBudgetAuthorization { id: string; source: string; recorded_at: string }
export interface ExtractionBudgetOptions { limits?: ExtractionBudgetLimits; authorization?: ExtractionBudgetAuthorization }
const limitKeys = Object.keys(S4_LIMITS) as Array<keyof ExtractionBudgetLimits>;
function validLimits(value: unknown): value is ExtractionBudgetLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== limitKeys.length) return false;
  const limits = value as Record<keyof ExtractionBudgetLimits, unknown>;
  return limitKeys.every(key => typeof limits[key] === 'number' && Number.isSafeInteger(limits[key]) &&
    (limits[key] as number) >= (key === 'transient_retries' ? 0 : 1));
}
function sameLimits(value: unknown, expected: ExtractionBudgetLimits): boolean {
  return validLimits(value) && limitKeys.every(key => value[key] === expected[key]);
}
function validAuthorization(value: unknown): value is ExtractionBudgetAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) return false;
  const authorization = value as Record<string, unknown>;
  return typeof authorization.id === 'string' && authorization.id.trim().length > 0 &&
    typeof authorization.source === 'string' && authorization.source.trim().length > 0 &&
    typeof authorization.recorded_at === 'string' && Number.isFinite(Date.parse(authorization.recorded_at));
}
function sameAuthorization(value: unknown, expected: ExtractionBudgetAuthorization): boolean {
  return validAuthorization(value) && value.id === expected.id && value.source === expected.source && value.recorded_at === expected.recorded_at;
}
export type ResponseModelIdentityStatus = 'unknown' | 'matched' | 'mismatch';
export interface ResponseModelObservation {
  source: 'provider_stream_event.response.model'; event_type: string; observed_at: string;
  expected_model: string; actual_model?: string; status: ResponseModelIdentityStatus;
}
export interface RequestAccounting {
  id: string; model_id: string; purpose: string; attempt: number; started_at: string; finished_at?: string;
  payload_sha256: string; payload_bytes: number; input_ceiling: number; output_ceiling: number;
  status?: number; request_id?: string; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number;
  cache_write_tokens?: number; reasoning_tokens?: number; provider_usage?: Record<string, unknown>;
  usage_status: 'reserved' | 'provider_reported' | 'missing_usage_conservative_reservation';
  reservation_policy?: 'trusted_profile_context_quota_not_provider_hard_limit';
  local_payload_estimate?: number; provider_input_exceeds_local_estimate?: boolean; input_reservation_exceeded?: boolean;
  provider_response_model?: string; provider_response_id?: string;
  response_model_identity_status?: ResponseModelIdentityStatus;
  response_model_observations?: ResponseModelObservation[];
  response_model_identity_evidence_scope?: 'provider_reported_name_only_not_weight_identity_or_HTTP_body_replay';
  configured_deadline_ms?: number;
  stream_event_count?: number; first_stream_event_at?: string; last_stream_event_at?: string;
  tool_argument_delta_characters?: number; reasoning_visible_delta_characters?: number; text_delta_characters?: number;
  response_stream_sha256?: string; response_hash_scope?: 'complete_decoded_HTTP_body' | 'received_decoded_body_prefix';
  requested_max_output_tokens?: number; requested_reasoning_effort?: string;
  application_context_estimate?: number; model_context_window_metadata?: number;
  actual_cost: null; cost_status: 'unknown_gateway_billing'; error_code?: string;
}
export interface WallClockAdjustment { from_seconds: 7200; to_seconds: 14400; authorized_by: 'main_session_astra';
  recorded_at: string; evidence_sha256: string }
interface Ledger { schema_version: 's4-call-ledger-1'; experiment_started_at: string | null; requests: RequestAccounting[];
  wall_clock_adjustments?: WallClockAdjustment[];
  limits: ExtractionBudgetLimits; authorization?: ExtractionBudgetAuthorization;
  halted: string | null; actual_cost: null; cost_status: 'unknown_gateway_billing'; }

/** One process owns a matrix ledger; every physical request is counted before network I/O. */
export class ExtractionBudget {
  readonly ledger: Ledger;
  readonly limits: Readonly<ExtractionBudgetLimits>;
  private readonly active = new Map<string, (code: string) => void>();
  constructor(readonly path: string, readonly endpoint: string, readonly now: () => number = Date.now,
    options: ExtractionBudgetOptions = {}) {
    const limits = options.limits ?? S4_LIMITS;
    if (!validLimits(limits)) throw new ContractError('invalid_experiment_limits');
    this.limits = Object.freeze({ ...limits });
    const usesDefaultLimits = sameLimits(this.limits, S4_LIMITS);
    if (!usesDefaultLimits && options.authorization === undefined) throw new ContractError('experiment_authorization_required');
    if (options.authorization !== undefined && !validAuthorization(options.authorization)) throw new ContractError('invalid_experiment_authorization');
    this.ledger = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Ledger : {
      schema_version: 's4-call-ledger-1', experiment_started_at: null, requests: [], limits: this.limits,
      ...(!usesDefaultLimits ? { authorization: { ...options.authorization! } } : {}),
      halted: null, actual_cost: null, cost_status: 'unknown_gateway_billing' };
    if (!sameLimits(this.ledger.limits, this.limits)) throw new ContractError('experiment_limits_changed');
    if (!usesDefaultLimits && !sameAuthorization(this.ledger.authorization, options.authorization!)) throw new ContractError('experiment_authorization_changed');
    const adjustments = this.ledger.wall_clock_adjustments ?? [];
    if ((!usesDefaultLimits && adjustments.length) || adjustments.length > 1 || adjustments.some(a => !this.validWallClockAdjustment(a))) throw new ContractError('invalid_wall_clock_adjustment');
    this.persist();
  }
  private validWallClockAdjustment(a: WallClockAdjustment) {
    return a.from_seconds === 7200 && a.to_seconds === 14400 && a.authorized_by === 'main_session_astra' &&
      Number.isFinite(Date.parse(a.recorded_at)) && /^[a-f0-9]{64}$/.test(a.evidence_sha256);
  }
  get wallClockSeconds(): number { return this.ledger.wall_clock_adjustments?.at(-1)?.to_seconds ?? this.limits.seconds; }
  extendExperimentWallClock(adjustment: WallClockAdjustment) {
    if (!sameLimits(this.limits, S4_LIMITS) || !this.validWallClockAdjustment(adjustment)) throw new ContractError('invalid_wall_clock_adjustment');
    const old = this.ledger.wall_clock_adjustments?.[0];
    if (old) {
      if (JSON.stringify(old) !== JSON.stringify(adjustment)) throw new ContractError('wall_clock_adjustment_already_recorded');
      return;
    }
    if (this.ledger.halted) throw new ContractError('cannot_extend_halted_experiment');
    this.ledger.wall_clock_adjustments = [{ ...adjustment }]; this.persist();
  }
  persist() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path + '.tmp', JSON.stringify(this.ledger, null, 2) + '\n', { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }
  totals() {
    return { requests: this.ledger.requests.length,
      input_tokens: this.ledger.requests.reduce((n, r) => n + (r.input_tokens ?? r.input_ceiling), 0),
      output_tokens: this.ledger.requests.reduce((n, r) => n + (r.output_tokens ?? r.output_ceiling), 0),
      conservative_missing_usage_requests: this.ledger.requests.filter(r => r.usage_status !== 'provider_reported').length,
      elapsed_seconds: this.ledger.experiment_started_at ? (this.now() - Date.parse(this.ledger.experiment_started_at)) / 1000 : 0 };
  }
  check(extraInput = 0, extraOutput = 0) {
    const t = this.totals();
    const reason = this.ledger.halted ?? (t.elapsed_seconds >= this.wallClockSeconds ? 'experiment_time_limit' :
      t.requests >= this.limits.requests ? 'experiment_request_limit' :
      t.input_tokens + extraInput > this.limits.input_tokens ? 'experiment_input_token_limit' :
      t.output_tokens + extraOutput > this.limits.output_tokens ? 'experiment_output_token_limit' : null);
    if (reason) { this.ledger.halted = reason; this.persist(); throw new ContractError(reason); }
  }
  begin(modelId: string, purpose: string, attempt: number, payload: string, maxOutput: number) {
    // Gateways may report input beyond the local payload (observed for Astra's synthetic probe).
    // Reserve at least the trusted profile's 32K context quota. This is NOT a provider-enforced ceiling.
    const bytes = Buffer.byteLength(payload), inputCeiling = Math.max(bytes + 512, 32768);
    this.check(inputCeiling, maxOutput);
    this.ledger.experiment_started_at ??= new Date(this.now()).toISOString();
    const entry: RequestAccounting = { id: randomUUID(), model_id: modelId, purpose, attempt,
      started_at: new Date(this.now()).toISOString(), payload_sha256: createHash('sha256').update(payload).digest('hex'),
      payload_bytes: bytes, input_ceiling: inputCeiling, output_ceiling: maxOutput, usage_status: 'reserved',
      local_payload_estimate: bytes + 512, reservation_policy: 'trusted_profile_context_quota_not_provider_hard_limit',
      response_model_identity_status: 'unknown',
      response_model_identity_evidence_scope: 'provider_reported_name_only_not_weight_identity_or_HTTP_body_replay',
      actual_cost: null, cost_status: 'unknown_gateway_billing' };
    this.ledger.requests.push(entry); this.persist(); return entry;
  }
  /** Compare literal provider event metadata; this neither authenticates model weights nor stores the HTTP body. */
  observeResponseModel(entry: RequestAccounting, actualModel: unknown, eventType: string) {
    const status: ResponseModelIdentityStatus = typeof actualModel !== 'string' ? 'unknown' :
      actualModel === entry.model_id ? 'matched' : 'mismatch';
    const observation: ResponseModelObservation = { source: 'provider_stream_event.response.model', event_type: eventType,
      observed_at: new Date(this.now()).toISOString(), expected_model: entry.model_id, status,
      ...(typeof actualModel === 'string' ? { actual_model: actualModel } : {}) };
    (entry.response_model_observations ??= []).push(observation);
    // Retain the first explicit value as well as every later event, including contradictory names.
    if (typeof actualModel === 'string') entry.provider_response_model ??= actualModel;
    if (entry.response_model_identity_status !== 'mismatch' && status !== 'unknown') entry.response_model_identity_status = status;
    if (status === 'mismatch') this.ledger.halted = 'response_model_identity_mismatch';
    this.persist(); // Do not throw/abort here: the in-flight stream must still deliver its usage.
  }
  settle(entry: RequestAccounting, usage?: Usage) {
    if (usage && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) {
      entry.input_tokens = usage.input + usage.cacheRead + usage.cacheWrite;
      entry.output_tokens = usage.output; // Pi's output already includes reasoning; do not double count it.
      entry.cache_read_tokens = usage.cacheRead; entry.cache_write_tokens = usage.cacheWrite;
      if (usage.reasoning !== undefined) entry.reasoning_tokens = usage.reasoning;
      entry.usage_status = 'provider_reported';
      entry.provider_input_exceeds_local_estimate = entry.input_tokens > (entry.local_payload_estimate ?? entry.payload_bytes + 512);
      entry.input_reservation_exceeded = entry.input_tokens > entry.input_ceiling;
    } else entry.usage_status = 'missing_usage_conservative_reservation';
    entry.finished_at = new Date(this.now()).toISOString(); this.persist();
    this.check();
  }
  cancelEntries(entries: readonly RequestAccounting[], code: string) {
    for (const entry of entries) if (!entry.finished_at) this.active.get(entry.id)?.(code);
  }
  guardedFetch(modelId: string, purpose: string, attempt: number, entries: RequestAccounting[], maxRequests = this.limits.batch_responses,
    maxOutput: number = this.limits.response_output_tokens, requestTimeoutMs = this.limits.request_seconds * 1000,
    contextMetadata?: { application_context_estimate: number; model_context_window_metadata: number }): typeof fetch {
    if (requestTimeoutMs < 1 || requestTimeoutMs > this.limits.request_seconds * 1000) throw new ContractError('request_deadline_exceeds_authorized_limit');
    const expected = new URL(this.endpoint.replace(/\/+$/, '') + '/');
    const original = globalThis.fetch;
    return async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (request.signal.aborted) throw new ContractError('run_cancelled');
      if (url.origin !== expected.origin || ![expected.pathname + 'responses', expected.pathname + 'chat/completions'].includes(url.pathname) ||
        request.method !== 'POST' || url.search || url.hash) throw new ContractError('model_network_destination_denied');
      if (entries.length >= maxRequests) throw new ContractError('batch_response_limit');
      const payload = await request.clone().text();
      const body = JSON.parse(payload) as Record<string, unknown>;
      if (body.model !== modelId || body.store === true || body.stream !== true) throw new ContractError('model_payload_policy_violation');
      const entry = this.begin(modelId, purpose, attempt, payload, maxOutput); entries.push(entry);
      const requestedOutput = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
      if (typeof requestedOutput === 'number') entry.requested_max_output_tokens = requestedOutput;
      const reasoning = body.reasoning as { effort?: unknown } | undefined;
      if (typeof reasoning?.effort === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning.effort)) entry.requested_reasoning_effort = reasoning.effort;
      if (contextMetadata) Object.assign(entry, contextMetadata);
      const globalRemaining = Math.max(1, (this.wallClockSeconds - this.totals().elapsed_seconds) * 1000);
      const effectiveTimeout = Math.min(requestTimeoutMs, globalRemaining);
      entry.configured_deadline_ms = effectiveTimeout;
      const transportController = new AbortController();
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let expired = false;
      const responseHash = createHash('sha256'); let hashFinalized = false;
      const finishHash = (complete: boolean) => {
        if (!hashFinalized) { entry.response_stream_sha256 = responseHash.digest('hex');
          entry.response_hash_scope = complete ? 'complete_decoded_HTTP_body' : 'received_decoded_body_prefix'; hashFinalized = true; }
      };
      let rejectDeadline: (reason: unknown) => void = () => {};
      const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
      const stop = (code: string) => {
        expired = true; entry.error_code = code;
        if (code === 'experiment_time_limit') this.ledger.halted = code;
        finishHash(false);
        this.persist(); clearTimeout(timer); this.active.delete(entry.id);
        const error = new ContractError(code); transportController.abort(error);
        streamController?.error(error); void reader?.cancel(error).catch(() => {}); rejectDeadline(error);
      };
      const timer = setTimeout(() => stop(effectiveTimeout === globalRemaining ? 'experiment_time_limit' : 'request_time_limit'), effectiveTimeout);
      this.active.set(entry.id, stop);
      try {
        const response = await Promise.race([original(new Request(request, { redirect: 'error',
          signal: AbortSignal.any([request.signal, transportController.signal]) })), deadline]);
        entry.status = response.status;
        const id = response.headers.get('x-request-id');
        if (id && /^[a-zA-Z0-9_.-]{1,120}$/.test(id)) entry.request_id = id;
        this.persist();
        if (!response.body) { clearTimeout(timer); this.active.delete(entry.id); return response; }
        reader = response.body.getReader();
        const active = this.active;
        const body = new ReadableStream<Uint8Array>({
          start(controller) { streamController = controller; },
          async pull(controller) {
            try {
              const chunk = await Promise.race([reader!.read(), deadline]);
              if (expired) return;
              if (chunk.done) { finishHash(true); clearTimeout(timer); active.delete(entry.id); controller.close(); }
              else { responseHash.update(chunk.value); controller.enqueue(chunk.value); }
            } catch (error) { finishHash(false); clearTimeout(timer); active.delete(entry.id); if (!expired) controller.error(error); }
          },
          async cancel(reason) { finishHash(false); clearTimeout(timer); active.delete(entry.id); transportController.abort(reason); await reader!.cancel(reason).catch(() => {}); },
        });
        const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
        return new Response(body, { status: response.status, statusText: response.statusText, headers });
      } catch (error) { finishHash(false); clearTimeout(timer); this.active.delete(entry.id); entry.error_code = error instanceof ContractError ? error.code : 'transport_failure'; this.settle(entry); throw error; }
    };
  }
}
