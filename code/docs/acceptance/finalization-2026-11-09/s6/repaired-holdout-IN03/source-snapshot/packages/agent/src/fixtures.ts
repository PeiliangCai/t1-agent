import { createHash, randomUUID } from 'node:crypto';
import { defaultScope, assertSchema, DocumentIRSchema, CatalogSchema, type Catalog, type DocumentIR, type RunInput, type Scope } from '@t1/contracts';
import type { ModelConfig } from './config.js';

export const catalog: Catalog = {
  catalog_version: 'engineering-demo-1', fixture: true,
  cancers: [{ id: 'demo_cancer_a', name: 'Engineering example A' }, { id: 'demo_cancer_b', name: 'Engineering example B' }],
  image_types: [{ id: 'demo_image_a', name: 'Engineering image A', cancer_ids: ['demo_cancer_a'] }, { id: 'demo_image_b', name: 'Engineering image B', cancer_ids: ['demo_cancer_b'] }],
  features: [{ feature_id: 'demo_rim', name: 'blue rim', synonyms: ['blue rim', 'azure border'], category: 'engineering_example', source: 'human_prepared_fixture', version: '1' }],
  bindings: [{ binding_id: 'demo_rim_a', feature_id: 'demo_rim', cancer_ids: ['demo_cancer_a'], image_type_ids: ['demo_image_a'], sequence_or_phase_conditions: [], source: 'human_prepared_fixture', version: '1' },
    { binding_id: 'demo_rim_b', feature_id: 'demo_rim', cancer_ids: ['demo_cancer_b'], image_type_ids: ['demo_image_b'], sequence_or_phase_conditions: [], source: 'human_prepared_fixture', version: '1' }],
};
assertSchema(CatalogSchema, catalog);
export function makeFixture(config: Pick<ModelConfig, 'provider' | 'modelId' | 'baseUrl'>, scope: Scope = defaultScope(catalog.catalog_version)) {
  const runId = randomUUID(); const documentId = 'engineering-fixture-' + randomUUID();
  const text = 'ENGINEERING FIXTURE ONLY — 人工文本 🧪. The sample shape has a blue rim measuring 7 mm. This text is not a medical paper or medical evidence.';
  const sha = createHash('sha256').update(text).digest('hex');
  const document: DocumentIR = { schema_version: '1', document_id: documentId, file_sha256: sha, fixture: true, evidence_kind: 'engineering_fixture',
    title: 'Human prepared engineering fixture; not a published paper', parser: { id: 'fixture-adapter', version: '1', status: 'fixture' }, text_version: 'fixture-text-1',
    pages: [{ physical_page: null, printed_label: null, width: null, height: null, rotation: 0, coordinate_unit: null, ocr: false, status: 'fixture_text_no_pdf_page' }],
    blocks: [{ block_id: 'demo-block-1', document_id: documentId, text_version: 'fixture-text-1', text, page: null, type: 'text', reading_order: 0, bbox: null }],
    coverage: { expected_block_ids: ['demo-block-1'], processed_block_ids: [], failed_block_ids: [], excluded: [] } };
  assertSchema(DocumentIRSchema, document);
  const input: RunInput = { schema_version: '1', run_id: runId, document_id: documentId, file_sha256: sha, fixture: true, scope: structuredClone(scope), rule_version: 'engineering-fixture-rules-1',
    runtime_profile: { provider: config.provider, model_id: config.modelId, endpoint: config.baseUrl, pi_version: '1.4.0', version: 's1-prototype-1' } };
  return { input, document, catalog: structuredClone(catalog) };
}
