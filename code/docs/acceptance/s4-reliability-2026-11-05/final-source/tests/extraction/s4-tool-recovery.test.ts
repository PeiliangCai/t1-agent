import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionBudget, S4_LIMITS } from '../../packages/agent/src/extraction-budget.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture, type ResponsesStep } from './fixtures/runtime-responses.js';

const read: ResponsesStep = { calls: [{ name: 'read_document_blocks', arguments: {} }] };
const finish: ResponsesStep = { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] };
const summary: ResponsesStep = { calls: [{ name: 'get_document_context', arguments: {} },
  { name: 'submit_candidate_records', arguments: { summary: 'Loopback fixture only.', reviews: [], links: [], updates: [], summary_complete: true } }] };
const statement = { source_unit_ids: ['su-000001'], feature_name_raw: 'spiculation', feature_category: 'margin',
  evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors' };
const submit = (record: unknown): ResponsesStep => ({ calls: [{ name: 'submit_candidate_records', arguments: { records: [record], batch_complete: true } }] });

async function run(steps: ResponsesStep[], oneRequestBudget = false) {
  const directory = await mkdtemp(join(tmpdir(), 's4-bounded-recovery-'));
  const server = await createRuntimeResponsesFixture(steps), store = new ExtractionStore(':memory:'), fixture = makeEvidenceFixture();
  const budget = new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint, Date.now, oneRequestBudget ? {
    limits: { ...S4_LIMITS, requests: 1 }, authorization: { id: 'loopback-one-request', source: 'synthetic:no-paid-api', recorded_at: '2026-11-05T00:00:00Z' },
  } : {});
  fixture.input.runtime_profile = { ...fixture.input.runtime_profile, provider: server.config.provider, model_id: server.config.modelId, endpoint: server.endpoint };
  try {
    const result = await runExtractionDocument({ input: fixture.input, document: fixture.document, metadata: fixture.context.metadata,
      catalog: fixture.catalog, config: server.config, profile: developmentProfile(server.config.modelId), budget, store,
      directory: join(directory, 'run'), strategy: 'baseline' });
    return { result, requests: server.requests, totals: budget.totals() };
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
}

test('the observed empty-property read error is rejected then corrected in the same batch without restarting the paper', async () => {
  const { result, requests, totals } = await run([{ calls: [{ name: 'read_document_blocks', arguments: { '': '' } }] },
    { calls: [...read.calls!, ...finish.calls!] }, summary]);
  assert.equal(result.error, undefined); assert.equal(requests.length, 3); assert.equal(totals.requests, 3);
  assert.equal(result.coverage.whole_document_summary_complete, true);
  assert.equal(result.events.filter(e => e.type === 'protocol_correction').length, 1);
  assert.equal(result.events.filter(e => e.type === 'retry').length, 0);
  assert.equal(result.events.filter(e => e.type === 'protocol_diagnostic_pause').length, 0);
  assert.match(JSON.stringify(requests[1]!.tool_results), /schema_validation|Validation failed/i);
});

test('unknown source ID and dual context selectors remain invalid; only explicit subsequent model arguments recover', async () => {
  const { result, requests } = await run([read,
    submit({ ...statement, source_unit_ids: ['su-00100'] }),
    submit({ ...statement, context_unit_ids: ['su-000001'], context_line_indices: [0] }),
    submit(statement), summary]);
  assert.equal(result.error, undefined); assert.equal(requests.length, 5); assert.equal(result.candidate_count, 1);
  assert.equal(result.events.filter(e => e.type === 'protocol_correction').length, 2);
  const rejections = result.events.filter(e => e.type === 'tool_protocol_rejected').map(e => e.detail.error_code);
  assert.ok(rejections.includes('source_unit_not_available'));
  assert.ok(rejections.includes('choose_context_units_or_context_lines'));
  assert.equal(result.versions.length, 1, 'failed arguments must not have created candidates');
});

test('the same invalid arguments stop after one correction opportunity and preserve diagnostics', async () => {
  const invalid: ResponsesStep = { calls: [{ name: 'read_document_blocks', arguments: { '': '' } }] };
  const { result, requests } = await run([invalid, invalid, read, finish, summary]);
  assert.equal(requests.length, 2); assert.equal(result.error?.code, 'model_tool_protocol_diagnostic_pause');
  assert.equal(result.coverage.whole_document_summary_complete, false);
  assert.equal(result.events.filter(e => e.type === 'protocol_correction').length, 1);
  assert.equal(result.events.filter(e => e.type === 'protocol_diagnostic_pause').length, 1);
});

test('unknown tool and host identity override attempts still stop before any correction call', async () => {
  for (const call of [{ name: 'run_shell', arguments: {} }, { name: 'read_document_blocks', arguments: { run_id: 'another-run' } }]) {
    const { result, requests } = await run([{ calls: [call] }, read, finish, summary]);
    assert.equal(requests.length, 1); assert.equal(result.error?.code, 'model_tool_protocol_diagnostic_pause');
    assert.equal(result.events.filter(e => e.type === 'protocol_correction').length, 0);
    assert.equal(result.candidate_count, 0);
  }
});

test('protocol correction uses the existing physical request cap without resetting its ledger', async () => {
  const { result, requests, totals } = await run([{ calls: [{ name: 'read_document_blocks', arguments: { '': '' } }] }, read], true);
  assert.equal(requests.length, 1); assert.equal(totals.requests, 1); assert.ok(result.error);
  assert.equal(result.coverage.whole_document_summary_complete, false);
});

test('an unsafe call blocks other calls from the same assistant response before any candidate is written', async () => {
  const { result, requests } = await run([{ calls: [{ name: 'run_shell', arguments: {} }, ...read.calls!,
    { name: 'submit_candidate_records', arguments: { records: [statement], batch_complete: true } }] }, summary]);
  assert.equal(requests.length, 1); assert.equal(result.error?.code, 'model_tool_protocol_diagnostic_pause');
  assert.equal(result.candidate_count, 0); assert.equal(result.coverage.source_blocks_read, 0);
});
