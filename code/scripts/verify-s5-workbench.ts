/** Operator-only one-run verification. prepare/check never start a provider; normal product UI has no approval-file workflow. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { ContractError, type RunInput, type Scope } from '@t1/contracts';
import { ExtractionBudget, ExtractionStore, RunStore, S4_LIMITS, createConfiguredPdfParserAdapter, discoverPdfFigures,
  loadModelConfig, safeError, ModelConfig, type ExtractionBudgetLimits } from '@t1/agent';
import { buildApp } from '../apps/server/src/app.js';
import { WorkbenchWorkflow, unavailableMedicalCatalog, type WorkflowRunner } from '../apps/server/src/workflow.js';
import { executeWorkbenchExtraction } from '../apps/server/src/workflow-runner.js';
import { workbenchModelPolicy } from '../apps/server/src/model-policy.js';

const CODE = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PUBLIC_MODEL = { provider: 'agicto', endpoint: 'https://api.agicto.cn/v1', model_id: 'gpt-6-luna', reasoning_effort: 'medium', api: 'openai-responses' } as const;
const PDF = { path: 'evaluation/corpus/development-candidates/L05.pdf', sha256: 'bd60db7e7fe5c7950ac85264c653f48feeb9c503eca76147da26d297f830535f', physical_pages: 10 };
const AUTHORIZATION_PATH = 'docs/acceptance/s5-workflow-2026-11-09/real-model-L05/authorization.json';
export const SINGLE_RUN_LIMITS: ExtractionBudgetLimits = { ...S4_LIMITS, requests: 40, input_tokens: 1_000_000, output_tokens: 60_000, seconds: 1800, document_seconds: 1800, batch_responses: 16 };
export interface VerificationPlan {
  schema_version: 's5-one-real-workbench-plan-1'; plan_id: string; prepared_at: string; new_paid_authorization: 0 | 1;
  input: typeof PDF; model: typeof PUBLIC_MODEL; limits: ExtractionBudgetLimits; scope: Scope;
  code_sha256: Record<string, string>; directory: string; frontend: 'http://127.0.0.1:30141'; backend_port: 3210;
  previous_case: { requests: number; input_tokens: number; output_tokens: number; seconds: number; candidates: number; cost: null; cached_IR_only: true; result_path: string; result_sha256: string };
  operation: string[]; stop_policy: string[]; permission: string; token_limit_semantics: string;
  frontend_build: { mode: 'production'; record_build_id_before_browser_start: true; route_smoke_must_pass: true };
}
function inside(path: string) { const rel = relative(CODE, resolve(path)); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('verification_path_outside_code'); return rel; }
export function assertPins(pins: Record<string, string>) { for (const [path, expected] of Object.entries(pins)) {
  inside(resolve(CODE, path)); if (hash(readFileSync(resolve(CODE, path))) !== expected) throw new ContractError('verification_code_or_input_changed');
} }
export function assertNewApproval(planBytes: Buffer, supplied: string | undefined) {
  if (!supplied) throw new ContractError('new_user_approval_required_no_provider_request_allowed');
  if (supplied !== hash(planBytes)) throw new ContractError('new_approval_plan_sha256_mismatch');
}
function realConfig() { return loadModelConfig(resolve(CODE, '.env'), { ...process.env, T1_MODEL_PROVIDER: PUBLIC_MODEL.provider,
  T1_MODEL_BASE_URL: PUBLIC_MODEL.endpoint, T1_MODEL_ID: PUBLIC_MODEL.model_id }); }
async function pinFiles() {
  const files: string[] = [];
  for (const folder of ['apps/server/src', 'packages/agent/src', 'packages/contracts/src', 'services/pdf-parser']) {
    for (const item of await readdir(resolve(CODE, folder), { recursive: true, withFileTypes: true })) {
      if (item.isFile() && /\.(?:ts|py)$/u.test(item.name) && !item.parentPath.includes('/tests')) files.push(relative(CODE, resolve(item.parentPath, item.name)));
    }
  }
  files.push('scripts/verify-s5-workbench.ts', 'package.json', 'package-lock.json', 'config/pdf-parser.json', PDF.path, AUTHORIZATION_PATH,
    'docs/acceptance/s4/selection-optimization/continuation-2026-11-03/supplier-alias-confirmation.json');
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async path => [path, hash(await readFile(resolve(CODE, path)))])));
}
export async function preparePlan(path: string) {
  inside(path); const config = realConfig(), policy = workbenchModelPolicy(config);
  assert.ok(config.apiKey()); assert.equal(policy.profile.reasoning_effort, 'medium'); assert.ok(policy.responseModelAliasPolicy);
  assert.equal(hash(await readFile(resolve(CODE, PDF.path))), PDF.sha256);
  const authorization = JSON.parse(await readFile(resolve(CODE, AUTHORIZATION_PATH), 'utf8'));
  if (authorization.authorized_runs !== 1 || authorization.selected_case !== 'L05' || authorization.maximum_requests !== 40) throw new ContractError('L05_authorization_binding_invalid');
  const plan: VerificationPlan = { schema_version: 's5-one-real-workbench-plan-1', plan_id: 's5-L05-' + randomUUID(), prepared_at: new Date().toISOString(), new_paid_authorization: 1,
    input: PDF, model: PUBLIC_MODEL, limits: SINGLE_RUN_LIMITS,
    scope: { scope_version: '1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] }, catalog_version: unavailableMedicalCatalog.catalog_version, matching_policy_version: 'exact-explicit-synonyms-1' },
    code_sha256: await pinFiles(), directory: '', frontend: 'http://127.0.0.1:30141', backend_port: 3210,
    frontend_build: { mode: 'production', record_build_id_before_browser_start: true, route_smoke_must_pass: true },
    previous_case: { requests: 15, input_tokens: 156254, output_tokens: 1636, seconds: 290.29995222900016, candidates: 0, cost: null, cached_IR_only: true,
      result_path: 'docs/acceptance/s4-b0-revalidation-2026-11-08/prepared/execution/L05-B0/result.json', result_sha256: 'de56841595caaeedbf2a0a4f1f13198cd745710d35a727c8eee559338d98a339' },
    operation: ['User authorized continuation with a delegated replacement case; main session selected L05. Coordinate temporary 3210 switch only; do not start a second Next instance.',
      'Fresh isolated SQLite/file directory, no retained-source imports and no synthetic review rows.',
      'Actual browser opens the existing Next workbench, uploads pinned L05 PDF and clicks Start once; Next /api/t1 proxy forwards to the existing Fastify routes.',
      'Fresh configured Docling CPU parse on uploaded bytes; existing B0/Pi extraction and same-run summary; persistent candidates/SSE/original PDF.',
      'Browser displays saved candidates or a truthful empty result, original page and candidate JSONL/CSV/package; never force candidates or call approve/revise/review APIs.',
      'Persist run/usage/report, close unused allowance and model-enabled server; always restore the ordinary model-disabled 3210 main/database and record health.'],
    stop_policy: ['One admitted run only; no whole-run retry, no automatic resume, no second paper.', '30 minutes starts before parsing at HTTP run admission; all bounded request retries and summary calls count.',
      'Stop at budget/deadline/source/model-identity/delivery-contract failure or first unrecovered batch failure after existing bounded retries; preserve saved partial results and actual usage; never add allowance automatically.'],
    permission: 'Exactly one L05 continuation run is newly user-authorized; the operator binds this frozen plan via --new-user-approved-plan-sha256. The superseded L01 plan and old S4 balances confer no reusable permission. No approval form is added to product UI.',
    token_limit_semantics: 'Existing budget reserves each request before dispatch (at least 32768 input and 8192 output), settles provider usage including cache classes, and stops future calls on overrun. A provider may report input beyond the local reservation; this is an application budget, not a provider-enforced monetary or hard input-token cap.' };
  plan.directory = 'runtime-data/s5-real-workbench/' + plan.plan_id;
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { plan, plan_sha256: hash(await readFile(path)), paid_requests: 0, credential_present_not_authorization: true };
}

/** The existing budget's wall clock is anchored to HTTP admission, not the first model request. */
export class OneRunAllowance {
  readonly controller = new AbortController(); budget?: ExtractionBudget; private timer?: ReturnType<typeof setTimeout>;
  private readonly statePath: string;
  private readonly runtimePins: Record<string, string> = {};
  constructor(readonly plan: VerificationPlan, readonly planSha: string, readonly config: ModelConfig, readonly now = Date.now) {
    this.statePath = resolve(CODE, plan.directory, 'allowance.json'); inside(this.statePath);
  }
  available = () => !existsSync(this.statePath) && !this.controller.signal.aborted;
  prepare = (input: RunInput, directory: string) => {
    if (!this.available()) throw new ContractError('single_verification_allowance_closed');
    assertPins(this.plan.code_sha256);
    if (input.file_sha256 !== this.plan.input.sha256 || JSON.stringify(input.scope) !== JSON.stringify(this.plan.scope)) throw new ContractError('verification_input_or_scope_not_authorized');
    const root = resolve(CODE, this.plan.directory), rel = relative(root, directory);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('verification_run_outside_isolated_directory');
    const started_at = new Date(this.now()).toISOString();
    writeFileSync(this.statePath, JSON.stringify({ plan_sha256: this.planSha, run_id: input.run_id, started_at, limits: this.plan.limits, closed: false }) + '\n', { flag: 'wx', mode: 0o600 });
    const policy = workbenchModelPolicy(this.config), pins = this.plan.code_sha256, runtimePins = this.runtimePins;
    class PinnedBudget extends ExtractionBudget {
      override begin(...args: Parameters<ExtractionBudget['begin']>) { assertPins(pins); assertPins(runtimePins); return super.begin(...args); }
    }
    this.budget = new PinnedBudget(resolve(directory, 'request-ledger.json'), this.config.baseUrl, this.now, { limits: this.plan.limits,
      responseModelAliasPolicy: policy.responseModelAliasPolicy, authorization: { id: this.planSha, source: 'new_user_approved_one_workbench_run', recorded_at: started_at } });
    this.budget.ledger.experiment_started_at = started_at; this.budget.persist();
    this.timer = setTimeout(() => this.close('verification_wall_clock_limit'), this.plan.limits.seconds * 1000); this.timer.unref();
  };
  signal(signal: AbortSignal) { return AbortSignal.any([signal, this.controller.signal]); }
  bindParsedSource(directory: string) {
    const pdf = resolve(CODE, this.plan.directory, 'pdf', this.plan.input.sha256 + '.pdf'), ir = resolve(directory, 'document-ir.json');
    if (hash(readFileSync(pdf)) !== this.plan.input.sha256) throw new ContractError('verification_uploaded_pdf_changed');
    this.runtimePins[inside(pdf)] = this.plan.input.sha256; this.runtimePins[inside(ir)] = hash(readFileSync(ir));
  }
  remainingMs() { if (!this.budget) throw new ContractError('verification_not_admitted'); this.budget.check(); return Math.max(1, Math.floor((this.plan.limits.seconds - this.budget.totals().elapsed_seconds) * 1000)); }
  close(reason: string) {
    clearTimeout(this.timer); this.controller.abort();
    if (this.budget) { this.budget.cancelEntries(this.budget.ledger.requests, reason); this.budget.ledger.halted ??= reason; this.budget.persist(); }
    if (existsSync(this.statePath)) { const previous = JSON.parse(readFileSync(this.statePath, 'utf8')); writeFileSync(this.statePath, JSON.stringify({ ...previous, closed: true, closed_at: new Date(this.now()).toISOString(), reason, unused_allowance_closed: true }) + '\n'); }
  }
}

async function ordinaryMainHealth() {
  const response = await fetch('http://127.0.0.1:3210/health', { signal: AbortSignal.timeout(1000) }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-t1-verification'), null);
  const caps = await (await fetch('http://127.0.0.1:3210/api/workbench/capabilities', { signal: AbortSignal.timeout(1000) })).json() as { controlled_fixture: boolean; extraction_start: boolean };
  assert.equal(caps.controlled_fixture, false); assert.equal(caps.extraction_start, false); return { health: await response.json(), capabilities: caps };
}
async function restoreOrdinaryMain(root: string) {
  try { return { reused_existing_main: true, ...await ordinaryMainHealth() }; } catch { /* temporary server already closed */ }
  const output = openSync(resolve(root, 'restored-main.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], { cwd: CODE, env: { ...process.env, T1_WORKBENCH_MODEL_ENABLED: 'false' }, detached: true, stdio: ['ignore', output, output] });
  closeSync(output); child.unref();
  for (let i = 0; i < 40; i++) { try { return { restored_pid: child.pid, ...await ordinaryMainHealth() }; } catch { await delay(250); } }
  throw new ContractError('ordinary_main_restore_health_failed');
}

export async function executePlan(path: string, approvedSha?: string, dryRun = false) {
  const bytes = await readFile(path); if (!dryRun) assertNewApproval(bytes, approvedSha);
  let plan = JSON.parse(bytes.toString()) as VerificationPlan;
  if (plan.schema_version !== 's5-one-real-workbench-plan-1' || JSON.stringify(plan.input) !== JSON.stringify(PDF) || JSON.stringify(plan.model) !== JSON.stringify(PUBLIC_MODEL) || JSON.stringify(plan.limits) !== JSON.stringify(SINGLE_RUN_LIMITS) || plan.backend_port !== 3210 || plan.frontend !== 'http://127.0.0.1:30141') throw new ContractError('verification_plan_configuration_changed');
  assertPins(plan.code_sha256);
  if (dryRun) { approvedSha = 'offline-dry-run-' + hash(bytes); plan = { ...plan, directory: plan.directory + '-dry-run-' + randomUUID() }; }
  const root = resolve(CODE, plan.directory); inside(root);
  if (existsSync(root)) throw new ContractError('verification_directory_already_exists_no_resume');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new ExtractionStore(resolve(root, 'workflow.sqlite')), legacy = new RunStore(':memory:');
  const replay = dryRun ? await (await import('../apps/server/test/controlled-fixture.js')).controlledFixture({ delayMs: 100 }) : undefined;
  const config = dryRun ? new ModelConfig('controlled-local-replay', 'http://127.0.0.1:1/v1', 'saved-S4-records-no-model-call', 'offline-placeholder') : realConfig();
  const allowance = new OneRunAllowance(plan, approvedSha!, config);
  const runner: WorkflowRunner = { controlled: dryRun, provider: config.provider, model_id: config.modelId, available: allowance.available, prepare: allowance.prepare,
    execute: async context => { allowance.bindParsedSource(context.directory); return dryRun ? replay!.runner!.execute(context) : executeWorkbenchExtraction({ ...context, signal: allowance.signal(context.signal) }, config, allowance.budget!, allowance.remainingMs(), true); } };
  const workflow = new WorkbenchWorkflow(store, { directory: root, sources: false, runner,
    parse: (input, file, directory, signal) => dryRun ? replay!.parse!(input, file, directory, allowance.signal(signal)) : createConfiguredPdfParserAdapter({ logDirectory: directory, timeoutMs: Math.min(600_000, allowance.remainingMs()) }).parse({ run_id: input.run_id, document_id: input.document_id, file_reference: file, file_sha256: input.file_sha256, fixture: false }, allowance.signal(signal)),
    discover: (document, directory, signal) => (dryRun ? replay!.discover! : discoverPdfFigures)(document, directory, signal ? allowance.signal(signal) : allowance.controller.signal) });
  const app = buildApp(legacy, undefined, workflow); let browser: any;
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('x-t1-verification', dryRun ? 'offline-dry-run' : plan.plan_id); return payload; });
  const report: Record<string, unknown> = { schema_version: 's5-real-browser-workbench-result-1', plan_sha256: hash(bytes), controlled_fixture: dryRun, dry_run: dryRun,
    synthetic_human_approval_added: false, actual_new_provider_run: false, frontend: plan.frontend, direct_Fastify_only: false, phase: 'starting', monetary_cost: null, medical_quality_approved: false };
  try {
    const buildPath = resolve(CODE, 'apps/pi-web/.next/BUILD_ID'), buildBytes = await readFile(buildPath);
    report.frontend_production_build_id = buildBytes.toString().trim(); report.frontend_build_id_file_sha256 = hash(buildBytes);
    await app.listen({ host: '127.0.0.1', port: 3210 });
    process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(CODE, '.tools/annotation-browser/browsers');
    process.env.LD_LIBRARY_PATH = [resolve(CODE, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    const { chromium } = await import(pathToFileURL(resolve(CODE, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
    browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
    const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, locale: 'zh-CN' });
    await context.route(/^https?:\/\//u, (route: any) => new URL(route.request().url()).origin === plan.frontend ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage();
    const json = async (suffix: string) => { const r = await context.request.get(plan.frontend + '/api/t1/' + suffix); assert.equal(r.status(), 200); return r.json(); };
    const initial = await json('workbench/runs'); assert.equal(initial.runs.length, 0);
    const caps = await json('workbench/capabilities'); assert.equal(caps.extraction_start, true); assert.equal(caps.controlled_fixture, dryRun);
    await page.goto(plan.frontend + '/?view=newTask'); await page.locator('.t1-scope-editor').waitFor();
    for (const label of ['癌种', '图像类型', '视觉特征']) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), 'all');
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(resolve(CODE, plan.input.path));
    await page.getByLabel('论文标题（可选）', { exact: true }).fill('L05 工作台真实贯通复验（原始结果待核）');
    const uploaded = page.waitForResponse((r: any) => r.url().endsWith('/api/t1/workbench/papers') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '上传论文', exact: true }).click(); const upload = await uploaded; assert.equal(upload.status(), 201);
    // React may already replace the route after saving; inspect persisted IDs through the same-origin API instead of an evicted browser response body.
    const papers = (await json('workbench/papers')).papers; assert.equal(papers.length, 1); const paper = papers[0]; assert.equal(paper.sha256, plan.input.sha256); report.paper_id = paper.id;
    await page.getByLabel('本次任务论文', { exact: true }).selectOption(paper.id);
    await page.locator('.t1-pdf-reader canvas[data-page="1"]').waitFor();
    await page.screenshot({ path: resolve(root, 'browser-upload-original.png'), fullPage: true });
    const started = page.waitForResponse((r: any) => r.url().endsWith('/runs') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '开始抽取', exact: true }).click(); const start = await started; assert.equal(start.status(), 202);
    const admitted = (await json('workbench/runs')).runs; assert.equal(admitted.length, 1); const run = admitted[0]; report.run_id = run.run_id; report.phase = 'running';
    await writeFile(resolve(root, 'verification-report.json'), JSON.stringify(report, null, 2) + '\n');
    let detail: any;
    do { detail = await json('workbench/runs/' + encodeURIComponent(run.run_id)); if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(detail.run.state)) break;
      await delay(1000);
    } while (allowance.remainingMs() > 0);
    await workflow.waitForIdle(); detail = await json('workbench/runs/' + encodeURIComponent(run.run_id));
    assert.equal(detail.source_status, 'valid'); assert.equal(detail.output.origin, dryRun ? 'controlled_fixture' : 'workbench_run');
    const sourcePdf = await context.request.get(plan.frontend + detail.pdf_url); assert.equal(hash(await sourcePdf.body()), plan.input.sha256);
    assert.equal((await json('workbench/runs')).runs.length, 1);
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM workbench_reviews').get()!.n), 0);
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM workbench_annotations').get()!.n), 0);
    await page.goto(`${plan.frontend}/?paper=${paper.id}&run=${encodeURIComponent(run.run_id)}&view=records`);
    await page.locator('.t1-task-progress').waitFor();
    if (detail.output.records.length) await page.locator('article.t1-evidence-card').waitFor();
    else await page.getByText('此运行暂无已保存候选；不代表论文没有证据或抽取无遗漏。', { exact: true }).waitFor();
    const downloads = [];
    for (const [kind, label] of [['candidate_jsonl', '候选 JSONL'], ['candidate_csv', '候选 CSV'], ['candidate_package', '候选证据包']] as const) {
      const pendingDownload = page.waitForEvent('download'); await page.getByRole('button', { name: label, exact: true }).click(); const file = await pendingDownload;
      const suffix = kind.endsWith('package') ? 'tar.gz' : kind.endsWith('csv') ? 'csv' : 'jsonl', output = resolve(root, kind + '.' + suffix);
      await file.saveAs(output); assert.equal(await file.failure(), null); const body = await readFile(output); downloads.push({ kind, bytes: body.length, sha256: hash(body) });
    }
    await page.screenshot({ path: resolve(root, 'browser-saved-candidates.png'), fullPage: true });
    Object.assign(report, { phase: 'finished', state: detail.run.state, records: detail.output.records.length, coverage: detail.output.coverage, downloads,
      task_processing_complete: detail.output.coverage?.task_processing_complete === true, business_review_rows: 0, business_annotation_rows: 0,
      actual_usage: allowance.budget?.totals(), browser_upload_and_start_through_existing_Next_gateway: true, saved_candidate_view_verified: detail.output.records.length > 0,
      empty_output_display_verified: detail.output.records.length === 0, result_view_verified: true,
      fresh_CPU_and_model_pipeline_executed: !dryRun, whole_document_medical_recall_claimed: false });
  } catch (error) { report.phase = 'stopped'; report.error = safeError(error); if (dryRun) report.offline_diagnostic = error instanceof Error ? error.stack : String(error); report.actual_usage = allowance.budget?.totals(); throw error; }
  finally {
    allowance.close('single_workbench_verification_closed_no_remaining_allowance');
    const cleaned = await Promise.allSettled([browser?.close(), app.close()]); legacy.close(); store.close();
    report.cleanup = cleaned.map(value => value.status === 'fulfilled' ? 'closed' : 'close_error');
    report.actual_new_provider_run = !dryRun && (allowance.budget?.totals().requests ?? 0) > 0; report.unused_allowance_closed = true;
    try { report.ordinary_main_restored = await restoreOrdinaryMain(root); }
    catch (error) { report.ordinary_main_restore_error = safeError(error); process.exitCode = 1; }
    await writeFile(resolve(root, 'verification-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), command = args[0], path = resolve(args[1] ?? 'docs/acceptance/s5-workflow-2026-11-09/real-model-L05/plan.json');
  try {
    if (command === 'prepare') { const result = await preparePlan(path); process.stdout.write(JSON.stringify({ plan_path: relative(CODE, path), plan_sha256: result.plan_sha256, paid_requests: 0 }) + '\n'); }
    else if (command === 'check') { const plan = JSON.parse(await readFile(path, 'utf8')) as VerificationPlan; assertPins(plan.code_sha256); realConfig(); process.stdout.write(JSON.stringify({ plan_sha256: hash(await readFile(path)), code_and_input_pins_valid: true, paid_requests: 0, new_authorization: 0 }) + '\n'); }
    else if (command === 'dry-run') process.stdout.write(JSON.stringify(await executePlan(path, undefined, true)) + '\n');
    else if (command === 'execute') { const at = args.indexOf('--new-user-approved-plan-sha256'); const result = await executePlan(path, at >= 0 ? args[at + 1] : undefined); if (result.task_processing_complete !== true || result.result_view_verified !== true) process.exitCode = 1; process.stdout.write(JSON.stringify(result) + '\n'); }
    else throw new ContractError('use_prepare_check_dry_run_or_explicitly_approved_execute');
  } catch (error) { process.stdout.write(JSON.stringify({ error: safeError(error), no_implicit_new_allowance: true }) + '\n'); process.exitCode = 1; }
}
