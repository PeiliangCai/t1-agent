import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGINAL_SUMMARY_PROMPT, TARGETED_REREAD_ADDITION, neutralInitialPayload, restoreSummaryCohort } from '../../scripts/summary-reread-replay.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';

test('paired initial payload permits only the declared prompt difference, preserving system, tools and model parameters', () => {
  const base = { model: 'fixture', input: [{ role: 'developer', content: 'fixed system' }, { role: 'user', content: [{ type: 'input_text', text: ORIGINAL_SUMMARY_PROMPT }] }],
    tools: [{ name: 'fixture', parameters: { unchanged: true } }], reasoning: { effort: 'medium' } };
  const variant = structuredClone(base); variant.input[1]!.content = [{ type: 'input_text', text: ORIGINAL_SUMMARY_PROMPT + TARGETED_REREAD_ADDITION }];
  assert.deepEqual(neutralInitialPayload(base, ORIGINAL_SUMMARY_PROMPT), neutralInitialPayload(variant, ORIGINAL_SUMMARY_PROMPT + TARGETED_REREAD_ADDITION));
  const altered = structuredClone(variant); altered.reasoning.effort = 'high';
  assert.notDeepEqual(neutralInitialPayload(base, ORIGINAL_SUMMARY_PROMPT), neutralInitialPayload(altered, ORIGINAL_SUMMARY_PROMPT + TARGETED_REREAD_ADDITION));
  assert.throws(() => neutralInitialPayload(base, 'different prompt'), /unique_prompt_not_found/);
});
test('experimental cohort restore keeps exact versions in a separate store and rejects human approval or cross-run rebinding', () => {
  const f = makeEvidenceFixture(), result = validateEvidenceSubmission(f.submission, f.context); assert.ok(result.record);
  const cohort: any = { job_id: 'fixture', document_id: f.document.document_id, input: f.input, metadata: f.context.metadata,
    versions: [{ record: result.record, version: 3, actor: 'automatic', status: 'active', created_at: '2026-11-04T00:00:00Z', reason: 'fixture frozen version' }], batches: [] };
  const store = new ExtractionStore(':memory:');
  try { restoreSummaryCohort(store, cohort); assert.equal(store.current(f.input.run_id)[0]!.version, 3);
    assert.deepEqual(store.current(f.input.run_id)[0]!.record, result.record); assert.equal(store.snapshot(f.input.run_id).state, 'reconciling'); }
  finally { store.close(); }
  const invalid = structuredClone(cohort); invalid.versions[0].actor = 'human'; const other = new ExtractionStore(':memory:');
  try { assert.throws(() => restoreSummaryCohort(other, invalid), /unapproved_bound_automatic_cohort/); } finally { other.close(); }
});
