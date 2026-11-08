import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceVersion } from '@t1/contracts';
import { makeEvidenceFixture } from '../extraction/fixtures/evidence-fixtures.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { buildEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';
import { currentEvidenceVersions, exactFragmentGroup, packHtmlEscape, selectVersionedOutputSample,
  versionSelectionUnit } from '../../evaluation/src/output-review-pack.js';

function fixture() {
  const f = makeEvidenceFixture(), valid = validateEvidenceSubmission(f.submission, f.context);
  assert.ok(valid.record);
  const versions: EvidenceVersion[] = [{ record: valid.record, version: 1, actor: 'automatic', status: 'active' }];
  return { ...f, versions, delivery: buildEvidenceDelivery(f.document, versions) };
}

test('fixed seed samples current record versions without replacement and regardless of input order', () => {
  const f = fixture(), base = f.delivery.records[0]!;
  const delivery = { ...f.delivery, records: Array.from({ length: 20 }, (_, i) => ({ ...base, record_id: `fixture-${i}`, record_version: i + 1,
    delivery_fingerprint: String(i).padStart(64, '0') })) };
  const options = { jobId: 'synthetic-job', count: 6, seed: 'synthetic-working-sample' };
  const selected = selectVersionedOutputSample(delivery, options);
  assert.deepEqual(selected, selectVersionedOutputSample({ ...delivery, records: [...delivery.records].reverse() }, options));
  assert.equal(selected.records.length, 6); assert.equal(new Set(selected.selection_units).size, 6);
  assert.equal(selected.actual_human_reviewed_count, 0); assert.equal(selected.product_export_approved, false);
  assert.equal(selected.medical_quality_approved, false); assert.equal(delivery.records[0]!.record_id, 'fixture-0');
  assert.throws(() => selectVersionedOutputSample(delivery, { ...options, count: 21 }), /selection_invalid/);
});

test('selection identity changes with task, record version or exact delivery content', () => {
  const record = fixture().delivery.records[0]!, original = versionSelectionUnit('job-a', record);
  assert.notEqual(original, versionSelectionUnit('job-b', record));
  assert.notEqual(original, versionSelectionUnit('job-a', { ...record, record_version: record.record_version + 1 }));
  assert.notEqual(original, versionSelectionUnit('job-a', { ...record, delivery_fingerprint: 'changed-content' }));
});

test('conflicting identical version envelopes and rewritten source quotes are refused', () => {
  const f = fixture(), changed = structuredClone(f.versions[0]!); changed.record.feature_name_raw += '-tampered';
  assert.throws(() => currentEvidenceVersions([...f.versions, changed]), /conflicting_record_version/);
  changed.record.original_quote += ' fabricated';
  assert.throws(() => buildEvidenceDelivery(f.document, [changed]), /quote_rewritten/);
});

test('literal duplicate groups bind source identity and exact fragment boundaries, without claiming medical deduplication', () => {
  const f = fixture(), fragments = f.delivery.records[0]!.original_fragments;
  const key = exactFragmentGroup(f.document.file_sha256, f.document.text_version, fragments);
  assert.equal(key, exactFragmentGroup(f.document.file_sha256, f.document.text_version, structuredClone(fragments)));
  assert.notEqual(key, exactFragmentGroup('another-pdf', f.document.text_version, fragments));
  assert.notEqual(key, exactFragmentGroup(f.document.file_sha256, 'another-text-version', fragments));
  assert.equal(packHtmlEscape('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});
