/** Read-only T1 web views. No provider credentials or filesystem paths cross this contract. */
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
}
export interface WorkbenchOutput {
  id: string; strategy: string; state: string; origin: 'historical_compatibility_replay';
  records: WorkbenchRecord[]; full_recall_claimed: false; medical_quality_approved: false;
}
export interface WorkbenchPaper {
  id: string; title: string; language: string; pages: number; note: string; sha256: string;
  output_ids: string[];
}
export interface WorkbenchPaperDetail {
  paper: WorkbenchPaper; text_version: string; pdf_url: string; source_verified: true;
  figures: WorkbenchFigure[]; outputs: WorkbenchOutput[]; read_only: true;
}
export interface WorkbenchRun {
  run_id: string; document_id: string; state: string; fixture: boolean; candidate_count: number;
}
export interface WorkbenchCapabilities {
  schema_version: 't1-workbench-capabilities-1'; read_only: true; paper_upload: false;
  extraction_start: false; persisted_review: false; approved_export: false;
  backend_pi_sdk: '1.4.0'; full_S5_complete: false;
}
