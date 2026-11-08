import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceVersion, OutputSampleReview } from '@t1/contracts';
import { makeEvidenceFixture } from '../extraction/fixtures/evidence-fixtures.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { buildEvidenceDelivery, auditOutputSample } from '../../packages/agent/src/evidence-delivery.js';
import { prepareOutputSample } from '../../evaluation/src/output-sampling.js';

function delivery() {
  const f = makeEvidenceFixture(), result = validateEvidenceSubmission(f.submission, f.context); assert.ok(result.record);
  const versions: EvidenceVersion[] = [{ record: result.record, version: 1, actor: 'automatic', status: 'active' }];
  return buildEvidenceDelivery(f.document, versions);
}
test('sample preparation selects reproducibly but never invents a reviewer or reviewed count', () => {
  const d = delivery(), options = { count: 1, seed: 'fixture-reproducibility', selectionMethod: 'Synthetic fixture only' };
  const p = prepareOutputSample(d, options); assert.deepEqual(p, prepareOutputSample(d, options));
  assert.equal(p.actual_human_reviewed_count, 0); assert.equal(p.review_template.reviewer, null); assert.equal(p.review_template.reviewed_at, null);
  assert.equal(auditOutputSample(d).unreviewed_count, 1); assert.equal(p.stage_passed, false);
  assert.throws(() => prepareOutputSample(d, { ...options, count: 2 }), /selection_invalid/);
});
test('legacy sample entries cannot claim original-PDF fidelity; pending images do not block verified text counts', () => {
  const d = delivery(), r = d.records[0]!;
  const review: OutputSampleReview = { schema_version: 'output-sample-review-1', sample_id: 'fixture', selection_method: 'Synthetic fixture only',
    reviewer: 'fixture-only', reviewed_at: '2026-11-04T00:00:00Z', entries: [{ record_id: r.record_id, record_version: r.record_version,
      delivery_fingerprint: r.delivery_fingerprint, relevance: 'pass', context: 'pass', figure_pairing: 'uncertain', notes: 'Synthetic check only' }] };
  let report = auditOutputSample(d, review); assert.equal(report.source_pdf_checked_count, 0); assert.equal(report.recorded_text_checks_pass_count, 0);
  assert.equal(report.reviewed_deduplicated_effective_description_count, null);
  Object.assign(review.entries[0]!, { source_pdf_checked: true, source_fidelity: 'pass', canonical_group_id: 'fixture-group', figure_completeness: 'uncertain' });
  report = auditOutputSample(d, review); assert.equal(report.recorded_text_checks_pass_count, 1); assert.equal(report.recorded_all_checks_pass_count, 0);
  assert.equal(report.reviewed_deduplicated_effective_description_count, 1); assert.equal(report.recall, null); assert.equal(report.stage_passed, false);
  review.reviewed_at = 'not-a-date'; assert.throws(() => auditOutputSample(d, review), /date_invalid/);
});
