import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, ExtractionBudget, evidenceScopeIssues } from '@t1/agent';
import { configuredEvidenceCatalog } from '../src/catalog-config.js';
import { WorkbenchWorkflow, unavailableMedicalCatalog } from '../src/workflow.js';
import { executeWorkbenchExtraction } from '../src/workflow-runner.js';
import { makeEvidenceFixture } from '../../../tests/extraction/fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture } from '../../../tests/extraction/fixtures/runtime-responses.js';

// All names/approval strings here are synthetic loader test data; no real medical catalog is approved or installed.
test('operator catalog validates schema, approval, relationships and exact scope version without leaking paths', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s7-catalog-')), path = resolve(directory, 'engineering-catalog.json');
  const catalog = { ...unavailableMedicalCatalog, catalog_version: 'ENGINEERING-LOADER-ONLY-1', status: 'approved' as const,
    cancers: [{ id: 'ENGINEERING-A', name: 'ENGINEERING ONLY', source: 'unit test only', approval_status: 'approved' as const, synonyms: [] }] };
  try {
    assert.equal(configuredEvidenceCatalog({}).status, 'unavailable');
    await writeFile(path, JSON.stringify(catalog)); const loaded = configuredEvidenceCatalog({ T1_WORKBENCH_CATALOG_FILE: path });
    assert.deepEqual(loaded, catalog);
    const store = new ExtractionStore(':memory:'), workflow = new WorkbenchWorkflow(store, { sources: false, catalog: loaded });
    try {
      assert.equal(workflow.scopeCatalog().restricted_available, true);
      const selected = { ...workflow.scopeCatalog().default_scope, cancers: { mode: 'selected' as const, ids: ['ENGINEERING-A'] } };
      assert.deepEqual(evidenceScopeIssues(selected, loaded), []);
      assert.ok(evidenceScopeIssues({ ...selected, catalog_version: 'old-version' }, loaded).includes('catalog_version_mismatch'));
      assert.ok(evidenceScopeIssues({ ...selected, cancers: { mode: 'selected', ids: [] } }, loaded).includes('cancers_selected_empty'));
      assert.ok(evidenceScopeIssues({ ...selected, cancers: { mode: 'selected', ids: ['unknown'] } }, loaded).length);
    } finally { await workflow.close(); store.close(); }
    for (const invalid of [{ ...catalog, fixture: true }, { ...catalog, status: 'development_only' }, { ...catalog, cancers: [{ ...catalog.cancers[0], approval_status: 'development_only' }] }]) {
      await writeFile(path, JSON.stringify(invalid)); assert.throws(() => configuredEvidenceCatalog({ T1_WORKBENCH_CATALOG_FILE: path }), /not_production_approved/);
    }
    await writeFile(path, '{}'); assert.throws(() => configuredEvidenceCatalog({ T1_WORKBENCH_CATALOG_FILE: path }), /configured_medical_catalog_invalid/);
    try { configuredEvidenceCatalog({ T1_WORKBENCH_CATALOG_FILE: path + '-private-missing' }); assert.fail(); }
    catch (error) { assert.equal((error as Error).message.includes(path), false); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual product extraction helper passes the configured catalog into installed Pi B0 on loopback', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s7-catalog-pi-')), store = new ExtractionStore(':memory:');
  const fixture = makeEvidenceFixture(['ENGINEERING SOURCE TEXT ONLY.']);
  const catalog = { ...fixture.catalog, catalog_version: 'ENGINEERING-REAL-RUNNER-CATALOG-1', status: 'approved' as const };
  fixture.input.scope.catalog_version = catalog.catalog_version; store.create(fixture.input, fixture.context.metadata);
  const local = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }, { name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: { summary: 'Engineering catalog propagation only.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ]);
  try {
    const result = await executeWorkbenchExtraction({ input: fixture.input, document: fixture.document, evidence_catalog: catalog,
      directory, store, metadata: fixture.context.metadata, signal: new AbortController().signal }, local.config,
      new ExtractionBudget(resolve(directory, 'loopback-ledger.json'), local.endpoint), 30_000, true);
    assert.equal(result.coverage.whole_document_summary_complete, true); assert.equal(local.requests.length, 2);
    assert.equal(store.snapshot(fixture.input.run_id).state, 'completed');
  } finally { await local.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
