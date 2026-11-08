import { Value } from 'typebox/value';
import { createHash } from 'node:crypto';
import { EvaluationInputSchema, type EvaluationInput, type EvaluationDocument, type Review, type EvidenceSegment } from './contracts.js';

export interface Counts { tp: number; fp: number; fn: number }
export interface Metrics extends Counts {
  precision: number | null; recall: number | null;
  precision_status: 'applicable' | 'not_applicable_zero_denominator';
  recall_status: 'applicable' | 'not_applicable_zero_denominator';
}
export interface DocumentScore extends Metrics {
  document_id: string; prediction_run_state: EvaluationDocument['prediction_run']['state'];
  human_reference_status: { annotation_status: string; full_text_read: boolean; independent_of_predictions: boolean; medical_review: Review; matching_review: Review };
  failed_or_incomplete: boolean; gold_in_scope: number; gold_out_of_scope_excluded: number;
  out_of_scope_predictions: string[]; unmatched_predictions: string[]; unmatched_gold_units: string[];
  matched_pairs: { prediction_id: string; gold_unit_id: string; basis: string; rationale: string; review: Review }[];
}
export interface EvaluationResult {
  schema_version: 's2-evaluation-result-1'; status: 'invalid_input' | 'not_evaluable' | 'fixture_scored' | 'real_scored';
  fixture: boolean | null; dataset_id: string | null; rule_version: string | null; gold_version: string | null;
  input_sha256: string; scope: EvaluationInput['scope'] | null; reasons: string[];
  input_hash_method: 'SHA256_of_JSON_stringify_parsed_input'; purpose: EvaluationInput['purpose'] | null; rules_status: EvaluationInput['rules_status'] | null;
  totals: Metrics | null; documents: DocumentScore[];
  by_stratum: { dimension: string; value: string; document_count: number; metrics: Metrics }[];
  official_acceptance: 'not_assessed'; stage_passed: null;
  semantic_matching: 'human_adjudicated_edges_only_no_string_or_model_inference';
}

export function metrics({ tp, fp, fn }: Counts): Metrics {
  return { tp, fp, fn, precision: tp + fp === 0 ? null : tp / (tp + fp), recall: tp + fn === 0 ? null : tp / (tp + fn),
    precision_status: tp + fp === 0 ? 'not_applicable_zero_denominator' : 'applicable',
    recall_status: tp + fn === 0 ? 'not_applicable_zero_denominator' : 'applicable' };
}
const reviewed = (r: Review, fixture: boolean) => fixture ? r.status === 'fixture'
  : r.status === 'approved' && r.reviewer !== null && r.reviewed_at !== null && Number.isFinite(Date.parse(r.reviewed_at));
const unique = (values: string[]) => new Set(values).size === values.length;

function segmentProblems(segment: EvidenceSegment, fixture: boolean): string[] {
  const issues: string[] = [];
  const hasStart = segment.start !== null, hasEnd = segment.end !== null;
  if (hasStart !== hasEnd || (hasStart && segment.end! <= segment.start!)) issues.push('invalid_segment_offsets');
  if (hasStart && (segment.block_id === null || segment.text_version === null)) issues.push('offset_mapping_missing');
  if (!fixture && segment.physical_page === null) issues.push('real_evidence_requires_physical_page');
  // Missing S3 block/offset mappings are allowed: S2 annotations refer directly to the original PDF.
  return issues;
}

function validateRelations(input: EvaluationInput): { invalid: string[]; pending: string[] } {
  const invalid: string[] = [], pending: string[] = [];
  if (!unique(input.documents.map(d => d.document_id))) invalid.push('duplicate_document_id');
  if (input.documents.length === 0) pending.push('no_documents_no_complete_human_gold');
  if (input.fixture !== (input.purpose === 'fixture_verification')) invalid.push('fixture_purpose_mismatch');
  if (!input.fixture && input.rules_status !== 'approved') pending.push('scoring_rules_pending_confirmation');
  if (input.purpose === 'independent_acceptance') pending.push('independent_acceptance_requires_sealed_corpus_and_frozen_thresholds_beyond_S2_preparation');
  for (const [level, part] of Object.entries(input.scope)) {
    if (typeof part === 'object' && part !== null && 'mode' in part) {
      const values = 'ids' in part ? part.ids : part.binding_ids;
      if ((part.mode === 'selected' && values.length === 0) || (part.mode === 'all' && values.length !== 0)) invalid.push(`invalid_scope_selection:${level}`);
    }
  }
  for (const d of input.documents) {
    const prefix = d.document_id + ':';
    if (d.fixture !== input.fixture || [...d.gold_units, ...d.predictions].some(u => u.fixture !== input.fixture)) invalid.push(prefix + 'mixed_real_and_fixture');
    if (!unique(d.gold_units.map(g => g.unit_id))) invalid.push(prefix + 'duplicate_gold_evidence_unit_id');
    if (!unique(d.predictions.map(p => p.prediction_id))) invalid.push(prefix + 'duplicate_prediction_record_id');
    if (!input.fixture) {
      if (d.file_sha256 === null || d.source_manifest_id === null) pending.push(prefix + 'original_file_identity_missing');
      const a = d.annotation;
      if (a.status !== 'complete' || !a.full_text_read || !a.independent_of_predictions || a.annotator === null || a.completed_at === null || !Number.isFinite(Date.parse(a.completed_at))) pending.push(prefix + 'independent_full_text_annotation_incomplete');
      const c = a.coverage;
      if (c.expected_page_count === null || c.expected_page_count === 0 || !c.all_physical_pages_checked
        || c.checked_physical_pages.length !== c.expected_page_count
        || c.checked_physical_pages.some(p => p > c.expected_page_count!)) pending.push(prefix + 'full_text_page_coverage_incomplete');
      if (!reviewed(a.medical_review, false)) pending.push(prefix + 'medical_gold_review_pending');
    } else if (d.annotation.status !== 'fixture' || !reviewed(d.annotation.medical_review, true)) invalid.push(prefix + 'fixture_annotation_labels_required');
    for (const unit of [...d.gold_units, ...d.predictions]) {
      const unitId = 'unit_id' in unit ? unit.unit_id : unit.prediction_id;
      if (!reviewed(unit.scope_review, input.fixture) || unit.scope_review.in_scope === null) pending.push(prefix + unitId + ':scope_adjudication_pending');
      for (const s of [...unit.segments, ...unit.necessary_context_segments]) {
        invalid.push(...segmentProblems(s, input.fixture).map(x => prefix + unitId + ':' + x));
        if (!input.fixture && s.physical_page !== null && d.annotation.coverage.expected_page_count !== null && s.physical_page > d.annotation.coverage.expected_page_count) invalid.push(prefix + unitId + ':evidence_page_outside_original');
      }
    }
    if (!reviewed(d.adjudication.review, input.fixture) || !d.adjudication.all_predictions_reviewed || !d.adjudication.all_gold_reviewed || !d.adjudication.all_candidate_pairs_reviewed) pending.push(prefix + 'matching_adjudication_incomplete');
    const edgeKeys = d.adjudication.edges.map(e => JSON.stringify([e.prediction_id, e.gold_unit_id]));
    if (!unique(edgeKeys)) invalid.push(prefix + 'duplicate_or_conflicting_match_edge');
    for (const e of d.adjudication.edges) {
      const p = d.predictions.find(p => p.prediction_id === e.prediction_id);
      const g = d.gold_units.find(g => g.unit_id === e.gold_unit_id);
      if (!p || !g) { invalid.push(prefix + 'match_edge_unknown_record'); continue; }
      if (!reviewed(e.review, input.fixture)) pending.push(prefix + 'match_edge_review_pending');
      if (input.fixture !== (e.basis === 'synthetic_fixture')) invalid.push(prefix + 'match_basis_fixture_mismatch');
      if (e.decision === 'match' && (!p.scope_review.in_scope || !g.scope_review.in_scope || Object.values(e.context_checks).some(v => !v))) invalid.push(prefix + 'match_edge_conflicts_with_scope_or_context');
    }
  }
  return { invalid: [...new Set(invalid)].sort(), pending: [...new Set(pending)].sort() };
}

/** Maximum cardinality bipartite matching. Sorted augmenting paths make tie breaking reproducible. */
export function maximumMatching(predictionIds: string[], edges: { prediction_id: string; gold_unit_id: string }[]): Map<string, string> {
  const adjacency = new Map<string, string[]>();
  for (const id of [...predictionIds].sort()) adjacency.set(id, [...new Set(edges.filter(e => e.prediction_id === id).map(e => e.gold_unit_id))].sort());
  const goldToPrediction = new Map<string, string>();
  const augment = (predictionId: string, visited: Set<string>): boolean => {
    for (const goldId of adjacency.get(predictionId) ?? []) {
      if (visited.has(goldId)) continue;
      visited.add(goldId);
      const previous = goldToPrediction.get(goldId);
      if (previous === undefined || augment(previous, visited)) { goldToPrediction.set(goldId, predictionId); return true; }
    }
    return false;
  };
  for (const id of [...predictionIds].sort()) augment(id, new Set());
  return new Map([...goldToPrediction.entries()].map(([goldId, predId]): [string, string] => [predId, goldId]).sort(([a], [b]) => a.localeCompare(b)));
}

function scoreDocument(d: EvaluationDocument): DocumentScore {
  const inGold = d.gold_units.filter(g => g.scope_review.in_scope);
  const predictions = d.predictions.filter(p => p.scope_review.in_scope);
  const matchEdges = d.adjudication.edges.filter(e => e.decision === 'match');
  const matched = maximumMatching(predictions.map(p => p.prediction_id), matchEdges);
  const goldMatched = new Set(matched.values());
  const unmatchedPredictions = d.predictions.map(p => p.prediction_id).filter(id => !matched.has(id)).sort();
  return {
    document_id: d.document_id, prediction_run_state: d.prediction_run.state,
    human_reference_status: { annotation_status: d.annotation.status, full_text_read: d.annotation.full_text_read,
      independent_of_predictions: d.annotation.independent_of_predictions, medical_review: structuredClone(d.annotation.medical_review),
      matching_review: structuredClone(d.adjudication.review) },
    failed_or_incomplete: d.prediction_run.state !== 'completed',
    ...metrics({ tp: matched.size, fp: unmatchedPredictions.length, fn: inGold.length - matched.size }),
    gold_in_scope: inGold.length, gold_out_of_scope_excluded: d.gold_units.length - inGold.length,
    out_of_scope_predictions: d.predictions.filter(p => !p.scope_review.in_scope).map(p => p.prediction_id).sort(),
    unmatched_predictions: unmatchedPredictions, unmatched_gold_units: inGold.map(g => g.unit_id).filter(id => !goldMatched.has(id)).sort(),
    matched_pairs: [...matched].map(([prediction_id, gold_unit_id]) => {
      const edge = matchEdges.find(e => e.prediction_id === prediction_id && e.gold_unit_id === gold_unit_id)!;
      return { prediction_id, gold_unit_id, basis: edge.basis, rationale: edge.rationale, review: edge.review };
    }),
  };
}

export function evaluate(input: unknown): EvaluationResult {
  const result: EvaluationResult = {
    schema_version: 's2-evaluation-result-1', status: 'invalid_input', fixture: null, dataset_id: null,
    rule_version: null, gold_version: null, input_sha256: createHash('sha256').update(JSON.stringify(input) ?? 'undefined').digest('hex'),
    input_hash_method: 'SHA256_of_JSON_stringify_parsed_input', purpose: null, rules_status: null,
    scope: null, reasons: [], totals: null, documents: [], by_stratum: [],
    official_acceptance: 'not_assessed', stage_passed: null,
    semantic_matching: 'human_adjudicated_edges_only_no_string_or_model_inference',
  };
  if (!Value.Check(EvaluationInputSchema, input)) { result.reasons = ['schema_validation_failed']; return result; }
  result.fixture = input.fixture; result.dataset_id = input.dataset_id; result.rule_version = input.rule_version;
  result.purpose = input.purpose; result.rules_status = input.rules_status;
  result.gold_version = input.gold_version; result.scope = structuredClone(input.scope);
  const { invalid, pending } = validateRelations(input);
  if (invalid.length) { result.reasons = invalid; return result; }
  if (pending.length) { result.status = 'not_evaluable'; result.reasons = pending; return result; }
  result.status = input.fixture ? 'fixture_scored' : 'real_scored';
  result.documents = input.documents.map(scoreDocument).sort((a, b) => a.document_id.localeCompare(b.document_id));
  const sum = (values: Counts[]) => metrics(values.reduce((a, b) => ({ tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn }), { tp: 0, fp: 0, fn: 0 }));
  result.totals = sum(result.documents);
  for (const dimension of ['language', 'cancer_tag', 'modality_tag', 'layout_tag'] as const) {
    const values = [...new Set(input.documents.map(d => d.strata[dimension]))].sort();
    for (const value of values) {
      const ids = new Set(input.documents.filter(d => d.strata[dimension] === value).map(d => d.document_id));
      const docs = result.documents.filter(d => ids.has(d.document_id));
      result.by_stratum.push({ dimension, value, document_count: docs.length, metrics: sum(docs) });
    }
  }
  return result;
}
