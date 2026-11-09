/** T1 web views. No provider credentials or filesystem paths cross this contract. */
export interface WorkbenchFragment {
  block_id: string; text_version: string; start: number; end: number; exact_quote: string;
  occurrence: number; physical_page: number; bbox: number[]; location_precision: string;
}
export interface WorkbenchAsset { id: string; url: string; sha256: string; page: number; width: number; height: number }
export interface WorkbenchFigure {
  id: string; number: string | null; verification: string; caption: WorkbenchFragment[];
  assets: WorkbenchAsset[]; human_approved: false;
}
export interface WorkbenchRecord {
  id: string; version: number; run_id: string; fragments: WorkbenchFragment[]; context: WorkbenchFragment[];
  association: 'paired' | 'pending' | 'no_explicit_reference' | 'not_checked'; figure_ids: string[];
  proposed_figure_ids: string[]; reasons: string[];
  review_status: string; text_fingerprint: string; delivery_fingerprint: string;
  evidence_role?: 'primary_candidate' | 'background_suggestion';
  model_primary_assessment?: import('./extraction-evidence.js').PrimaryAssessment | null;
  actor?: 'automatic' | 'human'; deleted?: boolean; labels?: WorkbenchLabels;
  text_approved?: boolean; figures_approved?: boolean; review_reason?: string;
  source_unit_ids?: string[]; context_unit_ids?: string[];
}
export interface WorkbenchOutput {
  id: string; strategy: string; state: string; origin: 'historical_compatibility_replay' | 'workbench_run' | 'controlled_fixture';
  records: WorkbenchRecord[]; full_recall_claimed: false; medical_quality_approved: false;
  fixture?: boolean; coverage?: unknown; error?: string; scope?: import('./index.js').Scope;
  result_ready?: boolean;
  summary?: string; summary_is_diagnostic?: true;
  same_source_review_index?: WorkbenchSameSourceReviewIndex;
}
export interface WorkbenchPaper {
  id: string; title: string; language: string; pages: number; note: string; sha256: string;
  output_ids: string[];
  uploaded?: boolean;
}
export interface WorkbenchPaperDetail {
  paper: WorkbenchPaper; text_version: string; pdf_url: string; source_verified: boolean;
  figures: WorkbenchFigure[]; outputs: WorkbenchOutput[]; read_only: boolean;
  source_status?: 'valid' | 'missing' | 'mismatch' | 'not_parsed'; source_issues?: string[];
  source_units?: WorkbenchSourceUnit[];
}
export interface WorkbenchRun {
  run_id: string; document_id: string; state: string; fixture: boolean; candidate_count: number;
  scope?: import('./index.js').Scope; origin?: WorkbenchOutput['origin']; created_at?: string; error?: string;
  execution_started_at?: string; queue_wait_ms?: number; runtime_deadline?: string;
  result_ready?: boolean; finished_at?: string;
}
export interface WorkbenchCapabilities {
  schema_version: 't1-workbench-capabilities-1'; read_only: boolean; paper_upload: boolean;
  extraction_start: boolean; persisted_review: boolean; approved_export: boolean;
  backend_pi_sdk: '1.4.0';
  max_concurrent_runs?: number;
  model_runtime?: WorkbenchModelRuntime;
  extraction_unavailable_reason?: string; controlled_fixture?: boolean; max_pdf_bytes?: number;
}
export interface WorkbenchModelRuntime {
  provider: string; model_id: string; reasoning_effort: string;
  limits: { requests: number; input_tokens: number; output_tokens: number; execution_seconds: number };
}

export interface WorkbenchSourceUnit {
  unit_id: string; kind: string; source_type: string; completeness: string;
  boundary_reasons: string[]; segments: WorkbenchFragment[]; text: string;
}
export interface WorkbenchLabels {
  feature_category?: string;
  evidence_type?: 'feature_mention' | 'definition' | 'imaging_observation' | 'interpretive_condition' | 'association_conclusion';
  tags?: string[]; comment?: string; evidence_role?: 'primary_candidate' | 'background_suggestion';
}
export interface WorkbenchRevisionInput {
  expected_version?: number; source_unit_ids?: string[]; context_unit_ids?: string[];
  labels?: WorkbenchLabels; reviewer: string; reason?: string;
}
export interface WorkbenchReviewInput {
  expected_version: number; action: 'approve_text' | 'approve_figures' | 'reject' | 'pending';
  reviewer: string; reason?: string; source_text_checked?: boolean; relevance_checked?: boolean;
  context_checked?: boolean; figure_pairing_checked?: boolean;
}
export interface WorkbenchEvent { run_id: string; seq: number; type: string; timestamp: string; detail: Record<string, unknown> }
export type WorkbenchExportKind = 'candidate_jsonl' | 'candidate_csv' | 'approved_jsonl' | 'approved_csv' | 'candidate_package' | 'approved_package';
export interface WorkbenchRunDetail {
  run: WorkbenchRun; output: WorkbenchOutput; source_units: WorkbenchSourceUnit[]; source_issues: string[];
  source_status: string; paper: WorkbenchPaper; pdf_url: string; text_version: string; figures: WorkbenchFigure[];
  figure_catalog_sha256: string | null;
}
export interface WorkbenchFigureCheckInput {
  expected_catalog_sha256: string; reviewer: string; all_panels_included: boolean; caption_figure_identity_checked: boolean; notes: string;
}
export type WorkbenchScopeCatalog = import('./extraction-evidence.js').EvidenceCatalog & {
  default_scope: import('./index.js').Scope; restricted_available: boolean; restricted_reason: string | null; development_only: boolean;
};
export interface WorkbenchSameSourceReviewIndex {
  schema_version: string; raw_current_record_count: number; source_context_group_count: number; same_source_multi_member_group_count: number;
  groups: Array<{ group_id: string; member_count: number; evidence_field_differences: string[];
    members: Array<{ record_id: string; record_version: number; evidence_fields: Record<string, unknown> }>;
    same_literal_source_context_needs_review: boolean; internal_reference_role_needs_review: boolean;
    automatic_record_merge: boolean; approval_propagated: boolean }>;
  internal_reference_hints: Array<{ group_id: string; record_id: string; record_version: number; internal_structure_markers: string[] }>;
  read_only_derived_view: boolean; clinical_deduplication_claimed: boolean; medical_quality_approved: boolean;
}
