import { Type, type Static } from 'typebox';
import { ScopeSchema } from '@t1/contracts';

const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 200 });
const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([id, Type.Null()]);
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
const nullableSha = Type.Union([sha, Type.Null()]);
const nullableCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const ids = Type.Array(id, { uniqueItems: true });

export const ReviewSchema = Type.Object({
  status: Type.Enum(['pending', 'approved', 'fixture']),
  reviewer: nullableText, reviewed_at: nullableText, rationale: text,
}, closed);
export const ScopeReviewSchema = Type.Object({
  ...ReviewSchema.properties, in_scope: Type.Union([Type.Boolean(), Type.Null()]),
}, closed);
export const EvidenceSegmentSchema = Type.Object({
  physical_page: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  printed_page_label: nullableText, quote: text,
  block_id: nullableText, text_version: nullableText,
  start: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  end: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  offset_unit: Type.Literal('unicode_code_point'),
}, closed);
const segments = Type.Array(EvidenceSegmentSchema, { minItems: 1 });
export const ClaimSchema = Type.Object({
  feature_name_raw: id,
  assertion: Type.Enum(['affirmed', 'negated', 'uncertain', 'conditional', 'comparison', 'unknown']),
  evidence_type: Type.Enum(['definition', 'observation', 'quoted_prior_work', 'unknown']),
  cancer_label: nullableText, modality_label: nullableText, sequence_or_phase: nullableText,
  conditions: Type.Array(text),
  numeric_expressions: Type.Array(Type.Object({ original_text: id, unit_original: nullableText }, closed)),
}, closed);
const evidence = {
  fixture: Type.Boolean(), claim: ClaimSchema, segments,
  necessary_context_segments: Type.Array(EvidenceSegmentSchema), scope_review: ScopeReviewSchema,
};
export const GoldUnitSchema = Type.Object({ unit_id: id, ...evidence }, closed);
export const PredictionSchema = Type.Object({ prediction_id: id, ...evidence }, closed);
export const MatchEdgeSchema = Type.Object({
  prediction_id: id, gold_unit_id: id, decision: Type.Enum(['match', 'no_match']),
  basis: Type.Enum(['human_evidence_unit_identity', 'human_semantic_equivalence', 'synthetic_fixture']),
  rationale: id, review: ReviewSchema,
  context_checks: Type.Object({
    quote_faithful: Type.Boolean(), scope_correct: Type.Boolean(), assertion_preserved: Type.Boolean(),
    conditions_preserved: Type.Boolean(), units_preserved: Type.Boolean(), cancer_modality_supported: Type.Boolean(),
  }, closed),
}, closed);
export const EvaluationDocumentSchema = Type.Object({
  document_id: id, article_family_id: id, fixture: Type.Boolean(),
  source_manifest_id: nullableText, file_sha256: nullableSha,
  strata: Type.Object({ language: id, cancer_tag: id, modality_tag: id, layout_tag: id }, closed),
  annotation: Type.Object({
    status: Type.Enum(['pending', 'complete', 'fixture']), full_text_read: Type.Boolean(),
    independent_of_predictions: Type.Boolean(), annotator: nullableText, completed_at: nullableText,
    coverage: Type.Object({
      all_physical_pages_checked: Type.Boolean(), expected_page_count: nullableCount,
      checked_physical_pages: Type.Array(Type.Integer({ minimum: 1 }), { uniqueItems: true }),
    }, closed),
    medical_review: ReviewSchema,
  }, closed),
  prediction_run: Type.Object({ run_id: id, state: Type.Enum(['completed', 'partial', 'failed', 'cancelled', 'interrupted']) }, closed),
  gold_units: Type.Array(GoldUnitSchema), predictions: Type.Array(PredictionSchema),
  adjudication: Type.Object({
    review: ReviewSchema, all_predictions_reviewed: Type.Boolean(), all_gold_reviewed: Type.Boolean(),
    all_candidate_pairs_reviewed: Type.Boolean(), edges: Type.Array(MatchEdgeSchema),
  }, closed),
}, closed);
export const EvaluationInputSchema = Type.Object({
  schema_version: Type.Literal('s2-evaluation-1'), dataset_id: id,
  fixture: Type.Boolean(), purpose: Type.Enum(['fixture_verification', 'development_measurement', 'independent_acceptance']),
  rule_version: Type.Literal('s2-scoring-draft-1'), rules_status: Type.Enum(['pending_confirmation', 'approved']),
  gold_version: id, scope: ScopeSchema, documents: Type.Array(EvaluationDocumentSchema),
}, closed);
export type EvaluationInput = Static<typeof EvaluationInputSchema>;
export type EvaluationDocument = Static<typeof EvaluationDocumentSchema>;
export type GoldUnit = Static<typeof GoldUnitSchema>;
export type Prediction = Static<typeof PredictionSchema>;
export type EvidenceSegment = Static<typeof EvidenceSegmentSchema>;
export type Review = Static<typeof ReviewSchema>;

const pendingTag = Type.Object({
  label: nullableText, basis: Type.Enum(['historical_source_topic', 'title_only', 'unknown']),
  status: Type.Literal('pending_medical_review'),
}, closed);
export const SourceRecordSchema = Type.Object({
  source_id: id, historical_aliases: ids,
  title: id, doi: nullableText, reliable_identifier: id, source_urls: Type.Array(id, { minItems: 1 }),
  language: Type.Enum(['zh', 'en', 'unknown']), document_type: nullableText,
  source_topic: nullableText, cancer_inclusion_tag: pendingTag, modality_tag: pendingTag,
  article_family_id: id, family_review_status: Type.Enum(['same_doi_linked_other_overlap_pending', 'pending']),
  publication_version: nullableText, version_review_status: Type.Literal('pending_full_text_check'),
  permission: Type.Object({
    license: nullableText, status: Type.Enum(['publisher_license_verified_by_main_session', 'unknown']),
    evidence_url: nullableText, redistribution: Type.Enum(['per_license_requirements', 'not_established']),
  }, closed),
  publisher_verification: Type.Object({
    status: Type.Enum(['not_rechecked', 'metadata_checked_by_main_session']), checked_date: nullableText,
    publication_date: nullableText, publication_year: nullableCount, url: nullableText,
    reported_pdf_pages: nullableCount, medical_review_completed: Type.Literal(false),
  }, closed),
  access: Type.Object({
    status: id, file_verified: Type.Boolean(), local_path: nullableText, sha256: nullableSha,
    bytes: nullableCount, retrieved_at: nullableText, page_count_method: nullableText,
  }, closed),
  current_composition: Type.Object({
    physical_pages: nullableCount, body_pages: nullableCount, reference_pages: nullableCount,
    figure_table_pages: nullableCount, appendix_pages: nullableCount, separate_supplement_pages: nullableCount,
    mixed_pages: Type.Union([Type.Array(Type.Integer({ minimum: 1 })), Type.Null()]),
    layout: nullableText, text_layer_status: Type.Literal('not_verified'),
  }, closed),
  historical_observations: Type.Array(Type.Object({
    source_pointer: id, checked_date: nullableText, recorded_sha256: nullableSha,
    recorded_pdf_pages: nullableCount, recorded_bytes: nullableCount, notes: id,
  }, closed)),
  exposure: Type.Object({
    used_in_prior_research: Type.Literal(true), uses: ids, full_text_human_read_status: Type.Literal('not_established_by_this_package'),
    independent_acceptance_eligible: Type.Literal(false),
  }, closed),
  allocation: Type.Object({ role: Type.Enum(['reference', 'development_candidate']), split_status: Type.Literal('not_sealed'), final_split: Type.Null(), selection_reason: id }, closed),
  annotation_status: Type.Literal('pending'), medical_review_status: Type.Literal('pending'),
}, closed);
export const SourceManifestSchema = Type.Object({
  schema_version: Type.Literal('s2-sources-1'), manifest_version: id, created_at: id,
  independent_acceptance_source_count: Type.Literal(0), formal_sample_count: Type.Null(),
  sources: Type.Array(SourceRecordSchema),
}, closed);
export type SourceManifest = Static<typeof SourceManifestSchema>;
export const SplitManifestSchema = Type.Object({
  schema_version: Type.Literal('s2-splits-1'), status: Type.Literal('draft_pending_human_confirmation'),
  formal_sample_count: Type.Null(), assignments: Type.Array(Type.Object({
    article_family_id: id, source_ids: ids,
    split: Type.Enum(['reference', 'development', 'regression', 'independent_acceptance', 'unassigned']),
    status: Type.Enum(['candidate_only', 'sealed']), reason: id,
  }, closed)),
  acceptance_seal: Type.Object({ status: Type.Literal('not_prepared'), source_ids: Type.Array(id, { maxItems: 0 }), sealed_by: Type.Null(), sealed_at: Type.Null() }, closed),
  coverage_directions: Type.Array(id),
}, closed);
export type SplitManifest = Static<typeof SplitManifestSchema>;
