import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSchema, defaultScope, ParserCandidateSchema, ParserResultSchema, StructuredParserResultSchema,
  type ParserCandidateId, type ParserResult, type RunInput, type StructuredParserResult } from '@t1/contracts';
import { assertParsedDocument, catalog, createRestrictedSession, executeRealDocumentRead, LocalPythonParserAdapter,
  createConfiguredPdfParserAdapter, loadPdfParserSelection, prepareRealDocumentRun, RunStore, TOOL_NAMES, type LocalDocumentResultParser } from '@t1/agent';
import { createLoopbackMockModel, type MockCall } from '../tests/parser/helpers/mock-pi-model.js';

const CODE = fileURLToPath(new URL('../', import.meta.url));
const EVIDENCE = resolve(CODE, 'docs/acceptance/s3/parser-selection-2026-11-03/pi-integration');
const ids = ['MED03', 'L07', 'L05', 'L01', 'L02'];
const args = process.argv.slice(2);
function values(flag: string): string[] {
  return args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]!] : []);
}
const selection = loadPdfParserSelection();
const explicitCandidate = values('--candidate-id')[0];
const candidateId = explicitCandidate ?? selection.default_candidate_id;
const selectionSource = explicitCandidate ? 'trusted_explicit_override' : 'formal_project_configuration';
if (candidateId !== 'docling-parse-text') assertSchema(ParserCandidateSchema, candidateId);
const resultFiles = values('--parser-result');
const requestedIds = (values('--documents')[0]?.split(',') ?? ids);
assert.ok(requestedIds.length && requestedIds.every(id => ids.includes(id)), 'Only the 5 bound development PDF IDs are allowed.');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const output = resolve(EVIDENCE, `${candidateId}-${stamp}-${randomUUID().slice(0, 8)}`);
await mkdir(output, { recursive: true });

async function loadResult(path: string) {
  const filename = await realpath(resolve(CODE, path));
  assert.ok(filename.startsWith(CODE), 'Parser results must be in code/.');
  const payload: unknown = JSON.parse(await readFile(filename, 'utf8'));
  if (candidateId === 'docling-parse-text') assertSchema(ParserResultSchema, payload);
  else assertSchema(StructuredParserResultSchema, payload);
  const result = payload as ParserResult | StructuredParserResult;
  assert.ok(result.document && !result.error, 'A successful/partial actual parser result with a document is required.');
  assertParsedDocument(result.document);
  assert.equal(result.document.parser.id, candidateId);
  assert.ok(ids.includes(result.document.document_id));
  if (result.document.schema_version === '3') {
    const artifact = await realpath(resolve(CODE, result.document.native_artifact.path));
    assert.ok(artifact.startsWith(CODE), 'Native parser artifacts must be in code/.');
    assert.equal(createHash('sha256').update(await readFile(artifact)).digest('hex'), result.document.native_artifact.sha256);
  }
  return { filename: relative(CODE, filename), result };
}
const savedResults = await Promise.all(resultFiles.map(loadResult));
const jobs = savedResults.length ? savedResults.map(saved => ({ id: saved.result.document!.document_id, saved })) : requestedIds.map(id => ({ id, saved: undefined }));
const reports: unknown[] = [];
const networkDestinations: string[] = [];
const originalFetch = globalThis.fetch;
let allowedOrigin: string | undefined;
globalThis.fetch = async (resource, init) => {
  const url = new URL(resource instanceof Request ? resource.url : resource.toString());
  networkDestinations.push(url.origin);
  assert.equal(url.origin, allowedOrigin, 'Only this run local mock loopback endpoint may receive requests.');
  return originalFetch(resource, init);
};
try {
  for (const [jobIndex, { id, saved }] of jobs.entries()) {
    const jobKey = `${jobIndex}-${id}`;
    // A batch parser job may legitimately reuse its run_id for different documents.
    // Each Pi probe gets a separate store, retaining the original result identity unchanged.
    const store = new RunStore(resolve(output, `${jobKey}-runs.sqlite`));
    try {
    const file = `evaluation/corpus/development-candidates/${id}.pdf`;
    const sha = createHash('sha256').update(await readFile(resolve(CODE, file))).digest('hex');
    if (saved) {
      assert.equal(saved.result.document!.file_sha256, sha);
      assert.equal(await realpath(resolve(CODE, saved.result.document!.source.file_reference)), await realpath(resolve(CODE, file)));
    }
    const run: RunInput = { schema_version: '1', run_id: saved?.result.run_id ?? `s3-pi-${candidateId}-${id}-${randomUUID().slice(0, 8)}`,
      document_id: id, file_sha256: sha, fixture: false, scope: defaultScope(catalog.catalog_version), rule_version: 's3-real-read-probe-1',
      runtime_profile: { provider: 's3-local-scripted', model_id: 's3-scripted-no-llm', endpoint: 'loopback-only', pi_version: '1.4.0', version: 's3-read-only-1' } };
    store.create(run);
    const parser: LocalDocumentResultParser = saved ? {
      parseResult: async request => {
        assert.equal(request.run_id, saved.result.run_id); assert.equal(request.document_id, saved.result.document!.document_id);
        assert.equal(request.file_sha256, saved.result.document!.file_sha256); return saved.result;
      },
    } : candidateId === 'docling-parse-text' ? new LocalPythonParserAdapter() : createConfiguredPdfParserAdapter({ ...(explicitCandidate ? { candidateId: candidateId as ParserCandidateId } : {}),
      logDirectory: relative(CODE, resolve(output, `${jobKey}-native-logs`)) });
    const prepared = await prepareRealDocumentRun(run, file, catalog, parser, store);
    const parserResultFile = saved?.filename ?? (prepared.parser_result ? relative(CODE, resolve(output, `${jobKey}-parser-result.json`)) : null);
    if (!saved && parserResultFile) await writeFile(resolve(CODE, parserResultFile), JSON.stringify(prepared.parser_result, null, 2));
    const parseProvenance = { parse_execution: saved ? 'reused_actual_candidate_parser_result' : 'actual_local_parser_subprocess',
      parser_result_file: parserResultFile, actual_source_pdf: file, original_file_sha256: sha, formal_parser_selected: true,
      formal_primary_candidate_id: selection.default_candidate_id, candidate_selection_source: selectionSource,
      business_event_store: relative(CODE, resolve(output, `${jobKey}-runs.sqlite`)) };
    if (!prepared.tools) {
      const report = { document_id: id, ...parseProvenance, preparation_state: prepared.state, error: prepared.error,
        parser_status: prepared.parser_result?.status, candidate_count: 0, medical_extraction_implemented: false,
        engineering_probe_completed: false, events: store.events(run.run_id) };
      reports.push(report); await writeFile(resolve(output, `${jobKey}-preparation-only.json`), JSON.stringify(report, null, 2));
      continue;
    }
    const tools = prepared.tools, doc = tools.document;
    const bound = { run_id: run.run_id, document_id: id };
    const versioned = { ...bound, file_sha256: sha, text_version: doc.text_version };
    const block = doc.blocks[0]!;
    const submit = { ...versioned, records: [{ block_id: block.block_id, original_quote: block.text, feature_binding_id: null }] };
    const readCalls: MockCall[] = [];
    for (let index = 0; index < doc.blocks.length; index += 8) {
      const blocks = doc.blocks.slice(index, index + 8);
      readCalls.push({ name: 'read_document_blocks', arguments: { ...versioned, block_ids: blocks.map(b => b.block_id),
        ...(index === 0 ? { source_reference: { document_id: id, text_version: doc.text_version, joiner: '\n',
          segments: blocks.slice(0, 2).map(b => ({ block_id: b.block_id, text_version: b.text_version, start: 0, end: Array.from(b.text).length })) } } : {}) } });
    }
    const mock = await createLoopbackMockModel([
      [{ name: 'submit_candidate_records', arguments: submit },
        { name: 'get_document_context', arguments: { ...bound, run_id: 'other-task-not-authorized' } },
        { name: 'read_document_blocks', arguments: { ...versioned, block_ids: ['../.env'] } },
        { name: 'read_document_blocks', arguments: { ...versioned, file_sha256: '0'.repeat(64), block_ids: [block.block_id] } },
        { name: 'read_document_blocks', arguments: { ...versioned, text_version: 'wrong-version', block_ids: [block.block_id] } },
        { name: 'get_document_context', arguments: bound }, { name: 'lookup_feature_bindings', arguments: bound }],
      readCalls, [{ name: 'submit_candidate_records', arguments: submit }],
      'SCRIPTED LOCAL MOCK: source reading probe ended; medical extraction and validation remain incomplete.',
    ]);
    allowedOrigin = new URL(mock.config.baseUrl).origin;
    let session: Awaited<ReturnType<typeof createRestrictedSession>> | undefined;
    try {
      session = await createRestrictedSession(mock.config, tools, resolve(output, `${jobKey}-pi-private`));
      assert.deepEqual(session.audit.active_tools, [...TOOL_NAMES].sort()); assert.equal(session.audit.fixture, false);
      const result = await executeRealDocumentRead(tools, session.session, { modelExecution: 'mock_loopback', timeoutMs: 60_000 });
      const afterSha = createHash('sha256').update(await readFile(resolve(CODE, file))).digest('hex'); assert.equal(afterSha, sha);
      assert.equal(result.engineering_probe_completed, true, JSON.stringify(result.error)); assert.equal(result.state, 'partial');
      assert.equal(result.source_blocks_read, doc.blocks.length); assert.equal(result.candidate_count, 0);
      for (const error of ['candidate_source_must_be_read_first', 'cross_task_access_denied', 'block_not_authorized', 'file_sha256_mismatch', 'text_version_mismatch', 'medical_candidate_submission_not_implemented']) {
        assert.ok(result.tool_calls.some(call => call.error_code === error), `${id}: missing ${error}`);
      }
      assert.equal(mock.requests.length, 4);
      assert.ok(mock.requests.every(request => JSON.stringify(request.registered_tools) === JSON.stringify([...TOOL_NAMES].sort())));
      const structures = doc.schema_version === '3' ? [...doc.structure.tables, ...doc.structure.pictures] : [];
      const expectedConflicts = structures.filter(s => s.association_status === 'conflict').length;
      const expectedRejected = structures.flatMap(s => s.caption_relationships ?? []).filter(r => r.project_status === 'rejected_conflict').length;
      const expectedUnusable = structures.filter(s => s.usable_for_semantic_interpretation === false).length;
      if (doc.schema_version === '3') assert.ok(mock.requests.some(request => request.context_guard_observations.some(observation =>
        observation.document_id === id && !observation.fixture && observation.native_association_conflicts === expectedConflicts &&
        observation.rejected_caption_relationships === expectedRejected && observation.unusable_structures === expectedUnusable)),
      `${id}: actual Pi context response did not preserve native relationship guard flags`);
      const sourceBlocks = doc.blocks.slice(0, 2);
      const report = { document_id: id, ...parseProvenance, schema_version: doc.schema_version,
        parser_id: doc.parser.id, parser_version: doc.parser.version, parser_config_digest: doc.parser.config_digest,
        physical_pages: doc.pages.length, source_policy: { raw_blocks_are_decoded_pdf_source: true, native_processed_text_is_literal_quote: false,
          source_box_precision: 'whole_textline_not_exact_glyph', medical_evidence_verified: false },
        source_excerpt_with_boundaries: sourceBlocks.map(b => ({ block_id: b.block_id, text_version: b.text_version, physical_page: b.page,
          start: 0, end: Array.from(b.text).length, raw_text: b.raw_text, text: b.text, bbox: b.bbox, source_geometry: b.source_geometry })),
        structure_summary: doc.schema_version === '3' ? { units: doc.structure.units.length, tables: doc.structure.tables.length,
          pictures: doc.structure.pictures.length, unmapped: doc.coverage.unmapped_unit_ids.length, ambiguous: doc.coverage.ambiguous_unit_ids.length } : null,
        association_protection: { metadata_present_on_all_structures: doc.schema_version === '3' && structures.length > 0 &&
          structures.every(s => s.association_status !== undefined && s.usable_for_semantic_interpretation === false),
          native_conflicts_retained: expectedConflicts, rejected_caption_relationships: expectedRejected, unusable_structures: expectedUnusable,
          conflict_entries: structures.filter(s => s.association_status === 'conflict').map(s => ({ native_ref: s.native_ref,
            native_caption_unit_ids: s.caption_unit_ids, association_status: s.association_status, association_issues: s.association_issues,
            caption_relationships: s.caption_relationships, usable_for_semantic_interpretation: s.usable_for_semantic_interpretation })),
          verified_in_actual_Pi_context_response: doc.schema_version === '3', reliable_medical_relationships_claimed: false },
        processed_native_examples: doc.schema_version === '3' ? doc.structure.units.filter(u => u.native_text && u.source_segments.length &&
          (u.source_segments.length > 1 || u.mapping.transformations.length)).slice(0, 3).map(u => ({ unit_id: u.unit_id, native_text: u.native_text,
            native_original_text: u.native_original_text, native_text_role: u.native_text_role, mapping: u.mapping,
            source_segment_boundaries: u.source_segments.map(segment => ({ ...segment,
              source_text: Array.from(doc.blocks.find(b => b.block_id === segment.block_id)!.text).slice(segment.start, segment.end).join('') })),
            contiguous_source_quote: false, source_authority: 'individual_segments_only' })) : [],
        pi_audit: session.audit, mock_model: { purpose: 'scripted_dispatch_verification_only', adversarial_calls_intentional: true,
          real_or_paid_llm_calls: 0, loopback_requests: mock.requests },
        result, business_events: store.events(run.run_id), original_pdf_unchanged: true };
      reports.push(report); await writeFile(resolve(output, `${jobKey}-pi-run.json`), JSON.stringify(report, null, 2));
      process.stdout.write(`${JSON.stringify({ document_id: id, candidate_id: candidateId, state: result.state,
        source_blocks_read: result.source_blocks_read, actual_pi_tool_events: result.events.filter(e => e.type.startsWith('tool_')).length,
        mock_model_requests: mock.requests.length, candidate_count: result.candidate_count })}\n`);
    } finally { session?.session.dispose(); await mock.close(); allowedOrigin = undefined; }
    } finally { store.close(); }
  }
  const report = { schema_version: 's3-pi-read-probe-1', created_at: new Date().toISOString(), candidate_id: candidateId,
    formal_parser_selected: true, formal_primary_candidate_id: selection.default_candidate_id, candidate_selection_source: selectionSource,
    selection_id: selection.selection_id, selection_decision: selection.decision_record,
    development_corpus_only: true, independent_acceptance: false, actual_pi_sdk: '1.4.0',
    sqlite_store_policy: 'one_private_store_per_document_retains_original_parser_run_id',
    proves_same_store_multi_run_isolation: false,
    model_execution: 'scripted_loopback_mock', paid_llm_calls: 0, external_pdf_uploads: 0,
    successful_engineering_runs: reports.filter(r => (r as { result?: { engineering_probe_completed: boolean } }).result?.engineering_probe_completed).length,
    full_document_extraction_completed: false, medical_extraction_implemented: false, s2_medical_gold_complete: false,
    s4_medical_extraction_complete: false, runs: reports, network_destinations: [...new Set(networkDestinations)],
    limitations: ['No paid/real model inference tested.', 'Development candidates are not independent acceptance data.',
      'Source line boxes are not exact glyph boxes.', 'Candidate parser native text is processed and not a verbatim quote.',
      'Every real run remains partial; S2 medical gold/review and S4 medical extraction remain unimplemented.',
      'Real model context-window capacity and tool-selection behavior were not verified by scripted dispatch.'] };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ report: relative(CODE, resolve(output, 'report.json')), engineering_runs: report.successful_engineering_runs, total_runs: reports.length })}\n`);
  if (report.successful_engineering_runs !== reports.length) process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; }
