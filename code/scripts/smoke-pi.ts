import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { FixtureTools, RunStore, createRestrictedSession, executeFixture, loadModelConfig, makeFixture, safeError, type SessionLike } from '@t1/agent';
import { validateCandidate } from '@t1/contracts';

const output = resolve('docs/acceptance/s1');
await mkdir(output, { recursive: true });
const startedAt = new Date().toISOString();
const label = startedAt.replace(/[:.]/g, '-');
let store: RunStore | undefined;
let createdRunId: string | undefined;
let activeSession: SessionLike | undefined;
let exit = 1;
let report: Record<string, unknown>;
try {
  store = new RunStore(resolve('runtime-data/t1.sqlite'));
  const config = loadModelConfig();
  const fixture = makeFixture(config);
  store.create(fixture.input);
  createdRunId = fixture.input.run_id;
  store.transition(fixture.input.run_id, 'extracting');
  const tools = new FixtureTools(fixture.input, fixture.document, fixture.catalog, store);
  const created = await createRestrictedSession(config, tools, resolve('runtime-data/runs', fixture.input.run_id));
  activeSession = created.session;
  const result = await executeFixture(tools, created.session);
  activeSession = undefined; // executeFixture releases the session in its finally block.
  const records = store.records(fixture.input.run_id); records.forEach(validateCandidate);
  const success = result.state === 'completed' && result.settled && records.length > 0 && result.events.some(e => e.type === 'tool_execution_end' && e.tool_name === 'submit_candidate_records' && !e.is_error);
  report = { schema_version: '1', stage: 'S1', status: success ? 'passed' : 'failed', real_model_call: true,
    fixture: true, medical_evidence: false, configuration: config.publicInfo(), started_at: startedAt, finished_at: new Date().toISOString(),
    pi_audit: created.audit, run_input: fixture.input, source_document_ir: fixture.document,
    tool_calls: tools.successfulCalls, ...result, business_events: store.events(fixture.input.run_id), records,
    coverage: { expected_block_ids: fixture.document.coverage.expected_block_ids, read_block_ids: [...tools.readBlocks] },
    paper_exports_allowed: false, dependencies_lock_sha256: createHash('sha256').update(await readFile('package-lock.json')).digest('hex') };
  exit = success ? 0 : 1;
} catch (cause) {
  const error = safeError(cause);
  let state: string | undefined;
  let stateError: ReturnType<typeof safeError> | undefined;
  if (store && createdRunId) {
    try { state = store.terminateIfRunning(createdRunId); } catch (failure) { stateError = safeError(failure); }
  }
  report = { stage: 'S1', status: 'failed', started_at: startedAt, finished_at: new Date().toISOString(), error,
    fixture: true, medical_evidence: false, real_model_call: 'not_confirmed', actual_cost: null, cost_status: 'unknown; not zero',
    run_id: createdRunId, state, state_transition_error: stateError };
} finally {
  if (activeSession) {
    try { activeSession.dispose(); } catch (failure) { report!.session_cleanup_error = safeError(failure); }
  }
  store?.close();
}
const path = resolve(output, `smoke-pi-${label}.json`);
await writeFile(path, JSON.stringify(report, null, 2) + '\n');
await writeFile(resolve(output, 'smoke-pi-latest.json'), JSON.stringify({ report: `smoke-pi-${label}.json`, status: report.status }, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, report: path, real_model_call: report.real_model_call, actual_cost: null }));
process.exitCode = exit;
