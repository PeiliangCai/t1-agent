import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { reconcileEvidence } from '../../packages/agent/src/reconciliation.js';
import { buildArticleScope } from '../../packages/agent/src/article-scope.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../../packages/agent/src/visual-evidence-policy.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture, type ResponsesStep } from './fixtures/runtime-responses.js';
import { createExtractionSession, developmentProfile, promptExtractionSession } from '../../packages/agent/src/extraction-pi.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';

const params = { summary: 'Synthetic transaction and coverage test only.', reviews: [], links: [], updates: [], summary_complete: true };
function context(texts?: string[]) {
  const f = makeEvidenceFixture(texts), store = new ExtractionStore(':memory:');
  store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
  const record = validateEvidenceSubmission(f.submission, f.context).record!;
  store.apply(f.input.run_id, reconcileEvidence(record, [])); store.transition(f.input.run_id, 'reconciling');
  const tools = new ExtractionSummaryTools({ ...f.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION }, buildArticleScope(f.document), store, 'independent_context_review');
  const invoke = (name: string, value: unknown) => tools.invoke(name, { run_id: f.input.run_id, document_id: f.input.document_id, ...value as object }, 'summary-fixture');
  const execute = (name: string, value: unknown) => {
    const definition = tools.definitions().find(d => d.name === name)!;
    return definition.execute('summary-model-fixture', value, undefined, undefined, {} as Parameters<typeof definition.execute>[4]);
  };
  return { f, store, tools, record, invoke, execute };
}

test('a failed summary submission rolls back prior reviews and every write in the same call', async () => {
  const c = context();
  try {
    await c.invoke('get_document_context', {});
    const before = c.store.versions(c.f.input.run_id), events = c.store.events(c.f.input.run_id);
    await assert.rejects(c.invoke('submit_candidate_records', { ...params,
      reviews: [{ record_id: c.record.record_id, expected_version: 1, issue_codes: [] }], updates: [c.f.submission] }), /summary_update_validation_failed/);
    assert.deepEqual(c.store.versions(c.f.input.run_id), before);
    const after = c.store.events(c.f.input.run_id);
    assert.deepEqual(after.filter(e => e.type !== 'summary_submission_rejected'), events);
    const diagnostic = after.find(e => e.type === 'summary_submission_rejected')!;
    assert.equal(diagnostic.detail.evidence_changes_saved, false); assert.equal(diagnostic.detail.atomic_evidence_rollback, true);
    assert.ok(diagnostic.detail.validation_issues.some((i: { code: string }) => i.code === 'source_block_not_read'));
    assert.equal(c.tools.reviewedIds.size, 0); assert.equal(c.tools.completed, false);
  } finally { c.store.close(); }
});

test('an exact submitted review is idempotent after a saved incomplete summary and completion blockers disclose current versions', async () => {
  const c = context();
  try {
    await c.invoke('get_document_context', {});
    const submission = { ...params, reviews: [{ record_id: c.record.record_id, expected_version: 1, issue_codes: [] }], summary_complete: false };
    await c.invoke('submit_candidate_records', submission);
    const count = c.store.versions(c.f.input.run_id).length;
    await c.invoke('submit_candidate_records', submission);
    assert.equal(c.store.versions(c.f.input.run_id).length, count);
    assert.equal(c.tools.completed, false);
  } finally { c.store.close(); }
});

test('new source updates are explicitly saved with complete=false until their current candidate context is read and reviewed', async () => {
  const c = context(['We observed spiculation on CT in lung cancer.', 'We observed lobulation on CT in lung cancer.']);
  try {
    await c.invoke('get_document_context', {}); await c.execute('read_document_blocks', { line_indices: [1] });
    const result = await c.execute('submit_candidate_records', { ...params, reviews: [{ record_id: c.record.record_id, expected_version: 1, issue_codes: [] }],
      updates: [{ source_unit_ids: ['su-000002'], feature_name_raw: 'lobulation', feature_category: 'margin', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors' }] });
    const body = JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}');
    assert.equal(body.summary_recorded, true); assert.equal(body.complete, false); assert.equal(c.tools.completed, false);
    assert.ok(body.completion_blockers.some((b: { code: string }) => b.code === 'summary_requires_all_candidate_context_read'));
    assert.equal(body.current_versions.length, 2); assert.equal(body.saved_updates[0].action, 'insert');
    assert.equal(c.store.current(c.f.input.run_id).length, 2);
    await c.invoke('get_document_context', {});
    const latest = c.store.current(c.f.input.run_id).find(v => v.record.feature_name_raw === 'lobulation')!;
    await c.invoke('submit_candidate_records', { ...params, reviews: [{ record_id: latest.record.record_id, expected_version: latest.version, issue_codes: [] }] });
    assert.equal(c.tools.completed, true);
  } finally { c.store.close(); }
});

test('a missing independent review is an explicit completion blocker and never marks summary complete', async () => {
  const c = context();
  try {
    await c.invoke('get_document_context', {});
    const result = await c.invoke('submit_candidate_records', params) as { complete: boolean; completion_blockers: Array<{ code: string }> };
    assert.equal(result.complete, false); assert.equal(c.tools.completed, false);
    assert.ok(result.completion_blockers.some(b => b.code === 'independent_review_coverage_incomplete'));
  } finally { c.store.close(); }
});

test('actual L05 source reads return complete exact units only within the current bounded window, never the historical read union', async () => {
  const c = context();
  try {
    const raw = JSON.parse(await readFile(new URL('../../docs/acceptance/user-feedback-2026-11-05/revalidation/sources/L05/parser-result.json', import.meta.url), 'utf8'));
    const document = raw.document ?? raw;
    assert.equal(document.blocks.length, 615);
    const tools = new ExtractionSummaryTools({ ...c.f.context, document, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION }, buildArticleScope(document), c.store, 'baseline');
    const read = tools.definitions().find(d => d.name === 'read_document_blocks')!;
    const bodies: any[] = [];
    for (const start of [0, 128, 256, 384, 512]) {
      const result = await read.execute('actual-L05-local-read', { line_indices: Array.from({ length: Math.min(128, 615 - start) }, (_, i) => start + i) }, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
      assert.equal(result.content[0]!.type, 'text'); const body = JSON.parse((result.content[0] as { text: string }).text); bodies.push(body);
      const expectedStart = Math.max(0, Math.min(start + 128, 615) - 128), expectedEnd = Math.min(start + 128, 615);
      assert.ok(body.source_units.every((u: { line_spans: Array<{ line_index: number }> }) => u.line_spans.every(s =>
        s.line_index >= expectedStart && s.line_index < expectedEnd)), 'source units must not repeat historical lines outside the current read working set');
      const window = body.source_window as { line_indices: number[]; maximum_lines: number };
      assert.ok(window.line_indices.length <= 128); assert.equal(window.maximum_lines, 128);
      assert.ok(body.source_units.every((u: { line_spans: Array<{ line_index: number }> }) => u.line_spans.every(s => window.line_indices.includes(s.line_index))));
      for (const b of body.blocks) assert.equal(b.text, document.blocks[b.line_index].text);
    }
    assert.equal(tools.readBlocks.size, 615);
    assert.equal(tools.completed, false); assert.equal(c.store.snapshot(c.f.input.run_id).state, 'reconciling');
    assert.ok(!bodies.at(-1).source_window.line_indices.includes(0));
  } finally { c.store.close(); }
});

test('repeated large raw reads send one exact source working set through installed Pi and still finish under the unchanged limits', async () => {
  const c = context(Array.from({ length: 64 }, (_, i) => `We observed spiculation on CT in lung cancer with synthetic marker ${i} ${'synthetic '.repeat(240)}.`));
  const directory = await mkdtemp(join(tmpdir(), 'summary-bounded-wire-'));
  const lines = Array.from({ length: 64 }, (_, i) => i);
  const steps: ResponsesStep[] = [{ calls: [{ name: 'get_document_context', arguments: {} }] },
    ...Array.from({ length: 8 }, () => ({ calls: [{ name: 'read_document_blocks', arguments: { line_indices: lines } }] })),
    { calls: [{ name: 'submit_candidate_records', arguments: { ...params, reviews: [{ record_id: c.record.record_id, expected_version: 1, issue_codes: [] }] } }] }];
  const server = await createRuntimeResponsesFixture(steps);
  try {
    const budget = new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint);
    const created = await createExtractionSession(server.config, developmentProfile(server.config.modelId), c.tools.definitions(), directory, budget, 'loopback-summary-working-set', 0, 16);
    const transform = created.session.agent.transformContext;
    created.session.agent.transformContext = async (messages, signal) => c.tools.projectModelMessages(transform ? await transform(messages, signal) : messages);
    created.session.agent.finishTurn = () => c.tools.completed ? { action: 'end' } : undefined;
    const result = await promptExtractionSession(created, 'Synthetic bounded raw-source reread test only.', budget);
    assert.equal(result.error, undefined); assert.equal(c.tools.completed, true); assert.equal(server.requests.length, 10);
    assert.equal(created.audit.application_context_estimate_limit, 128000);
    for (const request of server.requests) {
      const outputs = request.tool_results.map(r => { try { return JSON.parse(r.output); } catch { return null; } });
      const windows = outputs.filter(o => o?.blocks);
      assert.ok(windows.length <= 1, 'older raw-source payloads must be replaced with explicit transport receipts');
      for (const w of windows) for (const b of w.blocks) assert.equal(b.text, c.f.document.blocks[b.line_index]!.text);
    }
    assert.equal(c.tools.readBlocks.size, 64); assert.equal(budget.totals().requests, 10);
    const starts = result.events.filter(e => e.type === 'tool_execution_start' && e.tool === 'read_document_blocks');
    assert.equal(starts.length, 8); assert.deepEqual((starts[0]!.selectors as { line_indices: number[] }).line_indices, lines);
  } finally { c.store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an evicted source line remains in read history but cannot support an update until explicitly reread', async () => {
  const c = context(Array.from({ length: 129 }, (_, i) => `We observed spiculation on CT in lung cancer with synthetic marker ${i}.`));
  try {
    await c.execute('read_document_blocks', { line_indices: [0] });
    await c.execute('read_document_blocks', { line_indices: Array.from({ length: 128 }, (_, i) => i + 1) });
    assert.ok(c.tools.readBlocks.has(c.f.document.blocks[0]!.block_id));
    await assert.rejects(c.invoke('submit_candidate_records', { ...params, updates: [c.f.submission], summary_complete: false }), /summary_update_validation_failed/);
    await c.execute('read_document_blocks', { line_indices: [0] });
    await c.invoke('submit_candidate_records', { ...params, updates: [c.f.submission], summary_complete: false });
    assert.equal(c.tools.completed, false); assert.equal(c.tools.readBlocks.size, 129);
  } finally { c.store.close(); }
});

test('cross-line sentences expose missing context explicitly and remain exact when read together again', async () => {
  const c = context(['We observed spiculation on CT in lung cancer with', 'an irregular margin and no calcification.']);
  try {
    c.f.document.structure.units.push({ unit_id: 'synthetic-complete-paragraph', native_ref: '#/test/paragraph', kind: 'text', native_label: 'text',
      native_text: 'Untrusted processed native text.', native_original_text: null, native_text_role: 'processed_native_not_literal_quote', content_layer: 'body',
      source_segments: c.f.document.blocks.map(b => ({ block_id: b.block_id, text_version: c.f.document.text_version, start: 0, end: Array.from(b.text).length })),
      provenance: [], mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_3', matched_native_code_points: 1,
        alignable_native_code_points: 1, transformations: [], warnings: [] } });
    const first = await c.execute('read_document_blocks', { line_indices: [0] });
    const firstBody = JSON.parse((first.content[0] as { text: string }).text);
    assert.ok(firstBody.source_units_needing_reread.some((u: { required_document_line_indices: number[] }) =>
      u.required_document_line_indices.includes(0) && u.required_document_line_indices.includes(1)));
    const together = await c.execute('read_document_blocks', { line_indices: [0, 1] });
    const body = JSON.parse((together.content[0] as { text: string }).text);
    const unit = body.source_units.find((u: { line_spans: Array<{ line_index: number }> }) => u.line_spans.some(s => s.line_index === 0) && u.line_spans.some(s => s.line_index === 1));
    assert.ok(unit); assert.equal(unit.completeness, 'complete');
    assert.deepEqual(body.blocks.map((b: { text: string }) => b.text), c.f.document.blocks.map(b => b.text));
    assert.equal(c.tools.completed, false);
  } finally { c.store.close(); }
});
