import { Type, type Static } from 'typebox';
import type { DocumentIR, RunInput, Scope } from './index.js';

const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 200 });
const text = Type.String();
const nullableText = Type.Union([text, Type.Null()]);
const ids = Type.Array(id, { uniqueItems: true });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const box = Type.Array(Type.Number(), { minItems: 4, maxItems: 4 });
const selection = Type.Object({ mode: Type.Enum(['all', 'selected']), ids }, closed);
const scopeSchema = Type.Object({ scope_version: Type.Literal('1'), cancers: selection, image_types: selection,
  features: Type.Object({ mode: Type.Enum(['all', 'selected']), binding_ids: ids }, closed),
  catalog_version: id, matching_policy_version: id }, closed);

/** A model supplies text, never character offsets. occurrence is zero based, and mandatory for repeated text. */
export const EvidenceFragmentSchema = Type.Object({ block_id: id, exact_quote: Type.String({ minLength: 1 }),
  occurrence: Type.Optional(Type.Integer({ minimum: 0 })) }, closed);
export type EvidenceFragment = Static<typeof EvidenceFragmentSchema>;
const fragments = Type.Array(EvidenceFragmentSchema);
export const SourceBindingSchema = Type.Object({ task_id: id, run_id: id, document_id: id, file_sha256: hash,
  source_version: id, text_version: id }, closed);
export type SourceBinding = Static<typeof SourceBindingSchema>;
const observationInput = Type.Object({ value: nullableText, status: Type.Enum(['unknown', 'source_observed']), evidence: fragments }, closed);
export const StructureReferenceSchema = Type.Object({ kind: Type.Enum(['table', 'picture', 'unit']), id,
  relationship_used: Type.Boolean() }, closed);
export const EvidenceSubmissionSchema = Type.Object({
  binding: SourceBindingSchema,
  source_fragments: Type.Array(EvidenceFragmentSchema, { minItems: 1, maxItems: 64 }),
  context_fragments: Type.Array(EvidenceFragmentSchema, { maxItems: 128 }), display_joiner: Type.String({ maxLength: 8 }),
  feature_binding_id: Type.Union([id, Type.Null()]), feature_name_raw: nullableText, feature_category: id,
  evidence_type: Type.Enum(['feature_mention', 'definition', 'imaging_observation', 'interpretive_condition', 'association_conclusion']),
  disease_or_lesion: observationInput, modality: observationInput,
  sequence_or_phase: Type.Union([observationInput, Type.Null()]),
  assertion: Type.Object({ value: Type.Enum(['affirmed', 'negated', 'uncertain', 'conditional', 'comparative', 'unknown']),
    original_wording: text, evidence: fragments }, closed),
  applicability: Type.Object({ status: Type.Enum(['specified', 'unknown']), original_wording: text, evidence: fragments }, closed),
  numeric_expressions: Type.Array(Type.Object({ original_text: Type.String({ minLength: 1 }), unit_original: nullableText, evidence: fragments }, closed)),
  provenance: Type.Object({ origin: Type.Enum(['study_authors', 'cited_research', 'background_definition', 'unclear']),
    cited_references: Type.Array(text), evidence: fragments }, closed),
  translation_zh: nullableText,
  structure_references: Type.Optional(Type.Array(StructureReferenceSchema)),
  updates_record_id: Type.Optional(id),
}, closed);
export type EvidenceSubmission = Static<typeof EvidenceSubmissionSchema>;
export const ExtractionSubmissionSchema = EvidenceSubmissionSchema;
export type ExtractionSubmission = EvidenceSubmission;

export const CatalogApprovalSchema = Type.Enum(['approved', 'development_only', 'unavailable']);
const synonym = Type.Object({ text: Type.String({ minLength: 1 }), source: Type.String({ minLength: 1 }),
  approval_status: CatalogApprovalSchema }, closed);
const namedEntry = { id, name: Type.String({ minLength: 1 }), synonyms: Type.Array(synonym),
  source: text, approval_status: CatalogApprovalSchema };
/** This is separate from the S1 demo Catalog. A draft never becomes approved by conversion. */
export const EvidenceCatalogSchema = Type.Object({
  catalog_version: id, status: CatalogApprovalSchema, fixture: Type.Boolean(),
  cancers: Type.Array(Type.Object(namedEntry, closed)),
  image_types: Type.Array(Type.Object({ ...namedEntry, cancer_ids: ids }, closed)),
  features: Type.Array(Type.Object({ feature_id: id, name: Type.String({ minLength: 1 }), synonyms: Type.Array(synonym),
    category: id, source: text, version: id, approval_status: CatalogApprovalSchema }, closed)),
  bindings: Type.Array(Type.Object({ binding_id: id, feature_id: id, cancer_ids: ids, image_type_ids: ids,
    sequence_or_phase_conditions: Type.Array(text), source: text, version: id, approval_status: CatalogApprovalSchema }, closed)),
}, closed);
export type EvidenceCatalog = Static<typeof EvidenceCatalogSchema>;

export const ValidationIssueSchema = Type.Object({ code: id, severity: Type.Enum(['reject', 'requires_review', 'info']),
  path: text, detail: text }, closed);
export type ValidationIssue = Static<typeof ValidationIssueSchema>;
export const ScopeMatchSchema = Type.Object({ status: Type.Enum(['in_scope', 'out_of_scope', 'needs_context', 'blocked']),
  matched_binding_id: Type.Union([id, Type.Null()]), feature_match: Type.Enum(['canonical', 'synonym', 'new_term', 'none']),
  development_catalog_used: Type.Boolean(),
  basis: Type.Array(Type.Object({ dimension: Type.Enum(['cancer', 'modality', 'feature', 'sequence_or_phase']),
    catalog_id: id, source_text: text, matched_term: text, kind: Type.Enum(['canonical', 'synonym']), source: text }, closed)),
  issues: Type.Array(text) }, closed);
export type ScopeMatch = Static<typeof ScopeMatchSchema>;

export const LocatedEvidenceFragmentSchema = Type.Object({ block_id: id, text_version: id,
  start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }), exact_quote: Type.String({ minLength: 1 }),
  occurrence: Type.Integer({ minimum: 0 }), physical_page: Type.Integer({ minimum: 1 }), bbox: box,
  location_precision: Type.Literal('whole_textline_not_exact_glyph') }, closed);
export type LocatedEvidenceFragment = Static<typeof LocatedEvidenceFragmentSchema>;
const located = Type.Array(LocatedEvidenceFragmentSchema);
const observation = Type.Object({ value: nullableText, status: Type.Enum(['unknown', 'source_observed']), evidence: located }, closed);
const sourceVersion = Type.Object({ file_sha256: hash, source_kind: id, version: id, obtained_at: text }, closed);
export const BibliographicIdentitySchema = Type.Object({ title: nullableText, authors: Type.Array(text), venue: nullableText,
  year: Type.Union([Type.Integer(), Type.Null()]), doi: nullableText, pmid: nullableText, identity_status: id }, closed);
export type BibliographicIdentity = Static<typeof BibliographicIdentitySchema>;

/** The 28 CSV fields remain the record's only top-level fields. Version/CAS metadata belongs in a store envelope. */
export const EvidenceRecordSchema = Type.Object({
  record_id: id, document_id: id, article_family_id: id, bibliographic_identity: BibliographicIdentitySchema,
  source_version: sourceVersion, document_access: Type.Enum(['full_text', 'abstract_only', 'unavailable']),
  source_location: Type.Object({ kind: Type.Literal('pdf_textline'), physical_page: Type.Integer({ minimum: 1 }), block_id: id, bbox: box,
    location_precision: Type.Literal('whole_textline_not_exact_glyph'),
    locations: Type.Array(Type.Object({ block_id: id, physical_page: Type.Integer({ minimum: 1 }), bbox: box,
      location_precision: Type.Literal('whole_textline_not_exact_glyph') }, closed), { minItems: 1 }) }, closed),
  text_version: id, original_quote: Type.String({ minLength: 1 }),
  quote_span: Type.Object({ unit: Type.Literal('unicode_code_point'), interval: Type.Literal('[start,end)'),
    segments: Type.Array(LocatedEvidenceFragmentSchema, { minItems: 1 }), display_joiner: Type.String({ maxLength: 8 }),
    quote_kind: Type.Enum(['single_source_segment', 'display_composite_of_source_segments']), contiguous_source_quote: Type.Boolean() }, closed),
  context: Type.Object({ before: text, after: text, status: Type.Enum(['provided', 'needs_context']), fragments: located,
    source_attribution: Type.Object({ origin: EvidenceSubmissionSchema.properties.provenance.properties.origin,
      cited_references: Type.Array(text), evidence: located }, closed),
    structure_references: Type.Array(StructureReferenceSchema), article_scope_status: Type.Enum(['within_provided_scope', 'uncertain']) }, closed),
  disease_or_lesion: observation, modality: observation, sequence_or_phase: Type.Union([observation, Type.Null()]),
  feature_name_raw: nullableText, feature_category: id, evidence_type: EvidenceSubmissionSchema.properties.evidence_type,
  assertion: Type.Object({ value: EvidenceSubmissionSchema.properties.assertion.properties.value, original_wording: text, evidence: located }, closed),
  applicability: Type.Object({ status: Type.Enum(['specified', 'unknown']), original_wording: text, evidence: located }, closed),
  numeric_expressions: Type.Array(Type.Object({ original_text: text, unit_original: nullableText, evidence: located }, closed)),
  normalized_terms: Type.Array(Type.Object({ feature_id: id, binding_id: id, basis: text, source: text,
    approval_status: CatalogApprovalSchema }, closed)), translation_zh: nullableText,
  evidence_validation: Type.Object({ quote_located: Type.Literal(true), method: Type.Literal('exact_source_blocks_code_points_v1'),
    automatic_checks: Type.Object({ status: Type.Enum(['passed', 'requires_review']), checks: Type.Array(text) }, closed),
    medical_semantics_verified: Type.Literal(false),
    model_semantic_review: Type.Object({ status: Type.Enum(['not_performed', 'reviewed_unapproved']), model_id: nullableText, issue_codes: Type.Array(text) }, closed),
    human_approval: Type.Literal('not_performed'), warnings: Type.Array(text), issues: Type.Array(ValidationIssueSchema), scope_match: ScopeMatchSchema }, closed),
  duplicate_and_conflict_links: Type.Array(Type.Object({ record_id: id, relationship: Type.Enum(['duplicate', 'possible_duplicate', 'conflict', 'possible_conflict', 'context_update', 'updates', 'proposed_update']) }, closed)),
  extraction_trace: Type.Object({ task_id: id, run_id: id, fixture: Type.Boolean(), evidence_kind: Type.Enum(['engineering_fixture', 'real_paper']),
    scope: scopeSchema, catalog_version: id, catalog_status: CatalogApprovalSchema, development_catalog_used: Type.Boolean(),
    matching_policy_version: id, rule_version: id, pi_version: id, provider: id, model_id: id, parser_id: id, parser_version: id,
    read_block_ids: ids, provided_block_ids: ids, tool_call_ids: ids, source_binding: SourceBindingSchema,
    updates_record_id: Type.Union([id, Type.Null()]) }, closed),
  review_status: Type.Enum(['pending', 'approved', 'rejected', 'needs_context']),
  review_events: Type.Array(Type.Object({ action: id, actor: id, timestamp: text, reason: text, version: Type.Integer({ minimum: 1 }) }, closed)),
  handoff_status: Type.Enum(['candidate_only', 'approved_for_T2']),
}, closed);
export type EvidenceRecord = Static<typeof EvidenceRecordSchema>;
export const ExtractionCandidateRecordSchema = EvidenceRecordSchema;
export type ExtractionCandidateRecord = EvidenceRecord;

export interface ProvidedEvidence {
  allowedBlockIds: readonly string[];
  readBlockIds: readonly string[];
  quarantinedBlockIds?: readonly string[];
}
export interface EvidenceValidationContext extends ProvidedEvidence {
  input: RunInput;
  document: Exclude<DocumentIR, { schema_version: '1' }>;
  catalog: EvidenceCatalog;
  toolCallId: string;
  metadata: {
    task_id: string;
    source_version: Static<typeof sourceVersion>;
    article_family_id: string;
    bibliographic_identity?: BibliographicIdentity;
    document_access?: 'full_text' | 'abstract_only' | 'unavailable';
    created_at: string;
  };
  allowDevelopmentCatalog?: boolean;
}
export interface EvidenceValidationResult {
  accepted: boolean;
  record: EvidenceRecord | null;
  issues: ValidationIssue[];
  scope_match: ScopeMatch;
}
export interface EvidenceVersion {
  record: EvidenceRecord;
  version: number;
  actor: 'automatic' | 'human';
  status?: 'active' | 'proposed';
}
export interface ReconciliationChange {
  kind: 'insert' | 'append_version' | 'append_proposal' | 'link';
  record_id: string;
  expected_version: number | null;
  record?: EvidenceRecord;
  related_record_id?: string;
  relationship?: EvidenceRecord['duplicate_and_conflict_links'][number]['relationship'];
}
export interface ReconciliationResult {
  action: 'insert' | 'idempotent' | 'duplicate_link' | 'new_version' | 'proposed_update' | 'conflict';
  changes: ReconciliationChange[];
  record: EvidenceRecord;
  expected_version: number | null;
  target_record_id: string | null;
  related_record_ids: string[];
  issues: string[];
}
export type EvidenceScope = Scope;
