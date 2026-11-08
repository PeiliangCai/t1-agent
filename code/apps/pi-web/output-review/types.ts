export type Fragment = {
  block_id: string;
  text_version: string;
  start: number;
  end: number;
  exact_quote: string;
  occurrence: number;
  physical_page: number;
  bbox: [number, number, number, number];
  location_precision: string;
};

export type RecordView = {
  document_id: string;
  record_id: string;
  record_version: number;
  source_record_sha256: string;
  text_fingerprint: string;
  delivery_fingerprint: string;
  file_sha256: string;
  text_version: string;
  physical_pages: number[];
  original_fragments: Fragment[];
  context_fragments: Fragment[];
  figure_ids: string[];
  figure_status_label: string;
  figure_association: { status: string; no_figure_claimed: false; human_approved: false };
  fields: Record<string, unknown>;
  human_approved: false;
  product_export_approved: false;
};

export type RandomSample = {
  id: string;
  job_id: string;
  method: string;
  version_scope: string;
  view: RecordView;
};

export type RiskSample = {
  id: string;
  job_id: string;
  method: string;
  version_scope: string;
  record_id: string;
  before: RecordView;
  after: RecordView;
  reasons: string[];
  changes: { field: string; before: unknown; after: unknown }[];
  counted_in_random_statistics: false;
};

export type Figure = {
  figure_id: string;
  document_id: string;
  figure_number: string;
  caption_segments: Fragment[];
  assets: { pack_path: string; sha256: string; width_px: number; height_px: number; physical_page: number }[];
  status_label: string;
};

export type ReviewPack = {
  schema_version: string;
  pack_id: string;
  random_samples: RandomSample[];
  risks: RiskSample[];
  figures: Figure[];
  fragments: unknown[];
  papers: { document_id: string; pack_pdf: string; pdf_sha256: string }[];
  selection: { selected_count: number; selected_version_units_sha256: string };
};

export type ReviewItem =
  | { id: string; kind: "random"; sample: RandomSample }
  | { id: string; kind: "risk"; sample: RiskSample };
