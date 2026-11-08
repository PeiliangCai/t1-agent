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
  revision?: {
    schema_version: 'three-method-revision-binding-1'; declared_change: 'visual_scope_prompt';
    parent_authorization_path: string; parent_authorization_sha256: string;
    parent_plan_path: string; parent_plan_sha256: string;
    rule_confirmation_path: string; rule_confirmation_sha256: string;
  };
}
/** A source-bound single-rule revision inherits budget identity, never a fresh owner or clock. */
export function validateComparisonRevision(child: ComparisonAuthorization, expected: {
  parent: ComparisonAuthorization; parent_authorization_sha256: string; parent_plan_sha256: string;
  rule_confirmation_sha256: string; declared_change: string; rule_id: string; confirmation: Record<string, unknown>;
}): void {
  const r = child.revision, p = expected.parent;
  if (!r || r.schema_version !== 'three-method-revision-binding-1' || r.declared_change !== 'visual_scope_prompt' ||
    expected.declared_change !== r.declared_change || r.parent_authorization_sha256 !== expected.parent_authorization_sha256 ||
    r.parent_plan_sha256 !== expected.parent_plan_sha256 || p.prepared_plan_sha256 !== r.parent_plan_sha256 ||
    r.rule_confirmation_sha256 !== expected.rule_confirmation_sha256 || expected.rule_id !== 'metric-definitions-context-only-1' ||
    expected.confirmation.rule_id !== expected.rule_id || expected.confirmation.decision !== 'context_only_no_independent_primary' ||
    expected.confirmation.parent_plan_sha256 !== expected.parent_plan_sha256 ||
    expected.confirmation.authorization_id !== child.authorization_id || expected.confirmation.does_not_reset_authorization_ledger_or_wallclock !== true ||
    ['authorization_id', 'approved_at', 'user_confirmation_source', 'model_id', 'reasoning_effort', 'provider', 'api'].some(k =>
      child[k as keyof ComparisonAuthorization] !== p[k as keyof ComparisonAuthorization]) || JSON.stringify(child.limits) !== JSON.stringify(p.limits)) {
    throw new ContractError('comparison_revision_lineage_or_shared_budget_invalid');
  }
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
