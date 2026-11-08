import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';

test('completed selected text and summary remain separate from bibliography, bitmap OCR and legacy full-PDF status', async () => {
  const f = makeEvidenceFixture(['CT shows spiculation.', 'References', '1. Smith A. CT. J Med. 2024;2:1-8.']);
  f.document.pages[0]!.bitmap_count = 1; f.document.pages[0]!.ocr_requirement = 'possible_image_text_unverified';
  f.document.coverage.image_text_unverified_pages = [1]; f.document.parser.status = 'partial';
  const sourceBefore = JSON.stringify(f.document), directory = await mkdtemp(join(tmpdir(), 'task-completion-'));
  const server = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { summary: 'Local transport fixture only.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ]);
  const store = new ExtractionStore(':memory:');
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, metadata: f.context.metadata, catalog: f.catalog,
      config: server.config, profile: developmentProfile(server.config.modelId), budget: new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint),
      store, directory: join(directory, 'run'), strategy: 'baseline' });
    assert.equal(result.error, undefined); assert.equal(result.state, 'partial');
    assert.equal(result.task_processing_complete, true); assert.equal(result.coverage.task_processing_complete, true);
    assert.equal(result.coverage.selected_source_block_processing_complete, true); assert.equal(result.coverage.whole_document_summary_complete, true);
    assert.equal(result.coverage.task_scope_source_blocks, 2); assert.equal(result.coverage.task_scope_source_block_processing_complete, true);
    assert.deepEqual(result.coverage.task_scope_unprocessed_source_block_ids, []); assert.deepEqual(result.coverage.task_processing_blockers, []);
    assert.deepEqual(result.coverage.shared_bibliography_excluded_source_block_ids, [f.document.blocks[2]!.block_id]);
    assert.deepEqual(result.coverage.original_article_unprocessed_source_block_ids, [f.document.blocks[2]!.block_id]);
    assert.deepEqual(result.coverage.f_unselected_source_block_ids, []);
    assert.equal(result.coverage.source_text_layer_decode_complete, true); assert.deepEqual(result.coverage.parser_failed_pages, []);
    assert.deepEqual(result.coverage.image_text_unverified_pages, [1]); assert.equal(result.coverage.parser_status, 'partial');
    assert.equal(result.coverage.full_document_extraction_completed, false); assert.equal(result.coverage.source_fidelity_human_verified, false);
    assert.equal(JSON.stringify(f.document), sourceBefore);
    assert.equal(JSON.stringify(server.requests).includes('Smith'), false);
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
