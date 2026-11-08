import { Type, type Static } from 'typebox';

const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 160 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const box = Type.Array(Type.Number(), { minItems: 4, maxItems: 4 });
const matrix = Type.Array(Type.Number(), { minItems: 6, maxItems: 6 });
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const pageIds = Type.Array(Type.Integer({ minimum: 1 }), { uniqueItems: true });
const ids = Type.Array(id, { uniqueItems: true });

export const NormalizationRunSchema = Type.Object({
  raw_start: Type.Integer({ minimum: 0 }), raw_end: Type.Integer({ minimum: 0 }),
  normalized_start: Type.Integer({ minimum: 0 }), normalized_end: Type.Integer({ minimum: 0 }),
  kind: Type.Enum(['identity', 'newline']),
}, closed);

export const PageGeometrySchema = Type.Object({
  width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }),
  rotation: Type.Enum([0, 90, 180, 270]), coordinate_unit: Type.Literal('pt'),
  coordinate_system: Type.Literal('crop_rotated_top_left'), pdf_user_unit: Type.Number({ exclusiveMinimum: 0 }),
  pdf_crop_box: box, pdf_media_box: box, backend_to_pdf: matrix, canonical_to_pdf: matrix,
  backend_coordinate_system: Type.Literal('docling_crop_rotated_bottom_left_pdf_user_units'),
  conversion_version: Type.Literal('docling-crop-rotation-userunit-1'),
}, closed);

export const SourceGeometrySchema = Type.Object({
  coordinate_system: Type.Literal('docling_crop_rotated_bottom_left_pdf_user_units'), bbox: box,
  polygon: Type.Array(Type.Number(), { minItems: 8, maxItems: 8 }), pdf_bbox: box,
  precision: Type.Literal('whole_textline_not_exact_glyph'),
}, closed);

export const BlockV2Schema = Type.Object({
  block_id: id, document_id: id, text_version: id, text: Type.String(), raw_text: Type.String(), backend_text: Type.String(),
  raw_text_source: Type.Literal('backend_cell_orig'), normalization_map: Type.Array(NormalizationRunSchema),
  page: Type.Integer({ minimum: 1 }), type: Type.Literal('text'), semantic_type_status: Type.Literal('unclassified_textline'),
  reading_order: Type.Integer({ minimum: 0 }), bbox: box, source_geometry: SourceGeometrySchema,
  backend_cell_index: Type.Integer({ minimum: 0 }),
}, closed);
export type BlockV2 = Static<typeof BlockV2Schema>;

const pageFailure = Type.Object({ physical_page: Type.Integer({ minimum: 1 }), code: id }, closed);
export const DocumentIRV2Schema = Type.Object({
  schema_version: Type.Literal('2'), document_id: id, file_sha256: hash,
  fixture: Type.Boolean(), evidence_kind: Type.Enum(['engineering_fixture', 'real_paper']),
  title: Type.Union([Type.String(), Type.Null()]),
  source: Type.Object({ file_reference: Type.String({ minLength: 1 }), bytes: Type.Integer({ minimum: 1 }), original_modified: Type.Literal(false) }, closed),
  parser: Type.Object({ id, version: id, status: Type.Enum(['parsed', 'partial', 'unsupported']),
    config: Type.Object({ adapter_version: id, adapter_sha256: hash, config_revision: id, normalization_version: id,
      do_sanitization: Type.Literal(false), keep_glyphs: Type.Literal(false), ocr_enabled: Type.Literal(false),
      table_reconstruction: Type.Literal(false), reading_order: Type.Literal('backend_textline_order_unverified'), metadata_backend: id }, closed),
    config_digest: hash,
  }, closed),
  text_version: id, raw_text_version: id, offset_unit: Type.Literal('unicode_code_point'), offset_interval: Type.Literal('[start,end)'),
  normalization_version: Type.Literal('line-endings-only-1'),
  pages: Type.Array(Type.Object({
    physical_page: Type.Integer({ minimum: 1 }), printed_label: Type.Null(), ocr: Type.Literal(false),
    width: nullableNumber, height: nullableNumber, rotation: Type.Number(), coordinate_unit: Type.Literal('pt'),
    geometry: Type.Union([PageGeometrySchema, Type.Null()]), backend_dimension: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    status: Type.Enum(['failed', 'text_layer_extracted_images_unverified', 'text_layer_extracted_fidelity_unverified', 'ocr_required_no_text_layer', 'blank_or_vector_page_unverified']),
    text_layer_present: Type.Boolean(), bitmap_count: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    ocr_requirement: Type.Enum(['unknown', 'possible_image_text_unverified', 'required', 'not_detected']),
    error: Type.Union([Type.Object({ code: id, exception_type: id }, closed), Type.Null()]), duration_seconds: Type.Number({ minimum: 0 }),
  }, closed), { minItems: 1 }),
  blocks: Type.Array(BlockV2Schema),
  coverage: Type.Object({
    expected_block_ids: ids, processed_block_ids: ids, failed_block_ids: ids,
    excluded: Type.Array(Type.Object({ block_id: id, reason: id }, closed)), scope: Type.Literal('emitted_text_layer_blocks_only'),
    physical_pages_expected: pageIds, decoded_pages: pageIds, text_layer_pages: pageIds, failed_pages: Type.Array(pageFailure),
    pages_without_text: pageIds, image_text_unverified_pages: pageIds, page_enumeration_complete: Type.Boolean(),
    text_layer_decode_complete: Type.Boolean(), full_content_coverage_verified: Type.Literal(false), fidelity_human_verified: Type.Literal(false),
    table_structure: Type.Literal('not_reconstructed'), reading_order: Type.Literal('backend_textline_order_unverified'), limitations: Type.Array(Type.String()),
  }, closed),
  metrics: Type.Object({
    file_check_seconds: Type.Number({ minimum: 0 }), backend_init_seconds: Type.Number({ minimum: 0 }),
    first_text_seconds: nullableNumber, total_seconds: Type.Number({ minimum: 0 }),
    cpu_user_seconds: Type.Number({ minimum: 0 }), cpu_system_seconds: Type.Number({ minimum: 0 }),
    peak_rss_bytes: Type.Integer({ minimum: 0 }), peak_rss_scope: Type.Literal('current_process_lifetime_linux_ru_maxrss'),
    gpu_peak_memory_bytes: Type.Null(), network_document_uploads: Type.Literal(0), llm_calls: Type.Literal(0),
  }, closed),
}, closed);
export type DocumentIRV2 = Static<typeof DocumentIRV2Schema>;

export const ParserRequestSchema = Type.Object({
  run_id: id, document_id: id, file_reference: Type.String({ minLength: 1 }), file_sha256: hash,
  fixture: Type.Optional(Type.Boolean()),
}, closed);
export type ParserRequest = Static<typeof ParserRequestSchema>;
export const ParserResultSchema = Type.Object({
  schema_version: Type.Literal('parser-result-1'), run_id: id,
  status: Type.Enum(['ok', 'partial', 'unsupported', 'error']), document: Type.Union([DocumentIRV2Schema, Type.Null()]),
  error: Type.Union([Type.Object({ code: id, message: Type.String(), retryable: Type.Boolean() }, closed), Type.Null()]),
}, closed);
export type ParserResult = Static<typeof ParserResultSchema>;

export function documentIRV2Issues(document: DocumentIRV2): string[] {
  const issues: string[] = [];
  const ids = document.blocks.map(b => b.block_id);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const pages = document.pages.map(p => p.physical_page);
  if (!same(pages, document.pages.map((_, i) => i + 1)) || !same(pages, document.coverage.physical_pages_expected)) issues.push('physical_page_enumeration_mismatch');
  if (new Set(ids).size !== ids.length || !same(ids, document.coverage.expected_block_ids) || !same(ids, document.coverage.processed_block_ids)) issues.push('block_coverage_mismatch');
  if (document.fixture !== (document.evidence_kind === 'engineering_fixture')) issues.push('fixture_evidence_mismatch');
  const validPages = new Set(document.pages.filter(p => p.status !== 'failed').map(p => p.physical_page));
  for (const [i, block] of document.blocks.entries()) {
    if (block.document_id !== document.document_id || block.text_version !== document.text_version || !validPages.has(block.page) || block.reading_order !== i) issues.push('block_binding_mismatch');
    const raw = Array.from(block.raw_text), normalized = Array.from(block.text);
    let rawEnd = 0, normalizedEnd = 0;
    for (const run of block.normalization_map) {
      const a = raw.slice(run.raw_start, run.raw_end).join(''), b = normalized.slice(run.normalized_start, run.normalized_end).join('');
      if (run.raw_start !== rawEnd || run.normalized_start !== normalizedEnd || run.raw_end <= run.raw_start || run.normalized_end <= run.normalized_start ||
        (run.kind === 'identity' ? a !== b || a.includes('\r') : !['\r', '\r\n'].includes(a) || b !== '\n')) issues.push('normalization_map_mismatch');
      rawEnd = run.raw_end; normalizedEnd = run.normalized_end;
    }
    if (rawEnd !== raw.length || normalizedEnd !== normalized.length || block.raw_text.replace(/\r\n?/g, '\n') !== block.text) issues.push('normalization_map_mismatch');
  }
  const textPages = document.pages.filter(p => p.text_layer_present).map(p => p.physical_page);
  const noText = document.pages.filter(p => p.status !== 'failed' && !p.text_layer_present).map(p => p.physical_page);
  const images = document.pages.filter(p => p.bitmap_count).map(p => p.physical_page);
  const failed = document.pages.filter(p => p.status === 'failed').map(p => ({ physical_page: p.physical_page, code: p.error?.code }));
  const state = !ids.length ? 'unsupported' : failed.length || noText.length || images.length ? 'partial' : 'parsed';
  if (!same(textPages, document.coverage.text_layer_pages) || !same(failed, document.coverage.failed_pages) || !same(noText, document.coverage.pages_without_text) ||
    !same(images, document.coverage.image_text_unverified_pages) || document.coverage.text_layer_decode_complete !== (textPages.length === pages.length) ||
    document.parser.status !== state) issues.push('page_coverage_mismatch');
  return [...new Set(issues)];
}

export interface ExactSegment { block_id: string; text_version: string; start: number; end: number }

export function rawRange(block: BlockV2, start: number, end: number): [number, number] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > Array.from(block.text).length) throw new Error('invalid_span');
  const runs = block.normalization_map.filter(m => m.normalized_end > start && m.normalized_start < end);
  const first = runs[0], last = runs.at(-1);
  if (!first || !last) throw new Error('invalid_normalization_map');
  return [first.kind === 'identity' ? first.raw_start + start - first.normalized_start : first.raw_start,
    last.kind === 'identity' ? last.raw_start + end - last.normalized_start : last.raw_end];
}

export function resolveDocumentSegments(document: Pick<DocumentIRV2, 'document_id' | 'text_version' | 'blocks'>, reference: { document_id: string; text_version: string; segments: ExactSegment[]; joiner: string }) {
  if (reference.document_id !== document.document_id) throw new Error('document_id_mismatch');
  if (reference.text_version !== document.text_version) throw new Error('text_version_mismatch');
  if (!reference.segments.length || typeof reference.joiner !== 'string') throw new Error('invalid_segments');
  const blocks = new Map(document.blocks.map(b => [b.block_id, b]));
  let previousOrder = -1, previousEnd = -1;
  const located = reference.segments.map(segment => {
    if (segment.text_version !== document.text_version) throw new Error('text_version_mismatch');
    const block = blocks.get(segment.block_id);
    if (!block) throw new Error('unknown_block');
    const [rawStart, rawEnd] = rawRange(block, segment.start, segment.end);
    if (block.reading_order < previousOrder || block.reading_order === previousOrder && segment.start < previousEnd) throw new Error('segments_out_of_order');
    previousOrder = block.reading_order; previousEnd = segment.end;
    return { ...segment, physical_page: block.page, bbox: block.bbox, source_geometry: block.source_geometry,
      raw_start: rawStart, raw_end: rawEnd, quote: Array.from(block.text).slice(segment.start, segment.end).join(''),
      raw_quote: Array.from(block.raw_text).slice(rawStart, rawEnd).join('') };
  });
  return { ...reference, unit: 'unicode_code_point' as const, interval: '[start,end)' as const,
    quote: located.map(s => s.quote).join(reference.joiner), raw_quote: located.map(s => s.raw_quote).join(reference.joiner),
    segments: located.map(({ quote, raw_quote, ...segment }) => segment), medical_semantics_verified: false as const };
}

export function applyAffine(matrix: number[], x: number, y: number): [number, number] {
  if (matrix.length !== 6 || ![...matrix, x, y].every(Number.isFinite)) throw new Error('invalid_affine_matrix');
  const [a, b, c, d, e, f] = matrix as [number, number, number, number, number, number];
  return [a * x + c * y + e, b * x + d * y + f];
}
