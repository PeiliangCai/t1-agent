import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION_SYSTEM_RULES, METRIC_DEFINITION_CONTEXT_RULE } from '../../packages/agent/src/extraction-pi.js';
import { comparisonBudgetAuthorization, comparisonBudgetOwner, validateComparisonRevision, type ComparisonAuthorization } from '../../packages/agent/src/experiment-authorization.js';
import { S4_LIMITS } from '../../packages/agent/src/extraction-budget.js';
import { expandBatchLineEvidence } from '../../packages/agent/src/extraction-protocol.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { PRIMARY_ASSESSMENT_RULE } from '../../packages/agent/src/primary-evidence-assessment.js';

test('metric scope and separately versioned assessment additions leave the actual frozen parent rule intact', async () => {
  const parent = await import('../../docs/acceptance/user-feedback-2026-11-05/revalidation/prepared/execution/source-snapshot/packages/agent/src/extraction-pi.js');
  assert.equal(EXTRACTION_SYSTEM_RULES.replace(METRIC_DEFINITION_CONTEXT_RULE + '\n', '').replace(PRIMARY_ASSESSMENT_RULE + '\n', ''), parent.EXTRACTION_SYSTEM_RULES);
});

test('general morphology definitions and direct dimensions/CT values remain literal primary evidence; formulas can be necessary context', () => {
  for (const text of ['Spiculation is defined as strands radiating from a nodule margin.', 'The CT image shows a 9 mm nodule measuring 35 HU.']) {
    const f = makeEvidenceFixture([text, 'The CTR was calculated as solid-component diameter divided by nodule diameter.']);
    const s = expandBatchLineEvidence({ source_line_indices: [0], context_line_indices: [1], feature_name_raw: null,
      feature_category: 'synthetic-only', evidence_type: 'definition', assertion: 'affirmed', origin: 'study_authors' }, f.document.blocks, f.submission.binding);
    const r = validateEvidenceSubmission(s, { ...f.context, evidencePolicyVersion: 'visual-statements-2' });
    assert.equal(r.accepted, true, JSON.stringify(r.issues)); assert.equal(r.record!.original_quote, text);
    assert.ok(r.record!.context.fragments.some(p => p.exact_quote.includes('CTR was calculated')));
  }
});

test('the semantic context-only rule is not falsely claimed as a new mechanical validator guarantee', () => {
  const f = makeEvidenceFixture(['The CTR was calculated as solid-component diameter divided by nodule diameter.']);
  const s = expandBatchLineEvidence({ source_line_indices: [0], feature_name_raw: null, feature_category: 'synthetic-only',
    evidence_type: 'definition', assertion: 'affirmed', origin: 'study_authors' }, f.document.blocks, f.submission.binding);
  const r = validateEvidenceSubmission(s, { ...f.context, evidencePolicyVersion: 'visual-statements-2' });
  assert.equal(r.accepted, true); assert.equal(r.record!.evidence_validation.medical_semantics_verified, false);
  // Actual second-round model output must be audited; this test cannot establish model compliance.
});

test('a single-rule child inherits exact budget identity; changed id/time/source/caps or broken lineage reject', () => {
  const parent: ComparisonAuthorization = { schema_version: 'two-method-authorization-1', status: 'authorized', authorization_id: 'synthetic-owner',
    user_confirmation_source: 'synthetic-only-no-network', approved_at: '2026-11-05T00:00:00.000Z', prepared_plan_sha256: 'a'.repeat(64),
    batch_id: 'synthetic-parent', model_id: 'gpt-6-luna', reasoning_effort: 'medium', provider: 'agicto', api: 'openai-responses',
    limits: { ...S4_LIMITS, requests: 300, input_tokens: 6_000_000, output_tokens: 400_000, seconds: 14400 } };
  const child: ComparisonAuthorization = { ...structuredClone(parent), prepared_plan_sha256: 'b'.repeat(64), batch_id: 'synthetic-child',
    revision: { schema_version: 'two-method-revision-binding-1', declared_change: 'visual_scope_prompt', parent_authorization_path: 'synthetic-parent.json',
      parent_authorization_sha256: 'c'.repeat(64), parent_plan_path: 'synthetic-plan.json', parent_plan_sha256: 'a'.repeat(64),
      rule_confirmation_path: 'synthetic-rule.json', rule_confirmation_sha256: 'd'.repeat(64) } };
  const expected = { parent, parent_authorization_sha256: 'c'.repeat(64), parent_plan_sha256: 'a'.repeat(64), rule_confirmation_sha256: 'd'.repeat(64),
    declared_change: 'visual_scope_prompt', rule_id: 'metric-definitions-context-only-1', confirmation: { rule_id: 'metric-definitions-context-only-1',
      decision: 'context_only_no_independent_primary', authorization_id: parent.authorization_id, parent_plan_sha256: 'a'.repeat(64), does_not_reset_authorization_ledger_or_wallclock: true } };
  validateComparisonRevision(child, expected);
  assert.deepEqual(comparisonBudgetAuthorization(child), comparisonBudgetAuthorization(parent));
  assert.equal(comparisonBudgetOwner(child.authorization_id), comparisonBudgetOwner(parent.authorization_id));
  for (const change of [{ authorization_id: 'new-owner' }, { approved_at: '2026-11-05T01:00:00.000Z' }, { user_confirmation_source: 'changed' },
    { limits: { ...child.limits, requests: 301 } }, { revision: { ...child.revision!, parent_plan_sha256: 'e'.repeat(64) } }]) {
    assert.throws(() => validateComparisonRevision({ ...child, ...change }, expected), /revision_lineage_or_shared_budget_invalid/);
  }
});
