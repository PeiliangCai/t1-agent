import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionBudget, S4_LIMITS } from '../../packages/agent/src/extraction-budget.js';
import { buildArticleScope, planExtractionBatches } from '../../packages/agent/src/article-scope.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture, type ResponsesStep } from './fixtures/runtime-responses.js';

async function temporary<T>(body: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 's4-reliability-v2-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const batchZero: ResponsesStep = { calls: [{ name: 'read_document_blocks', arguments: {} },
  { name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] };
const summaryZero: ResponsesStep = { calls: [{ name: 'get_document_context', arguments: {} },
  { name: 'submit_candidate_records', arguments: { summary: 'Synthetic only.', reviews: [], links: [], updates: [], summary_complete: true } }] };
function context() {
  const fixture = makeEvidenceFixture(['Synthetic table line.', 'A different batch source.']);
  const store = new ExtractionStore(':memory:'); store.create(fixture.input, fixture.context.metadata); store.transition(fixture.input.run_id, 'extracting');
  const article = buildArticleScope(fixture.document), batch = planExtractionBatches(fixture.document, article, { maxBlocks: 1, contextBlocks: 0 })[0]!;
  const tools = new ExtractionTools(fixture.context, batch, article, store, 'batch_lines');
  const execute = (name: string, params: Record<string, unknown>) => {
    const definition = tools.definitions().find(tool => tool.name === name)!;
    return definition.execute('synthetic-' + name, params, undefined, undefined, {} as Parameters<typeof definition.execute>[4]);
  };
  return { fixture, store, tools, execute };
}

test('closed issue omission binds assigned IDs but never reads, completes or fabricates zero candidates', async () => {
  const c = context();
  try {
    await c.execute('report_context_issue', { reason: 'Synthetic missing table header.' });
    const issue = c.store.events(c.fixture.input.run_id).find(e => e.type === 'context_issue')!;
    assert.deepEqual(issue.detail.block_ids, [c.fixture.document.blocks[0]!.block_id]);
    assert.equal(c.tools.readBlocks.size, 0); assert.equal(c.tools.completed, false);
    assert.equal(c.store.current(c.fixture.input.run_id).length, 0);
    await assert.rejects(c.execute('report_context_issue', { reason: 'Guessed opaque batch ID.', block_ids: ['batch-0005'] }), /schema_validation_failed/);
    await assert.rejects(c.tools.invoke('report_context_issue', { ...c.tools.ids, reason: 'Legacy unauthorized ID.', block_ids: ['batch-0005'] }, 'raw'), /issue_block_not_authorized/);
    await assert.rejects(c.tools.invoke('report_context_issue', { ...c.tools.ids, reason: 'Legacy cross batch ID.', block_ids: [c.fixture.document.blocks[1]!.block_id] }, 'raw-cross'), /issue_block_not_authorized/);
  } finally { c.store.close(); }
});

test('closed issue indices must be returned/read and in this batch; host supplies the source ID', async () => {
  const c = context();
  try {
    await assert.rejects(c.execute('report_context_issue', { reason: 'Not yet read.', line_indices: [0] }), /issue_source_line_not_read/);
    await c.execute('read_document_blocks', {});
    await c.execute('report_context_issue', { reason: 'Synthetic table ambiguity.', line_indices: [0] });
    assert.deepEqual(c.tools.issues[0]!.block_ids, [c.fixture.document.blocks[0]!.block_id]);
    assert.equal(c.tools.completed, false);
    await assert.rejects(c.execute('report_context_issue', { reason: 'Outside allowed table.', line_indices: [1] }), /source_line_index_out_of_range/);
    await assert.rejects(c.execute('report_context_issue', { reason: 'Out of range.', line_indices: [256] }), /schema_validation_failed/);
  } finally { c.store.close(); }
});

async function runLocal(directory: string, steps: Parameters<typeof createRuntimeResponsesFixture>[0],
  options: { fixture?: ReturnType<typeof makeEvidenceFixture>; store?: ExtractionStore; oneRequestBudget?: boolean } = {}) {
  const server = await createRuntimeResponsesFixture(steps), fixture = options.fixture ?? makeEvidenceFixture(), store = options.store ?? new ExtractionStore(':memory:');
  const budget = new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint, Date.now, options.oneRequestBudget ? {
    limits: { ...S4_LIMITS, requests: 1 }, authorization: { id: 'synthetic-one-request', source: 'synthetic:no-network-outside-loopback', recorded_at: '2026-11-03T00:00:00Z' },
  } : {});
  fixture.input.runtime_profile = { ...fixture.input.runtime_profile, provider: server.config.provider, model_id: server.config.modelId, endpoint: server.endpoint };
  try {
    const result = await runExtractionDocument({ input: fixture.input, document: fixture.document, catalog: fixture.catalog, metadata: fixture.context.metadata,
      profile: developmentProfile(server.config.modelId), config: server.config, budget, store, directory: join(directory, 'run'), strategy: 'baseline' });
    return { result, requests: server.requests.length, budget };
  } finally { await server.close(); if (!options.store) store.close(); }
}

test('exact missing-terminal EOF retries a batch while retaining the failed unknown reservation', async () => {
  await temporary(async directory => {
    const { result, requests, budget } = await runLocal(directory, [{ text: 'Synthetic truncation.', omit_terminal_event: true }, batchZero, summaryZero]);
    assert.equal(result.error, undefined); assert.equal(requests, 3);
    assert.equal(result.coverage.explicitly_completed_source_blocks, 1);
    assert.equal(result.events.filter(e => e.type === 'retry').length, 1);
    assert.equal(budget.ledger.requests[0]!.error_code, 'provider_stream_missing_terminal_event');
    assert.equal(budget.ledger.requests[0]!.usage_status, 'missing_usage_conservative_reservation');
    assert.equal(budget.totals().conservative_missing_usage_requests, 1);
    assert.ok(budget.totals().input_tokens >= budget.ledger.requests[0]!.input_ceiling);
  });
});

test('whole-paper summary stops after two fresh-session retries and preserves all three failures', async () => {
  await temporary(async directory => {
    const eof: ResponsesStep = { text: 'Synthetic truncation.', omit_terminal_event: true };
    const { result, requests, budget } = await runLocal(directory, [batchZero, eof, eof, eof]);
    assert.equal(requests, 4); assert.equal(result.error?.code, 'whole_document_summary_incomplete');
    assert.equal(result.summary_attempts.length, 3);
    assert.equal(result.events.filter(e => e.type === 'summary_retry').length, 2);
    assert.equal(result.coverage.source_block_processing_complete, true);
    assert.equal(result.coverage.whole_document_summary_complete, false);
    assert.equal(result.coverage.full_document_extraction_completed, false);
    assert.equal(budget.totals().conservative_missing_usage_requests, 3);
  });
});

test('fresh summary retry re-reads current versions and keeps a concurrent human revision active with model proposals', async () => {
  await temporary(async directory => {
    const fixture = makeEvidenceFixture(), store = new ExtractionStore(':memory:');
    let recordId = '';
    const steps = (request: { index: number }): ResponsesStep => {
      if (request.index === 0) return { calls: [
        { name: 'read_document_blocks', arguments: {} }, { name: 'submit_candidate_records', arguments: { records: [{ source_line_indices: [0], feature_name_raw: 'spiculation',
          feature_category: 'margin', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors',
          disease_or_lesion: { value: 'lung cancer', line_indices: [0] }, modality: { value: 'CT', line_indices: [0] } }], batch_complete: true } },
      ] };
      if (request.index === 1 || request.index === 3) return { calls: [{ name: 'get_document_context', arguments: {} }] };
      if (request.index === 2) {
        const current = store.current(fixture.input.run_id)[0]!; recordId = current.record.record_id;
        const human = structuredClone(current); human.version = 2; human.actor = 'human'; human.reason = 'synthetic-human-edit-during-EOF';
        human.record.translation_zh = 'Synthetic human revision retained.';
        store.db.prepare('INSERT INTO s4_versions VALUES(?,?,?,?)').run(fixture.input.run_id, recordId, 2, JSON.stringify(human));
        return { omit_terminal_event: true };
      }
      return { calls: [{ name: 'submit_candidate_records', arguments: { summary: 'Synthetic transport recovery only.',
        reviews: [{ record_id: recordId, expected_version: 2, issue_codes: [], primary_assessment: 'uncertain' }], links: [], updates: [], summary_complete: true } }] };
    };
    try {
      const { result, requests } = await runLocal(directory, steps, { fixture, store });
      assert.equal(result.error, undefined); assert.equal(requests, 5); assert.equal(result.summary_attempts.length, 2);
      const active = store.current(fixture.input.run_id)[0]!;
      assert.equal(active.actor, 'human'); assert.equal(active.version, 2);
      assert.equal(active.record.translation_zh, 'Synthetic human revision retained.');
      assert.ok(store.versions(fixture.input.run_id).some(v => v.version === 3 && v.status === 'proposed' && v.actor === 'automatic'));
    } finally { store.close(); }
  });
});

test('a shared hard budget prevents EOF retries after its last permitted physical request', async () => {
  await temporary(async directory => {
    const { result, requests, budget } = await runLocal(directory, [{ omit_terminal_event: true }], { oneRequestBudget: true });
    assert.equal(requests, 1); assert.equal(budget.totals().requests, 1);
    assert.equal(budget.ledger.halted, 'experiment_request_limit');
    assert.ok(result.error); assert.equal(result.events.filter(e => e.type === 'retry' || e.type === 'summary_retry').length, 0);
  });
});
