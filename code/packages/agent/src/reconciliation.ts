import { createHash } from 'node:crypto';
import type { EvidenceRecord, EvidenceVersion, ReconciliationChange, ReconciliationResult } from '../../contracts/src/extraction-evidence.js';
import { ContractError } from '@t1/contracts';
import { literalFold } from './scope-matching.js';
import { strictSourceGroupKey, sourceAttributionKey } from './strict-source-groups.js';

const clone = <T>(value: T): T => structuredClone(value);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const sourceAnchors = (record: EvidenceRecord) => record.quote_span.segments.map(s => ({ block_id: s.block_id, text_version: s.text_version,
  start: s.start, end: s.end, exact_quote: s.exact_quote }));
const featureKey = (record: EvidenceRecord) => stable(record.normalized_terms.length ? record.normalized_terms.map(t => ({ feature_id: t.feature_id, binding_id: t.binding_id })) : literalFold(record.feature_name_raw ?? ''));
const observed = (value: EvidenceRecord['sequence_or_phase']) => value ? { value: value.value === null ? null : literalFold(value.value), status: value.status } : null;
const conditionKey = (record: EvidenceRecord) => stable({ disease: observed(record.disease_or_lesion), modality: observed(record.modality),
  sequence: observed(record.sequence_or_phase), applicability: { status: record.applicability.status, wording: literalFold(record.applicability.original_wording) },
  attribution: { origin: record.context.source_attribution.origin, references: record.context.source_attribution.cited_references } });
const protectedVersion = (version: EvidenceVersion) => version.actor === 'human' || version.record.review_status === 'approved' ||
  version.record.review_status === 'rejected' || version.record.review_events.length > 0;
const sameRunSource = (a: EvidenceRecord, b: EvidenceRecord) => a.document_id === b.document_id && a.article_family_id === b.article_family_id &&
  a.source_version.file_sha256 === b.source_version.file_sha256 && a.source_version.version === b.source_version.version && a.text_version === b.text_version &&
  a.extraction_trace.run_id === b.extraction_trace.run_id && a.extraction_trace.task_id === b.extraction_trace.task_id &&
  stable(a.extraction_trace.scope) === stable(b.extraction_trace.scope);

/** Ignores call timestamps, presentation warnings and review metadata, but includes clinical context and all evidence anchors. */
export function evidenceSemanticFingerprint(record: EvidenceRecord): string {
  return createHash('sha256').update(stable({ document: record.document_id, family: record.article_family_id, source_version: record.source_version.version,
    sha: record.source_version.file_sha256, text_version: record.text_version, source: sourceAnchors(record), quote: record.original_quote,
    joiner: record.quote_span.display_joiner, context: { before: record.context.before, after: record.context.after,
      fragments: record.context.fragments, source_attribution: record.context.source_attribution,
      structure_references: record.context.structure_references, article_scope_status: record.context.article_scope_status,
      supporting_table_evidence: record.context.supporting_table_evidence ?? [] },
    disease: record.disease_or_lesion, modality: record.modality,
    sequence: record.sequence_or_phase, feature: record.feature_name_raw, category: record.feature_category, evidence_type: record.evidence_type,
    assertion: record.assertion, applicability: record.applicability, numbers: record.numeric_expressions,
    normalized_terms: record.normalized_terms, translation: record.translation_zh })).digest('hex');
}

function enrichment(old: EvidenceRecord, next: EvidenceRecord): boolean {
  const observations = [
    [old.disease_or_lesion, next.disease_or_lesion], [old.modality, next.modality], [old.sequence_or_phase, next.sequence_or_phase],
  ] as const;
  let enriched = false;
  for (const [before, after] of observations) {
    if (before?.status === 'source_observed' && stable(observed(before)) !== stable(observed(after))) return false;
    if (before?.status !== 'source_observed' && after?.status === 'source_observed') enriched = true;
  }
  if (old.applicability.status === 'specified' && stable(old.applicability) !== stable(next.applicability)) return false;
  if (old.applicability.status === 'unknown' && next.applicability.status === 'specified') enriched = true;
  if (old.assertion.value !== next.assertion.value && old.assertion.value !== 'unknown') return false;
  if (old.context.source_attribution.origin !== next.context.source_attribution.origin) return false;
  return enriched;
}

export interface ReconciliationOptions { targetRecordId?: string; expectedVersion?: number }
function safeFeatureRevision(before: EvidenceRecord, after: EvidenceRecord) {
  const observations = [[before.disease_or_lesion, after.disease_or_lesion], [before.modality, after.modality],
    [before.sequence_or_phase, after.sequence_or_phase]] as const;
  return stable(sourceAnchors(before)) === stable(sourceAnchors(after)) && before.original_quote === after.original_quote &&
    observations.every(([a, b]) => a?.status !== 'source_observed' || stable(observed(a)) === stable(observed(b))) &&
    (before.applicability.status !== 'specified' || stable(before.applicability) === stable(after.applicability)) &&
    (before.assertion.value === 'unknown' || before.assertion.value === after.assertion.value) &&
    before.context.source_attribution.origin === after.context.source_attribution.origin &&
    (!before.context.source_attribution.cited_references.length ||
      stable(before.context.source_attribution.cited_references) === stable(after.context.source_attribution.cited_references));
}
/** Advice only. The caller persists every change in one transaction and enforces each expected_version using CAS. */
export function reconcileEvidence(candidate: EvidenceRecord, existing: readonly EvidenceVersion[], options: ReconciliationOptions = {}): ReconciliationResult {
  const next = clone(candidate);
  const latest = new Map<string, EvidenceVersion>();
  for (const version of existing) {
    if (version.status === 'proposed') continue;
    const previous = latest.get(version.record.record_id);
    if (!previous || previous.version < version.version) latest.set(version.record.record_id, version);
  }
  const versions = [...latest.values()].filter(v => sameRunSource(v.record, next)).sort((a, b) => a.record.record_id.localeCompare(b.record.record_id));
  const result: ReconciliationResult = { action: 'insert', changes: [], record: next, expected_version: null,
    target_record_id: null, related_record_ids: [], issues: [] };
  const requestedTarget = options.targetRecordId ?? next.extraction_trace.updates_record_id;
  let target = requestedTarget ? versions.find(v => v.record.record_id === requestedTarget) : undefined;
  if (requestedTarget && !target) throw new ContractError('update_target_missing_or_outside_bound_run');
  const featureRevision = !!target && featureKey(target.record) !== featureKey(next);
  if (featureRevision && !safeFeatureRevision(target!.record, next)) throw new ContractError('update_target_feature_mismatch');
  const fingerprint = evidenceSemanticFingerprint(next);
  const replay = versions.find(v => evidenceSemanticFingerprint(v.record) === fingerprint);
  if (replay) return { ...result, action: 'idempotent', record: clone(replay.record), expected_version: replay.version,
    target_record_id: replay.record.record_id, related_record_ids: [replay.record.record_id] };
  // A retry of an already stored proposal is also idempotent and must never become an active automatic version.
  const proposedReplay = existing.find(v => v.status === 'proposed' && sameRunSource(v.record, next) && evidenceSemanticFingerprint(v.record) === fingerprint);
  if (proposedReplay) return { ...result, action: 'idempotent', record: clone(proposedReplay.record), expected_version: proposedReplay.version,
    target_record_id: proposedReplay.record.record_id, related_record_ids: [proposedReplay.record.record_id] };
  if (!target && !requestedTarget) target = versions.find(v => featureKey(v.record) === featureKey(next) &&
    stable(sourceAnchors(v.record)) === stable(sourceAnchors(next)) && enrichment(v.record, next));
  if (target) {
    const stale = options.expectedVersion !== undefined && options.expectedVersion !== target.version;
    const humanProtected = protectedVersion(target);
    const contextPairs = [
      [target.record.disease_or_lesion, next.disease_or_lesion], [target.record.modality, next.modality],
      [target.record.sequence_or_phase, next.sequence_or_phase],
    ] as const;
    const distinctContext = contextPairs.some(([before, after]) => before?.status === 'source_observed' && stable(observed(before)) !== stable(observed(after))) ||
      target.record.context.source_attribution.origin !== next.context.source_attribution.origin;
    const changedSource = stable(sourceAnchors(target.record)) !== stable(sourceAnchors(next));
    const proposal = stale || humanProtected || distinctContext || featureRevision || changedSource;
    const updated = clone(next); updated.record_id = target.record.record_id;
    updated.review_status = next.review_status === 'needs_context' ? 'needs_context' : 'pending';
    updated.review_events = []; updated.handoff_status = 'candidate_only';
    const relationship = proposal ? 'proposed_update' as const : 'context_update' as const;
    updated.duplicate_and_conflict_links = [...updated.duplicate_and_conflict_links, { record_id: target.record.record_id, relationship }];
    result.action = proposal ? 'proposed_update' : 'new_version'; result.record = updated;
    result.expected_version = target.version; result.target_record_id = target.record.record_id; result.related_record_ids = [target.record.record_id];
    if (stale) result.issues.push('expected_version_mismatch_preserve_proposal');
    if (humanProtected) result.issues.push('human_version_protected');
    if (distinctContext) result.issues.push('distinct_source_context_requires_review_proposal');
    if (featureRevision) result.issues.push('feature_revision_requires_review');
    if (changedSource) result.issues.push('changed_source_anchors_requires_review_proposal');
    result.changes = [{ kind: proposal ? 'append_proposal' : 'append_version', record_id: target.record.record_id,
      expected_version: target.version, record: updated }];
    return result;
  }
  const changes: ReconciliationChange[] = [];
  const links: EvidenceRecord['duplicate_and_conflict_links'] = [];
  const strictSourceKey = strictSourceGroupKey(next);
  for (const previous of versions.filter(v => featureKey(v.record) === featureKey(next) || strictSourceGroupKey(v.record) === strictSourceKey)) {
    const sameStrictSource = strictSourceGroupKey(previous.record) === strictSourceKey;
    const sameCondition = conditionKey(previous.record) === conditionKey(next);
    const sameQuote = previous.record.original_quote === next.original_quote;
    let relationship: EvidenceRecord['duplicate_and_conflict_links'][number]['relationship'] | null = null;
    if (sameStrictSource) {
      const attributionConflict = sourceAttributionKey(previous.record) !== sourceAttributionKey(next);
      relationship = attributionConflict ? 'possible_conflict' : 'duplicate';
      result.issues.push(`${attributionConflict ? 'strict_same_source_attribution_conflict' : 'strict_same_source_duplicate'}:${previous.record.record_id}`);
    } else if (sameQuote && sameCondition && previous.record.assertion.value === next.assertion.value &&
      previous.record.assertion.original_wording === next.assertion.original_wording) relationship = 'duplicate';
    else if (sameCondition && new Set([previous.record.assertion.value, next.assertion.value]).size === 2 &&
      [previous.record.assertion.value, next.assertion.value].every(v => v === 'affirmed' || v === 'negated')) relationship = 'conflict';
    else if (sameCondition && previous.record.numeric_expressions.length && next.numeric_expressions.length &&
      stable(previous.record.numeric_expressions.map(n => [n.original_text, n.unit_original])) !== stable(next.numeric_expressions.map(n => [n.original_text, n.unit_original]))) relationship = 'possible_conflict';
    else if (sameQuote && !sameCondition) {
      // Same words with different lesions, modalities, phases or conditions remain separate evidence.
      result.issues.push(`same_quote_distinct_context:${previous.record.record_id}`);
    }
    if (!relationship) continue;
    links.push({ record_id: previous.record.record_id, relationship });
    changes.push({ kind: 'link', record_id: previous.record.record_id, expected_version: previous.version,
      related_record_id: next.record_id, relationship });
    result.related_record_ids.push(previous.record.record_id);
    if (relationship === 'conflict' || relationship === 'possible_conflict') result.action = 'conflict';
    else if (result.action !== 'conflict') result.action = 'duplicate_link';
  }
  next.duplicate_and_conflict_links = [...next.duplicate_and_conflict_links, ...links];
  if (result.action === 'conflict') {
    next.review_status = 'needs_context'; next.context.status = 'needs_context';
    next.evidence_validation.automatic_checks.status = 'requires_review';
    if (!next.evidence_validation.warnings.includes('same_document_conflict_requires_review')) {
      next.evidence_validation.warnings.push('same_document_conflict_requires_review');
      next.evidence_validation.issues.push({ code: 'same_document_conflict_requires_review', severity: 'requires_review',
        path: 'duplicate_and_conflict_links', detail: 'Both source statements are retained; no conflict is automatically resolved.' });
    }
  }
  // A content-ID collision is never permission to overwrite an existing version.
  if (latest.has(next.record_id)) {
    result.issues.push('record_id_collision_preserve_separate_candidate');
    next.record_id = `${next.record_id.slice(0, 145)}-${fingerprint.slice(0, 12)}`;
    for (const change of changes) change.related_record_id = next.record_id;
  }
  result.record = next;
  result.changes = [{ kind: 'insert', record_id: next.record_id, expected_version: null, record: next }, ...changes];
  return result;
}
