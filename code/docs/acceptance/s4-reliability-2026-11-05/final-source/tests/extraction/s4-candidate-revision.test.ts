import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { EvidenceRecord, EvidenceVersion } from '../../packages/contracts/src/extraction-evidence.js';
import { reconcileEvidence } from '../../packages/agent/src/reconciliation.js';

const frozenPath = new URL('../../docs/acceptance/user-feedback-2026-11-05/revalidation/metric-context-revision/prepared/execution/L05-B0/result.json', import.meta.url);
async function actualAAH() {
  const result = JSON.parse(await readFile(frozenPath, 'utf8')) as { records: EvidenceVersion[] };
  const revision = result.records.find(v => !!v.record.extraction_trace.updates_record_id)!;
  const target = result.records.find(v => v.record.record_id === revision.record.extraction_trace.updates_record_id)!;
  assert.ok(target); assert.equal(target.record.original_quote, revision.record.original_quote);
  return { target, revision };
}

test('the frozen actual AAH feature revision remains one active identity plus a preserved unapproved proposal', async () => {
  const { target, revision } = await actualAAH();
  const before = structuredClone(target);
  const result = reconcileEvidence(revision.record, [target]);
  assert.equal(result.action, 'proposed_update'); assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.kind, 'append_proposal'); assert.equal(result.record.record_id, target.record.record_id);
  assert.ok(result.issues.includes('feature_revision_requires_review'));
  assert.equal(result.record.feature_name_raw, 'typically measures less than 5 mm');
  assert.deepEqual(result.record.context.source_attribution.cited_references, ['7']);
  assert.deepEqual(target, before); assert.equal(result.record.evidence_validation.medical_semantics_verified, false);
  const retry = reconcileEvidence(revision.record, [target, { record: result.record, version: 2, actor: 'automatic', status: 'proposed' }]);
  assert.equal(retry.action, 'idempotent'); assert.deepEqual(retry.changes, []);
});

test('a wrong feature update never falls through to insert or merges a distinct source, subject or attribution', async () => {
  const { target, revision } = await actualAAH();
  for (const dimension of ['anchor', 'subject', 'origin', 'citation', 'run', 'scope'] as const) {
    const next = structuredClone(revision.record), prior = structuredClone(target);
    if (dimension === 'anchor') next.quote_span.segments[0]!.start++;
    if (dimension === 'subject') next.disease_or_lesion.value = 'IAC';
    if (dimension === 'origin') next.context.source_attribution.origin = 'study_authors';
    if (dimension === 'citation') prior.record.context.source_attribution.cited_references = ['8'];
    if (dimension === 'run') next.extraction_trace.run_id += '-other';
    if (dimension === 'scope') next.extraction_trace.scope.scope_version = 'different' as '1';
    assert.throws(() => reconcileEvidence(next, [prior]), /update_target_/, dimension);
  }
});

test('human active data is preserved and Figure/context changes survive in the feature revision proposal', async () => {
  const { target, revision } = await actualAAH(); target.actor = 'human';
  const before = structuredClone(target), next = structuredClone(revision.record);
  next.context.before = 'Retained additional original source context.';
  next.context.structure_references = [{ kind: 'picture', id: 'Figure 2', relationship_used: false }];
  const result = reconcileEvidence(next, [target]);
  assert.equal(result.action, 'proposed_update'); assert.deepEqual(result.record.context, next.context);
  assert.deepEqual(target, before); assert.ok(result.issues.includes('human_version_protected'));
  const changed = structuredClone(result.record); changed.context.after = 'A different retained context.';
  assert.notEqual(reconcileEvidence(changed, [target, { record: result.record, version: 2, actor: 'automatic', status: 'proposed' }]).action, 'idempotent');
});
