import { createHash } from 'node:crypto';
import type { RunInput, StructuredDocumentIR } from '../../../packages/contracts/src/index.js';
import type { EvidenceCatalog, EvidenceSubmission, EvidenceValidationContext } from '../../../packages/contracts/src/extraction-evidence.js';

export interface SyntheticLine { text: string; page?: number }
/** Synthetic engineering evidence only; no PDF, medical annotation, or medical approval is implied. */
export function makeEvidenceFixture(lines: Array<string | SyntheticLine> = ['We observed spiculation on CT in lung cancer.'],
  options: { runId?: string; documentId?: string } = {}) {
  const documentId = options.documentId ?? 'synthetic-s4-document', runId = options.runId ?? 'synthetic-s4-run';
  const texts = lines.map(line => typeof line === 'string' ? { text: line, page: 1 } : { text: line.text, page: line.page ?? 1 });
  const sha = createHash('sha256').update(JSON.stringify(texts)).digest('hex');
  const textVersion = `synthetic-code-point-text-${sha.slice(0, 16)}`;
  const pageCount = Math.max(...texts.map(line => line.page));
  const pageIds = Array.from({ length: pageCount }, (_, i) => i + 1);
  const document: StructuredDocumentIR = {
    schema_version: '3', document_id: documentId, file_sha256: sha, fixture: true, evidence_kind: 'engineering_fixture',
    title: 'Synthetic S4 engineering fixture; not a medical paper', source: { file_reference: 'synthetic:no-pdf', bytes: 1, original_modified: false },
    parser: { id: 'docling-standard-cpu', version: 'synthetic-no-parser-call', status: 'parsed', config: { synthetic: true }, config_digest: sha },
    text_version: textVersion, raw_text_version: textVersion, offset_unit: 'unicode_code_point', offset_interval: '[start,end)', normalization_version: 'line-endings-only-1',
    pages: pageIds.map(page => ({ physical_page: page, printed_label: null, ocr: false, width: 600, height: 800, rotation: 0,
      coordinate_unit: 'pt', geometry: null, status: 'text_layer_extracted_fidelity_unverified', text_layer_present: true, bitmap_count: 0,
      ocr_requirement: 'not_detected', error: null, duration_seconds: 0 })),
    blocks: texts.map((line, index) => ({ block_id: `synthetic-line-${index + 1}`, document_id: documentId, text_version: textVersion,
      text: line.text, raw_text: line.text, backend_text: line.text, raw_text_source: 'backend_cell_orig',
      normalization_map: [{ raw_start: 0, raw_end: Array.from(line.text).length, normalized_start: 0, normalized_end: Array.from(line.text).length, kind: 'identity' }],
      page: line.page, type: 'text', semantic_type_status: 'unclassified_textline', reading_order: index, bbox: [10, 10 + index * 20, 500, 25 + index * 20],
      source_geometry: { coordinate_system: 'docling_crop_rotated_bottom_left_pdf_user_units', bbox: [10, 10, 500, 25],
        polygon: [10, 10, 500, 10, 500, 25, 10, 25], pdf_bbox: [10, 10, 500, 25], precision: 'whole_textline_not_exact_glyph' }, backend_cell_index: index })),
    source_extraction: { parser_id: 'synthetic-no-parser-call', parser_version: '1', config_digest: sha, text_version: textVersion,
      raw_text_definition: 'decoded_PDF_text_layer_no_native_structure_rewrite' },
    native_artifact: { path: 'synthetic:no-native-artifact', sha256: sha, format: 'synthetic-no-parser-call' },
    structure: { units: [], reading_order: [], furniture_unit_ids: [], hierarchy: [], tables: [], pictures: [],
      native_processed_text_is_authoritative_quote: false, human_fidelity_verified: false },
    coverage: { expected_block_ids: texts.map((_, index) => `synthetic-line-${index + 1}`), processed_block_ids: texts.map((_, index) => `synthetic-line-${index + 1}`),
      failed_block_ids: [], excluded: [], scope: 'raw_pdf_text_layer_with_candidate_structure', physical_pages_expected: pageIds,
      decoded_pages: pageIds, text_layer_pages: pageIds, failed_pages: [], pages_without_text: [], image_text_unverified_pages: [],
      page_enumeration_complete: true, text_layer_decode_complete: true, full_content_coverage_verified: false, fidelity_human_verified: false,
      table_structure: 'native_candidate_output_unverified', reading_order: 'native_candidate_order_unverified', limitations: ['synthetic_engineering_only'],
      native_pages: pageIds, native_errors: [], unmapped_unit_ids: [], ambiguous_unit_ids: [], structure_verified_by_human: false },
    metrics: { source_anchor_seconds: 0, native_seconds: 0, mapping_seconds: 0, total_seconds: 0, native_metrics: {}, host_metrics: {}, remote_document_uploads: 0, llm_calls: 0 },
  };
  const catalog: EvidenceCatalog = { catalog_version: 'synthetic-unavailable-catalog-1', status: 'unavailable', fixture: false,
    cancers: [], image_types: [], features: [], bindings: [] };
  const input: RunInput = { schema_version: '1', run_id: runId, document_id: documentId, file_sha256: sha, fixture: true,
    scope: { scope_version: '1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] },
      features: { mode: 'all', binding_ids: [] }, catalog_version: catalog.catalog_version, matching_policy_version: 'exact-explicit-synonyms-1' },
    rule_version: 'synthetic-s4-rules-1', runtime_profile: { provider: 'synthetic-no-provider', model_id: 'synthetic-no-llm',
      endpoint: 'http://127.0.0.1:1/unused', pi_version: '1.4.0', version: 'synthetic-s4-1' } };
  const context: EvidenceValidationContext = { input, document, catalog, allowedBlockIds: document.blocks.map(b => b.block_id),
    readBlockIds: document.blocks.map(b => b.block_id), toolCallId: 'synthetic-submit-call', metadata: { task_id: 'synthetic-task',
      article_family_id: 'synthetic-family', source_version: { file_sha256: sha, source_kind: 'synthetic_engineering_fixture', version: `sha256:${sha}`,
        obtained_at: '2026-11-03T00:00:00Z' }, document_access: 'full_text', created_at: '2026-11-03T00:00:00Z' } };
  const source = { block_id: document.blocks[0]!.block_id, exact_quote: document.blocks[0]!.text };
  const submission: EvidenceSubmission = { binding: { task_id: context.metadata.task_id, run_id: runId, document_id: documentId,
    file_sha256: sha, source_version: context.metadata.source_version.version, text_version: textVersion }, source_fragments: [source],
    context_fragments: [], display_joiner: '\n…\n', feature_binding_id: null, feature_name_raw: 'spiculation', feature_category: 'margin',
    evidence_type: 'imaging_observation', disease_or_lesion: { value: 'lung cancer', status: 'source_observed', evidence: [{ ...source }] },
    modality: { value: 'CT', status: 'source_observed', evidence: [{ ...source }] }, sequence_or_phase: null,
    assertion: { value: 'affirmed', original_wording: source.exact_quote, evidence: [{ ...source }] },
    applicability: { status: 'unknown', original_wording: '', evidence: [] }, numeric_expressions: [],
    provenance: { origin: 'study_authors', cited_references: [], evidence: [{ ...source }] }, translation_zh: null };
  return { input, document, catalog, context, submission };
}

/** All approval strings here are test data, never an approved product vocabulary. */
export function syntheticApprovedCatalog(): EvidenceCatalog {
  const base = { synonyms: [], source: 'synthetic-test-only-not-medical-approval', approval_status: 'approved' as const };
  return { catalog_version: 'synthetic-approved-catalog-1', status: 'approved', fixture: true,
    cancers: [{ ...base, id: 'lung', name: 'lung cancer', synonyms: [{ text: 'pulmonary carcinoma', source: 'synthetic-synonym-source', approval_status: 'approved' }] },
      { ...base, id: 'colon', name: 'colon cancer' }],
    image_types: [{ ...base, id: 'ct', name: 'CT', cancer_ids: ['lung', 'colon'],
      synonyms: [{ text: 'computed tomography', source: 'synthetic-synonym-source', approval_status: 'approved' }] },
      { ...base, id: 'mri', name: 'MRI', cancer_ids: ['lung', 'colon'] }],
    features: [{ ...base, feature_id: 'spiculation', name: 'spiculation', category: 'margin', version: 'synthetic-1',
      synonyms: [{ text: 'spiculated margin', source: 'synthetic-synonym-source', approval_status: 'approved' },
        { text: 'irregular margin', source: 'unreviewed-hierarchy-is-not-synonym', approval_status: 'development_only' }] },
      { ...base, feature_id: 'lobulation', name: 'lobulation', category: 'margin', version: 'synthetic-1', synonyms: [] }],
    bindings: [{ source: base.source, approval_status: 'approved', binding_id: 'spiculation-lung-ct', feature_id: 'spiculation', cancer_ids: ['lung'], image_type_ids: ['ct'], sequence_or_phase_conditions: [], version: 'synthetic-1' },
      { source: base.source, approval_status: 'approved', binding_id: 'lobulation-lung-ct', feature_id: 'lobulation', cancer_ids: ['lung'], image_type_ids: ['ct'], sequence_or_phase_conditions: [], version: 'synthetic-1' }] };
}
