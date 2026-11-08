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

async function run(steps: ResponsesStep[], oneRequestBudget = false, options: { lines?: string[]; requestLimit?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 's4-bounded-recovery-'));
  const store = new ExtractionStore(':memory:'), fixture = makeEvidenceFixture(options.lines);
  const server = await createRuntimeResponsesFixture(steps, { summaryAssessments: () => store.current(fixture.input.run_id).map(v => ({
    record_id: v.record.record_id, expected_version: v.version, issue_codes: [], primary_assessment: 'uncertain' })) });
  const requestLimit = options.requestLimit ?? (oneRequestBudget ? 1 : undefined);
  const budget = new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint, Date.now, requestLimit !== undefined ? {
    limits: { ...S4_LIMITS, requests: requestLimit }, authorization: { id: 'loopback-bounded-request-cap', source: 'synthetic:no-paid-api', recorded_at: '2026-11-05T00:00:00Z' },
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
  assert.equal(result.versions.length, 2, 'one original candidate plus one explicit summary assessment; invalid arguments create neither');
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

const bibliographyLines = ['CT shows spiculation.', 'References', '1. Smith A. CT. J Med. 2024;2:1-8.',
  '2. Jones B. MRI. J Med. 2023;3:4-9.', '上接第38页', 'CT material from an uncertain other article.'];
const beginBibliographySummary = (arguments_: unknown): ResponsesStep => ({ calls: [{ name: 'get_document_context', arguments: {} },
  { name: 'read_document_blocks', arguments: arguments_ }] });
const bibliographyRead = (line_indices: number[]): ResponsesStep => ({ calls: [{ name: 'read_document_blocks', arguments: { line_indices } }] });
const batchDone: ResponsesStep = { calls: [...read.calls!, ...finish.calls!] };

test('repeating the same known bibliography read stops after one correction and preserves partial summary', async () => {
  const { result, requests } = await run([batchDone, beginBibliographySummary({ line_indices: [2] }), bibliographyRead([2]), summary], false,
    { lines: bibliographyLines });
  assert.equal(requests.length, 3); assert.equal(result.error?.code, 'whole_document_summary_incomplete');
  assert.equal(result.task_processing_complete, false); assert.ok(result.coverage.task_processing_blockers.includes('summary_incomplete'));
  assert.equal(result.coverage.whole_document_summary_complete, false); assert.equal(result.state, 'partial');
  assert.equal(result.events.filter(e => e.type === 'protocol_correction').length, 1);
  const pause = result.events.filter(e => e.type === 'protocol_diagnostic_pause');
  assert.equal(pause.length, 1); assert.equal(pause[0]!.detail.stop_reason, 'repeated_invalid_arguments');
  assert.equal(pause[0]!.detail.error_code, 'bibliography_read_outside_task_scope');
  assert.deepEqual(result.coverage.summary_reread_source_block_ids, []);
  assert.equal(JSON.stringify(requests).includes('Smith'), false);
});

test('known bibliography reads share the existing two distinct correction opportunities, then stop', async () => {
  const { result, requests } = await run([batchDone, beginBibliographySummary({ line_indices: [2] }), bibliographyRead([3]),
    bibliographyRead([2, 3]), summary], false, { lines: bibliographyLines });
  assert.equal(requests.length, 4); assert.equal(result.coverage.whole_document_summary_complete, false);
  assert.equal(result.events.filter(e => e.type === 'protocol_correction').length, 2);
  const pause = result.events.filter(e => e.type === 'protocol_diagnostic_pause');
  assert.equal(pause.length, 1); assert.equal(pause[0]!.detail.stop_reason, 'correction_limit');
  assert.equal(pause[0]!.detail.correction_limit, 2); assert.equal(pause[0]!.detail.parameters_rewritten, false);
  assert.deepEqual(result.coverage.summary_reread_source_block_ids, []);
  assert.equal(result.events.filter(e => e.type === 'summary_retry').length, 0);
});

test('known bibliography mixed with unknown IDs, another article, or identity override remains fatal', async () => {
  for (const selector of [
    { block_ids: ['synthetic-line-3', 'synthetic-nonexistent-id'] },
    { block_ids: ['synthetic-line-3', 'synthetic-line-6'] },
    { block_ids: ['synthetic-line-3'], document_id: 'another-document' },
  ]) {
    const { result, requests } = await run([batchDone, beginBibliographySummary(selector), bibliographyRead([0]), summary], false,
      { lines: bibliographyLines });
    assert.equal(requests.length, 2); assert.equal(result.coverage.whole_document_summary_complete, false);
    assert.equal(result.events.filter(e => e.type === 'protocol_correction').length, 0);
    assert.deepEqual(result.coverage.summary_reread_source_block_ids, []);
    assert.equal(JSON.stringify(requests).includes('Smith'), false);
  }
});

test('bibliography candidate updates remain fatal rather than receiving read-query correction', async () => {
  const update = { source_line_indices: [2], feature_name_raw: 'CT', feature_category: 'appearance', evidence_type: 'imaging_observation',
    assertion: 'affirmed', origin: 'study_authors' };
  const { result, requests } = await run([batchDone, { calls: [{ name: 'get_document_context', arguments: {} },
    { name: 'submit_candidate_records', arguments: { summary: '', reviews: [], links: [], updates: [update], summary_complete: true } }] }, summary], false,
    { lines: bibliographyLines });
  assert.equal(requests.length, 2); assert.equal(result.candidate_count, 0); assert.equal(result.coverage.whole_document_summary_complete, false);
  assert.equal(result.events.filter(e => e.type === 'protocol_correction').length, 0);
  assert.ok(result.events.some(e => e.type === 'protocol_diagnostic_pause' && e.detail.error_code === 'summary_update_validation_failed'));
});

test('known bibliography query correction cannot exceed the original physical request cap', async () => {
  const { result, requests, totals } = await run([batchDone, beginBibliographySummary({ line_indices: [2] }), bibliographyRead([0]), summary], false,
    { lines: bibliographyLines, requestLimit: 3 });
  assert.equal(requests.length, 3); assert.equal(totals.requests, 3); assert.equal(result.coverage.whole_document_summary_complete, false);
  assert.equal(result.events.filter(e => e.type === 'protocol_correction').length, 1);
  assert.ok(result.coverage.summary_reread_source_block_ids.every(id => !['synthetic-line-3', 'synthetic-line-4'].includes(id)));
  assert.equal(result.events.filter(e => e.type === 'summary_retry' || e.type === 'retry').length, 0);
});
