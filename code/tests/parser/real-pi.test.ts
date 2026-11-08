import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultScope, type DocumentIRV2, type RunInput, type StructuredDocumentIR } from '@t1/contracts';
import { catalog, LocalPythonParserAdapter, LocalStructuredPythonParserAdapter, RealDocumentTools, RunStore,
  prepareRealDocumentRun, createRestrictedSession, executeRealDocumentRead, TOOL_NAMES, assertParsedDocument, type SessionLike } from '@t1/agent';
import { createLoopbackMockModel, type MockCall } from './helpers/mock-pi-model.js';

const file = 'evaluation/corpus/development-candidates/L01.pdf';
let document: DocumentIRV2;
let sha: string;
before(async () => {
  sha = createHash('sha256').update(await readFile(file)).digest('hex');
  document = await new LocalPythonParserAdapter().parse({ run_id: 'real-pi-test-source', document_id: 'L01', file_reference: file, file_sha256: sha });
});
function input(): RunInput {
  return { schema_version: '1', run_id: randomUUID(), document_id: 'L01', file_sha256: sha, fixture: false,
    scope: defaultScope(catalog.catalog_version), rule_version: 's3-real-read-probe-1',
    runtime_profile: { provider: 's3-local-scripted', model_id: 's3-scripted-no-llm', endpoint: 'loopback-only', pi_version: '1.4.0', version: 's3-read-only-1' } };
}
function context(store = new RunStore()) {
  const run = input(); store.create(run); store.transition(run.run_id, 'parsing'); store.transition(run.run_id, 'extracting');
  const tools = new RealDocumentTools(run, document, catalog, store);
  return { input: run, store, tools, bound: { run_id: run.run_id, document_id: run.document_id },
    versioned: { run_id: run.run_id, document_id: run.document_id, file_sha256: sha, text_version: document.text_version } };
}

test('actual PDF source remains real with precise version binding, whole-line geometry and no model paths', async () => {
  const c = context();
  try {
    const metadata = await c.tools.invoke('get_document_context', c.bound, 'context') as Record<string, unknown>;
    assert.equal(metadata.fixture, false); assert.equal(metadata.physical_pdf, true); assert.equal(metadata.feature_catalog_fixture, true);
    assert.equal(metadata.medical_extraction_implemented, false); assert.equal(metadata.text_version, document.text_version);
    assert.ok(!JSON.stringify(metadata).includes(file));
    const blocks = document.blocks.slice(0, 2), block_ids = blocks.map(b => b.block_id);
    const reference = { document_id: document.document_id, text_version: document.text_version, joiner: '\n',
      segments: blocks.map(b => ({ block_id: b.block_id, text_version: b.text_version, start: 0, end: Array.from(b.text).length })) };
    const result = await c.tools.invoke('read_document_blocks', { ...c.versioned, block_ids, source_reference: reference }, 'read') as {
      fixture: boolean; blocks: DocumentIRV2['blocks']; source_reference: { quote_kind: string; contiguous_source_quote: boolean; segments: unknown[]; quote: string; location_precision: string } };
    assert.equal(result.fixture, false); assert.deepEqual(result.blocks, blocks);
    assert.equal(result.source_reference.quote, blocks.map(b => b.text).join('\n'));
    assert.equal(result.source_reference.segments.length, 2); assert.equal(result.source_reference.contiguous_source_quote, false);
    assert.equal(result.source_reference.quote_kind, 'display_composite_of_source_segments');
    assert.equal(result.source_reference.location_precision, 'whole_textline_not_exact_glyph');
    assert.ok(c.store.events(c.input.run_id).every(e => e.fixture === false));
  } finally { c.store.close(); }
});

test('real tools reject path/identity/version widening and do not mark a partially invalid read as read', async () => {
  const c = context(); const id = document.blocks[0]!.block_id;
  try {
    for (const change of [{ run_id: 'foreign' }, { document_id: 'foreign' }, { file_sha256: '0'.repeat(64) }, { text_version: 'foreign' }]) {
      await assert.rejects(c.tools.invoke('read_document_blocks', { ...c.versioned, ...change, block_ids: [id] }, 'bad'), /cross_task|sha256|text_version/);
    }
    await assert.rejects(c.tools.invoke('read_document_blocks', { ...c.versioned, block_ids: [id], path: file }, 'bad'), /schema/);
    await assert.rejects(c.tools.invoke('read_document_blocks', { ...c.versioned, block_ids: [id, '../.env'] }, 'bad'), /not_authorized/);
    await assert.rejects(c.tools.invoke('bash', { command: 'anything' }, 'bad'), /tool_not_allowed/);
    assert.equal(c.tools.readBlocks.size, 0);
    const source_reference = { document_id: 'L01', text_version: document.text_version, joiner: '',
      segments: [{ block_id: document.blocks[1]!.block_id, text_version: document.text_version, start: 0, end: 1 }] };
    await assert.rejects(c.tools.invoke('read_document_blocks', { ...c.versioned, block_ids: [id], source_reference }, 'bad'), /outside_requested/);
    await assert.rejects(c.tools.invoke('read_document_blocks', { ...c.versioned, block_ids: [id],
      source_reference: { ...source_reference, text_version: 'wrong', segments: [{ ...source_reference.segments[0]!, block_id: id }] } }, 'bad'), /text_version/);
    assert.equal(c.tools.readBlocks.size, 0);
  } finally { c.store.close(); }
});

test('read-before-submit and exact quotes are enforced while S4 medical candidate writes remain blocked', async () => {
  const c = context(); const block = document.blocks[0]!;
  const submit = { ...c.versioned, records: [{ block_id: block.block_id, original_quote: block.text, feature_binding_id: null }] };
  try {
    await assert.rejects(c.tools.invoke('submit_candidate_records', submit, 'before'), /must_be_read_first/);
    await c.tools.invoke('read_document_blocks', { ...c.versioned, block_ids: [block.block_id] }, 'read');
    await assert.rejects(c.tools.invoke('submit_candidate_records', { ...submit, records: [{ ...submit.records[0]!, original_quote: 'synthetic invented quote' }] }, 'invented'), /quote_not_in_source/);
    await assert.rejects(c.tools.invoke('submit_candidate_records', submit, 'after'), /medical_candidate_submission_not_implemented/);
    assert.deepEqual(c.store.records(c.input.run_id), []);
  } finally { c.store.close(); }
});

test('shared real IR does not share read authorization across runs; cancellation is isolated', async () => {
  const store = new RunStore(); const a = context(store), b = context(store); const block = document.blocks[0]!;
  try {
    await a.tools.invoke('read_document_blocks', { ...a.versioned, block_ids: [block.block_id] }, 'a-read');
    await assert.rejects(b.tools.invoke('submit_candidate_records', { ...b.versioned,
      records: [{ block_id: block.block_id, original_quote: block.text, feature_binding_id: null }] }, 'b-before'), /must_be_read_first/);
    store.transition(a.input.run_id, 'cancelled');
    await assert.rejects(a.tools.invoke('get_document_context', a.bound, 'stale'), /not_extracting/);
    await b.tools.invoke('get_document_context', b.bound, 'allowed');
    assert.equal(store.snapshot(b.input.run_id).state, 'extracting');
    assert.ok(store.events(a.input.run_id).every(e => e.run_id === a.input.run_id));
    assert.ok(store.events(b.input.run_id).every(e => e.run_id === b.input.run_id));
  } finally { store.close(); }
});

test('real parser preparation emits parsing events and preserves actual partial/failed/cancelled states', async () => {
  for (const mode of ['actual', 'sha-mismatch', 'outside-code', 'pre-cancelled', 'cancel-in-flight'] as const) {
    const run = input(); if (mode === 'sha-mismatch') run.file_sha256 = '0'.repeat(64);
    const store = new RunStore(); store.create(run); const controller = new AbortController();
    if (mode === 'pre-cancelled') controller.abort();
    const timer = mode === 'cancel-in-flight' ? setTimeout(() => controller.abort(), 30) : undefined;
    try {
      const prepared = await prepareRealDocumentRun(run, mode === 'outside-code' ? '../AGENTS.md' : file, catalog, new LocalPythonParserAdapter(), store, controller.signal);
      if (mode === 'actual') {
        assert.equal(prepared.state, 'extracting'); assert.equal(prepared.parser_result?.status, 'partial'); assert.ok(prepared.tools);
        assert.deepEqual(store.events(run.run_id).filter(e => e.type === 'state').map(e => e.stage), ['queued', 'parsing', 'extracting']);
      } else {
        assert.equal(prepared.state, ['sha-mismatch', 'outside-code'].includes(mode) ? 'failed' : 'cancelled'); assert.equal(prepared.tools, undefined);
        if (mode === 'sha-mismatch') assert.equal(prepared.error?.code, 'file_sha256_mismatch');
        if (mode === 'outside-code') assert.equal(prepared.error?.code, 'file_outside_allowed_root');
      }
      assert.ok(store.events(run.run_id).every(e => !e.fixture)); assert.equal(store.records(run.run_id).length, 0);
    } finally { if (timer) clearTimeout(timer); store.close(); }
  }
});

test('invalid structured candidate configuration and source IR version rebinding are rejected locally', () => {
  assert.throws(() => new LocalStructuredPythonParserAdapter({ candidateId: 'automatic-default' as never }), /schema/);
  const changed = structuredClone(document); changed.blocks[0]!.text_version = 'foreign-version';
  assert.throws(() => assertParsedDocument(changed), /invalid_document_ir/);
});

test('a reused IR envelope cannot relabel an actual partial parse as ok', async () => {
  const run = input(), store = new RunStore(); store.create(run);
  try {
    const prepared = await prepareRealDocumentRun(run, file, catalog, {
      parseResult: async request => ({ schema_version: 'parser-result-1', run_id: request.run_id,
        status: 'ok', document, error: null }),
    }, store);
    assert.equal(prepared.state, 'failed'); assert.equal(prepared.error?.code, 'parser_status_mismatch'); assert.equal(prepared.tools, undefined);
    assert.ok(!store.events(run.run_id).some(event => event.stage === 'extracting'));
  } finally { store.close(); }
});

test('synthetic v3 structure over actual source blocks keeps processed text separate and rejects corrupt source anchors', async () => {
  // Only this test's structure metadata is synthetic. Actual candidate parsing is verified by verify-s3-pi.ts.
  const blocks = document.blocks.slice(0, 2);
  const segments = blocks.map(b => ({ block_id: b.block_id, text_version: b.text_version, start: 0, end: Array.from(b.text).length }));
  const native = 'synthetic_processed_native_text_not_present_in_the_PDF_source';
  const structured: StructuredDocumentIR = { ...structuredClone(document), schema_version: '3',
    parser: { id: 'docling-standard-cpu', version: 'synthetic-structure-unit-test-only', status: 'partial',
      config: { purpose: 'synthetic_structure_for_negative_tests' }, config_digest: document.parser.config_digest },
    source_extraction: { parser_id: document.parser.id, parser_version: document.parser.version,
      config_digest: document.parser.config_digest, text_version: document.text_version, raw_text_definition: 'decoded_PDF_text_layer_no_native_structure_rewrite' },
    native_artifact: { path: 'not-created-synthetic-unit-test.json', sha256: '0'.repeat(64), format: 'synthetic_structure_for_unit_test' },
    structure: { units: [{ unit_id: 'synthetic-native-unit', native_ref: '#/texts/0', kind: 'text', native_label: 'text', native_text: native,
      native_original_text: native, native_text_role: 'processed_native_not_literal_quote', content_layer: 'body', source_segments: segments,
      provenance: [], mapping: { status: 'partial', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_1', matched_native_code_points: 0,
        alignable_native_code_points: native.length, transformations: [], warnings: ['synthetic_structure_unit_test_only'] } }],
      reading_order: ['synthetic-native-unit'], furniture_unit_ids: [], hierarchy: [], tables: [], pictures: [],
      native_processed_text_is_authoritative_quote: false, human_fidelity_verified: false },
    coverage: { ...structuredClone(document.coverage), scope: 'raw_pdf_text_layer_with_candidate_structure', native_pages: [1], native_errors: [],
      unmapped_unit_ids: ['synthetic-native-unit'], ambiguous_unit_ids: [], structure_verified_by_human: false,
      table_structure: 'native_candidate_output_unverified', reading_order: 'native_candidate_order_unverified' },
    metrics: { source_anchor_seconds: 0, native_seconds: 0, mapping_seconds: 0, total_seconds: 0, native_metrics: {}, host_metrics: {}, remote_document_uploads: 0, llm_calls: 0 } };
  const c = context(); const tools = new RealDocumentTools(c.input, structured, catalog, c.store);
  try {
    const read = await tools.invoke('read_document_blocks', { ...c.versioned, block_ids: blocks.map(b => b.block_id),
      source_reference: { document_id: 'L01', text_version: document.text_version, segments, joiner: '\n' } }, 'v3-read') as {
        blocks: DocumentIRV2['blocks']; structure_units: Array<{ native_text: string; native_original_text_is_literal_quote: boolean }>;
        source_reference: { quote: string; contiguous_source_quote: boolean } };
    assert.deepEqual(read.blocks, blocks); assert.equal(read.structure_units[0]!.native_text, native);
    assert.equal(read.structure_units[0]!.native_original_text_is_literal_quote, false);
    assert.equal(read.source_reference.quote, blocks.map(b => b.text).join('\n')); assert.equal(read.source_reference.contiguous_source_quote, false);
    await assert.rejects(tools.invoke('submit_candidate_records', { ...c.versioned,
      records: [{ block_id: blocks[0]!.block_id, original_quote: native, feature_binding_id: null }] }, 'native-quote'), /quote_not_in_source/);
    const wrong = structuredClone(structured); wrong.structure.units[0]!.source_segments[0]!.end = 1_000_000;
    assert.throws(() => assertParsedDocument(wrong), /invalid_structure_source_segment/);
    const order = structuredClone(structured); order.structure.reading_order.push('missing-native-unit');
    assert.throws(() => assertParsedDocument(order), /invalid_structure_reference/);
    const coverage = structuredClone(structured); coverage.coverage.unmapped_unit_ids = [];
    assert.throws(() => assertParsedDocument(coverage), /invalid_document_coverage/);
  } finally { c.store.close(); }
});

test('a settled empty real probe fails and pre-cancelled Pi work disposes the session without a model request', async () => {
  for (const cancelled of [false, true]) {
    const c = context(); const controller = new AbortController(); if (cancelled) controller.abort();
    let emit: Parameters<SessionLike['subscribe']>[0] = () => {}, disposed = false, prompts = 0;
    const session: SessionLike = {
      subscribe: listener => { emit = listener; return () => { emit = () => {}; }; },
      prompt: async () => { prompts++; emit({ type: 'agent_settled', aborted: false }); },
      abort: async () => {}, dispose: () => { disposed = true; },
    };
    try {
      const result = await executeRealDocumentRead(c.tools, session, { modelExecution: 'mock_loopback' }, controller.signal);
      assert.equal(result.state, cancelled ? 'cancelled' : 'failed'); assert.equal(result.engineering_probe_completed, false);
      assert.equal(result.candidate_count, 0); assert.equal(disposed, true); assert.equal(prompts, cancelled ? 0 : 1);
      assert.equal(result.error?.code, cancelled ? 'run_cancelled' : 'real_read_probe_incomplete');
    } finally { c.store.close(); }
  }
});

test('actual Pi SDK dispatches only 5 registered tools against real parsed PDF with scripted loopback responses', async () => {
  const c = context(); const block = document.blocks[0]!;
  const submission = { ...c.versioned, records: [{ block_id: block.block_id, original_quote: block.text, feature_binding_id: null }] };
  const reads: MockCall[] = [];
  for (let i = 0; i < document.blocks.length; i += 8) reads.push({ name: 'read_document_blocks', arguments: { ...c.versioned, block_ids: document.blocks.slice(i, i + 8).map(b => b.block_id) } });
  const mock = await createLoopbackMockModel([
    [{ name: 'submit_candidate_records', arguments: submission }, { name: 'get_document_context', arguments: c.bound }, { name: 'lookup_feature_bindings', arguments: c.bound }],
    reads, [{ name: 'submit_candidate_records', arguments: submission }], 'Local mock: engineering source reading confirmed; medical extraction remains unavailable.',
  ]);
  const directory = await mkdtemp(resolve('runtime-data/pi-real-test-'));
  const originalFetch = globalThis.fetch; const destinations: string[] = [];
  globalThis.fetch = async (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : resource.toString()); destinations.push(url.origin);
    assert.equal(url.origin, new URL(mock.config.baseUrl).origin, 'external network is prohibited');
    return originalFetch(resource, init);
  };
  let session: Awaited<ReturnType<typeof createRestrictedSession>> | undefined;
  try {
    session = await createRestrictedSession(mock.config, c.tools, directory);
    assert.deepEqual(session.audit.active_tools, [...TOOL_NAMES].sort()); assert.equal(session.audit.fixture, false);
    const result = await executeRealDocumentRead(c.tools, session.session, { modelExecution: 'mock_loopback' });
    assert.equal(result.state, 'partial'); assert.equal(result.engineering_probe_completed, true);
    assert.equal(result.full_document_extraction_completed, false); assert.equal(result.medical_extraction_implemented, false);
    assert.equal(result.source_blocks_read, document.blocks.length); assert.equal(result.candidate_count, 0);
    assert.equal(result.assistant_requests_observed, 4); assert.equal(result.session_disposed, true);
    assert.equal(mock.requests.length, 4); assert.ok(mock.requests.every(r => JSON.stringify(r.registered_tools) === JSON.stringify([...TOOL_NAMES].sort())));
    assert.ok(result.events.some(e => e.type === 'tool_execution_end' && e.is_error));
    assert.ok(result.tool_calls.some(c => c.error_code === 'candidate_source_must_be_read_first'));
    assert.ok(result.tool_calls.some(c => c.error_code === 'medical_candidate_submission_not_implemented'));
    assert.ok(destinations.length > 0);
  } finally { session?.session.dispose(); globalThis.fetch = originalFetch; await mock.close(); c.store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('two actual PDFs with distinct real parser run IDs execute Pi tools in the same SQLite without cross-run reads', async () => {
  const root = resolve('docs/acceptance/s3/comparison-2026-11-02/pi-integration'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'same-store-two-real-pdfs-'));
  const store = new RunStore(resolve(directory, 'runs.sqlite'));
  const sourceIds = ['L01', 'L02'];
  const runs = await Promise.all(sourceIds.map(async document_id => {
    const file_reference = `evaluation/corpus/development-candidates/${document_id}.pdf`;
    const file_sha256 = createHash('sha256').update(await readFile(file_reference)).digest('hex');
    return { input: { ...input(), run_id: `same-store-${document_id}-${randomUUID()}`, document_id, file_sha256 }, file_reference };
  }));
  const summaries: unknown[] = [];
  try {
    runs.forEach(run => store.create(run.input));
    const prepared = await Promise.all(runs.map(run => prepareRealDocumentRun(run.input, run.file_reference, catalog, new LocalPythonParserAdapter(), store)));
    const first = prepared[0]!.tools!, second = prepared[1]!.tools!; assert.ok(first && second);
    assert.notEqual(first.input.run_id, second.input.run_id); assert.notEqual(first.input.document_id, second.input.document_id);
    await assert.rejects(first.invoke('get_document_context', { run_id: second.input.run_id, document_id: second.input.document_id }, 'cross-task'), /cross_task/);
    await assert.rejects(first.invoke('read_document_blocks', { run_id: first.input.run_id, document_id: first.input.document_id,
      file_sha256: first.input.file_sha256, text_version: first.document.text_version, block_ids: [second.document.blocks[0]!.block_id] }, 'foreign-block'), /not_authorized/);
    for (const [index, tools] of [first, second].entries()) {
      const bound = { run_id: tools.input.run_id, document_id: tools.input.document_id };
      const versioned = { ...bound, file_sha256: tools.document.file_sha256, text_version: tools.document.text_version };
      const reads: MockCall[] = [];
      for (let offset = 0; offset < tools.document.blocks.length; offset += 8) reads.push({ name: 'read_document_blocks',
        arguments: { ...versioned, block_ids: tools.document.blocks.slice(offset, offset + 8).map(block => block.block_id) } });
      const mock = await createLoopbackMockModel([
        [{ name: 'get_document_context', arguments: bound }, { name: 'lookup_feature_bindings', arguments: bound }],
        reads, 'SCRIPTED LOCAL MOCK: isolated engineering source read confirmed; medical extraction incomplete.',
      ]);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (resource, init) => {
        const url = new URL(resource instanceof Request ? resource.url : resource.toString());
        assert.equal(url.origin, new URL(mock.config.baseUrl).origin); return originalFetch(resource, init);
      };
      let session: Awaited<ReturnType<typeof createRestrictedSession>> | undefined;
      try {
        session = await createRestrictedSession(mock.config, tools, resolve(directory, `${index}-pi-private`));
        const result = await executeRealDocumentRead(tools, session.session, { modelExecution: 'mock_loopback' });
        assert.equal(result.state, 'partial'); assert.equal(result.engineering_probe_completed, true); assert.equal(result.candidate_count, 0);
        assert.equal(result.source_blocks_read, tools.document.blocks.length); assert.equal(mock.requests.length, 3);
        if (index === 0) { assert.equal(second.readBlocks.size, 0); assert.equal(store.snapshot(second.input.run_id).state, 'extracting'); }
        assert.ok(store.events(tools.input.run_id).every(event => event.run_id === tools.input.run_id && !event.fixture));
        summaries.push({ input: tools.input, parse_execution: 'actual_local_parser_subprocess', source_pdf: runs[index]!.file_reference,
          schema_version: tools.document.schema_version, parser_id: tools.document.parser.id, text_version: tools.document.text_version,
          original_pdf_unchanged: createHash('sha256').update(await readFile(runs[index]!.file_reference)).digest('hex') === tools.input.file_sha256,
          actual_pi_sdk: '1.4.0', mock_model: true, pi_audit: session.audit, result, business_events: store.events(tools.input.run_id) });
      } finally { session?.session.dispose(); globalThis.fetch = originalFetch; await mock.close(); }
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 2);
    assert.equal(store.records(first.input.run_id).length, 0); assert.equal(store.records(second.input.run_id).length, 0);
    await writeFile(resolve(directory, 'report.json'), JSON.stringify({ purpose: 'same_SQLite_two_distinct_actual_PDF_parser_runs_and_Pi_tools',
      shared_store: resolve(directory, 'runs.sqlite'), same_database_for_both_runs: true, actual_pdf_parses: 2,
      original_parser_run_ids_preserved: true, actual_pi_sdk: '1.4.0', model_execution: 'scripted_loopback_mock',
      paid_llm_calls: 0, external_pdf_uploads: 0, cross_task_and_foreign_block_rejected: true,
      full_document_extraction_completed: false, medical_extraction_implemented: false, runs: summaries }, null, 2));
  } finally { store.close(); }
});
