import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { StructuredDocumentIR, EvidenceValidationContext } from '@t1/contracts';
import { buildDocumentStructureContext, tableStructureStatus } from '../../packages/agent/src/document-structure-context.js';
import { classifySourceSpan, buildSourceEvidenceUnits } from '../../packages/agent/src/source-evidence-units.js';
import { visualStatementIssues, VISUAL_STATEMENT_POLICY_VERSION } from '../../packages/agent/src/visual-evidence-policy.js';
import { assertParsedDocument } from '../../packages/agent/src/parser.js';
import { buildArticleScope } from '../../packages/agent/src/article-scope.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

const load = async (id: string): Promise<StructuredDocumentIR> => JSON.parse(await readFile(
  new URL(`../../docs/acceptance/pdf-input-quality-2026-11-07/derived/${id}/parser-result.json`, import.meta.url), 'utf8')).document;
const full = (doc: StructuredDocumentIR, suffix: string) => {
  const b = doc.blocks.find(b => b.block_id.endsWith(suffix))!;
  assert.ok(b, suffix);
  return { block_id: b.block_id, text_version: doc.text_version, start: 0, end: Array.from(b.text).length };
};
function context(document: StructuredDocumentIR) {
  const f = makeEvidenceFixture();
  const input = { ...f.input, document_id: document.document_id, file_sha256: document.file_sha256, fixture: false };
  const metadata = { ...f.context.metadata, source_version: { ...f.context.metadata.source_version,
    file_sha256: document.file_sha256, version: 'sha256:' + document.file_sha256 } };
  const context: EvidenceValidationContext = { ...f.context, input, document, metadata,
    allowedBlockIds: document.blocks.map(b => b.block_id), readBlockIds: [], evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
  const store = new ExtractionStore(':memory:'); store.create(input, metadata); store.transition(input.run_id, 'extracting');
  return { context, store, article: buildArticleScope(document) };
}

test('real L05 conflicted raw table rows retain table role and cannot become primary or numeric support', async () => {
  const doc = await load('L05'), table = doc.structure.tables.find(t => t.native_ref === '#/tables/3')!;
  assert.equal(tableStructureStatus(doc, table).support_semantics, 'blocked_due_to_structure_conflict');
  // The native cell containing N/Y is unmapped; the raw table source row remains located.
  const tableSource = full(doc, 'p0007-l000092');
  assert.equal(classifySourceSpan(doc, tableSource), 'table');
  const block = doc.blocks.find(b => b.block_id === tableSource.block_id)!;
  const fragment = { ...tableSource, exact_quote: block.text, physical_page: block.page, bbox: block.bbox,
    location_precision: 'whole_textline_not_exact_glyph' as const, occurrence: 0 };
  const primary = visualStatementIssues(doc, { evidence_type: 'imaging_observation' }, [fragment], [], [], []);
  assert.ok(primary.some(i => i.code === 'table_evidence_cannot_be_primary' && i.severity === 'reject'));
  const support = visualStatementIssues(doc, { evidence_type: 'imaging_observation' }, [], [], [], [{ table_id: table.table_id, reference_evidence: [], fragments: [fragment] }]);
  assert.ok(support.some(i => i.code === 'supporting_table_structure_conflict' && i.severity === 'reject'));
  const normalBody = doc.blocks.find(b => b.page === 7 && b.text.startsWith('We focused'))!;
  assert.ok(normalBody); assert.notEqual(classifySourceSpan(doc, { block_id: normalBody.block_id, text_version: doc.text_version, start: 0, end: Array.from(normalBody.text).length }), 'table');
  const caption = doc.structure.units.find(u => u.native_ref === '#/texts/92')!;
  assert.ok(caption.native_text.startsWith('Table 4'));
  assert.equal(classifySourceSpan(doc, caption.source_segments[0]!), 'table_caption');
});

test('known source-conflicted grids are withheld while unverified tables keep native cell hints', async () => {
  const doc = await load('L05'), selected = doc.blocks.filter(b => b.page === 7).map(b => b.block_id);
  const packet = buildDocumentStructureContext(doc, selected);
  assert.equal(packet.available, true);
  if (!packet.available) return;
  const t = packet.tables.find(t => t.layout_status === 'source_conflict')!;
  assert.ok(t); assert.deepEqual(t.cells, []); assert.ok(t.withheld_conflicted_cell_hints > 0);
  assert.ok(t.source_rows.length >= 20); assert.equal(t.header_relationship_status, 'withheld_due_to_structure_conflict');
  const unverified = buildDocumentStructureContext(doc, doc.blocks.filter(b => b.page === 5).map(b => b.block_id));
  if (!unverified.available) return;
  assert.ok(unverified.tables.some(t => t.support_semantics === 'unverified' && t.cells.length > 0));
});

test('a cross-page continuation candidate cannot certify the following Chinese sentence start as complete', async () => {
  const doc = await load('L01'), target = doc.structure.units.find(u => u.native_ref === '#/texts/19')!;
  const first = buildSourceEvidenceUnits(doc).find(u => u.segments.some(s => s.block_id === target.source_segments[0]!.block_id))!;
  assert.ok(first); assert.equal(first.completeness, 'unverified');
  assert.ok(first.boundary_reasons.includes('sentence_start_unverified'));
  assert.ok(first.segments[0]!.exact_quote.startsWith('敏'));
  assert.ok(!first.segments.some(s => s.physical_page === 1));
});

test('heading semantics outside the read window stay bounded processed context, without silently marking source read', async () => {
  const doc = await load('L05'), paragraph = doc.structure.units.find(u => u.native_ref === '#/texts/51')!;
  const one = doc.blocks.find(b => b.block_id === paragraph.source_segments[0]!.block_id)!;
  const packet = buildDocumentStructureContext(doc, [one.block_id], [one.block_id], [one.block_id]);
  if (!packet.available) return;
  assert.ok(packet.headings.some(h => h.native_title_display.length > 0 && !h.source_text_in_window));
  assert.ok(packet.headings.every(h => h.title_display_role === 'processed_native_context_not_literal_quote_or_read_source'));
  assert.equal(packet.referenced_unread_lines_are_not_read, true); assert.equal(packet.body_source_text_copied, false);
  assert.ok(packet.paragraphs.every(p => p.line_spans.every(s => s[0] === 0)));
});

test('the actual statement read tool preserves source lines plus bounded structure and does not read external heading context', async () => {
  const doc = await load('L05'), c = context(doc), blocks = doc.blocks.filter(b => b.page === 7 && b.bbox[1]! >= 245 && b.bbox[1]! <= 280);
  const ids = blocks.map(b => b.block_id);
  try {
    const tools = new ExtractionTools(c.context, { batch_id: 'pdf-structure-window', assigned_block_ids: ids, context_block_ids: [], physical_pages: [7],
      source_code_points: blocks.reduce((n, b) => n + Array.from(b.text).length, 0), order_basis: 'native_mapped_then_source_fallback', warnings: [] }, c.article, c.store, 'batch_lines');
    const read = tools.definitions().find(t => t.name === 'read_document_blocks')!;
    const result = await read.execute('pdf-structure-read', {}, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    assert.deepEqual(body.source_lines.map((b: any) => b.text), blocks.map(b => b.text));
    assert.equal(body.document_structure.tables[0].support_semantics, 'blocked_due_to_structure_conflict');
    assert.deepEqual(body.document_structure.tables[0].cells, []);
    assert.equal(tools.readBlocks.size, ids.length);
    assert.equal(body.document_structure.referenced_unread_lines_are_not_read, true);
    assert.ok(body.source_units.every((u: any) => u.source_type === 'table'));
  } finally { c.store.close(); }
});

test('summary read projection evicts old structure together with its raw source window', async () => {
  const doc = await load('L05'), c = context(doc);
  try {
    c.store.transition(c.context.input.run_id, 'reconciling');
    const tools = new ExtractionSummaryTools(c.context, c.article, c.store, 'baseline');
    const read = tools.definitions().find(t => t.name === 'read_document_blocks')!;
    const tableLine = doc.blocks.findIndex(b => b.block_id.endsWith('p0007-l000092'));
    const first = await read.execute('table-read', { line_indices: [tableLine] }, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
    const second = await read.execute('later-read', { line_indices: Array.from({ length: 128 }, (_, i) => i) }, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
    const message = (result: typeof first, id: string) => ({ role: 'toolResult' as const, toolCallId: id, toolName: 'read_document_blocks', content: result.content,
      isError: false, timestamp: 0 });
    const projected = tools.projectModelMessages([message(first, 'table-read'), message(second, 'later-read')]);
    const latest = projected[1]!; assert.equal(latest.role, 'toolResult');
    if (latest.role !== 'toolResult') throw new Error('expected_tool_result');
    const body = JSON.parse((latest.content[0] as { text: string }).text);
    assert.equal(body.source_window.line_indices.length, 128); assert.ok(!body.source_window.line_indices.includes(tableLine));
    assert.ok(!body.document_structure.tables.some((t: any) => t.layout_status === 'source_conflict'));
    assert.ok(body.document_structure.paragraphs.every((p: any) => p.line_spans.every((s: number[]) => body.source_window.line_indices.includes(s[0]))));
    assert.ok(tools.readBlocks.has(doc.blocks[tableLine]!.block_id));
    assert.equal(body.document_structure.referenced_unread_lines_are_not_read, true);
  } finally { c.store.close(); }
});

test('real 128-line projections stay below 20KB and never replace or reorder the source lines', async () => {
  for (const id of ['L01', 'L05']) {
    const doc = await load(id); assertParsedDocument(doc);
    const before = JSON.stringify(doc.blocks);
    for (let start = 0; start < doc.blocks.length; start += 64) {
      const ids = doc.blocks.slice(start, start + 128).map(b => b.block_id);
      const p = buildDocumentStructureContext(doc, ids);
      assert.ok(Buffer.byteLength(JSON.stringify(p)) < 20_000, `${id}/${start}`);
      if (p.available) { assert.ok(p.paragraphs.length <= 24); assert.ok(p.headings.length <= 16); assert.ok(p.tables.every(t => t.cells.length <= 24)); }
    }
    assert.equal(JSON.stringify(doc.blocks), before);
    const broken = structuredClone(doc); broken.structure.organization!.heading_paths[0]!.parent_unit_id = 'missing-heading';
    assert.throws(() => assertParsedDocument(broken), /invalid_structure_heading_path/);
  }
});
