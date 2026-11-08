import { Type, type Static } from 'typebox';
import { BlockV2Schema, DocumentIRV2Schema } from './document-ir-v2.js';

const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 160 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const ids = Type.Array(id, { uniqueItems: true });
const box = Type.Array(Type.Number(), { minItems: 4, maxItems: 4 });
const pageIds = Type.Array(Type.Integer({ minimum: 1 }), { uniqueItems: true });
export const ParserCandidateSchema = Type.Enum(['docling-standard-cpu', 'mineru-basic-onnx-cpu']);
export type ParserCandidateId = Static<typeof ParserCandidateSchema>;
export const SourceSegmentSchema = Type.Object({ block_id: id, text_version: id,
  start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) }, closed);
export const NativeProvenanceSchema = Type.Object({
  physical_page: Type.Integer({ minimum: 1 }), bbox: Type.Union([box, Type.Null()]),
  coordinate_system: Type.Literal('crop_rotated_top_left_pt'), native_ref: Type.String(),
  native_bbox: Type.Record(Type.String(), Type.Unknown()), native_page_size: Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }),
  precision: Type.Enum(['native_element_bbox', 'native_table_cell_bbox', 'native_table_region_only']),
  native_charspan: Type.Union([Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 }), Type.Null()]),
}, closed);
export const StructureUnitSchema = Type.Object({
  unit_id: id, native_ref: Type.String(), kind: Type.Enum(['text', 'section_header', 'caption', 'table', 'table_cell', 'picture', 'footnote', 'list_item', 'other']),
  native_label: Type.String(), native_text: Type.String(), native_original_text: Type.Union([Type.String(), Type.Null()]),
  native_text_role: Type.Literal('processed_native_not_literal_quote'),
  content_layer: Type.String(), source_segments: Type.Array(SourceSegmentSchema), provenance: Type.Array(NativeProvenanceSchema),
  native_inline_spans: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  mapping: Type.Object({ status: Type.Enum(['exact', 'normalized_alignment', 'partial', 'unmapped', 'ambiguous', 'not_text']),
    method: Type.Enum(['geometry_and_nfkd_whitespace_hyphen_alignment_1', 'geometry_and_nfkd_whitespace_hyphen_alignment_2', 'geometry_and_nfkd_whitespace_hyphen_alignment_3']),
    matched_native_code_points: Type.Integer({ minimum: 0 }), alignable_native_code_points: Type.Integer({ minimum: 0 }),
    transformations: Type.Array(Type.String()), warnings: Type.Array(Type.String()),
    native_provenance_partitioned: Type.Optional(Type.Boolean()) }, closed),
}, closed);
export type StructureUnit = Static<typeof StructureUnitSchema>;
const cell = Type.Object({ unit_id: id, row_start: Type.Integer({ minimum: 0 }), row_end: Type.Integer({ minimum: 1 }),
  col_start: Type.Integer({ minimum: 0 }), col_end: Type.Integer({ minimum: 1 }),
  row_span: Type.Integer({ minimum: 1 }), col_span: Type.Integer({ minimum: 1 }),
  column_header: Type.Boolean(), row_header: Type.Boolean(), row_section: Type.Boolean() }, closed);

export const StructuredDocumentIRSchema = Type.Object({
  schema_version: Type.Literal('3'), document_id: id, file_sha256: hash, fixture: Type.Boolean(),
  evidence_kind: Type.Enum(['engineering_fixture', 'real_paper']), title: Type.Union([Type.String(), Type.Null()]),
  source: DocumentIRV2Schema.properties.source,
  parser: Type.Object({ id: ParserCandidateSchema, version: id, status: Type.Enum(['parsed', 'partial', 'unsupported']),
    config: Type.Record(Type.String(), Type.Unknown()), config_digest: hash }, closed),
  text_version: id, raw_text_version: id, offset_unit: Type.Literal('unicode_code_point'), offset_interval: Type.Literal('[start,end)'),
  normalization_version: Type.Literal('line-endings-only-1'), pages: DocumentIRV2Schema.properties.pages,
  blocks: Type.Array(BlockV2Schema),
  source_extraction: Type.Object({ parser_id: id, parser_version: id, config_digest: hash, text_version: id,
    raw_text_definition: Type.Literal('decoded_PDF_text_layer_no_native_structure_rewrite') }, closed),
  native_artifact: Type.Object({ path: Type.String(), sha256: hash, format: id }, closed),
  structure: Type.Object({ units: Type.Array(StructureUnitSchema), reading_order: ids, furniture_unit_ids: ids,
    hierarchy: Type.Array(Type.Object({ parent_ref: Type.String(), child_refs: Type.Array(Type.String()) }, closed)),
    tables: Type.Array(Type.Object({ table_id: id, native_ref: Type.String(), physical_pages: pageIds,
      caption_unit_ids: ids, footnote_unit_ids: ids, association_basis: Type.Enum(['native_explicit', 'geometric_heuristic_unverified', 'none']),
      n_rows: Type.Integer({ minimum: 0 }), n_cols: Type.Integer({ minimum: 0 }), cells: Type.Array(cell),
      native_html: Type.Union([Type.String(), Type.Null()]), cross_page_continuation: Type.Enum(['not_assumed', 'native_flag_unverified']),
      native_continues_previous: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      association_status: Type.Optional(Type.Enum(['native_unverified', 'conflict', 'none'])),
      association_issues: Type.Optional(Type.Array(Type.String())), usable_for_semantic_interpretation: Type.Optional(Type.Literal(false)),
      caption_relationships: Type.Optional(Type.Array(Type.Object({ unit_id: id, native_retained: Type.Literal(true),
        project_status: Type.Enum(['unverified', 'rejected_conflict']), reason: Type.String() }, closed))) }, closed)),
    pictures: Type.Array(Type.Object({ picture_id: id, native_ref: Type.String(), physical_pages: pageIds,
      caption_unit_ids: ids, footnote_unit_ids: ids, association_basis: Type.Enum(['native_explicit', 'geometric_heuristic_unverified', 'none']),
      association_status: Type.Optional(Type.Enum(['native_unverified', 'conflict', 'none'])),
      association_issues: Type.Optional(Type.Array(Type.String())), usable_for_semantic_interpretation: Type.Optional(Type.Literal(false)),
      caption_relationships: Type.Optional(Type.Array(Type.Object({ unit_id: id, native_retained: Type.Literal(true),
        project_status: Type.Enum(['unverified', 'rejected_conflict']), reason: Type.String() }, closed))) }, closed)),
    native_processed_text_is_authoritative_quote: Type.Literal(false), human_fidelity_verified: Type.Literal(false),
  }, closed),
  coverage: Type.Object({ ...DocumentIRV2Schema.properties.coverage.properties,
    scope: Type.Literal('raw_pdf_text_layer_with_candidate_structure'), native_pages: pageIds,
    native_errors: Type.Array(Type.Record(Type.String(), Type.Unknown())), unmapped_unit_ids: ids, ambiguous_unit_ids: ids,
    structure_verified_by_human: Type.Literal(false),
    table_structure: Type.Literal('native_candidate_output_unverified'), reading_order: Type.Literal('native_candidate_order_unverified'),
  }, closed),
  metrics: Type.Object({ source_anchor_seconds: Type.Number({ minimum: 0 }), native_seconds: Type.Number({ minimum: 0 }),
    mapping_seconds: Type.Number({ minimum: 0 }), total_seconds: Type.Number({ minimum: 0 }),
    native_metrics: Type.Record(Type.String(), Type.Unknown()), host_metrics: Type.Record(Type.String(), Type.Unknown()),
    remote_document_uploads: Type.Literal(0), llm_calls: Type.Literal(0) }, closed),
}, closed);
export const DocumentIRV3Schema = StructuredDocumentIRSchema;
export type StructuredDocumentIR = Static<typeof StructuredDocumentIRSchema>;
export const StructuredParserRequestSchema = Type.Object({
  run_id: id, document_id: id, file_reference: Type.String({ minLength: 1 }), file_sha256: hash,
  candidate_id: ParserCandidateSchema, fixture: Type.Optional(Type.Boolean()),
}, closed);
export type StructuredParserRequest = Static<typeof StructuredParserRequestSchema>;
export const StructuredParserResultSchema = Type.Object({ schema_version: Type.Literal('parser-result-2'), run_id: id,
  status: Type.Enum(['ok', 'partial', 'unsupported', 'error']), document: Type.Union([StructuredDocumentIRSchema, Type.Null()]),
  error: Type.Union([Type.Object({ code: id, message: Type.String(), retryable: Type.Boolean() }, closed), Type.Null()]) }, closed);
export type StructuredParserResult = Static<typeof StructuredParserResultSchema>;
