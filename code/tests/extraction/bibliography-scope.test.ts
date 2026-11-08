import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildArticleScope, type ExtractionDocument } from '../../packages/agent/src/article-scope.js';
import { planPaperMethods } from '../../packages/agent/src/method-comparison.js';
import { assertParsedDocument } from '../../packages/agent/src/parser.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { assertTaskSourceAccess, BIBLIOGRAPHY_SCOPE_RULE_VERSION } from '../../packages/agent/src/source-selection.js';
import { SOURCE_EVIDENCE_UNIT_VERSION } from '../../packages/agent/src/source-evidence-units.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../../packages/agent/src/visual-evidence-policy.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const root = new URL('../../docs/acceptance/pdf-structure-review-2026-11-07/', import.meta.url);

for (const sourceId of ['L01', 'L05', 'L07']) test(`${sourceId} final unit4 real IR: actual batch inputs exclude only shared bibliography and model reread cannot restore it`, async () => {
  const path = new URL(`derived/${sourceId}/parser-result.json`, root), bytes = await readFile(path);
  const document = JSON.parse(bytes.toString('utf8')).document as ExtractionDocument;
  assertParsedDocument(document);
  assert.equal(SOURCE_EVIDENCE_UNIT_VERSION, 'literal-source-sentences-4');
  const pdfPath = new URL('../../' + document.source.file_reference.replace(/^code\//, ''), import.meta.url), pdfBefore = sha(await readFile(pdfPath));
  assert.equal(pdfBefore, document.file_sha256);
  const before = JSON.stringify(document), article = buildArticleScope(document),
    planned = planPaperMethods(document, { offline_scope_check: true }, { maxCodePoints: 8500, maxBlocks: 128, contextBlocks: 6 });
  assert.deepEqual(planned.jobs[0]!.selection.excluded_block_ids, planned.jobs[1]!.selection.excluded_block_ids);
  assert.ok(planned.jobs[0]!.selection.excluded_block_ids.length > 0);
  assert.equal(article.quarantined_block_ids.length, 0);
  for (const job of planned.jobs) {
    const excluded = new Set(job.selection.excluded_block_ids), f = makeEvidenceFixture(undefined, { runId: sourceId + '-' + job.condition, documentId: sourceId });
    f.input.document_id = sourceId; f.input.file_sha256 = document.file_sha256; f.input.fixture = false;
    const context = { ...f.context, input: f.input, document,
      metadata: { ...f.context.metadata, source_version: { ...f.context.metadata.source_version, file_sha256: document.file_sha256, version: 'sha256:' + document.file_sha256 } },
      evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
    const store = new ExtractionStore(':memory:'); store.create(f.input, context.metadata); store.transition(f.input.run_id, 'extracting');
    try {
      for (const entry of job.selection.entries.filter(e => e.state === 'excluded')) {
        assert.equal(entry.article_eligible, true); assert.deepEqual(entry.rule_ids, ['TASK_BIBLIOGRAPHY_EXCLUDED']);
      }
      const dispatched = new Set<string>();
      for (const batch of job.batches) {
        const ids = [...new Set([...batch.assigned_block_ids, ...batch.context_block_ids])];
        assert.ok(ids.every(id => !excluded.has(id)), 'complete-statement boundary context must not restore bibliography');
        const tools = new ExtractionTools(context, batch, article, store, 'batch_lines'), read = tools.definitions().find(t => t.name === 'read_document_blocks')!;
        const response = await read.execute('offline-batch-read', {}, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
        const payload = JSON.parse((response.content[0] as { text: string }).text);
        assert.equal(payload.source_lines.length, ids.length);
        for (const line of payload.source_lines as Array<{ line_index: number; text: string }>) {
          const id = ids[line.line_index]!;
          assert.ok(id && !excluded.has(id)); assert.equal(line.text, document.blocks.find(b => b.block_id === id)!.text); dispatched.add(id);
        }
        assertTaskSourceAccess(payload, excluded);
      }
      assert.ok(job.selection.kept_block_ids.every(id => dispatched.has(id)));
      store.transition(f.input.run_id, 'reconciling');
      const summary = new ExtractionSummaryTools(context, article, store, 'baseline', [], job.selection), binding = { run_id: f.input.run_id, document_id: sourceId };
      const inventory = await summary.invoke('get_document_context', binding, 'offline-summary-context') as {
        input_selection: { bibliography_scope_rule_version: string; source_pages: Array<{ authorized_document_line_indices: number[] }> } };
      assert.equal(inventory.input_selection.bibliography_scope_rule_version, BIBLIOGRAPHY_SCOPE_RULE_VERSION);
      assert.ok(inventory.input_selection.source_pages.flatMap(p => p.authorized_document_line_indices).every(i => !excluded.has(document.blocks[i]!.block_id)));
      assertTaskSourceAccess(inventory, excluded);
      const read = summary.definitions().find(t => t.name === 'read_document_blocks')!;
      const toolContext = {} as Parameters<typeof read.execute>[4];
      for (const selector of [{ block_ids: [...excluded].slice(0, 128) }, { line_indices: [...excluded].slice(-128).map(id => document.blocks.findIndex(b => b.block_id === id)) }])
        await assert.rejects(read.execute('offline-summary-denied', selector, undefined, undefined, toolContext), /bibliography_read_outside_task_scope/);
      assert.equal(summary.readBlocks.size, 0);
      const deferredOrKept = (job.selection.deferred_block_ids[0] ?? job.selection.kept_block_ids[0])!;
      const response = await read.execute('offline-summary-allowed', { block_ids: [deferredOrKept] }, undefined, undefined, toolContext);
      const payload = JSON.parse((response.content[0] as { text: string }).text);
      assertTaskSourceAccess(payload, excluded); assert.equal(payload.blocks[0].text, document.blocks.find(b => b.block_id === deferredOrKept)!.text);
      assert.equal(summary.readBlocks.has(deferredOrKept), true);
    } finally { store.close(); }
  }
  // Historical unmerged cross-boundary reference candidates are left in the IR
  // and available when no complete bibliographic entry can safely be identified.
  const cases = JSON.parse(await readFile(new URL('review-cases-tables-continuations.json', root), 'utf8')).cases;
  for (const c of cases.filter((c: { source_id: string; after: { status?: string } }) => c.source_id === sourceId && c.after.status === 'needs_user_review')) {
    const sourceIds = c.after.ordered_parts.flatMap((p: { segments: Array<{ block_id: string }> }) => p.segments.map(s => s.block_id));
    assert.ok(sourceIds.every((id: string) => !planned.jobs[0]!.selection.excluded_block_ids.includes(id)));
  }
  assert.equal(JSON.stringify(document), before); assert.equal(sha(await readFile(path)), sha(bytes)); assert.equal(sha(await readFile(pdfPath)), pdfBefore);
});
