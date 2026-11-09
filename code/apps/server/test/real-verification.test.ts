import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { ContractError, type RunInput } from '@t1/contracts';
import { ExtractionStore, ModelConfig, RunStore, ExtractionBudget, createExtractionSession, promptExtractionSession, developmentProfile, runExtractionDocument } from '@t1/agent';
import { workbenchModelPolicy } from '../src/model-policy.js';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { assertNewApproval, executePlan, OneRunAllowance, SINGLE_RUN_LIMITS, type VerificationPlan } from '../../../scripts/verify-s5-workbench.js';
import { createRuntimeResponsesFixture } from '../../../tests/extraction/fixtures/runtime-responses.js';
import { makeEvidenceFixture } from '../../../tests/extraction/fixtures/evidence-fixtures.js';
import { controlledFixture } from './controlled-fixture.js';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const publicModel = { provider: 'agicto', endpoint: 'https://api.agicto.cn/v1', model_id: 'gpt-6-luna', reasoning_effort: 'medium', api: 'openai-responses' } as const;
const model = () => new ModelConfig(publicModel.provider, publicModel.endpoint, publicModel.model_id, 'synthetic-local-placeholder');
async function fixture() {
  const directory = await mkdtemp(resolve('runtime-data/s5-real-verification-test-'));
  const pin = resolve(directory, 'pinned-code.txt'), body = Buffer.from('explicit fixture code pin'); await writeFile(pin, body);
  const plan: VerificationPlan = { schema_version: 's5-one-real-workbench-plan-1', plan_id: 'nonmedical-offline-fixture', prepared_at: '2026-11-09T00:00:00Z', new_paid_authorization: 0,
    input: { path: 'evaluation/corpus/development-candidates/L05.pdf', sha256: 'bd60db7e7fe5c7950ac85264c653f48feeb9c503eca76147da26d297f830535f', physical_pages: 10 }, model: publicModel,
    limits: { ...SINGLE_RUN_LIMITS }, scope: { scope_version: '1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] }, catalog_version: 'medical-unavailable-1', matching_policy_version: 'exact-explicit-synonyms-1' },
    directory: relative(process.cwd(), directory), code_sha256: { [relative(process.cwd(), pin)]: sha(body) }, frontend: 'http://127.0.0.1:30141', backend_port: 3210,
    previous_case: { requests: 15, input_tokens: 156254, output_tokens: 1636, seconds: 290.299, candidates: 0, cost: null, cached_IR_only: true, result_path: 'synthetic fixture', result_sha256: '0'.repeat(64) },
    operation: [], stop_policy: [], permission: 'offline test only', token_limit_semantics: 'synthetic fixture',
    frontend_build: { mode: 'production', record_build_id_before_browser_start: true, route_smoke_must_pass: true } };
  const input: RunInput = { schema_version: '1', run_id: 'controlled-one-run', document_id: 'controlled-L05', file_sha256: plan.input.sha256,
    fixture: false, scope: plan.scope, rule_version: 'visual-statements-2', runtime_profile: { provider: 'agicto', model_id: 'gpt-6-luna', endpoint: '', pi_version: '1.4.0', version: 's5-host-admission-test' } };
  return { directory, pin, plan, input };
}

test('a matching new approval is required before executable verification can perform any HTTP/model operation', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s5-permission-fixture-')), path = resolve(directory, 'plan.json');
  const bytes = Buffer.from('{"fixture":"no permissions"}\n'); await writeFile(path, bytes);
  let requests = 0; const original = globalThis.fetch; globalThis.fetch = async () => { requests++; throw new Error('forbidden in permission test'); };
  try {
    assert.throws(() => assertNewApproval(bytes, undefined), /new_user_approval_required/);
    assert.throws(() => assertNewApproval(bytes, '0'.repeat(64)), /new_approval_plan_sha256_mismatch/);
    await assert.rejects(executePlan(path), /new_user_approval_required/); assert.equal(requests, 0);
    const superseded = resolve('docs/acceptance/s5-workflow-2026-11-09/real-model/plan.json'), previous = await readFile(superseded);
    await assert.rejects(executePlan(superseded, sha(previous)), /verification_plan_configuration_changed/); assert.equal(requests, 0);
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});

test('fixed L05 saved-source empty output still has valid empty JSONL, CSV header and candidate package without model calls', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s5-L05-empty-offline-')), store = new ExtractionStore(resolve(directory, 'workflow.sqlite'));
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false, ...await controlledFixture({ delayMs: 1 }) });
  try {
    const upload = await workflow.upload(await readFile('evaluation/corpus/development-candidates/L05.pdf'), 'L05.pdf');
    const run = (await workflow.start(upload.paper.id, workflow.scopeCatalog().default_scope)).run; await workflow.waitForIdle();
    const detail = await workflow.runDetail(run.run_id); assert.equal(detail.output.records.length, 0); assert.equal(detail.output.origin, 'controlled_fixture');
    const jsonl = await workflow.export(run.run_id, 'candidate_jsonl'), csv = await workflow.export(run.run_id, 'candidate_csv'), archive = await workflow.export(run.run_id, 'candidate_package');
    assert.equal(jsonl.bytes.length, 0); assert.match(csv.bytes.toString(), /record_id,record_version,fragment_index/); assert.equal(archive.bytes.subarray(0, 2).toString('hex'), '1f8b');
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM workbench_reviews').get()!.n), 0);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP admission is one run only, deadline includes pre-model parsing, pins and input cannot widen, and reopening cannot resume', async () => {
  const f = await fixture(); let clock = Date.parse('2026-11-09T10:00:00Z');
  const allowance = new OneRunAllowance(f.plan, 'offline-test-plan', model(), () => clock), runDirectory = resolve(f.directory, 'runs', f.input.run_id); await mkdir(runDirectory, { recursive: true });
  try {
    assert.throws(() => allowance.prepare({ ...f.input, file_sha256: '0'.repeat(64) }, runDirectory), /verification_input_or_scope_not_authorized/); assert.equal(allowance.available(), true);
    allowance.prepare(f.input, runDirectory); assert.equal(allowance.available(), false); assert.equal(allowance.budget!.totals().requests, 0);
    assert.equal(allowance.budget!.ledger.experiment_started_at, '2026-11-09T10:00:00.000Z');
    assert.throws(() => allowance.prepare(f.input, runDirectory), /single_verification_allowance_closed/);
    const reopened = new OneRunAllowance(f.plan, 'offline-test-plan', model(), () => clock); assert.equal(reopened.available(), false);
    await mkdir(resolve(f.directory, 'pdf')); await writeFile(resolve(f.directory, 'pdf', f.plan.input.sha256 + '.pdf'), await readFile(f.plan.input.path));
    const ir = resolve(runDirectory, 'document-ir.json'); await writeFile(ir, '{"explicit":"offline source fixture"}\n'); allowance.bindParsedSource(runDirectory);
    await writeFile(ir, '{}'); assert.throws(() => allowance.budget!.begin('gpt-6-luna', 'fixture', 0, '{}', 8192), /verification_code_or_input_changed/);
    await writeFile(f.pin, 'changed'); assert.throws(() => allowance.budget!.begin('gpt-6-luna', 'fixture', 0, '{}', 8192), /verification_code_or_input_changed/); assert.equal(allowance.budget!.totals().requests, 0);
    clock += 1800_001; assert.throws(() => allowance.remainingMs(), /experiment_time_limit/);
  } finally { allowance.close('offline-test-finished'); await rm(f.directory, { recursive: true, force: true }); }
});

test('one-run host failure policy stops after the first unrecovered batch and counts existing bounded retries without a second batch', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s5-fail-fast-fixture-')), store = new ExtractionStore(':memory:');
  const fixture = makeEvidenceFixture(['CT shows a round nodule.', 'MRI shows a solid lesion.']);
  const local = await createRuntimeResponsesFixture(() => ({ status: 503 }));
  try {
    const budget = new ExtractionBudget(resolve(directory, 'local-ledger.json'), local.endpoint);
    const result = await runExtractionDocument({ input: fixture.input, document: fixture.document, catalog: fixture.catalog, metadata: fixture.context.metadata,
      profile: developmentProfile(local.config.modelId), config: local.config, budget, store, directory: resolve(directory, 'run'), strategy: 'baseline',
      batchOptions: { maxBlocks: 1, contextBlocks: 0 }, stopOnBatchFailure: true });
    assert.equal(local.requests.length, 3); assert.equal(budget.totals().requests, 3); assert.equal(result.error?.code, 'unrecovered_batch_failure_stopped');
    assert.equal(new Set(store.batches(fixture.input.run_id).map(b => b.batch_id)).size, 1); assert.equal(result.task_processing_complete, false);
  } finally { await local.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('actual Fastify upload/start uses the optional host gate while keeping all trial data and approvals isolated', async () => {
  const f = await fixture(), allowance = new OneRunAllowance(f.plan, 'offline-http-plan', model()), store = new ExtractionStore(resolve(f.directory, 'workflow.sqlite')), legacy = new RunStore();
  const workflow = new WorkbenchWorkflow(store, { sources: false, directory: f.directory,
    runner: { controlled: false, provider: 'agicto', model_id: 'gpt-6-luna', available: allowance.available, prepare: allowance.prepare, execute: async () => { throw new Error('must never reach provider in this test'); } },
    parse: async () => { throw new ContractError('offline_test_stops_before_CPU_or_provider'); } });
  const app = buildApp(legacy, undefined, workflow);
  try {
    const upload = await app.inject({ method: 'POST', url: '/api/workbench/papers', headers: { 'content-type': 'application/pdf', 'x-t1-filename': 'L01.pdf' }, payload: await readFile(f.plan.input.path) }); assert.equal(upload.statusCode, 201);
    const id = upload.json().paper.id, url = `/api/workbench/papers/${id}/runs`;
    const start = await app.inject({ method: 'POST', url, payload: { scope: f.plan.scope } }); assert.equal(start.statusCode, 202);
    const second = await app.inject({ method: 'POST', url, payload: { scope: f.plan.scope } }); assert.equal(second.statusCode, 400); assert.equal(second.json().error, 'run_start_allowance_closed');
    await workflow.waitForIdle(); assert.equal((await workflow.runs()).length, 1); assert.equal((await workflow.runs())[0]!.state, 'failed');
    assert.equal((await app.inject('/api/workbench/capabilities')).json().extraction_start, false);
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM workbench_reviews').get()!.n), 0);
    assert.equal(allowance.budget!.totals().requests, 0);
  } finally { allowance.close('offline-test-finished'); await app.close(); store.close(); legacy.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('formal and verification runtime share exact supplier alias; installed Pi emits canonical Luna/medium to the fixed endpoint, intercepted on loopback only', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s5-model-config-fixture-'));
  const policy = workbenchModelPolicy(model()); assert.equal(policy.profile.model_id, 'gpt-6-luna'); assert.equal(policy.profile.reasoning_effort, 'medium'); assert.ok(policy.responseModelAliasPolicy);
  const local = await createRuntimeResponsesFixture([{ text: 'Explicit local configuration fixture only.', response_model: 'igpt-6-luna' }]);
  const original = globalThis.fetch; const destinations: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); destinations.push(request.url); assert.equal(request.url, 'https://api.agicto.cn/v1/responses');
    return original(new Request(local.endpoint + '/responses', { method: request.method, headers: request.headers, body: await request.text(), signal: request.signal }));
  };
  try {
    const budget = new ExtractionBudget(resolve(directory, 'local-ledger.json'), publicModel.endpoint, Date.now, { responseModelAliasPolicy: policy.responseModelAliasPolicy });
    const session = await createExtractionSession(model(), policy.profile, [], directory, budget, 'synthetic-configuration-check');
    const result = await promptExtractionSession(session, 'Controlled loopback transport check only.', budget);
    assert.equal(result.error, undefined); assert.deepEqual(destinations, ['https://api.agicto.cn/v1/responses']);
    assert.equal(local.requests[0]!.body.model, 'gpt-6-luna'); assert.equal((local.requests[0]!.body.reasoning as { effort: string }).effort, 'medium');
    assert.equal(local.requests[0]!.body.stream, true); assert.notEqual(local.requests[0]!.body.store, true);
    assert.equal(budget.ledger.requests[0]!.response_model_identity_status, 'confirmed_alias');
    assert.equal(budget.ledger.requests[0]!.provider_response_model, 'igpt-6-luna');
  } finally { globalThis.fetch = original; await local.close(); await rm(directory, { recursive: true, force: true }); }
});
