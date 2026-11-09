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
  native_heading_level: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  source_regions: Type.Optional(Type.Array(Type.Object({ provenance_index: Type.Integer({ minimum: 0 }),
    source_segments: Type.Array(SourceSegmentSchema), mapping_status: Type.Enum(['exact', 'normalized_alignment', 'partial', 'unmapped', 'ambiguous', 'not_text']) }, closed))),
  native_inline_spans: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  mapping: Type.Object({ status: Type.Enum(['exact', 'normalized_alignment', 'partial', 'unmapped', 'ambiguous', 'not_text']),
    method: Type.Enum(['geometry_and_nfkd_whitespace_hyphen_alignment_1', 'geometry_and_nfkd_whitespace_hyphen_alignment_2', 'geometry_and_nfkd_whitespace_hyphen_alignment_3', 'geometry_and_nfkd_whitespace_hyphen_alignment_4']),
    matched_native_code_points: Type.Integer({ minimum: 0 }), alignable_native_code_points: Type.Integer({ minimum: 0 }),
    transformations: Type.Array(Type.String()), warnings: Type.Array(Type.String()),
    native_provenance_partitioned: Type.Optional(Type.Boolean()) }, closed),
}, closed);
export type StructureUnit = Static<typeof StructureUnitSchema>;
const cell = Type.Object({ unit_id: id, row_start: Type.Integer({ minimum: 0 }), row_end: Type.Integer({ minimum: 1 }),
  col_start: Type.Integer({ minimum: 0 }), col_end: Type.Integer({ minimum: 1 }),
  row_span: Type.Integer({ minimum: 1 }), col_span: Type.Integer({ minimum: 1 }),
  column_header: Type.Boolean(), row_header: Type.Boolean(), row_section: Type.Boolean() }, closed);
const gridBase = { method: Type.String(), source_pdf_sha256: hash, text_version: id, issue_codes: Type.Array(Type.String()), human_approved: Type.Literal(false) };
export const SourceGridSchema = Type.Union([
  Type.Object({ ...gridBase, status: Type.Literal('unresolved') }, closed),
  Type.Object({ ...gridBase, status: Type.Enum(['geometry_checked', 'source_conflict']), grid_id: id,
    n_rows: Type.Integer({ minimum: 1 }), n_cols: Type.Integer({ minimum: 1 }), header_rows: Type.Integer({ minimum: 0 }),
    logical_header_rows: Type.Integer({ minimum: 1 }), region_bbox: box, native_region_bbox: box, region_basis: Type.String(),
    caption_status: Type.Enum(['geometry_checked_numbered_title', 'unresolved']), caption_number: Type.Union([Type.String(), Type.Null()]),
    caption_segments: Type.Array(SourceSegmentSchema),
    column_bounds: Type.Array(Type.Number()), row_bounds: Type.Array(Type.Number()), physical_page: Type.Integer({ minimum: 1 }),
    cells: Type.Array(Type.Object({ cell_id: id, row_start: Type.Integer({ minimum: 0 }), row_end: Type.Integer({ minimum: 1 }),
      col_start: Type.Integer({ minimum: 0 }), col_end: Type.Integer({ minimum: 1 }), row_span: Type.Integer({ minimum: 1 }), col_span: Type.Integer({ minimum: 1 }),
      physical_page: Type.Integer({ minimum: 1 }), bbox: box, role: Type.Enum(['column_header', 'data', 'row_group_label']), span_basis: Type.String(),
      status: Type.Enum(['geometry_checked', 'blank_geometry_checked', 'source_conflict']), source_segments: Type.Array(SourceSegmentSchema),
      column_header_ids: ids, row_group_cell_id: Type.Union([id, Type.Null()]) }, closed)),
    footnote_segments: Type.Array(SourceSegmentSchema),
    verification: Type.Object({ raw_nonspace_codepoints: Type.Integer({ minimum: 0 }), covered_nonspace_codepoints: Type.Integer({ minimum: 0 }),
      all_cells_independently_checked: Type.Boolean(), grid_slots_covered_once: Type.Boolean(), column_rule_witness_count: Type.Integer({ minimum: 0 }),
      literal_values_not_imputed: Type.Literal(true) }, closed),
  }, closed),
]);
const continuationBase = { from_unit_id: id, to_unit_id: id, boundary: Type.Enum(['physical_page', 'column']),
  source_type: Type.Enum(['body', 'figure_caption']), ordered_segments: Type.Array(SourceSegmentSchema), proof_codes: Type.Array(Type.String()), human_approved: Type.Literal(false) };

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
    organization: Type.Optional(Type.Object({ version: Type.Literal('pdf-organization-1'), native_order_preserved: Type.Literal(true),
      heading_paths: Type.Array(Type.Object({ unit_id: id, native_level: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        printed_number: Type.Union([Type.String(), Type.Null()]), inferred_level: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        parent_unit_id: Type.Union([id, Type.Null()]), status: Type.Enum(['numbering_inferred', 'native_unverified']),
        role: Type.Enum(['metadata', 'numbered_section', 'native_heading']) }, closed)),
      paragraph_continuations: Type.Array(Type.Object({ from_unit_id: id, to_unit_id: id, boundary: Type.Enum(['physical_page', 'column']),
        status: Type.Literal('candidate_unverified'), reason_codes: Type.Array(Type.String()) }, closed)),
      continuation_recovery: Type.Optional(Type.Object({ method: Type.String(),
        relations: Type.Array(Type.Object({ ...continuationBase, relation_id: id, status: Type.Literal('engineering_checked'), proof_method: Type.String() }, closed)),
        unresolved: Type.Array(Type.Object({ ...continuationBase, status: Type.Literal('needs_user_review'), reason: Type.String() }, closed)),
        paragraph_indent_witness_unit_ids: ids }, closed)),
    }, closed)),
    tables: Type.Array(Type.Object({ table_id: id, native_ref: Type.String(), physical_pages: pageIds,
      caption_unit_ids: ids, footnote_unit_ids: ids, association_basis: Type.Enum(['native_explicit', 'geometric_heuristic_unverified', 'none']),
      n_rows: Type.Integer({ minimum: 0 }), n_cols: Type.Integer({ minimum: 0 }), cells: Type.Array(cell),
      native_html: Type.Union([Type.String(), Type.Null()]), cross_page_continuation: Type.Enum(['not_assumed', 'native_flag_unverified']),
      native_continues_previous: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      source_layout: Type.Optional(Type.Object({ status: Type.Enum(['source_conflict', 'requires_review', 'native_unverified']),
        issue_codes: Type.Array(Type.String()), source_rows: Type.Array(Type.Object({ physical_page: Type.Integer({ minimum: 1 }), bbox: box,
          source_segments: Type.Array(SourceSegmentSchema) }, closed)), row_basis: Type.Literal('decoded_baselines_not_semantic_rows'),
        header_paths: Type.Array(Type.Object({ cell_unit_id: id, parent_cell_unit_ids: ids, status: Type.Literal('native_grid_unverified') }, closed)),
        support_semantics: Type.Enum(['blocked_due_to_structure_conflict', 'unverified']) }, closed)),
      source_grid: Type.Optional(SourceGridSchema),
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
