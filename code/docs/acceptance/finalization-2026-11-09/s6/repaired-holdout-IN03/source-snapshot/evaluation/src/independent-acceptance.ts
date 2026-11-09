import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError, type LocatedEvidenceFragment, type EvidenceVersion, type FigureAssetCatalog } from '@t1/contracts';
import type { ExtractionDocument } from '../../packages/agent/src/article-scope.js';
import { allDeliveredRecords, exportEvidenceDelivery, type EvidenceDelivery, type DeliveredEvidence } from '../../packages/agent/src/evidence-delivery.js';
import { selectVersionedOutputSample } from './output-review-pack.js';

export const S6_SEED = 't1-s6-20261109-v1';
export const S6_SAMPLE_MAX = 10;

/** The shared exporter deliberately requires an existing parent and never overwrites a package. */
export async function exportIndependentCandidatePackage(document: ExtractionDocument, versions: readonly EvidenceVersion[], options: {
  codeRoot: string; directory: string; catalog?: FigureAssetCatalog; coverage: unknown;
}) {
  await mkdir(dirname(options.directory), { recursive: true, mode: 0o700 });
  return exportEvidenceDelivery(document, versions, { ...options, mode: 'candidates' });
}

/** Two real worker slots; a queued paper cannot start until a slot is released. */
export async function runWithTwoSlots<T>(items: readonly T[], work: (item: T) => Promise<void>, stopped: () => boolean = () => false) {
  let next = 0;
  const worker = async () => { while (next < items.length && !stopped()) { const item = items[next++]!; await work(item); } };
  await Promise.all([worker(), worker()]);
}

/** Literal IR anchors only. Original PDF glyphs and semantics need the delegated review. */
export function auditIndependentDelivery(document: ExtractionDocument, delivery: EvidenceDelivery, expectedPdfSha: string) {
  const issues: Array<{ owner_id: string; role: string; issue: string }> = [];
  const blocks = new Map(document.blocks.map(block => [block.block_id, block]));
  if (document.file_sha256 !== expectedPdfSha || delivery.file_sha256 !== expectedPdfSha || delivery.document_id !== document.document_id ||
      delivery.text_version !== document.text_version) throw new ContractError('independent_delivery_source_identity_mismatch');
  let fragments = 0;
  const check = (owner: string, role: string, parts: readonly LocatedEvidenceFragment[]) => {
    let previous = -1;
    for (const part of parts) {
      fragments++;
      const block = blocks.get(part.block_id), fail = (issue: string) => issues.push({ owner_id: owner, role, issue });
      if (!block) { fail('block_not_in_this_document'); continue; }
      if (part.text_version !== document.text_version || part.text_version !== block.text_version) fail('source_text_version_mismatch');
      if (part.physical_page !== block.page || part.physical_page < 1 || part.physical_page > document.pages.length) fail('physical_page_mismatch');
      if (!Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end) || part.start < 0 || part.end <= part.start ||
          part.end > [...block.text].length || [...block.text].slice(part.start, part.end).join('') !== part.exact_quote) fail('verbatim_unicode_range_mismatch');
      const order = block.reading_order * 1_000_000 + part.start;
      if (order < previous) fail('fragment_source_order_mismatch');
      previous = order;
    }
  };
  for (const record of allDeliveredRecords(delivery)) {
    check(record.record_id, 'original', record.original_fragments); check(record.record_id, 'context', record.context_fragments);
  }
  for (const figure of delivery.figures) check(figure.figure_id, 'caption', figure.caption_segments);
  return { schema_version: 's6-mechanical-source-audit-1', document_id: document.document_id, file_sha256: expectedPdfSha,
    output_count: allDeliveredRecords(delivery).length, fragment_count: fragments, issues, passed: issues.length === 0,
    scope: 'Exact Unicode-point IR ranges, document/version identity and physical pages; PDF glyph fidelity and semantics are separate delegated checks.',
    rewritten_or_cross_document_fragments_observed: issues.filter(i => ['block_not_in_this_document', 'verbatim_unicode_range_mismatch'].includes(i.issue)).length,
    medical_quality_approved: false, product_export_approved: false };
}

export function prepareIndependentReview(delivery: EvidenceDelivery, sourceId: string) {
  const all = allDeliveredRecords(delivery), count = Math.min(S6_SAMPLE_MAX, all.length);
  const sample = count ? selectVersionedOutputSample(delivery, { jobId: sourceId, count, seed: S6_SEED }) : null;
  const riskReasons = (record: DeliveredEvidence) => [
    ...(record.figure_association.status === 'pending' ? ['figure_association_pending'] : []),
    ...(record.context_fragments.length ? ['context_boundaries_require_original_page_check'] : []),
    ...(record.primary_assessment?.effective_role === 'background_suggestion' ? ['background_necessity_not_confirmed'] : []),
  ];
  const rank = (id: string) => createHash('sha256').update(S6_SEED + '/risk/' + sourceId + '\0' + id).digest('hex');
  const risks = all.filter(r => riskReasons(r).length).sort((a, b) => rank(a.record_id).localeCompare(rank(b.record_id))).slice(0, 5);
  return { schema_version: 's6-delegated-review-material-1', source_id: sourceId, document_id: delivery.document_id,
    file_sha256: delivery.file_sha256, text_version: delivery.text_version, seed: S6_SEED,
    selection_method: 'Per independent paper, fixed SHA256 ordering of current version and delivery fingerprint; at most ten, all if fewer. Directed risks are separate.',
    output_count: all.length, random_sample_count: count, random_denominator: count || null,
    empty_output_meaning: all.length ? null : 'No candidates; no review denominator. This does not prove that the paper has no eligible evidence or full recall.',
    random_records: sample?.records ?? [], random_selection_units: sample?.selection_units ?? [],
    directed_risks: risks.map(record => ({ record, reasons: riskReasons(record), also_in_random_sample: sample?.records.some(r => r.record_id === record.record_id) ?? false })),
    reviewer_kind: 'delegated_ai_operator', delegated_review_status: 'pending', actual_human_reviewed_count: 0,
    human_medical_review_status: 'pending', medical_quality_approved: false, product_export_approved: false,
    population_precision: null, recall: null };
}

export function summarizeIndependentTiming(input: { admissionMs: number; firstProgressMs: number | null; firstCandidateMs: number | null; totalMs: number; outputCount: number }) {
  return { admission_seconds: input.admissionMs / 1000, first_progress_seconds: input.firstProgressMs === null ? null : input.firstProgressMs / 1000,
    first_candidate_seconds: input.firstCandidateMs === null ? null : input.firstCandidateMs / 1000, terminal_seconds: input.totalMs / 1000,
    admission_pass: input.admissionMs <= 2000, first_progress_pass: input.firstProgressMs !== null && input.firstProgressMs <= 5000,
    first_candidate_pass: input.outputCount === 0 ? null : input.firstCandidateMs !== null && input.firstCandidateMs <= 600_000,
    terminal_pass: input.totalMs <= 1800_000, observation_count: 1, population_p95: null };
}
