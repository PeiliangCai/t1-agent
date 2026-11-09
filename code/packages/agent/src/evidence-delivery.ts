import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertSchema, ContractError, DeliveryReviewSchema, EvidenceRecordSchema, FigureAssetCatalogSchema,
  OutputSampleReviewSchema, type DeliveryReview, type EvidenceRecord, type EvidenceVersion, type Figure,
  type FigureAssetCatalog, type LocatedEvidenceFragment, type OutputSampleReview } from '@t1/contracts';
import type { ExtractionDocument } from './article-scope.js';
import { locateEvidenceFragment } from './evidence-validation.js';
import { isSourceBoundaryDelimiter, VERBATIM_OUTPUT_POLICY, verbatimOmissionIssues } from './verbatim-policy.js';
import { VISUAL_STATEMENT_POLICY_VERSION, visualStatementIssues } from './visual-evidence-policy.js';
import { PRIMARY_ASSESSMENT_POLICY_VERSION } from './primary-evidence-assessment.js';
import { buildStrictSourceGroups, STRICT_SOURCE_GROUPING_POLICY_VERSION, type StrictSourceGroup } from './strict-source-groups.js';
import { sourceGlyphCheckStatus } from './source-evidence-units.js';
import { auditLegacySourceGlyphs } from './parser.js';

const clone = <T>(x: T): T => structuredClone(x);
export const evidenceDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashBytes = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const sameBinding = (document: ExtractionDocument, value: { document_id: string; file_sha256: string; text_version: string }) =>
  document.document_id === value.document_id && document.file_sha256 === value.file_sha256 && document.text_version === value.text_version;

function assertLocated(document: ExtractionDocument, fragment: LocatedEvidenceFragment, allowUnverifiedGlyphs = false) {
  const actual = locateEvidenceFragment(document, fragment, allowUnverifiedGlyphs);
  if (!isDeepStrictEqual(fragment, actual)) throw new ContractError('delivery_fragment_source_mismatch');
}
export function assertFigureCatalog(document: ExtractionDocument, value: unknown): asserts value is FigureAssetCatalog {
  assertSchema(FigureAssetCatalogSchema, value);
  if (!sameBinding(document, value)) throw new ContractError('figure_catalog_source_binding_mismatch');
  const figureIds = new Set<string>(), assetIds = new Set<string>();
  for (const figure of value.figures) {
    if (figureIds.has(figure.figure_id)) throw new ContractError('duplicate_figure_id');
    figureIds.add(figure.figure_id);
    // Unreliable literal captions remain visible beside their original page,
    // but cannot grant a verified image association or an approved export.
    for (const caption of figure.caption_segments) assertLocated(document, caption, figure.verification.status === 'needs_review');
    for (const asset of figure.regions) {
      const page = document.pages.find(p => p.physical_page === asset.physical_page), [left, top, right, bottom] = asset.bbox;
      if (assetIds.has(asset.asset_id) || asset.source_pdf_sha256 !== document.file_sha256 || !page || page.width === null || page.height === null ||
        !asset.bbox.every(Number.isFinite) || !(left! >= 0 && top! >= 0 && right! > left! && bottom! > top! && right! <= page.width && bottom! <= page.height)) {
        throw new ContractError('figure_asset_source_or_geometry_mismatch');
      }
      assetIds.add(asset.asset_id);
    }
    if (figure.verification.status !== 'needs_review' && (!figure.figure_number || !figure.caption_segments.length || !figure.regions.length ||
      !figure.verification.actor || !figure.verification.checked_at ||
      !figure.verification.all_panels_included || !figure.verification.caption_figure_identity_checked)) throw new ContractError('whole_figure_check_incomplete');
    if (figure.verification.status === 'whole_figure_checked' && figure.verification.method !== 'source_page_visual_check') throw new ContractError('figure_verification_method_mismatch');
    if (figure.verification.status === 'mechanically_checked' && (figure.verification.method !== 'single_pdf_bitmap_caption_guard_1' || !figure.verification.mechanical_evidence)) throw new ContractError('figure_mechanical_evidence_required');
  }
}

/** A generic engineering check, bound to the exact candidate catalog; this never grants human approval. */
export function confirmWholeFigure(document: ExtractionDocument, catalog: FigureAssetCatalog, expectedDigest: string,
  figureId: string, check: { actor: string; checked_at: string; all_panels_included: true; caption_figure_identity_checked: true; notes: string }): FigureAssetCatalog {
  assertFigureCatalog(document, catalog);
  if (evidenceDigest(catalog) !== expectedDigest) throw new ContractError('figure_catalog_version_conflict');
  if (!check.actor.trim() || !check.notes.trim() || !Number.isFinite(Date.parse(check.checked_at))) throw new ContractError('figure_verification_provenance_required');
  const copy = clone(catalog), figure = copy.figures.find(f => f.figure_id === figureId);
  if (!figure) throw new ContractError('figure_not_found');
  figure.verification = { ...check, status: 'whole_figure_checked', method: 'source_page_visual_check', human_approved: false };
  assertFigureCatalog(document, copy);
  return copy;
}

interface FigureMention { number: string; panel: string | null; exact_marker: string; complex: boolean }
export function explicitFigureMentions(text: string): FigureMention[] {
  const regex = /(?:\bfig(?:ure)?s?\.?|图)\s*([1-9][0-9]*)(?:\s*\(?([A-Za-z])(?![A-Za-z])\)?)?/giu;
  return [...text.matchAll(regex)].map(match => ({ number: match[1]!, panel: match[2] ?? null, exact_marker: match[0],
    complex: /^\s*(?:[,;、–—-]|and\b|to\b|及|和|至)\s*[1-9][0-9]*/iu.test(text.slice(match.index! + match[0].length)) }));
}
function incompatibleDimensions(text: string, caption: string): string[] {
  const dimensions = {
    case: /(?:\bcase\s*(?:no\.?\s*)?|病例\s*)(\d+)/giu,
    lesion: /(?:\blesion\s*(?:no\.?\s*)?|病灶\s*)(\d+)/giu,
    modality: /\b(CT|MRI|PET|ultrasound)\b/giu,
    condition: /\b(arterial|venous|delayed|unenhanced|T1WI|T2WI|DWI|ADC)\b/giu,
  };
  const terms = (s: string, pattern: RegExp) => new Set([...s.matchAll(pattern)].map(m => m[1]!.toLowerCase()));
  return Object.entries(dimensions).flatMap(([name, pattern]) => {
    const a = terms(text, pattern), b = terms(caption, pattern);
    return a.size && b.size && ![...a].some(t => b.has(t)) ? [name] : [];
  });
}
export interface FigureAssociation {
  status: 'paired' | 'pending' | 'not_checked' | 'no_explicit_reference';
  figure_ids: string[]; proposed_figure_ids: string[]; exact_markers: FigureMention[]; reasons: string[];
  no_figure_claimed: false; human_approved: false;
}
export function associateFigures(document: ExtractionDocument, record: EvidenceRecord, catalog?: FigureAssetCatalog): FigureAssociation {
  if (catalog) assertFigureCatalog(document, catalog);
  const source = record.quote_span.segments, text = source.map(s => s.exact_quote).join('\n');
  const mentions = explicitFigureMentions(text);
  const result: FigureAssociation = { status: catalog ? 'no_explicit_reference' : 'not_checked', figure_ids: [], proposed_figure_ids: [],
    exact_markers: mentions, reasons: [], no_figure_claimed: false, human_approved: false };
  if (!catalog) { result.reasons.push('Figure inventory not supplied; text remains deliverable.'); return result; }
  const captionMatches = catalog.figures.filter(f => f.caption_segments.some(c => source.some(s =>
    s.block_id === c.block_id && s.start < c.end && c.start < s.end)));
  const requested = new Set([...mentions.map(m => m.number), ...captionMatches.flatMap(f => f.figure_number ? [f.figure_number] : [])]);
  if (!requested.size) { result.reasons.push('No explicit source Figure marker or original-caption overlap; this does not prove absence of images.'); return result; }
  result.status = 'pending';
  if (mentions.some(m => m.complex)) { result.reasons.push('Figure list/range reference needs explicit resolution; no partial first-number pairing.'); return result; }
  for (const number of requested) {
    const matches = catalog.figures.filter(f => f.figure_number === number);
    result.proposed_figure_ids.push(...matches.map(f => f.figure_id));
    if (matches.length !== 1) { result.reasons.push(`Figure ${number}: no unique original-caption/asset identity.`); continue; }
    const figure = matches[0]!, caption = figure.caption_segments.map(c => c.exact_quote).join('\n');
    const captionMentions = explicitFigureMentions(caption);
    if (!captionMentions.some(m => m.number === number) || captionMentions[0]?.number !== number) {
      result.reasons.push(`Figure ${number}: original caption number not verified.`); continue;
    }
    const conflicts = incompatibleDimensions(text, caption);
    if (conflicts.length) { result.reasons.push(`Figure ${number}: incompatible ${conflicts.join(', ')}; no automatic pairing.`); continue; }
    const knownPanels = new Set(figure.panel_labels.flatMap(label => {
      const range = /([A-Za-z])\s*[-–—]\s*([A-Za-z])/u.exec(label);
      if (range) {
        const start = range[1]!.toUpperCase().charCodeAt(0), end = range[2]!.toUpperCase().charCodeAt(0);
        return end >= start && end-start < 26 ? Array.from({ length: end-start+1 }, (_, index) => String.fromCharCode(start+index)) : [];
      }
      const single = /^\(?([A-Za-z])\)?$/u.exec(label.trim()); return single ? [single[1]!.toUpperCase()] : [];
    }));
    for (const marker of captionMentions) if (marker.number === number && marker.panel) knownPanels.add(marker.panel.toUpperCase());
    if (knownPanels.size && mentions.some(m => m.number === number && m.panel && !knownPanels.has(m.panel.toUpperCase()))) {
      result.reasons.push(`Figure ${number}: explicitly referenced panel conflicts with original caption labels.`); continue;
    }
    if (figure.verification.status === 'needs_review' || !figure.regions.length) {
      result.reasons.push(`Figure ${number}: complete Figure region/panels and caption identity need source-page verification.`); continue;
    }
    result.figure_ids.push(figure.figure_id);
  }
  if (result.figure_ids.length === requested.size && !result.reasons.length) result.status = 'paired';
  // A partially resolved multi-Figure statement stays wholly pending. Never attach a misleading subset.
  if (result.status !== 'paired') result.figure_ids = [];
  return result;
}

export interface DeliveredEvidence {
  record_id: string; record_version: number; run_id: string; document_id: string;
  original_fragments: LocatedEvidenceFragment[]; context_fragments: LocatedEvidenceFragment[];
  figure_association: FigureAssociation; review_status: EvidenceRecord['review_status'];
  source_record_sha256: string; text_fingerprint: string; delivery_fingerprint: string;
  supporting_table_evidence?: NonNullable<EvidenceRecord['context']['supporting_table_evidence']>;
  human_role_selection?: { role: 'primary_candidate' | 'background_suggestion'; actor: string; record_version: number; source: 'versioned_human_annotation' };
  evidence_policy_version?: string; source_evidence_unit_version?: string;
  primary_assessment?: {
    policy_version: typeof PRIMARY_ASSESSMENT_POLICY_VERSION;
    value: NonNullable<EvidenceRecord['evidence_validation']['model_semantic_review']['primary_assessment']> | null;
    status: 'reviewed_unapproved' | 'not_performed'; model_id: string | null;
    record_version: number; source_record_sha256: string; record_actor: EvidenceVersion['actor'];
    effective_role: 'primary_candidate' | 'background_suggestion'; human_approved: false;
    human_confirmation_overrides_grouping?: true;
  };
}
export interface EvidenceDelivery {
  schema_version: 'verbatim-figure-delivery-1'; output_policy: typeof VERBATIM_OUTPUT_POLICY;
  document_id: string; file_sha256: string; text_version: string; fixture: boolean;
  scope_snapshots: EvidenceRecord['extraction_trace']['scope'][];
  records: DeliveredEvidence[]; figures: Figure[]; full_recall_claimed: false; medical_quality_approved: false;
  primary_assessment_policy_version?: typeof PRIMARY_ASSESSMENT_POLICY_VERSION;
  background_records?: DeliveredEvidence[];
  source_grouping_policy_version?: typeof STRICT_SOURCE_GROUPING_POLICY_VERSION;
  strict_source_groups?: StrictSourceGroup[];
  unique_source_group_count?: number;
  source_glyph_check?: { status: ReturnType<typeof sourceGlyphCheckStatus>; detects_all_font_encoding_errors: false; source_page_review_still_required: true };
}
/** Include retained background suggestions in audits and sampling; never improve a denominator by hiding them. */
export function allDeliveredRecords(delivery: EvidenceDelivery): DeliveredEvidence[] {
  return [...delivery.records, ...(delivery.background_records ?? [])];
}
export function deliveryRecordCounts(delivery: EvidenceDelivery) {
  return { total_output_count: allDeliveredRecords(delivery).length, primary_candidate_count: delivery.records.length,
    background_suggestion_count: delivery.background_records?.length ?? 0,
    ...(delivery.strict_source_groups ? { unique_source_group_count: delivery.strict_source_groups.length,
      same_source_duplicate_member_count: allDeliveredRecords(delivery).length - delivery.strict_source_groups.length,
      source_grouping_is_not_medical_deduplication: true as const } : {}),
    model_classification_is_not_quality_improvement: true as const };
}
function refreshStrictSourceGroups(delivery: EvidenceDelivery, versions: readonly EvidenceVersion[], reviews?: ReadonlyMap<string, DeliveryReview>) {
  // Membership is projected from the actual delivery set, never from links to omitted records.
  // Group metadata stays outside each member's historical text/delivery fingerprint.
  delivery.strict_source_groups = buildStrictSourceGroups(versions, allDeliveredRecords(delivery).map(record => ({
    record_id: record.record_id, record_version: record.record_version,
    effective_role: record.human_role_selection?.role ?? record.primary_assessment?.effective_role ?? 'primary_candidate',
    figure_association: record.figure_association,
    ...(reviews ? { human_confirmation: reviews.get(record.record_id) ?? null } : {}),
  })));
  delivery.source_grouping_policy_version = STRICT_SOURCE_GROUPING_POLICY_VERSION;
  delivery.unique_source_group_count = delivery.strict_source_groups.length;
}
export function buildEvidenceDelivery(document: ExtractionDocument, versions: readonly EvidenceVersion[], catalog?: FigureAssetCatalog): EvidenceDelivery {
  if (catalog) assertFigureCatalog(document, catalog);
  const current = new Map<string, EvidenceVersion>();
  for (const version of versions) {
    if (!Number.isInteger(version.version) || version.version < 1 || !['automatic', 'human'].includes(version.actor)) throw new ContractError('delivery_version_envelope_invalid');
    if (version.status === 'proposed') continue;
    const old = current.get(version.record.record_id);
    if (!old || version.version > old.version) current.set(version.record.record_id, version);
  }
  const scopes = new Map<string, EvidenceRecord['extraction_trace']['scope']>();
  const records = [...current.values()].map(version => {
    const record = version.record;
    assertSchema(EvidenceRecordSchema, record);
    if (!sameBinding(document, { document_id: record.document_id, file_sha256: record.source_version.file_sha256, text_version: record.text_version })) {
      throw new ContractError('delivery_record_source_binding_mismatch');
    }
    const binding = record.extraction_trace.source_binding;
    if (!sameBinding(document, binding) || binding.run_id !== record.extraction_trace.run_id || binding.task_id !== record.extraction_trace.task_id ||
      binding.source_version !== record.source_version.version) throw new ContractError('delivery_record_trace_binding_mismatch');
    if (record.extraction_trace.fixture !== document.fixture || !isSourceBoundaryDelimiter(record.quote_span.display_joiner) ||
      record.original_quote !== record.quote_span.segments.map(s => s.exact_quote).join(record.quote_span.display_joiner)) throw new ContractError('delivery_quote_rewritten');
    let previousOrder = -1, previousEnd = -1;
    for (const segment of record.quote_span.segments) {
      assertLocated(document, segment);
      const order = document.blocks.find(b => b.block_id === segment.block_id)!.reading_order;
      if (order < previousOrder || order === previousOrder && segment.start < previousEnd) throw new ContractError('delivery_source_order_changed');
      previousOrder = order; previousEnd = segment.end;
    }
    for (const segment of record.context.fragments) assertLocated(document, segment);
    if (record.extraction_trace.evidence_policy_version === VISUAL_STATEMENT_POLICY_VERSION) {
      const fieldEvidence = [record.disease_or_lesion, record.modality, record.sequence_or_phase, record.assertion,
        record.applicability, record.context.source_attribution, ...record.numeric_expressions].flatMap(f => f?.evidence ?? []);
      const support = record.context.supporting_table_evidence ?? [];
      for (const segment of [...fieldEvidence, ...support.flatMap(t => [...t.reference_evidence, ...t.fragments])]) assertLocated(document, segment);
      const issues = visualStatementIssues(document, record, record.quote_span.segments, record.context.fragments, fieldEvidence, support);
      if (issues.some(i => i.severity === 'reject')) throw new ContractError('delivery_visual_statement_policy_failed');
    } else if (verbatimOmissionIssues(document, record.quote_span.segments).length) throw new ContractError('delivery_source_qualifier_omitted');
    scopes.set(evidenceDigest(record.extraction_trace.scope), record.extraction_trace.scope);
    const textContent = { record_id: record.record_id, record_version: version.version, run_id: record.extraction_trace.run_id,
      document_id: record.document_id, original_fragments: clone(record.quote_span.segments), context_fragments: clone(record.context.fragments),
      source_record_sha256: evidenceDigest(record),
      ...(record.context.supporting_table_evidence ? { supporting_table_evidence: clone(record.context.supporting_table_evidence) } : {}),
      ...(record.extraction_trace.evidence_policy_version ? { evidence_policy_version: record.extraction_trace.evidence_policy_version,
        source_evidence_unit_version: record.extraction_trace.source_evidence_unit_version } : {}) };
    const review = record.evidence_validation.model_semantic_review;
    if (review.primary_assessment && (review.assessment_policy_version !== PRIMARY_ASSESSMENT_POLICY_VERSION ||
      review.status !== 'reviewed_unapproved' || !review.model_id)) throw new ContractError('delivery_primary_assessment_policy_mismatch');
    const assessed = review.assessment_policy_version === PRIMARY_ASSESSMENT_POLICY_VERSION;
    const primaryAssessment: DeliveredEvidence['primary_assessment'] = assessed || record.extraction_trace.primary_assessment_policy_version ? {
      policy_version: PRIMARY_ASSESSMENT_POLICY_VERSION, value: review.primary_assessment ?? null,
      status: assessed ? 'reviewed_unapproved' : 'not_performed', model_id: assessed ? review.model_id : null,
      record_version: version.version, source_record_sha256: textContent.source_record_sha256, record_actor: version.actor,
      effective_role: assessed && review.primary_assessment === 'context_only_suggested' && version.actor !== 'human'
        ? 'background_suggestion' : 'primary_candidate', human_approved: false,
    } : undefined;
    const value = { ...textContent, text_fingerprint: evidenceDigest(textContent),
      figure_association: associateFigures(document, record, catalog), review_status: record.review_status,
      ...(primaryAssessment ? { primary_assessment: primaryAssessment } : {}) };
    // Bind the Figure contents, not just its ID; replacing an image/caption invalidates prior confirmation.
    const figureContent = catalog?.figures.filter(f => value.figure_association.proposed_figure_ids.includes(f.figure_id)) ?? [];
    return { ...value, delivery_fingerprint: evidenceDigest({ ...value, figure_content: figureContent }) };
  });
  const delivery: EvidenceDelivery = { schema_version: 'verbatim-figure-delivery-1', output_policy: VERBATIM_OUTPUT_POLICY, document_id: document.document_id,
    file_sha256: document.file_sha256, text_version: document.text_version, fixture: document.fixture,
    scope_snapshots: [...scopes.values()].map(clone), records: records.filter(r => r.primary_assessment?.effective_role !== 'background_suggestion'),
    ...(records.some(r => r.primary_assessment) ? { primary_assessment_policy_version: PRIMARY_ASSESSMENT_POLICY_VERSION,
      background_records: records.filter(r => r.primary_assessment?.effective_role === 'background_suggestion') } : {}),
    figures: clone(catalog?.figures ?? []),
    full_recall_claimed: false, medical_quality_approved: false,
    ...(sourceGlyphCheckStatus(document) !== 'legacy_not_checked' ? {
      source_glyph_check: { status: sourceGlyphCheckStatus(document), detects_all_font_encoding_errors: false as const, source_page_review_still_required: true as const } } : {}) };
  refreshStrictSourceGroups(delivery, [...current.values()]);
  return delivery;
}

export function auditOutputSample(delivery: EvidenceDelivery, reviews?: OutputSampleReview) {
  const allRecords = allDeliveredRecords(delivery);
  if (reviews) assertSchema(OutputSampleReviewSchema, reviews);
  if (reviews && !Number.isFinite(Date.parse(reviews.reviewed_at))) throw new ContractError('sample_review_date_invalid');
  const seen = new Set<string>();
  for (const entry of reviews?.entries ?? []) {
    const record = allRecords.find(r => r.record_id === entry.record_id);
    if (!record || record.record_version !== entry.record_version || record.delivery_fingerprint !== entry.delivery_fingerprint) throw new ContractError('sample_review_version_conflict');
    if (seen.has(entry.record_id)) throw new ContractError('duplicate_sample_review');
    seen.add(entry.record_id);
  }
  const entries = reviews?.entries ?? [];
  const textChecked = entries.filter(e => e.source_pdf_checked === true && e.source_fidelity === 'pass' && e.relevance === 'pass' && e.context === 'pass');
  const checked = textChecked.filter(e => {
    const record = allRecords.find(r => r.record_id === e.record_id)!;
    return e.figure_pairing === 'pass' && e.figure_completeness === 'pass' ||
      e.figure_pairing === 'not_applicable' && e.figure_completeness === 'not_applicable' &&
      record.figure_association.status === 'no_explicit_reference';
  });
  const groupsComplete = textChecked.length > 0 && textChecked.every(e => e.canonical_group_id);
  return { schema_version: 'output-sample-report-1', output_count: allRecords.length, sampled_count: entries.length,
    ...(delivery.primary_assessment_policy_version || delivery.source_grouping_policy_version ? deliveryRecordCounts(delivery) : {}),
    status: entries.length ? 'human_sample_recorded_thresholds_pending' : 'human_sample_pending',
    unreviewed_count: allRecords.length - entries.length,
    source_pdf_checked_count: entries.filter(e => e.source_pdf_checked === true).length,
    recorded_text_checks_pass_count: textChecked.length,
    recorded_all_checks_pass_count: checked.length,
    not_fully_verified_count: allRecords.length - checked.length,
    reviewed_deduplicated_effective_description_count: groupsComplete ? new Set(textChecked.map(e => e.canonical_group_id)).size : null,
    deduplication_basis: groupsComplete ? 'human_supplied_canonical_groups_for_checked_output_only' : 'not_established',
    verified_scope: { document_id: delivery.document_id, file_sha256: delivery.file_sha256, text_version: delivery.text_version,
      record_ids: entries.map(e => e.record_id), full_document_recall_measured: false },
    source_consistency: 'all_delivered_fragments_checked_against_bound_IR_not_full_PDF_fidelity',
    observed_errors: { relevance: entries.filter(e => e.relevance === 'fail').length, context: entries.filter(e => e.context === 'fail').length,
      figure_pairing: entries.filter(e => e.figure_pairing === 'fail').length, source_fidelity: entries.filter(e => e.source_fidelity === 'fail').length,
      figure_completeness: entries.filter(e => e.figure_completeness === 'fail').length },
    uncertain_count: entries.filter(e => e.relevance === 'uncertain' || e.context === 'uncertain' || e.figure_pairing === 'uncertain' ||
      e.source_fidelity === 'uncertain' || e.figure_completeness === 'uncertain').length,
    selection_method: reviews?.selection_method ?? null, reviewer: reviews?.reviewer ?? null,
    sample_size_threshold: null, acceptance_threshold: null, stage_passed: false,
    full_gold_required: false, recall: null, medical_precision: null, F1: null, zero_errors_proven: false,
    approved_export_still_requires_each_record_confirmation: true };
}

/** Source assets and approvals are verified before creating an exclusive output folder. No old artifact is rewritten. */
export async function exportEvidenceDelivery(document: ExtractionDocument, versions: readonly EvidenceVersion[], options: {
  codeRoot: string; directory: string; catalog?: FigureAssetCatalog; mode: 'candidates' | 'approved'; reviews?: readonly DeliveryReview[];
  coverage: unknown; sampleReview?: OutputSampleReview;
  humanRoles?: readonly { record_id: string; record_version: number; role: 'primary_candidate' | 'background_suggestion'; actor: string }[];
}) {
  let sourceGlyphAudit: Awaited<ReturnType<typeof auditLegacySourceGlyphs>>['audit'] | undefined;
  if (options.mode === 'approved' && sourceGlyphCheckStatus(document) === 'legacy_not_checked') {
    try {
      const audited = await auditLegacySourceGlyphs(document); document = audited.document; sourceGlyphAudit = audited.audit;
    } catch { throw new ContractError('source_glyph_check_missing_reparse_required'); }
  }
  const delivery = buildEvidenceDelivery(document, versions, options.catalog), checked = new Map<string, DeliveryReview>();
  const allRecords = allDeliveredRecords(delivery);
  for (const review of options.reviews ?? []) {
    assertSchema(DeliveryReviewSchema, review);
    if (!Number.isFinite(Date.parse(review.reviewed_at)) || checked.has(review.record_id)) throw new ContractError('delivery_review_invalid');
    const record = allRecords.find(r => r.record_id === review.record_id);
    if (!record || record.record_version !== review.record_version || record.text_fingerprint !== review.text_fingerprint ||
      review.review_scope === 'text_and_figures' && record.delivery_fingerprint !== review.delivery_fingerprint ||
      review.review_scope === 'text_only' && review.delivery_fingerprint !== null) throw new ContractError('delivery_review_version_conflict');
    checked.set(review.record_id, review);
  }
  const legacyTextApprovals = new Map<string, EvidenceRecord['review_events']>();
  if (options.mode === 'approved') for (const record of allRecords) {
    const review = checked.get(record.record_id);
    const sourceVersion = versions.find(v => v.record.record_id === record.record_id && v.version === record.record_version && v.status !== 'proposed');
    const legacyApproved = sourceVersion?.actor === 'human' && sourceVersion.record.review_status === 'approved' && sourceVersion.record.handoff_status === 'approved_for_T2' &&
      sourceVersion.record.review_events.some(e => e.version === record.record_version && /^(?:approve|approved)$/u.test(e.action) && e.actor.trim() && Number.isFinite(Date.parse(e.timestamp)));
    if (review && (review.decision !== 'approved' || !review.source_text_checked || !review.relevance_checked || !review.context_checked ||
      review.review_scope === 'text_and_figures' && !review.figure_pairing_checked) || !review && !legacyApproved) {
      throw new ContractError('approved_export_requires_each_record_confirmation');
    }
    if (!review && legacyApproved) legacyTextApprovals.set(record.record_id, clone(sourceVersion!.record.review_events));
    // A genuine version-bound human relevance decision takes precedence over the
    // model's grouping suggestion. Keep that suggestion and its provenance visible.
    if (review && record.primary_assessment?.effective_role === 'background_suggestion') {
      record.primary_assessment.effective_role = 'primary_candidate';
      record.primary_assessment.human_confirmation_overrides_grouping = true;
      const { delivery_fingerprint: _old, ...value } = record;
      record.delivery_fingerprint = evidenceDigest({ ...value, figure_content: delivery.figures.filter(f => record.figure_association.proposed_figure_ids.includes(f.figure_id)) });
    }
    if (!review || review.review_scope === 'text_only') {
      record.figure_association.status = record.figure_association.proposed_figure_ids.length ? 'pending' : record.figure_association.status;
      record.figure_association.figure_ids = [];
      record.figure_association.reasons.push('Text approval applies to source fragments only; Figure assets and pairing await separate confirmation.');
      const { delivery_fingerprint: _old, ...value } = record;
      record.delivery_fingerprint = evidenceDigest({ ...value, figure_content: delivery.figures.filter(f => record.figure_association.proposed_figure_ids.includes(f.figure_id)) });
    }
  }
  if (options.mode === 'approved' && delivery.background_records) {
    delivery.records.push(...delivery.background_records.filter(r => r.primary_assessment?.effective_role !== 'background_suggestion'));
    delivery.background_records = delivery.background_records.filter(r => r.primary_assessment?.effective_role === 'background_suggestion');
  }
  // Product labels are version-bound human annotations, kept separate from the model's unapproved assessment and source wording.
  const selectedRoles = new Set<string>();
  for (const selection of options.humanRoles ?? []) {
    const record = allRecords.find(r => r.record_id === selection.record_id), version = versions.find(v => v.record.record_id === selection.record_id && v.version === selection.record_version && v.status !== 'proposed');
    if (!record || record.record_version !== selection.record_version || version?.actor !== 'human' || !selection.actor.trim() ||
      !['primary_candidate', 'background_suggestion'].includes(selection.role) || selectedRoles.has(selection.record_id)) throw new ContractError('human_role_version_conflict');
    selectedRoles.add(selection.record_id);
    record.human_role_selection = { role: selection.role, actor: selection.actor, record_version: selection.record_version, source: 'versioned_human_annotation' };
    if (record.primary_assessment) record.primary_assessment.effective_role = selection.role;
    const { delivery_fingerprint: _old, ...value } = record;
    record.delivery_fingerprint = evidenceDigest({ ...value, figure_content: delivery.figures.filter(f => record.figure_association.proposed_figure_ids.includes(f.figure_id)) });
  }
  if (selectedRoles.size) {
    const effectiveRole = (r: DeliveredEvidence) => r.human_role_selection?.role ?? r.primary_assessment?.effective_role ?? 'primary_candidate';
    delivery.records = allRecords.filter(r => effectiveRole(r) === 'primary_candidate');
    delivery.background_records = allRecords.filter(r => effectiveRole(r) === 'background_suggestion');
  }
  refreshStrictSourceGroups(delivery, versions, checked);
  const sample = auditOutputSample(delivery, options.sampleReview);
  const codeRoot = await realpath(options.codeRoot), directory = resolve(options.directory);
  const parent = await realpath(dirname(directory));
  const inside = (path: string) => { const rel = relative(codeRoot, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
  if (!inside(parent) && parent !== codeRoot || !inside(directory)) throw new ContractError('delivery_output_outside_code');
  const pdfPath = await realpath(resolve(codeRoot, document.source.file_reference));
  if (!inside(pdfPath) || hashBytes(await readFile(pdfPath)) !== document.file_sha256) throw new ContractError('delivery_pdf_hash_mismatch');
  const assets: Array<{ asset_id: string; source_path: string; package_path: string; sha256: string; bytes: Buffer }> = [];
  const referencedFigures = new Set(allRecords.flatMap(r => [...r.figure_association.figure_ids, ...r.figure_association.proposed_figure_ids]));
  for (const figure of delivery.figures.filter(f => referencedFigures.has(f.figure_id))) for (const asset of figure.regions) {
    const path = await realpath(resolve(codeRoot, asset.path));
    if (!inside(path)) throw new ContractError('figure_asset_outside_code');
    const bytes = await readFile(path);
    if (hashBytes(bytes) !== asset.sha256) throw new ContractError('figure_asset_hash_mismatch');
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== asset.width_px || bytes.readUInt32BE(20) !== asset.height_px) throw new ContractError('figure_asset_png_or_dimensions_mismatch');
    const mainPair = allRecords.some(r => r.figure_association.figure_ids.includes(figure.figure_id));
    const packagePath = `${mainPair ? 'figures' : 'review-materials'}/${evidenceDigest(asset.asset_id).slice(0, 32)}.png`;
    assets.push({ asset_id: asset.asset_id, source_path: asset.path, package_path: packagePath, sha256: asset.sha256, bytes });
  }
  await mkdir(directory, { recursive: false, mode: 0o700 });
  for (const folder of new Set(assets.map(a => dirname(a.package_path)))) await mkdir(resolve(directory, folder));
  for (const asset of assets) await writeFile(resolve(directory, asset.package_path), asset.bytes, { flag: 'wx' });
  const exportedRecord = (r: DeliveredEvidence) => ({ ...r,
    export_review_status: options.mode === 'approved' ? checked.get(r.record_id)?.review_scope === 'text_and_figures' ? 'approved_text_and_figures' : 'approved_text_only' : 'candidate',
    human_confirmation: checked.get(r.record_id) ?? null, legacy_text_review_events: legacyTextApprovals.get(r.record_id) ?? [] });
  const exportRecords = delivery.records.map(exportedRecord), backgroundRecords = (delivery.background_records ?? []).map(exportedRecord);
  await writeFile(resolve(directory, 'records.jsonl'), exportRecords.map(r => JSON.stringify(r)).join('\n') + (delivery.records.length ? '\n' : ''), { flag: 'wx' });
  const csv = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  // One row per original fragment. No flattened, reconstructed prose description is created.
  const csvRows = (records: DeliveredEvidence[]) => records.flatMap(r => r.original_fragments.map((f, index) => [r.record_id, String(r.record_version), String(index), f.exact_quote,
    String(f.physical_page), f.block_id, String(f.start), String(f.end), r.figure_association.status].map(csv).join(',')));
  const rows = csvRows(delivery.records);
  await writeFile(resolve(directory, 'records.csv'), '\ufeffrecord_id,record_version,fragment_index,original_fragment,physical_page,block_id,start,end,figure_status\n'+rows.join('\n')+(rows.length?'\n':''), { flag: 'wx' });
  if (delivery.background_records) {
    const backgroundRows = csvRows(delivery.background_records);
    await writeFile(resolve(directory, 'background-records.jsonl'), backgroundRecords.map(r => JSON.stringify(r)).join('\n') + (backgroundRecords.length ? '\n' : ''), { flag: 'wx' });
    await writeFile(resolve(directory, 'background-records.csv'), '\ufeffrecord_id,record_version,fragment_index,original_fragment,physical_page,block_id,start,end,figure_status\n'+backgroundRows.join('\n')+(backgroundRows.length?'\n':''), { flag: 'wx' });
  }
  await writeFile(resolve(directory, 'delivery.json'), JSON.stringify({ ...delivery, records: exportRecords,
    ...(delivery.background_records ? { background_records: backgroundRecords } : {}) }, null, 2)+'\n', { flag: 'wx' });
  await writeFile(resolve(directory, 'coverage.json'), JSON.stringify(options.coverage, null, 2)+'\n', { flag: 'wx' });
  if (sourceGlyphAudit) await writeFile(resolve(directory, 'source-glyph-audit.json'), JSON.stringify(sourceGlyphAudit, null, 2)+'\n', { flag: 'wx' });
  await writeFile(resolve(directory, 'sample-audit.json'), JSON.stringify(sample, null, 2)+'\n', { flag: 'wx' });
  await writeFile(resolve(directory, 'reviews.json'), JSON.stringify([...checked.values()], null, 2)+'\n', { flag: 'wx' });
  const manifest = { schema_version: 'verbatim-figure-export-1', mode: options.mode, output_policy: VERBATIM_OUTPUT_POLICY,
    document_id: document.document_id, file_sha256: document.file_sha256, text_version: document.text_version,
    record_count: allRecords.length, ...(delivery.primary_assessment_policy_version || delivery.source_grouping_policy_version ? deliveryRecordCounts(delivery) : {}),
    ...(delivery.source_grouping_policy_version ? { source_grouping_policy_version: delivery.source_grouping_policy_version,
      source_groups: 'delivery.json strict_source_groups; records.jsonl/CSV retain every original member and fragment' } : {}),
    ...(delivery.primary_assessment_policy_version ? { primary_assessment_policy_version: delivery.primary_assessment_policy_version,
      background_suggestions: 'background-records.jsonl / background-records.csv; only background suggested, not human confirmed' } : {}),
    fixture: document.fixture, record_level_human_confirmation: options.mode === 'approved',
    approved_by_model: false, full_recall_claimed: false, medical_quality_approved: false,
    assets: assets.map(({ bytes: _bytes, ...a }) => a), authoritative_description: 'records.jsonl original_fragments; records.csv has one row per fragment',
    source_ir_fidelity_is_not_medical_approval: true, legacy_records_modified: false,
    source_glyph_check: delivery.source_glyph_check ?? { status: 'legacy_not_checked', detects_all_font_encoding_errors: false, source_page_review_still_required: true },
    ...(sourceGlyphAudit ? { source_glyph_audit: 'source-glyph-audit.json', historical_ir_rewritten: false, source_glyph_audit_model_calls: 0 } : {}) };
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2)+'\n', { flag: 'wx' });
  return { delivery, manifest, sample };
}
