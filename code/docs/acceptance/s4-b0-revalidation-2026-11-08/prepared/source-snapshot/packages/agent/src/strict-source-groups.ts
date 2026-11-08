import { createHash } from 'node:crypto';
import type { DeliveryReview, EvidenceRecord, EvidenceVersion } from '@t1/contracts';

export const STRICT_SOURCE_GROUPING_POLICY_VERSION = 'strict-source-groups-1' as const;
export const SOURCE_ATTRIBUTION_RULE = 'Distinguish source attribution from internal cross-references. A Figure, panel or Table marker refers to an article structure and by itself never establishes cited_research or an external bibliographic citation. Use the actual source wording and necessary context for origin; keep unclear attribution explicit. Same exact source statement and context with different model labels or attribution remains one mechanical source group with all member records and disagreements retained, not two independently sourced descriptions. Do not resolve an attribution or role disagreement by selecting one member or by changing a human decision.';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const anchors = (fragments: EvidenceRecord['quote_span']['segments']) => fragments.map(s => ({ block_id: s.block_id,
  text_version: s.text_version, start: s.start, end: s.end, exact_quote: s.exact_quote }));
const observation = (value: EvidenceRecord['sequence_or_phase']) => value ? {
  value: value.value, status: value.status, evidence: anchors(value.evidence),
} : null;

/** Exact source identity only. Model feature labels/attribution never manufacture another source statement.
 * Clinical fields and their actual evidence remain strict guards; no semantic/fuzzy matching is performed. */
export function strictSourceGroupKey(record: EvidenceRecord): string {
  return digest(stable({ document_id: record.document_id, article_family_id: record.article_family_id,
    source_version: record.source_version.version, file_sha256: record.source_version.file_sha256, text_version: record.text_version,
    run_id: record.extraction_trace.run_id, task_id: record.extraction_trace.task_id, scope: record.extraction_trace.scope,
    source: anchors(record.quote_span.segments), original_quote: record.original_quote, display_joiner: record.quote_span.display_joiner,
    context: { before: record.context.before, after: record.context.after, fragments: anchors(record.context.fragments),
      article_scope_status: record.context.article_scope_status, supporting_table_evidence: record.context.supporting_table_evidence ?? [] },
    disease: observation(record.disease_or_lesion), modality: observation(record.modality), sequence: observation(record.sequence_or_phase),
    assertion: { value: record.assertion.value, original_wording: record.assertion.original_wording, evidence: anchors(record.assertion.evidence) },
    applicability: { status: record.applicability.status, original_wording: record.applicability.original_wording,
      evidence: anchors(record.applicability.evidence) }, numeric_expressions: record.numeric_expressions,
  }));
}

export function sourceAttributionKey(record: EvidenceRecord): string {
  return stable({ origin: record.context.source_attribution.origin,
    cited_references: [...record.context.source_attribution.cited_references].sort() });
}

/** A narrow, literal marker check flags provenance misuse without inferring medical attribution. */
export function internalStructureReferencesOnly(references: readonly string[]): boolean {
  return references.length > 0 && references.every(reference =>
    /^(?:(?:fig(?:ure)?s?\.?|tables?\.?|panels?)\s*\d+[a-z]?(?:\s*[-–,]\s*\d*[a-z]?)?|[图表]\s*\d+[a-z]?)$/iu.test(reference.trim()));
}

interface FigureGroupView {
  status: string; figure_ids: string[]; proposed_figure_ids: string[]; exact_markers: unknown[];
}
export interface StrictSourceMemberProjection {
  record_id: string; record_version: number; effective_role?: 'primary_candidate' | 'background_suggestion';
  figure_association?: FigureGroupView; human_confirmation?: DeliveryReview | null;
}
export interface StrictSourceGroup {
  group_id: string; member_count: number;
  members: Array<{
    record_id: string; record_version: number; source_record_sha256: string; record_actor: EvidenceVersion['actor'];
    review_status: EvidenceRecord['review_status']; review_events: EvidenceRecord['review_events'];
    source_attribution: EvidenceRecord['context']['source_attribution'];
    feature_name_raw: EvidenceRecord['feature_name_raw']; feature_category: string;
    model_semantic_review_unapproved: EvidenceRecord['evidence_validation']['model_semantic_review'];
    effective_role: 'primary_candidate' | 'background_suggestion';
    structure_references_untrusted: EvidenceRecord['context']['structure_references'];
    figure_association?: FigureGroupView; human_confirmation?: DeliveryReview | null;
  }>;
  attribution_conflict: boolean; role_conflict: boolean; figure_association_conflict: boolean;
  human_review_disagreement: boolean; internal_reference_attribution_needs_review: boolean;
  status: 'single_source_candidate' | 'same_source_members_need_review' | 'conflicting_members_need_review';
  needs_review: boolean; mechanical_only: true; medical_quality_approved: false; automatic_member_selection: false;
}

/** The caller supplies the exact output set. Proposals and unrelated versions can never enter a group. */
export function buildStrictSourceGroups(versions: readonly EvidenceVersion[], projections?: readonly StrictSourceMemberProjection[]): StrictSourceGroup[] {
  const current = new Map<string, EvidenceVersion>();
  for (const version of versions) {
    if (version.status === 'proposed') continue;
    const previous = current.get(version.record.record_id);
    if (!previous || previous.version < version.version) current.set(version.record.record_id, version);
  }
  const projected = projections ? new Map(projections.map(p => [p.record_id, p])) : undefined;
  const grouped = new Map<string, EvidenceVersion[]>();
  for (const version of current.values()) {
    if (projected && projected.get(version.record.record_id)?.record_version !== version.version) continue;
    const key = strictSourceGroupKey(version.record), group = grouped.get(key) ?? [];
    group.push(version); grouped.set(key, group);
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const members: StrictSourceGroup['members'] = group.sort((a, b) => a.record.record_id.localeCompare(b.record.record_id)).map(v => {
      const r = v.record, p = projected?.get(r.record_id), assessment = r.evidence_validation.model_semantic_review;
      return { record_id: r.record_id, record_version: v.version, source_record_sha256: digest(JSON.stringify(r)), record_actor: v.actor,
        review_status: r.review_status, review_events: structuredClone(r.review_events), source_attribution: structuredClone(r.context.source_attribution),
        feature_name_raw: r.feature_name_raw, feature_category: r.feature_category, model_semantic_review_unapproved: structuredClone(assessment),
        effective_role: p?.effective_role ?? (v.actor !== 'human' && assessment.status === 'reviewed_unapproved' &&
          assessment.assessment_policy_version === 'model-primary-assessment-1' && assessment.primary_assessment === 'context_only_suggested'
          ? 'background_suggestion' : 'primary_candidate'),
        structure_references_untrusted: structuredClone(r.context.structure_references),
        ...(p?.figure_association ? { figure_association: structuredClone(p.figure_association) } : {}),
        ...(p?.human_confirmation !== undefined ? { human_confirmation: structuredClone(p.human_confirmation) } : {}) };
    });
    const attributionConflict = new Set(group.map(v => sourceAttributionKey(v.record))).size > 1;
    const roleConflict = new Set(members.map(m => m.effective_role)).size > 1;
    const figureConflict = new Set(members.map(m => stable(m.figure_association ?? null))).size > 1 ||
      new Set(members.map(m => stable(m.structure_references_untrusted))).size > 1;
    const humanDisagreement = new Set(members.flatMap(m => [
      ...((m.record_actor === 'human' || m.review_events.length > 0) && ['approved', 'rejected', 'needs_context'].includes(m.review_status)
        ? [m.review_status] : []),
      ...(m.human_confirmation ? [m.human_confirmation.decision] : []),
    ])).size > 1;
    const internalReferenceIssue = group.some(v => v.record.context.source_attribution.origin === 'cited_research' &&
      internalStructureReferencesOnly(v.record.context.source_attribution.cited_references));
    const conflict = attributionConflict || roleConflict || figureConflict || humanDisagreement || internalReferenceIssue;
    return { group_id: `source-group-${key}`, member_count: members.length, members,
      attribution_conflict: attributionConflict, role_conflict: roleConflict, figure_association_conflict: figureConflict,
      human_review_disagreement: humanDisagreement, internal_reference_attribution_needs_review: internalReferenceIssue,
      status: conflict ? 'conflicting_members_need_review' : members.length > 1 ? 'same_source_members_need_review' : 'single_source_candidate',
      needs_review: conflict || members.length > 1, mechanical_only: true, medical_quality_approved: false, automatic_member_selection: false };
  });
}
