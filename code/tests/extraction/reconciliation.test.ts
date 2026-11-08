import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceRecord, EvidenceVersion } from '../../packages/contracts/src/extraction-evidence.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { evidenceSemanticFingerprint, reconcileEvidence } from '../../packages/agent/src/reconciliation.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

function evidence() {
  const fixture = makeEvidenceFixture(['We observed spiculation on CT and MRI in lung cancer and colon cancer in arterial phase and venous phase.',
    'The observation applies only when contrast is absent.']);
  const result = validateEvidenceSubmission(fixture.submission, fixture.context); assert.equal(result.accepted, true);
  return { ...fixture, record: result.record! };
}
const version = (record: EvidenceRecord, n = 1, actor: EvidenceVersion['actor'] = 'automatic'): EvidenceVersion => ({ record, version: n, actor, status: 'active' });

test('an exact resubmission is idempotent across tool call IDs and never writes another version', () => {
  const { record } = evidence(); const replay = structuredClone(record); replay.extraction_trace.tool_call_ids = ['later-submit'];
  const before = structuredClone(record); const result = reconcileEvidence(replay, [version(record, 4)]);
  assert.equal(result.action, 'idempotent'); assert.deepEqual(result.changes, []); assert.equal(result.expected_version, 4);
  assert.equal(evidenceSemanticFingerprint(record), evidenceSemanticFingerprint(replay)); assert.deepEqual(record, before);
});

test('the first candidate generates a reversible insert proposal with no expected parent version', () => {
  const { record } = evidence(); const result = reconcileEvidence(record, []);
  assert.equal(result.action, 'insert'); assert.equal(result.changes.length, 1); assert.equal(result.changes[0]!.kind, 'insert');
  assert.equal(result.changes[0]!.expected_version, null); result.record.translation_zh = 'derived'; assert.equal(record.translation_zh, null);
});

test('the same literal observation at different anchors is linked while retaining both locations', () => {
  const fixture = makeEvidenceFixture(['We observed spiculation on CT in lung cancer.', 'We observed spiculation on CT in lung cancer.']);
  const first = validateEvidenceSubmission(fixture.submission, fixture.context).record!;
  const secondSubmission = structuredClone(fixture.submission), fragment = { block_id: fixture.document.blocks[1]!.block_id, exact_quote: fixture.document.blocks[1]!.text };
  secondSubmission.source_fragments = [fragment]; secondSubmission.disease_or_lesion.evidence = [fragment]; secondSubmission.modality.evidence = [fragment];
  secondSubmission.assertion.evidence = [fragment]; secondSubmission.provenance.evidence = [fragment];
  const second = validateEvidenceSubmission(secondSubmission, fixture.context).record!;
  const result = reconcileEvidence(second, [version(first, 2)]);
  assert.equal(result.action, 'duplicate_link'); assert.equal(result.changes[0]!.kind, 'insert');
  assert.equal(result.changes[1]!.kind, 'link'); assert.equal(result.changes[1]!.expected_version, 2);
  assert.notEqual(result.record.quote_span.segments[0]!.block_id, first.quote_span.segments[0]!.block_id);
  assert.deepEqual(first.duplicate_and_conflict_links, []);
});

test('identical quote text with different known lesions, modalities, phases or conditions remains separate', () => {
  for (const dimension of ['disease', 'modality', 'sequence', 'condition'] as const) {
    const { record } = evidence(); const before = structuredClone(record), after = structuredClone(record); after.record_id += `-${dimension}`;
    if (dimension === 'disease') after.disease_or_lesion.value = 'colon cancer';
    if (dimension === 'modality') after.modality.value = 'MRI';
    if (dimension === 'sequence') {
      before.sequence_or_phase = { value: 'arterial phase', status: 'source_observed', evidence: before.quote_span.segments };
      after.sequence_or_phase = { value: 'venous phase', status: 'source_observed', evidence: after.quote_span.segments };
    }
    if (dimension === 'condition') {
      before.applicability = { status: 'specified', original_wording: 'arterial phase', evidence: before.quote_span.segments };
      after.applicability = { status: 'specified', original_wording: 'venous phase', evidence: after.quote_span.segments };
    }
    const result = reconcileEvidence(after, [version(before)]);
    assert.equal(result.action, 'insert', dimension); assert.equal(result.changes.length, 1, dimension);
    assert.ok(result.issues.some(i => i.startsWith('same_quote_distinct_context:')), dimension);
  }
});

test('later context constraining an unknown applicability generates a new immutable version with CAS', () => {
  const fixture = evidence(); const source = { block_id: fixture.document.blocks[1]!.block_id, exact_quote: fixture.document.blocks[1]!.text };
  fixture.submission.context_fragments = [source]; fixture.submission.applicability = { status: 'specified', original_wording: source.exact_quote, evidence: [source] };
  const candidate = validateEvidenceSubmission(fixture.submission, fixture.context).record!; const before = structuredClone(fixture.record);
  const result = reconcileEvidence(candidate, [version(fixture.record, 3)]);
  assert.equal(result.action, 'new_version'); assert.equal(result.expected_version, 3); assert.equal(result.changes[0]!.kind, 'append_version');
  assert.equal(result.record.record_id, fixture.record.record_id); assert.equal(result.record.applicability.status, 'specified');
  assert.ok(result.record.context.fragments.some(f => f.block_id === source.block_id)); assert.deepEqual(fixture.record, before);
});

test('unknown-to-sourced sequence enrichment creates a version; it is never interpreted as negation', () => {
  const { record } = evidence(); const next = structuredClone(record); next.record_id += '-phase';
  next.sequence_or_phase = { value: 'arterial phase', status: 'source_observed', evidence: next.quote_span.segments };
  const result = reconcileEvidence(next, [version(record)]);
  assert.equal(result.action, 'new_version'); assert.equal(result.record.sequence_or_phase!.value, 'arterial phase');
  assert.equal(record.sequence_or_phase, null); assert.equal(record.assertion.value, 'affirmed');
});

test('human edited or approved active versions are preserved and automatic changes only become proposals', () => {
  for (const protection of ['actor', 'approved', 'event'] as const) {
    const { record } = evidence(); const next = structuredClone(record); next.record_id += '-new';
    next.applicability = { status: 'specified', original_wording: 'arterial phase', evidence: next.quote_span.segments };
    next.extraction_trace.updates_record_id = record.record_id;
    if (protection === 'approved') record.review_status = 'approved';
    if (protection === 'event') record.review_events = [{ action: 'edited', actor: 'synthetic-test-human', timestamp: '2026-11-03T00:00:00Z', reason: 'Synthetic version protection fixture only', version: 6 }];
    const active = version(record, 6, protection === 'actor' ? 'human' : 'automatic'); const before = structuredClone(active);
    const result = reconcileEvidence(next, [active]);
    assert.equal(result.action, 'proposed_update', protection); assert.equal(result.changes[0]!.kind, 'append_proposal');
    assert.equal(result.changes[0]!.expected_version, 6); assert.ok(result.issues.includes('human_version_protected'));
    assert.equal(result.record.handoff_status, 'candidate_only'); assert.equal(result.record.review_status, 'pending');
    assert.deepEqual(result.record.review_events, []); assert.deepEqual(active, before);
  }
});

test('a retry of an already persisted human-protected proposal remains idempotent', () => {
  const { record } = evidence(); const next = structuredClone(record); next.applicability = { status: 'specified', original_wording: 'arterial phase', evidence: next.quote_span.segments };
  next.extraction_trace.updates_record_id = record.record_id;
  const human = version(record, 1, 'human'); const first = reconcileEvidence(next, [human]);
  const second = reconcileEvidence(next, [human, { record: first.record, version: 2, actor: 'automatic', status: 'proposed' }]);
  assert.equal(second.action, 'idempotent'); assert.deepEqual(second.changes, []);
});

test('stale expected versions and explicitly changed known source contexts preserve proposals', () => {
  const { record } = evidence(); const next = structuredClone(record); next.translation_zh = 'A derived translation'; next.extraction_trace.updates_record_id = record.record_id;
  const stale = reconcileEvidence(next, [version(record, 5)], { expectedVersion: 4 });
  assert.equal(stale.action, 'proposed_update'); assert.equal(stale.expected_version, 5); assert.ok(stale.issues.includes('expected_version_mismatch_preserve_proposal'));
  next.disease_or_lesion.value = 'colon cancer';
  const contextChange = reconcileEvidence(next, [version(record)]);
  assert.equal(contextChange.action, 'proposed_update'); assert.ok(contextChange.issues.includes('distinct_source_context_requires_review_proposal'));
});

test('explicit same-condition affirmative/negative observations link conflicts without resolving either source', () => {
  const { record } = evidence(); const negative = structuredClone(record); negative.record_id += '-negative';
  negative.original_quote = 'No spiculation was observed.'; negative.assertion = { value: 'negated', original_wording: negative.original_quote, evidence: negative.quote_span.segments };
  const result = reconcileEvidence(negative, [version(record, 2)]);
  assert.equal(result.action, 'conflict'); assert.equal(result.record.review_status, 'needs_context');
  assert.ok(result.record.duplicate_and_conflict_links.some(l => l.record_id === record.record_id && l.relationship === 'conflict'));
  assert.equal(record.assertion.value, 'affirmed'); assert.equal(result.record.assertion.value, 'negated');
  assert.equal(result.record.evidence_validation.medical_semantics_verified, false);
  // Saving the returned record and retrying the original submission must not create another conflict version.
  const retry = reconcileEvidence(negative, [version(record, 2), version(result.record)]);
  assert.equal(retry.action, 'idempotent');
});

test('unknown assertions and differently attributed source studies are not treated as contradictory negatives', () => {
  const { record } = evidence(); const unknown = structuredClone(record); unknown.record_id += '-unknown'; unknown.assertion.value = 'unknown';
  assert.equal(reconcileEvidence(unknown, [version(record)]).action, 'insert');
  const cited = structuredClone(record); cited.record_id += '-cited'; cited.assertion.value = 'negated';
  cited.context.source_attribution.origin = 'cited_research'; cited.context.source_attribution.cited_references = ['[9]'];
  assert.equal(reconcileEvidence(cited, [version(record)]).action, 'insert');
});

test('different numeric measurements are possible conflicts requiring review, not inferred medical contradictions', () => {
  const { record } = evidence(); const measured = structuredClone(record); measured.record_id += '-measurement';
  record.numeric_expressions = [{ original_text: '5 mm', unit_original: 'mm', evidence: record.quote_span.segments }];
  measured.numeric_expressions = [{ original_text: '10 mm', unit_original: 'mm', evidence: measured.quote_span.segments }];
  measured.original_quote += ' 10 mm';
  const result = reconcileEvidence(measured, [version(record)]);
  assert.equal(result.action, 'conflict'); assert.ok(result.record.duplicate_and_conflict_links.some(l => l.relationship === 'possible_conflict'));
  assert.equal(result.record.review_status, 'needs_context');
});

test('another run, document version or article cannot become a duplicate or update target', () => {
  for (const dimension of ['run', 'sha', 'text', 'document'] as const) {
    const { record } = evidence(); const other = structuredClone(record); other.record_id += '-other';
    if (dimension === 'run') other.extraction_trace.run_id = 'another-run';
    if (dimension === 'sha') other.source_version.file_sha256 = '0'.repeat(64);
    if (dimension === 'text') other.text_version = 'another-text-version';
    if (dimension === 'document') other.document_id = 'another-article';
    other.extraction_trace.updates_record_id = record.record_id;
    assert.throws(() => reconcileEvidence(other, [version(record)]), /update_target_missing_or_outside_bound_run/, dimension);
  }
});

test('same record ID with distinct data never authorizes silent overwrite', () => {
  const { record } = evidence(); const other = structuredClone(record); other.translation_zh = 'A changed derived translation';
  const result = reconcileEvidence(other, [version(record)]);
  assert.equal(result.action, 'duplicate_link'); assert.notEqual(result.record.record_id, record.record_id);
  assert.equal(result.changes[0]!.kind, 'insert'); assert.ok(result.issues.includes('record_id_collision_preserve_separate_candidate'));
});
