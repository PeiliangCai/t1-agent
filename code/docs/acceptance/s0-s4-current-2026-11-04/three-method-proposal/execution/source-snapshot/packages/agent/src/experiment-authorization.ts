import { ContractError } from '@t1/contracts';
import { createHash } from 'node:crypto';
import type { ExtractionBudgetLimits, ExtractionBudgetAuthorization } from './extraction-budget.js';

export const RETIRED_EXPERIMENT_ENTRYPOINTS = ['probe-s4-api.ts', 'probe-s4-closed-protocol.ts', 'run-s4-development.ts',
  'run-s4-selection.ts', 'run-s4-selection-continuation.ts', 'run-s4-selection-reliability.ts',
  'retry-s4-selection-baseline.ts', 'retry-s4-job.ts', 'apply-s4-wall-clock-adjustment.ts'] as const;

export interface ComparisonAuthorization {
  schema_version: 'three-method-authorization-1'; status: 'authorized'; authorization_id: string;
  user_confirmation_source: string; approved_at: string; prepared_plan_sha256: string; batch_id: string;
  model_id: string; reasoning_effort: 'medium'; provider: string; api: 'openai-responses' | 'openai-completions';
  limits: ExtractionBudgetLimits;
}
export function validateComparisonAuthorization(value: unknown, expected: {
  plan_sha256: string; batch_id: string; model_id: string; reasoning_effort: 'medium'; provider: string;
  api: 'openai-responses' | 'openai-completions'; proposed_limits: ExtractionBudgetLimits;
}): ComparisonAuthorization {
  const v = value as ComparisonAuthorization | undefined;
  if (!v || v.schema_version !== 'three-method-authorization-1' || v.status !== 'authorized' || !v.authorization_id?.trim() ||
    !v.user_confirmation_source?.trim() || !Number.isFinite(Date.parse(v.approved_at)) || v.prepared_plan_sha256 !== expected.plan_sha256 ||
    v.batch_id !== expected.batch_id || v.model_id !== expected.model_id || v.reasoning_effort !== expected.reasoning_effort ||
    v.provider !== expected.provider || v.api !== expected.api || !v.limits || Object.keys(v.limits).length !== Object.keys(expected.proposed_limits).length) {
    throw new ContractError('new_comparison_user_authorization_required');
  }
  for (const key of Object.keys(expected.proposed_limits) as Array<keyof ExtractionBudgetLimits>) {
    const n = v.limits[key], cap = expected.proposed_limits[key];
    if (!Number.isSafeInteger(n) || n < (key === 'transient_retries' ? 0 : 1) || n > cap) throw new ContractError('comparison_authorized_limits_invalid');
  }
  // One experiment uses one common execution setting across all methods.
  for (const key of ['document_seconds', 'request_seconds', 'transient_retries', 'response_output_tokens', 'batch_responses'] as const) {
    if (v.limits[key] !== expected.proposed_limits[key]) throw new ContractError('comparison_execution_setting_changed_reprepare_required');
  }
  return structuredClone(v);
}
export const comparisonBudgetAuthorization = (v: ComparisonAuthorization): ExtractionBudgetAuthorization => ({
  id: v.authorization_id, source: v.user_confirmation_source, recorded_at: v.approved_at,
});
/** The same authorization always owns the same ledger, across retries or a one-point follow-up plan. */
export const comparisonBudgetOwner = (authorizationId: string): string =>
  'runtime-data/s4-budget-owners/' + createHash('sha256').update(authorizationId).digest('hex');
