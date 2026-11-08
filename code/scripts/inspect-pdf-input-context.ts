/** Pure local model-input projection diagnostics: no provider, API or model session. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { StructuredDocumentIR, EvidenceValidationContext } from '@t1/contracts';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { buildDocumentStructureContext } from '../packages/agent/src/document-structure-context.js';
import { buildArticleScope } from '../packages/agent/src/article-scope.js';
import { ExtractionTools } from '../packages/agent/src/extraction-tools.js';
import { ExtractionStore } from '../packages/agent/src/extraction-store.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../packages/agent/src/visual-evidence-policy.js';
import { SOURCE_EVIDENCE_UNIT_VERSION } from '../packages/agent/src/source-evidence-units.js';
import { makeEvidenceFixture } from '../tests/extraction/fixtures/evidence-fixtures.js';

const root = resolve(process.argv[2] ?? 'docs/acceptance/pdf-input-quality-2026-11-07');
if (!root.startsWith(resolve('docs/acceptance') + '/')) throw new Error('acceptance_output_required');
const load = async (id: string): Promise<StructuredDocumentIR> => JSON.parse(await readFile(resolve(root, `derived/${id}/parser-result.json`), 'utf8')).document;
const writeNew = (name: string, value: unknown) => writeFile(resolve(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const summaries: unknown[] = [];
for (const id of ['L01', 'L05', 'L07', 'L02']) {
  const document = await load(id); assertParsedDocument(document);
  const windows = [];
  for (let start = 0; start < document.blocks.length; start += 64) {
    const blocks = document.blocks.slice(start, start + 128), ids = blocks.map(b => b.block_id);
    const packet = buildDocumentStructureContext(document, ids);
    windows.push({ first_document_line_index: start, source_line_count: ids.length,
      source_text_UTF8_bytes: Buffer.byteLength(blocks.map(b => b.text).join('\n')),
      structure_JSON_UTF8_bytes: Buffer.byteLength(JSON.stringify(packet)),
      omitted_paragraph_hints: packet.available ? packet.omitted_paragraph_hints : 0,
      omitted_heading_hints: packet.available ? packet.omitted_heading_hints : 0,
      omitted_cell_hints: packet.available ? packet.tables.reduce((n, t) => n + t.omitted_cell_hints, 0) : 0,
      withheld_conflicted_cell_hints: packet.available ? packet.tables.reduce((n, t) => n + t.withheld_conflicted_cell_hints, 0) : 0 });
  }
  const article = buildArticleScope(document);
  summaries.push({ source_id: id, file_sha256: document.file_sha256, text_version: document.text_version,
    full_IR_JSON_UTF8_bytes: Buffer.byteLength(JSON.stringify(document)),
    maximum_structure_window_JSON_UTF8_bytes: Math.max(...windows.map(w => w.structure_JSON_UTF8_bytes)), windows,
    article_scope: { included_blocks: article.included_block_ids.length, quarantined_blocks: article.quarantined_block_ids.length,
      regions: article.regions, human_approved: false } });
}

// Exercise the actual statement-protocol tool, rather than merely serializing a helper.
const document = await load('L05'), f = makeEvidenceFixture();
const input = { ...f.input, document_id: document.document_id, file_sha256: document.file_sha256, fixture: false };
const metadata = { ...f.context.metadata, source_version: { ...f.context.metadata.source_version,
  file_sha256: document.file_sha256, version: 'sha256:' + document.file_sha256 } };
const context: EvidenceValidationContext = { ...f.context, input, document, metadata,
  allowedBlockIds: document.blocks.map(b => b.block_id), readBlockIds: [], evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
const store = new ExtractionStore(':memory:');
try {
  store.create(input, metadata); store.transition(input.run_id, 'extracting');
  const blocks = document.blocks.filter(b => b.page === 7 && b.bbox[1]! >= 245 && b.bbox[1]! <= 280), ids = blocks.map(b => b.block_id);
  const tools = new ExtractionTools(context, { batch_id: 'local-table4-input', assigned_block_ids: ids, context_block_ids: [], physical_pages: [7],
    source_code_points: blocks.reduce((n, b) => n + Array.from(b.text).length, 0), order_basis: 'native_mapped_then_source_fallback', warnings: [] },
    buildArticleScope(document), store, 'batch_lines');
  const read = tools.definitions().find(t => t.name === 'read_document_blocks')!;
  const output = await read.execute('local-table4-tool-read', {}, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
  const modelInput = JSON.parse((output.content[0] as { text: string }).text);
  if (modelInput.document_structure.tables[0].cells.length || modelInput.document_structure.tables[0].support_semantics !== 'blocked_due_to_structure_conflict') throw new Error('conflicted_cell_semantics_exposed');
  if (tools.readBlocks.size !== ids.length) throw new Error('unread_heading_context_marked_read');
  if (JSON.stringify(modelInput.source_lines.map((b: { text: string }) => b.text)) !== JSON.stringify(blocks.map(b => b.text))) throw new Error('source_text_changed');
  await writeNew('actual-statement-read-L05-table4.json', modelInput);
  await writeNew('input-context-diagnostics.json', { schema_version: 'pdf-input-context-diagnostics-1', llm_calls: 0, provider_calls: 0,
    source_unit_version: SOURCE_EVIDENCE_UNIT_VERSION, sources: summaries,
    actual_read: { file: 'actual-statement-read-L05-table4.json', JSON_UTF8_bytes: Buffer.byteLength(JSON.stringify(modelInput)),
      raw_source_line_count: ids.length, host_read_line_count: tools.readBlocks.size,
      source_text_exact_and_order_unchanged: true, conflicted_cell_relationships_withheld: true,
      packet_sha256: createHash('sha256').update(JSON.stringify(modelInput)).digest('hex') },
    limits: ['Bytes describe local input structure, not model tokens, latency, quality or cost',
      'Paragraph/cell/heading hint caps are explicit; source text itself is never truncated by this projection',
      'Headings outside the window are processed native display context; they are neither literal evidence nor marked read'] });
} finally { store.close(); }
console.log(JSON.stringify({ sources: 4, actual_tool_reads: 1, llm_calls: 0, provider_calls: 0, output: root }));
