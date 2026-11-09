import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { buildArticleScope, planExtractionBatches } from '../../packages/agent/src/article-scope.js';
import { buildSourceEvidenceUnits, sourceGlyphCheckStatus, sourceGlyphQuarantine } from '../../packages/agent/src/source-evidence-units.js';
import { selectSourceBlocks, taskSourceBlockIds } from '../../packages/agent/src/source-selection.js';
import { locateEvidenceFragment } from '../../packages/agent/src/evidence-validation.js';
import { buildEvidenceDelivery, exportEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { freshPreparedSource } from './fixtures/current-parser.js';
import type { StructuredDocumentIR, DeliveryReview } from '@t1/contracts';

test('unsafe source sentence remains literal, visibly unverified, and absent from model read/batch scope', () => {
  const { document } = makeEvidenceFixture(['An affected sentence has 50 mm.', 'A separate normal finding has 5 mm.']);
  document.blocks[0]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 27, end: 28,
    font_name: 'Custom', font_program_sha256: 'a'.repeat(64), pdf_character_code: 109, precision: 'glyph_offset' }];
  const before = document.blocks.map(b => b.text), article = buildArticleScope(document);
  for (const condition of ['B0', 'F'] as const) {
    const selection = selectSourceBlocks(document, article, condition);
    assert.ok(selection.deferred_block_ids.includes(document.blocks[0]!.block_id));
    assert.ok(selection.entries[0]!.rule_ids.includes('SOURCE_GLYPH_QUARANTINE'));
    const batches = planExtractionBatches(document, { ...article, included_block_ids: selection.kept_block_ids });
    assert.ok(!batches.flatMap(b => [...b.assigned_block_ids, ...b.context_block_ids]).includes(document.blocks[0]!.block_id));
  }
  assert.deepEqual(sourceGlyphQuarantine(document), [document.blocks[0]!.block_id]);
  assert.deepEqual(taskSourceBlockIds(document, article), [document.blocks[1]!.block_id]);
  assert.deepEqual(document.blocks.map(b => b.text), before);
  const unsafe = buildSourceEvidenceUnits(document).filter(u => u.segments.some(s => s.block_id === document.blocks[0]!.block_id));
  assert.ok(unsafe.every(u => u.completeness === 'unverified' && u.boundary_reasons.includes('source_glyph_fidelity_unverified')));
  assert.throws(() => locateEvidenceFragment(document, { block_id: document.blocks[0]!.block_id, exact_quote: document.blocks[0]!.text }), /source_glyph_fidelity_unverified/);
  assert.equal(locateEvidenceFragment(document, { block_id: document.blocks[1]!.block_id, exact_quote: document.blocks[1]!.text }).exact_quote, before[1]);
});

test('quarantine retains every line of the affected native sentence while other units stay available', () => {
  const { document } = makeEvidenceFixture(['This complete source sentence has', 'a scale bar of 50 mm.', 'An unrelated finding has 5 mm.']);
  const blocks = document.blocks;
  document.structure.units.push({ unit_id: 'native-paragraph', native_ref: '#/texts/0', kind: 'text', content_layer: 'body',
    native_label: 'text', native_original_text: null, native_text_role: 'processed_native_not_literal_quote',
    native_text: blocks.slice(0, 2).map(b => b.text).join(' '), source_segments: blocks.slice(0, 2).map(b => ({ block_id: b.block_id,
      text_version: document.text_version, start: 0, end: Array.from(b.text).length })), provenance: [],
    mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_4', matched_native_code_points: 50,
      alignable_native_code_points: 50, transformations: [], warnings: [] } });
  const offset = blocks[1]!.text.indexOf('mm');
  blocks[1]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: offset, end: offset + 1,
    font_name: 'Custom', font_program_sha256: 'a'.repeat(64), pdf_character_code: 109, precision: 'glyph_offset' }];
  assert.deepEqual(sourceGlyphQuarantine(document), blocks.slice(0, 2).map(b => b.block_id));
  assert.deepEqual(taskSourceBlockIds(document, buildArticleScope(document)), [blocks[2]!.block_id]);
  assert.equal(document.blocks[0]!.text, 'This complete source sentence has');
});

test('a saved candidate cannot evade a newly known source glyph problem during delivery or approved export', async () => {
  const f = makeEvidenceFixture();
  const result = validateEvidenceSubmission(f.submission, f.context); assert.ok(result.record);
  const versions = [{ record: result.record, version: 1, actor: 'automatic' as const, status: 'active' as const }];
  f.document.blocks[0]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 0, end: 1,
    font_name: 'Custom', font_program_sha256: 'a'.repeat(64), pdf_character_code: 109, precision: 'glyph_offset' }];
  assert.throws(() => buildEvidenceDelivery(f.document, versions), /source_glyph_fidelity_unverified/);
  await assert.rejects(exportEvidenceDelivery(f.document, versions, { codeRoot: '.', directory: 'must-not-be-created', mode: 'approved', coverage: {} }), /source_glyph_fidelity_unverified/);
});

test('actual batch and summary tools refuse quarantined rereads and expose a gap without copying its text', async () => {
  const f = makeEvidenceFixture(['The original scale is 50 mm.', 'A separate normal source statement remains available.']);
  f.document.blocks[0]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 25, end: 26,
    font_name: 'Custom', font_program_sha256: 'a'.repeat(64), pdf_character_code: 109, precision: 'glyph_offset' }];
  const article = buildArticleScope(f.document), selection = selectSourceBlocks(f.document, article),
    batch = planExtractionBatches(f.document, { ...article, included_block_ids: selection.kept_block_ids })[0]!;
  const store = new ExtractionStore(':memory:');store.create(f.input, f.context.metadata);store.transition(f.input.run_id, 'extracting');
  try {
    const { allowedBlockIds: _a, readBlockIds: _r, toolCallId: _t, ...context } = f.context;
    const tools = new ExtractionTools(context, batch, article, store);
    const ids = { run_id: f.input.run_id, document_id: f.document.document_id, batch_id: batch.batch_id };
    const response = await tools.invoke('read_document_blocks', ids, 'safe-read') as { blocks: Array<{ text: string }> };
    assert.deepEqual(response.blocks.map(b => b.text), [f.document.blocks[1]!.text]);
    await assert.rejects(tools.invoke('read_document_blocks', { ...ids, block_ids: [f.document.blocks[0]!.block_id] }, 'unsafe-read'), /block_not_authorized/);
    const inventory = await tools.invoke('get_document_context', ids, 'inventory');
    assert.ok(!JSON.stringify(inventory).includes(f.document.blocks[0]!.text));
    store.transition(f.input.run_id, 'reconciling');
    const summary = new ExtractionSummaryTools(context, article, store, 'baseline', [], selection);
    await assert.rejects(summary.invoke('read_document_blocks', { run_id: f.input.run_id, document_id: f.document.document_id,
      block_ids: [f.document.blocks[0]!.block_id] }, 'unsafe-summary-read'), /bibliography_read_outside_task_scope/);
  } finally { store.close(); }
});

test('historical real IR never inherits glyph verification and approved export refuses before side effects', async () => {
  const { document } = makeEvidenceFixture(); document.fixture = false; document.evidence_kind = 'real_paper';
  assert.equal(sourceGlyphCheckStatus(document), 'legacy_not_checked');
  await assert.rejects(exportEvidenceDelivery(document, [], { codeRoot: '.', directory: 'must-not-be-created', mode: 'approved', coverage: {} }), /source_glyph_check_missing_reparse_required/);
  document.parser.config.font_glyph_guard_version = 'sparse-embedded-font-no-unicode-1';
  assert.equal(sourceGlyphCheckStatus(document), 'checked_no_detected_gaps');
});

test('fresh real-PDF source anchoring keeps a normal line citable and exportable with isolated synthetic approval', async () => {
  const directory = await mkdtemp(resolve('runtime-data/source-glyph-positive-'));
  try {
    const prepared = freshPreparedSource('L05', directory);
    const document = JSON.parse(await readFile(resolve(prepared.prepared_directory, 'parser-result.json'), 'utf8')).document as StructuredDocumentIR;
    const block = document.blocks.find(b => !b.source_glyph_issues?.length && b.text.length > 15)!;
    assert.ok(block); assert.equal(locateEvidenceFragment(document, { block_id: block.block_id, exact_quote: block.text }).exact_quote, block.text);
    const f = makeEvidenceFixture(); f.context.document = document; f.input.document_id = document.document_id;
    f.input.file_sha256 = document.file_sha256; f.input.fixture = false;
    f.context.allowedBlockIds = document.blocks.map(b => b.block_id); f.context.readBlockIds = [...f.context.allowedBlockIds];
    f.context.metadata.source_version = { ...f.context.metadata.source_version, file_sha256: document.file_sha256, version: 'sha256:' + document.file_sha256 };
    const source = { block_id: block.block_id, exact_quote: block.text };
    f.submission.binding = { ...f.submission.binding, document_id: document.document_id, file_sha256: document.file_sha256,
      text_version: document.text_version, source_version: f.context.metadata.source_version.version };
    f.submission.source_fragments = [source]; f.submission.feature_name_raw = null;
    f.submission.disease_or_lesion = { value: null, status: 'unknown', evidence: [] };
    f.submission.modality = { value: null, status: 'unknown', evidence: [] };
    f.submission.assertion = { value: 'affirmed', original_wording: block.text, evidence: [source] };
    f.submission.provenance.evidence = [source];
    const result = validateEvidenceSubmission(f.submission, f.context); assert.ok(result.record, JSON.stringify(result.issues));
    const versions = [{ record: result.record, version: 1, actor: 'automatic' as const, status: 'active' as const }];
    const delivered = buildEvidenceDelivery(document, versions).records[0]!;
    const review: DeliveryReview = { record_id: delivered.record_id, record_version: 1, text_fingerprint: delivered.text_fingerprint,
      delivery_fingerprint: null, review_scope: 'text_only', decision: 'approved', actor: 'synthetic-functional-test-no-clinical-approval',
      reviewed_at: '2026-11-09T09:00:00Z', source_text_checked: true, relevance_checked: true, context_checked: true,
      figure_pairing_checked: false, reason: 'Isolated export-gate fixture only; no production or medical approval.' };
    const exported = await exportEvidenceDelivery(document, versions, { codeRoot: resolve('.'), directory: resolve(directory, 'export'),
      mode: 'approved', reviews: [review], coverage: { engineering_fixture_only: true, model_calls: 0 } });
    assert.equal(exported.manifest.record_count, 1); assert.equal(exported.delivery.records[0]!.original_fragments[0]!.exact_quote, block.text);
    assert.equal(exported.manifest.medical_quality_approved, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
