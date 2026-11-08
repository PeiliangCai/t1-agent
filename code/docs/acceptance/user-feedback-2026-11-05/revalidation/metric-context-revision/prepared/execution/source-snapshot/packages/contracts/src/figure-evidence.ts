import { Type, type Static } from 'typebox';
import { LocatedEvidenceFragmentSchema } from './extraction-evidence.js';

const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 200 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const text = Type.String();
const nullableText = Type.Union([text, Type.Null()]);
const bbox = Type.Array(Type.Number(), { minItems: 4, maxItems: 4 });

/** Sidecar to immutable IR v2/v3. A detected region is not automatically a whole Figure. */
export const FigureAssetSchema = Type.Object({
  asset_id: id, path: Type.String({ minLength: 1 }), sha256: hash, mime_type: Type.Literal('image/png'),
  physical_page: Type.Integer({ minimum: 1 }), bbox,
  coordinate_system: Type.Literal('crop_rotated_top_left_pt'),
  width_px: Type.Integer({ minimum: 1 }), height_px: Type.Integer({ minimum: 1 }),
  render_scale: Type.Number({ minimum: 0.25, maximum: 4 }),
  extraction_method: Type.Literal('original_pdf_region_render'),
  source_pdf_sha256: hash, visual_modification: Type.Literal('none'),
}, closed);
export type FigureAsset = Static<typeof FigureAssetSchema>;
export const FigureSchema = Type.Object({
  figure_id: id, figure_number: Type.Union([Type.String({ pattern: '^[1-9][0-9]*$' }), Type.Null()]),
  caption_segments: Type.Array(LocatedEvidenceFragmentSchema), panel_labels: Type.Array(text, { uniqueItems: true }),
  native_picture_ids: Type.Array(id, { uniqueItems: true }), regions: Type.Array(FigureAssetSchema),
  verification: Type.Object({
    status: Type.Enum(['whole_figure_checked', 'mechanically_checked', 'needs_review']),
    method: Type.Enum(['native_candidate_only', 'source_page_visual_check', 'single_pdf_bitmap_caption_guard_1']),
    actor: nullableText, checked_at: nullableText, notes: text,
    all_panels_included: Type.Boolean(), caption_figure_identity_checked: Type.Boolean(),
    human_approved: Type.Literal(false),
    mechanical_evidence: Type.Optional(Type.Object({ pdf_image_object_count: Type.Literal(1),
      original_image_bbox: bbox, caption_number_unique: Type.Literal(true),
      no_nearby_uncontained_visual_objects: Type.Literal(true), no_intervening_paragraph: Type.Literal(true),
      native_region_matches_complete_pdf_bitmap: Type.Literal(true) }, closed)),
  }, closed),
}, closed);
export type Figure = Static<typeof FigureSchema>;
export const FigureAssetCatalogSchema = Type.Object({
  schema_version: Type.Literal('figure-asset-catalog-1'), document_id: id, file_sha256: hash, text_version: id,
  figures: Type.Array(FigureSchema), inventory_complete: Type.Literal(false),
  original_pdf_modified: Type.Literal(false), generated_images_used: Type.Literal(false),
}, closed);
export type FigureAssetCatalog = Static<typeof FigureAssetCatalogSchema>;

/** Approval is tied to the exact text, candidate version AND supplied figure assets. */
export const DeliveryReviewSchema = Type.Object({
  record_id: id, record_version: Type.Integer({ minimum: 1 }), review_scope: Type.Enum(['text_only', 'text_and_figures']),
  text_fingerprint: hash, delivery_fingerprint: Type.Union([hash, Type.Null()]),
  decision: Type.Enum(['approved', 'rejected', 'needs_context']), actor: id,
  reviewed_at: Type.String({ minLength: 1 }), source_text_checked: Type.Boolean(),
  relevance_checked: Type.Boolean(), context_checked: Type.Boolean(), figure_pairing_checked: Type.Boolean(), reason: text,
}, closed);
export type DeliveryReview = Static<typeof DeliveryReviewSchema>;
export const OutputSampleReviewSchema = Type.Object({
  schema_version: Type.Literal('output-sample-review-1'), sample_id: id,
  selection_method: Type.String({ minLength: 1 }), reviewer: id, reviewed_at: Type.String({ minLength: 1 }),
  entries: Type.Array(Type.Object({ record_id: id, record_version: Type.Integer({ minimum: 1 }), delivery_fingerprint: hash,
    relevance: Type.Enum(['pass', 'fail', 'uncertain']), context: Type.Enum(['pass', 'fail', 'uncertain']),
    figure_pairing: Type.Enum(['pass', 'fail', 'uncertain', 'not_applicable']), notes: text,
    source_pdf_checked: Type.Optional(Type.Boolean()),
    source_fidelity: Type.Optional(Type.Enum(['pass', 'fail', 'uncertain'])),
    figure_completeness: Type.Optional(Type.Enum(['pass', 'fail', 'uncertain', 'not_applicable'])),
    canonical_group_id: Type.Optional(id), error_codes: Type.Optional(Type.Array(id, { uniqueItems: true })),
  }, closed)),
}, closed);
export type OutputSampleReview = Static<typeof OutputSampleReviewSchema>;
