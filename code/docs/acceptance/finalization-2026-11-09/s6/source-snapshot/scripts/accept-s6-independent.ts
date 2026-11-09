import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cpus, totalmem, platform, release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ContractError, type RunInput, type FigureAssetCatalog } from '@t1/contracts';
import { ExtractionStore, RunStore, ExtractionBudget, loadModelConfig, safeError, createConfiguredPdfParserAdapter, discoverPdfFigures,
  buildEvidenceDelivery, allDeliveredRecords, exportEvidenceDelivery, assertLivePdfSource, type ModelConfig, type ExtractionBudgetLimits } from '@t1/agent';
import { buildApp } from '../apps/server/src/app.js';
import { WorkbenchWorkflow, type WorkflowExecution } from '../apps/server/src/workflow.js';
import { executeWorkbenchExtraction } from '../apps/server/src/workflow-runner.js';
import { workbenchModelPolicy } from '../apps/server/src/model-policy.js';
import { assertIndependentCorpus, assertIndependentUse, type IndependentCorpus } from '../evaluation/src/corpus-isolation.js';
import type { SourceManifest } from '../evaluation/src/contracts.js';
import { auditIndependentDelivery, prepareIndependentReview, summarizeIndependentTiming, runWithTwoSlots, S6_SEED } from '../evaluation/src/independent-acceptance.js';

const CODE = fileURLToPath(new URL('../', import.meta.url));
const EVIDENCE = 'docs/acceptance/finalization-2026-11-09/s6';
const PLAN_PATH = EVIDENCE + '/plan.json';
const AUTH_PATH = EVIDENCE + '/authorization.json';
const ORIGIN = 'http://127.0.0.1:3211';
export const PER_PAPER: ExtractionBudgetLimits = { requests: 40, input_tokens: 600_000, output_tokens: 40_000, seconds: 1800,
  request_seconds: 120, document_seconds: 1800, transient_retries: 2, response_output_tokens: 8192, batch_responses: 16 };
const MODEL = { provider: 'agicto', endpoint: 'https://api.agicto.cn/v1', model_id: 'gpt-6-luna', reasoning_effort: 'medium', api: 'openai-responses' } as const;
const sha = (raw: Uint8Array | string) => createHash('sha256').update(raw).digest('hex');
const hashFile = (path: string) => sha(readFileSync(resolve(CODE, path)));
const json = <T = any>(path: string): T => JSON.parse(readFileSync(resolve(CODE, path), 'utf8')) as T;
const inside = (path: string) => { const rel = relative(CODE, resolve(path)); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('s6_path_outside_code'); return rel; };
const exclusiveJson = async (path: string, value: unknown) => { await mkdir(dirname(resolve(CODE, path)), { recursive: true }); await writeFile(resolve(CODE, path), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); };
interface Source { source_id: string; article_family_id: string; title: string; doi: string | null; path: string; sha256: string; physical_pages: number; seal_identity_sha256: string }
export interface S6Plan {
  schema_version: 's6-independent-plan-1'; prepared_at: string; authorization_sha256: string; absolute_deadline: string;
  inputs: Source[]; model: typeof MODEL; per_paper_limits: ExtractionBudgetLimits; global_limits: { requests: number; input_tokens: number; output_tokens: number; seconds: number };
  scope: any; concurrency: 2; directory: string; origin: string; seed: string; code_sha256: Record<string, string>; runtime: Record<string, unknown>;
  thresholds: Record<string, number>; protocol: Record<string, unknown>;
}
function sourceFiles() {
  const files: string[] = [];
  const visit = (directory: string) => { for (const item of readdirSync(resolve(CODE, directory), { withFileTypes: true })) {
    const path = directory + '/' + item.name; if (item.isDirectory()) { if (!['__pycache__', '.pytest_cache'].includes(item.name)) visit(path); }
    else if (/\.(?:ts|py)$/u.test(path)) files.push(path);
  } };
  for (const directory of ['packages/agent/src', 'packages/contracts/src', 'services/pdf-parser']) visit(directory);
  files.push('scripts/accept-s6-independent.ts', 'scripts/independent-corpus.ts', 'evaluation/src/independent-acceptance.ts',
    'evaluation/src/corpus-isolation.ts', 'evaluation/src/output-sampling.ts', 'evaluation/src/output-review-pack.ts',
    'apps/server/src/app.ts', 'apps/server/src/workbench.ts', 'apps/server/src/workflow.ts', 'apps/server/src/workflow-runner.ts', 'apps/server/src/model-policy.ts',
    'config/pdf-parser.json', 'package.json', 'package-lock.json', 'docs/acceptance/s4/selection-optimization/continuation-2026-11-03/supplier-alias-confirmation.json');
  return [...new Set(files)].sort();
}
function assertPins(pins: Record<string, string>) { for (const [path, expected] of Object.entries(pins)) if (hashFile(path) !== expected) throw new ContractError('s6_code_or_source_pin_changed:' + path); }
function publicConfig(config: ModelConfig) { return { provider: config.provider, endpoint: config.baseUrl, model_id: config.modelId, reasoning_effort: workbenchModelPolicy(config).profile.reasoning_effort, api: 'openai-responses' }; }
/** The experiment's authorized public model is explicit; the existing secret is read without changing production settings. */
export function authorizedConfig(environment: NodeJS.ProcessEnv = process.env, path = resolve(CODE, '.env')) {
  return loadModelConfig(path, { ...environment, T1_MODEL_PROVIDER: MODEL.provider, T1_MODEL_BASE_URL: MODEL.endpoint, T1_MODEL_ID: MODEL.model_id });
}
function intake() { const c = json<IndependentCorpus>('evaluation/manifests/independent-intake.json'), h = json<SourceManifest>('evaluation/manifests/source-register.json'); assertIndependentCorpus(c, h); return { c, h }; }
export async function preparePlan() {
  const authorization = json(AUTH_PATH); assert.equal(authorization.maximum_requests, 120); assert.equal(authorization.source, 'user_four_hour_delegation_relayed_by_root');
  assert.equal(authorization.deadline_utc, '2026-11-09T11:53:56Z');
  const { c, h } = intake(), identity = json<any[]>(EVIDENCE + '/intake/pdf-identity-and-physical-pages.json');
  const inputs: Source[] = ['IN01', 'IN02', 'IN03'].map(source_id => {
    const paper = assertIndependentUse(c, h, source_id, 'independent_acceptance'); assert.equal(paper.state, 'sealed');
    return { source_id, article_family_id: paper.article_family_id, title: paper.title, doi: paper.doi, path: paper.file.path,
      sha256: paper.file.sha256, physical_pages: identity.find(p => p.source_id === source_id).physical_pages, seal_identity_sha256: paper.seal!.identity_sha256 };
  });
  assert.equal(inputs.reduce((n, p) => n + p.physical_pages, 0), 17);
  const snapshot = EVIDENCE + '/source-snapshot'; await mkdir(resolve(CODE, snapshot), { recursive: true });
  const pins: Record<string, string> = {};
  for (const path of sourceFiles()) { pins[path] = hashFile(path); const destination = resolve(CODE, snapshot, path); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(resolve(CODE, path), destination); }
  const sealedSnapshot = EVIDENCE + '/sealed-intake-before-exposure.json'; await exclusiveJson(sealedSnapshot, c); pins[sealedSnapshot] = hashFile(sealedSnapshot); pins[AUTH_PATH] = hashFile(AUTH_PATH);
  for (const source of inputs) pins[source.path] = source.sha256;
  const python = spawnSync(resolve(CODE, '.venv/bin/python'), ['-c', 'import json,platform,importlib.metadata as m; print(json.dumps({"python":platform.python_version(),"packages":{x:m.version(x) for x in ["docling","docling-parse","pypdf","pypdfium2","torch"]}}))'], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  const plan: S6Plan = { schema_version: 's6-independent-plan-1', prepared_at: new Date().toISOString(), authorization_sha256: hashFile(AUTH_PATH),
    absolute_deadline: authorization.deadline_utc, inputs, model: MODEL, per_paper_limits: PER_PAPER,
    global_limits: { requests: 120, input_tokens: 1_800_000, output_tokens: 120_000, seconds: 3600 },
    scope: { scope_version: '1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] },
      catalog_version: 'medical-unavailable-1', matching_policy_version: 'exact-explicit-synonyms-1' },
    concurrency: 2, directory: 'runtime-data/s6-independent/execution', origin: ORIGIN, seed: S6_SEED, code_sha256: pins,
    runtime: { node: process.version, architecture: process.arch, platform: platform(), kernel: release(), cpus: cpus().map(c => c.model), total_memory_bytes: totalmem(), parser: JSON.parse(python.stdout),
      parse_process: 'Fresh process and first parse of each new PDF; model weights already downloaded; OS caches not cleared and unrelated services not stopped.',
      background_load: 'S7 Docker dependency download/install may share the host; backend owner agreed to pause Next/CPU work during parser windows. Actual windows logged.' },
    thresholds: { http_admission_seconds: 2, first_progress_seconds: 5, first_candidate_seconds_if_nonempty: 600, terminal_seconds_per_paper: 1800 },
    protocol: { method: 'B0 only; unchanged existing Pi engine/prompt/rules and exact confirmed alias policy', scheduling: 'Two workers actually execute in parallel; IN03 waits for the first completed worker slot.',
      sampling: 'Every delivered current candidate, primary plus background; fixed version/fingerprint rank with seed, min(10,N) per paper, max30 total. Types reported separately. N=0 => denominator N/A. No output-based source replacement.',
      directed_risks: 'At most five deterministic risk examples per paper, separate denominator; image examples only explicit paired/proposed catalog links, never invented pairs.',
      reviewer_kind: 'delegated_ai_operator', actual_human_reviewed_count: 0, medical_quality_approved: false, product_export_approved: false,
      budget_semantics: 'Hard application request admission with in-flight reservations: input=max(payload bytes+512,32768), output8192. Three disjoint per-paper limits sum to global limit. Provider hidden input/output can exceed local reservations; actual overrun is reported as failure and blocks future calls, not claimed as provider-enforced monetary/token cap.',
      failure: 'No full-run retry or automatic resume. Existing at-most-two bounded transient retries count as physical requests. First unrecovered task/contract/budget failure stops new work and aborts peers; paid technical repair requires root decision.',
      timer: 'Global timer begins before first local HTTP and ends within3600s and absolute deadline; per-paper1800s anchored before HTTP admission parsing.' } };
  await exclusiveJson(PLAN_PATH, plan); return { plan_path: PLAN_PATH, plan_sha256: hashFile(PLAN_PATH), pins: Object.keys(pins).length, requests_started: 0 };
}
export async function preflight(path = PLAN_PATH) {
  const plan = json<S6Plan>(path); assert.equal(plan.schema_version, 's6-independent-plan-1'); assert.deepEqual(plan.model, MODEL); assert.deepEqual(plan.per_paper_limits, PER_PAPER);
  assert.deepEqual(plan.global_limits, { requests: 120, input_tokens: 1_800_000, output_tokens: 120_000, seconds: 3600 });
  assert.equal(plan.directory, 'runtime-data/s6-independent/execution'); assert.equal(plan.absolute_deadline, '2026-11-09T11:53:56Z');
  assert.deepEqual(plan.inputs.map(p => p.source_id), ['IN01', 'IN02', 'IN03']);
  assert.equal(plan.origin, ORIGIN); assert.equal(plan.concurrency, 2); assert.equal(plan.seed, S6_SEED); assert.equal(plan.authorization_sha256, hashFile(AUTH_PATH)); assertPins(plan.code_sha256);
  const { c, h } = intake(); for (const source of plan.inputs) { const paper = assertIndependentUse(c, h, source.source_id, 'independent_acceptance'); assert.equal(paper.file.sha256, source.sha256); assert.equal(paper.seal!.identity_sha256, source.seal_identity_sha256); }
  const config = authorizedConfig(); assert.deepEqual(publicConfig(config), MODEL); workbenchModelPolicy(config);
  assert.ok(Date.now() < Date.parse(plan.absolute_deadline));
  const caps = await (await fetch('http://127.0.0.1:3210/api/workbench/capabilities', { signal: AbortSignal.timeout(3000) })).json() as any; assert.equal(caps.extraction_start, false); assert.equal(caps.controlled_fixture, false);
  return { plan_path: path, plan_sha256: hashFile(path), pins_verified: Object.keys(plan.code_sha256).length, independent_sources: plan.inputs.length,
    credential_present: Boolean(config.apiKey()), new_model_calls: 0, production_model_disabled: true, protocol_frozen: true, medical_quality_approved: false };
}
interface Admission { source: Source; runId: string; directory: string; started: number; controller: AbortController; budget: ExtractionBudget;
  timer: ReturnType<typeof setTimeout>; runtimePins: Record<string, string>; parse_started_at?: string; parse_finished_at?: string; model_started_at?: string; model_finished_at?: string }
function resourceSnapshot() {
  const found = new Map<number, { ppid: number; ticks: number; rss: number; start: string }>();
  for (const dir of readdirSync('/proc')) if (/^\d+$/u.test(dir)) {
    try { const raw = readFileSync('/proc/' + dir + '/stat', 'utf8'), parts = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/u);
      found.set(Number(dir), { ppid: Number(parts[1]), ticks: Number(parts[11]) + Number(parts[12]), rss: Number(parts[21]) * 4096, start: parts[19]! }); } catch { /* process exited during sample */ }
  }
  const included = new Set([process.pid]); let more = true;
  while (more) { more = false; for (const [pid, p] of found) if (!included.has(pid) && included.has(p.ppid)) { included.add(pid); more = true; } }
  return { timestamp: new Date().toISOString(), total_rss_bytes: [...included].reduce((n, pid) => n + (found.get(pid)?.rss ?? 0), 0),
    processes: [...included].flatMap(pid => found.has(pid) ? [{ pid, ...found.get(pid)! }] : []), host_loadavg: readFileSync('/proc/loadavg', 'utf8').trim(), host_meminfo: readFileSync('/proc/meminfo', 'utf8').split('\n').filter(x => /^(?:MemAvailable|MemFree|SwapFree):/u.test(x)) };
}
export async function executePlan(path: string, approvedSha: string) {
  const checked = await preflight(path); assert.equal(approvedSha, checked.plan_sha256); const plan = json<S6Plan>(path), config = authorizedConfig();
  const directory = resolve(CODE, plan.directory), evidence = resolve(CODE, EVIDENCE); await mkdir(directory, { recursive: true });
  const started = Date.now(), deadline = Math.min(started + plan.global_limits.seconds * 1000, Date.parse(plan.absolute_deadline));
  await exclusiveJson(plan.directory + '/started.json', { at: new Date(started).toISOString(), plan_sha256: approvedSha, no_automatic_resume: true });
  for (const source of plan.inputs) {
    const exposed = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/independent-corpus.ts', 'expose', '--source-id', source.source_id,
      '--purpose', 'independent_acceptance', '--actor', 'S6 delegated independent execution / GPT-6.1-Sol max', '--evidence', PLAN_PATH], { cwd: CODE, encoding: 'utf8' });
    assert.equal(exposed.status, 0, exposed.stderr);
  }
  const store = new ExtractionStore(resolve(directory, 'workflow.sqlite')), legacy = new RunStore(':memory:'), globalController = new AbortController();
  const admissions = new Map<string, Admission>(), sourceAdmitted = new Set<string>(), observations: any[] = [], resources: ReturnType<typeof resourceSnapshot>[] = [];
  let stopReason: string | null = null, active = 0, peakActive = 0;
  const event = (type: string, details: unknown) => { const row = { at: new Date().toISOString(), type, details }; observations.push(row); writeFileSync(resolve(evidence, 'progress.jsonl'), JSON.stringify(row) + '\n', { flag: 'a' }); process.stdout.write(JSON.stringify(row) + '\n'); };
  const stop = (reason: string) => { stopReason ??= reason; globalController.abort(); for (const a of admissions.values()) { a.controller.abort(); a.budget.cancelEntries(a.budget.ledger.requests, reason); } event('experiment_stop', { reason }); };
  const globalTimer = setTimeout(() => stop('s6_global_deadline'), Math.max(1, deadline - Date.now())); globalTimer.unref();
  const sampleTimer = setInterval(() => { try { resources.push(resourceSnapshot()); } catch { /* report missing sample */ } }, 500); sampleTimer.unref(); resources.push(resourceSnapshot());
  const policy = workbenchModelPolicy(config);
  const workflow = new WorkbenchWorkflow(store, { codeRoot: CODE, directory: plan.directory + '/workbench', sources: false,
    runner: { controlled: false, provider: config.provider, model_id: config.modelId, available: () => !stopReason && sourceAdmitted.size < 3,
      prepare: (input: RunInput, runDirectory: string) => {
        assertPins(plan.code_sha256); if (globalController.signal.aborted || Date.now() >= deadline) throw new ContractError('s6_allowance_closed');
        const source = plan.inputs.find(p => p.sha256 === input.file_sha256); if (!source || sourceAdmitted.has(source.source_id) || JSON.stringify(input.scope) !== JSON.stringify(plan.scope)) throw new ContractError('s6_input_not_authorized_or_already_admitted');
        const runtimePins: Record<string, string> = {}, now = Date.now();
        class PinnedBudget extends ExtractionBudget { override begin(...args: Parameters<ExtractionBudget['begin']>) { assertPins(plan.code_sha256); assertPins(runtimePins); if (globalController.signal.aborted || Date.now() >= deadline) throw new ContractError('s6_allowance_closed'); return super.begin(...args); } }
        const budget = new PinnedBudget(resolve(runDirectory, 'request-ledger.json'), config.baseUrl, Date.now, { limits: plan.per_paper_limits,
          responseModelAliasPolicy: policy.responseModelAliasPolicy, authorization: { id: approvedSha + ':' + source.source_id, source: 'new_s6_four_hour_delegated_authorization', recorded_at: new Date(started).toISOString() } });
        budget.ledger.experiment_started_at = new Date(now).toISOString(); budget.persist();
        const controller = new AbortController(), timer = setTimeout(() => { controller.abort(); budget.cancelEntries(budget.ledger.requests, 's6_document_deadline'); }, Math.min(1800_000, deadline - now)); timer.unref();
        admissions.set(input.run_id, { source, runId: input.run_id, directory: runDirectory, started: now, controller, budget, timer, runtimePins }); sourceAdmitted.add(source.source_id);
        event('http_admission', { source_id: source.source_id, run_id: input.run_id, deadline: new Date(Math.min(now + 1800_000, deadline)).toISOString() });
      }, execute: async (context: WorkflowExecution) => {
        const a = admissions.get(context.input.run_id)!; a.model_started_at = new Date().toISOString();
        for (const file of [context.document.source.file_reference, relative(CODE, resolve(context.directory, 'document-ir.json')), ...(context.catalog ? [relative(CODE, resolve(context.directory, 'figure-catalog.json'))] : [])]) a.runtimePins[file] = hashFile(file);
        if (a.runtimePins[context.document.source.file_reference] !== a.source.sha256) throw new ContractError('s6_uploaded_pdf_hash_changed');
        event('model_phase_start', { source_id: a.source.source_id, run_id: a.runId });
        try { const result = await executeWorkbenchExtraction({ ...context, signal: AbortSignal.any([context.signal, a.controller.signal, globalController.signal]) }, config, a.budget,
          Math.max(1, Math.min(1800_000 - (Date.now() - a.started), deadline - Date.now())), true);
          a.model_finished_at = new Date().toISOString(); if ((result.coverage as any)?.task_processing_complete !== true) stop('s6_unrecovered_task_incomplete'); return result;
        } catch (cause) { stop(safeError(cause).code ?? 's6_unclassified_execution_failure'); throw cause; }
      } },
    parse: async (input, file, runDirectory, signal) => { const a = admissions.get(input.run_id)!; a.parse_started_at = new Date().toISOString(); event('fresh_cpu_parse_start', { source_id: a.source.source_id, run_id: a.runId });
      try { return await createConfiguredPdfParserAdapter({ logDirectory: runDirectory, timeoutMs: Math.max(1, Math.min(600_000, deadline - Date.now(), 1800_000 - (Date.now() - a.started))) }).parse(
        { run_id: input.run_id, document_id: input.document_id, file_reference: file, file_sha256: input.file_sha256, fixture: false }, AbortSignal.any([signal, a.controller.signal, globalController.signal]));
      } finally { a.parse_finished_at = new Date().toISOString(); event('fresh_cpu_parse_end', { source_id: a.source.source_id, run_id: a.runId }); }
    }, discover: async (document, runDirectory, signal) => discoverPdfFigures(document, runDirectory, AbortSignal.any([...(signal ? [signal] : []), globalController.signal])) });
  const app = buildApp(legacy, undefined, workflow), results: any[] = [];
  const localJson = async (suffix: string, init?: RequestInit) => { const response = await fetch(ORIGIN + '/api/workbench/' + suffix, { ...init, signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new ContractError('s6_http_' + response.status + ':' + (await response.text()).slice(0, 250)); return response.json() as Promise<any>; };
  async function runSource(source: Source) {
    if (stopReason) { results.push({ source_id: source.source_id, status: 'not_admitted_after_stop' }); return; }
    const uploadStarted = Date.now();
    const uploaded = await localJson('papers', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t1-filename': source.source_id + '.pdf', 'x-t1-title': encodeURIComponent(source.title) }, body: readFileSync(resolve(CODE, source.path)) });
    const uploadMs = Date.now() - uploadStarted;
    const paperId = uploaded.paper?.id ?? uploaded.id; assert.ok(paperId); const requestStarted = Date.now(); active++; peakActive = Math.max(active, peakActive);
    const admitted = await localJson('papers/' + encodeURIComponent(paperId) + '/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: plan.scope }) });
    const admissionMs = Date.now() - requestStarted, runId = admitted.run.run_id, a = admissions.get(runId)!; let firstProgress: number | null = null, firstCandidate: number | null = null, cursor = 0;
    const sseController = new AbortController(), sse = (async () => {
      const response = await fetch(ORIGIN + '/api/workbench/runs/' + encodeURIComponent(runId) + '/events', { signal: sseController.signal }); assert.equal(response.status, 200); assert.ok(response.body); const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
      try { while (!sseController.signal.aborted) { const { done, value } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n'); let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) { const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2); const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'); if (!data) continue; const business = JSON.parse(data); if (business.seq <= cursor) continue; cursor = business.seq; firstProgress ??= Date.now(); if (business.type === 'candidate') firstCandidate ??= Date.now();
          writeFileSync(resolve(evidence, source.source_id + '-events.jsonl'), JSON.stringify({ received_at: new Date().toISOString(), event: business }) + '\n', { flag: 'a' });
        }
      } } finally { await reader.cancel().catch(() => {}); }
    })().catch(cause => { if (!sseController.signal.aborted) event('sse_error', { source_id: source.source_id, code: safeError(cause).code }); });
    let detail: any;
    try { do { detail = await localJson('runs/' + encodeURIComponent(runId)); if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(detail.run.state)) break; await delay(500); } while (Date.now() < deadline + 3000);
      const terminalAt = Date.now(); detail = await localJson('runs/' + encodeURIComponent(runId));
      await exclusiveJson(EVIDENCE + '/' + source.source_id + '-workbench-detail.json', detail);
      const row = JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(runId)!.payload_json as string); if (!row.source) throw new ContractError('s6_parsed_source_missing');
      const document = row.source.document; await assertLivePdfSource(document); assert.equal(document.file_sha256, source.sha256); assert.equal(document.pages.length, source.physical_pages);
      const versions = store.current(runId), catalog = row.source.catalog as FigureAssetCatalog | undefined, delivery = buildEvidenceDelivery(document, versions, catalog), mechanical = auditIndependentDelivery(document, delivery, source.sha256);
      const material = prepareIndependentReview(delivery, source.source_id); await exclusiveJson(EVIDENCE + '/' + source.source_id + '-delivery.json', delivery); await exclusiveJson(EVIDENCE + '/' + source.source_id + '-mechanical-audit.json', mechanical); await exclusiveJson(EVIDENCE + '/' + source.source_id + '-review-material.json', material);
      const exportDirectory = resolve(directory, 'candidate-packages', source.source_id); await exportEvidenceDelivery(document, versions, { codeRoot: CODE, directory: exportDirectory, catalog, mode: 'candidates', coverage: row.coverage ?? {} });
      for (const figure of catalog?.figures ?? []) for (const asset of figure.regions) if (hashFile(asset.path) !== asset.sha256 || asset.source_pdf_sha256 !== source.sha256) throw new ContractError('s6_figure_asset_source_mismatch');
      const timing = summarizeIndependentTiming({ admissionMs, firstProgressMs: firstProgress === null ? null : firstProgress - requestStarted,
        firstCandidateMs: firstCandidate === null ? null : firstCandidate - requestStarted, totalMs: terminalAt - requestStarted, outputCount: allDeliveredRecords(delivery).length });
      const coverage = row.coverage ?? {}, pageStates = document.pages.map((page: any) => ({ physical_page: page.physical_page, status: page.status, error: page.error, ocr_requirement: page.ocr_requirement }));
      const result = { source_id: source.source_id, paper_id: paperId, run_id: runId, status: detail.run.state, admitted_at: new Date(requestStarted).toISOString(), terminal_at: new Date(terminalAt).toISOString(),
        parse_started_at: a.parse_started_at, parse_finished_at: a.parse_finished_at, model_started_at: a.model_started_at, model_finished_at: a.model_finished_at,
        timing, upload_http_seconds: uploadMs / 1000, usage: a.budget.totals(), ledger: relative(CODE, a.budget.path), source_status: detail.source_status, page_states: pageStates,
        parser_status: document.parser.status, parser_limits: document.coverage?.limitations ?? [], parser_metrics: document.metrics ?? null, task_processing_complete: coverage.task_processing_complete === true,
        unprocessed_block_ids: coverage.task_scope_unprocessed_source_block_ids ?? [], failed_block_ids: coverage.task_scope_failed_source_block_ids ?? [], output_count: allDeliveredRecords(delivery).length,
        primary_count: delivery.records.length, background_count: delivery.background_records?.length ?? 0, figure_count: catalog?.figures.length ?? 0,
        random_sample_count: material.random_sample_count, random_denominator: material.random_denominator, mechanical_passed: mechanical.passed, raw_ir: row.source.ir,
        figure_catalog: row.source.catalog_artifact ?? null, candidate_package: relative(CODE, exportDirectory), source_pdf_modified: false, medical_quality_approved: false, actual_human_reviewed_count: 0 };
      results.push(result); await exclusiveJson(EVIDENCE + '/' + source.source_id + '-result.json', result); event('source_terminal', result);
      if (!mechanical.passed || coverage.task_processing_complete !== true || !['completed', 'partial'].includes(detail.run.state)) stop('s6_source_contract_or_processing_failure');
    } finally { active--; clearTimeout(a.timer); sseController.abort(); await sse; }
  }
  let summary: any;
  try {
    await app.listen({ host: '127.0.0.1', port: 3211 }); event('experiment_start', { plan_sha256: approvedSha, inputs: plan.inputs.map(p => p.source_id), deadline: new Date(deadline).toISOString(), process_id: process.pid });
    await runWithTwoSlots(plan.inputs, async source => { try { await runSource(source); } catch (cause) { results.push({ source_id: source.source_id, status: 'failed', error: safeError(cause) }); stop(safeError(cause).code ?? 's6_unclassified_driver_failure'); } }, () => Boolean(stopReason));
    await workflow.waitForIdle();
    const totals = [...admissions.values()].reduce((sum, a) => { const t = a.budget.totals(); return { requests: sum.requests + t.requests, input_tokens: sum.input_tokens + t.input_tokens, output_tokens: sum.output_tokens + t.output_tokens }; }, { requests: 0, input_tokens: 0, output_tokens: 0 });
    const budgetExceeded = totals.requests > 120 || totals.input_tokens > 1_800_000 || totals.output_tokens > 120_000 || [...admissions.values()].some(a => { const t = a.budget.totals(); return t.requests > 40 || t.input_tokens > 600_000 || t.output_tokens > 40_000; });
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM workbench_reviews').get()!.n), 0); assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM workbench_annotations').get()!.n), 0);
    summary = { schema_version: 's6-independent-execution-1', plan_sha256: approvedSha, started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(),
      elapsed_seconds: (Date.now() - started) / 1000, sources: results, peak_active_tasks: peakActive, actual_two_task_overlap: results.some(a => results.some(b => a.source_id !== b.source_id && a.admitted_at && b.admitted_at && Date.parse(a.admitted_at) < Date.parse(b.terminal_at) && Date.parse(b.admitted_at) < Date.parse(a.terminal_at))),
      actual_usage: totals, provider_token_overrun: budgetExceeded, stop_reason: stopReason, budget_closed: true, unused_allowance_closed: true,
      sampled_process_tree_peak_rss_bytes: Math.max(0, ...resources.map(r => r.total_rss_bytes)), resource_sample_interval_ms: 500,
      observation_count: results.filter(r => r.timing).length, population_p95: null, monetary_cost: null, cost_status: 'unknown_gateway_billing',
      production_mutations: 0, production_record_approvals: 0, medical_quality_approved: false, delegated_source_review_status: 'pending', independent_experiment_complete: results.length === 3 && results.every(r => r.task_processing_complete === true) && !budgetExceeded && !stopReason };
  } finally {
    clearTimeout(globalTimer); clearInterval(sampleTimer); globalController.abort();
    for (const a of admissions.values()) { clearTimeout(a.timer); a.controller.abort(); a.budget.cancelEntries(a.budget.ledger.requests, 's6_allowance_closed'); a.budget.ledger.halted ??= 's6_allowance_closed_no_unused_credit'; a.budget.persist(); }
    await app.close(); legacy.close(); store.close();
    await writeFile(resolve(evidence, 'resource-samples.json'), JSON.stringify(resources, null, 2) + '\n');
    await exclusiveJson(EVIDENCE + '/execution-summary.json', summary ?? { status: 'driver_failed', stop_reason: stopReason, sources: results, unused_allowance_closed: true, medical_quality_approved: false });
  }
  return summary;
}
const main = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const [action, path = PLAN_PATH, flag, approvedSha] = process.argv.slice(2);
  try {
    if (action === 'prepare') process.stdout.write(JSON.stringify(await preparePlan()) + '\n');
    else if (action === 'preflight') { const result = await preflight(path); await exclusiveJson(EVIDENCE + '/preflight.json', result); process.stdout.write(JSON.stringify(result) + '\n'); }
    else if (action === 'execute' && flag === '--authorized-plan-sha256' && approvedSha) { const result = await executePlan(path, approvedSha); process.stdout.write(JSON.stringify(result) + '\n'); if (!result?.independent_experiment_complete) process.exitCode = 1; }
    else throw new ContractError('usage_accept_s6_prepare_preflight_execute_with_frozen_authorized_sha');
  } catch (cause) { process.stderr.write(JSON.stringify(safeError(cause)) + '\n'); process.exitCode = 1; }
}
