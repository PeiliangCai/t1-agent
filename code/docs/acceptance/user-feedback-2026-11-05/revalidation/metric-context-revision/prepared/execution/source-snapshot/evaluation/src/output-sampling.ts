import { createHash } from 'node:crypto';
import { ContractError } from '@t1/contracts';
import type { EvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';

/** Select records for later human work. Selected records are never reported as reviewed. */
export function prepareOutputSample(delivery: EvidenceDelivery, options: { count: number; seed: string; selectionMethod: string }) {
  if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > delivery.records.length ||
    !options.seed.trim() || !options.selectionMethod.trim()) throw new ContractError('output_sample_selection_invalid');
  const rank = (recordId: string) => createHash('sha256').update(options.seed + '\0' + recordId).digest('hex');
  const records = [...delivery.records].sort((a, b) => rank(a.record_id).localeCompare(rank(b.record_id))).slice(0, options.count);
  return { schema_version: 'output-sample-preparation-1', document_id: delivery.document_id, file_sha256: delivery.file_sha256,
    text_version: delivery.text_version, fixture: delivery.fixture, selection_method: options.selectionMethod, seed: options.seed,
    output_count: delivery.records.length, selected_count: records.length, actual_human_reviewed_count: 0,
    full_reference_answer_required: false, formal_sample_count: null, quality_thresholds: null, medical_quality_approved: false,
    status: 'selected_pending_real_human_review',
    review_template: { schema_version: 'output-sample-review-1', sample_id: createHash('sha256').update(JSON.stringify({
      seed: options.seed, ids: records.map(r => [r.record_id, r.record_version, r.delivery_fingerprint]) })).digest('hex'),
      selection_method: options.selectionMethod, reviewer: null, reviewed_at: null,
      entries: records.map(r => ({ record_id: r.record_id, record_version: r.record_version, delivery_fingerprint: r.delivery_fingerprint,
        relevance: 'uncertain', context: 'uncertain', source_pdf_checked: false, source_fidelity: 'uncertain',
        figure_pairing: 'uncertain', figure_completeness: 'uncertain', notes: 'Pending real human check; this template is not a submitted review.' })) },
    selected_records: records.map(r => ({ record_id: r.record_id, original_fragments: r.original_fragments,
      context_fragments: r.context_fragments, figure_association: r.figure_association })),
    recall: null, accuracy: null, stage_passed: false, product_export_approved: false };
}
