/** One necessary same-input recovery, using the original authorization/ledger/clock.
 * No production source, source masks or historical result is modified. */
import { readFile, writeFile, mkdir, open, unlink, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { loadModelConfig, safeError } from '../packages/agent/src/config.js';
import { validateComparisonAuthorization, validateComparisonRevision, comparisonBudgetOwner, comparisonBudgetAuthorization } from '../packages/agent/src/experiment-authorization.js';
import { ExtractionBudget } from '../packages/agent/src/extraction-budget.js';
import { ExtractionStore } from '../packages/agent/src/extraction-store.js';
import { runExtractionDocument } from '../packages/agent/src/extraction-run.js';
import { developmentProfile } from '../packages/agent/src/extraction-pi.js';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { assertFigureCatalog } from '../packages/agent/src/evidence-delivery.js';
import { assertLivePdfSource } from '../packages/agent/src/figure-assets.js';
import { comparisonDigest, planPaperMethods, assertComparisonSourceUse } from '../packages/agent/src/method-comparison.js';
import { ContractError } from '@t1/contracts';

const code = resolve(import.meta.dirname, '..'), parentRoot = resolve(code, 'docs/acceptance/user-feedback-2026-11-05/revalidation');
const isChild = process.argv[5] === '--child', root = isChild ? resolve(parentRoot, 'metric-context-revision') : parentRoot;
const action = process.argv[2] ?? 'prepare', attempt = Number(process.argv[3] ?? '1');
if (!['prepare', 'execute'].includes(action) || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 2) throw new ContractError('bounded_feedback_recovery_arguments_required');
const jobId = process.argv[4] ?? 'L01-F';
if (!['L01-F', 'L05-F'].includes(jobId)) throw new ContractError('only_actual_failed_feedback_jobs_may_retry');
const documentId = jobId.split('-')[0]!, sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const json = async (p: string) => JSON.parse(await readFile(resolve(code, p), 'utf8'));
const save = async (p: string, value: unknown) => { await writeFile(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); };
const planBytes = await readFile(resolve(root, 'prepared/plan.json')), plan = JSON.parse(planBytes.toString('utf8'));
if (sha(planBytes) !== (isChild ? 'c2369db87b88efb1f40e695a616449eac27fdb4b9b92550d512e5bf0fda6a96f' : '7c995ed66a85bb9f2f5fbcdde84788394022ae5d43bdd1d64049e10abecbdbf4')) throw new ContractError('reviewed_plan_changed');
const authorization = validateComparisonAuthorization(await json(relative(code, resolve(root, 'authorization.json'))), {
  plan_sha256: sha(planBytes), batch_id: plan.batch_id, ...plan.config.model, proposed_limits: plan.config.proposed_limits });
if (isChild) {
  const revision = authorization.revision; if (!revision) throw new ContractError('recovery_revision_binding_required');
  const parentAuthBytes = await readFile(resolve(code, revision.parent_authorization_path)), parentPlanBytes = await readFile(resolve(code, revision.parent_plan_path));
  const ruleBytes = await readFile(resolve(code, revision.rule_confirmation_path));
  validateComparisonRevision(authorization, { parent: JSON.parse(parentAuthBytes.toString('utf8')), parent_authorization_sha256: sha(parentAuthBytes),
    parent_plan_sha256: sha(parentPlanBytes), rule_confirmation_sha256: sha(ruleBytes), declared_change: 'visual_scope_prompt',
    rule_id: 'metric-definitions-context-only-1', confirmation: JSON.parse(ruleBytes.toString('utf8')) });
}
for (const [p, wanted] of Object.entries(plan.source_hashes)) if (sha(await readFile(resolve(code, p))) !== wanted ||
  sha(await readFile(resolve(root, 'prepared/execution/source-snapshot', p))) !== wanted) throw new ContractError('recovery_runtime_or_snapshot_changed');
const registered = await json('evaluation/manifests/source-register.json'), independent = await json('evaluation/manifests/independent-intake.json');
for (const paper of plan.papers) {
  const entry = registered.sources.find((s: any) => s.source_id === paper.document_id);
  if (!entry) throw new ContractError('recovery_source_not_registered');
  assertComparisonSourceUse({ source_id: entry.source_id, article_family_id: paper.article_family_id, doi: entry.doi, file_sha256: paper.pdf_sha256 }, registered, independent);
}
for (const paper of plan.papers) for (const [p, wanted] of [[paper.pdf_path, paper.pdf_sha256], [paper.ir_path, paper.ir_sha256],
  [paper.figure_catalog_path, paper.figure_catalog_sha256], ...Object.entries(paper.assets)]) if (sha(await readFile(resolve(code, p))) !== wanted) throw new ContractError('recovery_source_changed');
const paper = plan.papers.find((p: any) => p.document_id === documentId), job = paper.methods.jobs.find((j: any) => j.job_id === jobId);
const document = (await json(paper.ir_path)).document, figures = await json(paper.figure_catalog_path);
assertParsedDocument(document); await assertLivePdfSource(document); assertFigureCatalog(document, figures);
const source = { document_id: paper.document_id, article_family_id: paper.article_family_id, pdf_path: paper.pdf_path, pdf_sha256: paper.pdf_sha256,
  ir_path: paper.ir_path, ir_sha256: paper.ir_sha256, text_version: paper.text_version, parser_config_digest: paper.parser_config_digest,
  figure_catalog_path: paper.figure_catalog_path, figure_catalog_sha256: paper.figure_catalog_sha256, assets: paper.assets };
if (comparisonDigest(planPaperMethods(document, { ...plan.common, source }, plan.config.batch_options)) !== comparisonDigest(paper.methods)) throw new ContractError('recovery_masks_or_context_changed');
const originalPath = resolve(root, 'prepared/execution', jobId, 'result.json');
const original = await json(relative(code, originalPath));
if (original.error?.code !== 'model_tool_protocol_diagnostic_pause' || (!isChild && original.candidate_count !== 0)) throw new ContractError('recovery_requires_actual_preserved_failed_F');
const target = resolve(root, 'retries', jobId + '-attempt-' + attempt), retryPlanPath = resolve(root, 'retry-plan-' + jobId + '-' + attempt + '.json');
const descriptor = { schema_version: 'same-input-feedback-recovery-plan-1', job_id: jobId, attempt, original_plan_sha256: sha(planBytes),
  authorization_id: authorization.authorization_id, authorization_approved_at: authorization.approved_at, limits: authorization.limits,
  runtime_source_hashes: plan.source_hashes, retry_driver_sha256: sha(await readFile(import.meta.filename)),
  model_source_input_sha256: job.model_source_input_sha256, condition: job.condition, scope: plan.config.scope,
  model: plan.config.model, batch_options: plan.config.batch_options, strategy: plan.config.strategy,
  original_failed_result: relative(code, originalPath), original_failed_result_sha256: sha(await readFile(originalPath)),
  reason: 'The actual model supplied a malformed tool argument; see preserved protocol_diagnostic_pause. Repeat this identical input once with no schema relaxation, ID correction or fuzzy source matching.',
  same_authorization_ledger_and_original_wallclock: true, representative_for: jobId === 'L01-F' ? ['L01-F', 'L01-R'] : ['L05-F'],
  only_failed_job_repeated: true, output_directory: relative(code, target), medical_quality_approved: false };
if (action === 'prepare') {
  await save(retryPlanPath, { ...descriptor, prepared_at: new Date().toISOString(), status: 'inherited_explicit_necessary_retest_authorization_no_calls_yet' });
  process.stdout.write(JSON.stringify({ prepared: relative(code, retryPlanPath), paid_calls: 0, authorization_id: authorization.authorization_id }) + '\n');
} else {
  const prepared = await json(relative(code, retryPlanPath));
  const { prepared_at: _at, status: _status, ...controls } = prepared;
  if (comparisonDigest(controls) !== comparisonDigest(descriptor)) throw new ContractError('recovery_plan_changed');
  if (attempt > 1) {
    const before = await json(relative(code, resolve(root, 'retries', jobId + '-attempt-' + (attempt - 1), 'retry-report.json')));
    if (!before.error && before.run_error?.code !== 'model_tool_protocol_diagnostic_pause') throw new ContractError('recovery_previous_attempt_not_failed');
  }
  const config = loadModelConfig();
  if (config.provider !== plan.config.model.provider || config.baseUrl !== plan.config.model.endpoint) throw new ContractError('recovery_provider_endpoint_changed');
  const owner = resolve(code, comparisonBudgetOwner(authorization.authorization_id)), lockPath = resolve(owner, 'active-owner.lock');
  const lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, job_id: jobId, recovery_attempt: attempt })); await lock.close();
  const controller = new AbortController(), stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let store: ExtractionStore | undefined, budget: ExtractionBudget | undefined;
  const report: Record<string, any> = { schema_version: 'same-input-feedback-recovery-report-1', job_id: jobId, attempt,
    original_failed_result: descriptor.original_failed_result, authorization_id: authorization.authorization_id, status: 'running', medical_quality_approved: false };
  try {
    const existing = await json(relative(code, resolve(owner, 'call-ledger.json')));
    if (!existing.experiment_started_at || existing.authorization.id !== authorization.authorization_id) throw new ContractError('recovery_existing_owner_required');
    budget = new ExtractionBudget(resolve(owner, 'call-ledger.json'), config.baseUrl, Date.now, { limits: authorization.limits,
      authorization: comparisonBudgetAuthorization(authorization), responseModelAliasPolicy: plan.config.response_model_alias_policy });
    budget.check(); report.before = budget.totals(); report.experiment_started_at = budget.ledger.experiment_started_at;
    await mkdir(dirname(target), { recursive: true });
    await mkdir(target, { recursive: false }); await writeFile(resolve(target, 'retry-driver.ts'), await readFile(import.meta.filename), { flag: 'wx' });
    await save(resolve(target, 'retry-plan.json'), prepared); store = new ExtractionStore(resolve(target, 'evidence.sqlite'));
    const runId = plan.batch_id + ':source-' + documentId + ':input-' + job.model_source_input_sha256.slice(0, 12) + ':necessary-retry-' + attempt;
    const profile = developmentProfile(plan.config.model.model_id, plan.config.model.api);
    const result = await runExtractionDocument({ input: { schema_version: '1', run_id: runId, document_id: document.document_id,
      file_sha256: document.file_sha256, fixture: false, scope: plan.config.scope, rule_version: original.versions[0]?.record?.extraction_trace.rule_version ?? 'verbatim-three-method-comparison-1',
      runtime_profile: { provider: config.provider, model_id: profile.model_id, endpoint: config.baseUrl, pi_version: '1.4.0', version: profile.profile_version } },
      document, catalog: plan.config.catalog, profile, config, budget, store, directory: resolve(target, 'extraction'), strategy: plan.config.strategy,
      batchOptions: plan.config.batch_options, sourceSelectionCondition: job.condition, figureCatalog: figures, figureDiscovery: 'not_requested',
      documentTimeoutMs: authorization.limits.document_seconds * 1000, batchMaxResponses: authorization.limits.batch_responses, executionConcurrency: 1,
      metadata: { task_id: runId, article_family_id: paper.article_family_id, created_at: new Date().toISOString(),
        source_version: { file_sha256: paper.pdf_sha256, source_kind: 'public_published_pdf_development', version: paper.pdf_sha256,
          obtained_at: (await json('evaluation/manifests/source-register.json')).sources.find((s: any) => s.source_id === documentId).access.retrieved_at } }, signal: controller.signal });
    report.status = result.error ? 'retry_failed_preserved' : 'retry_completed_medical_review_pending'; report.result_path = relative(code, resolve(target, 'extraction/result.json'));
    report.state = result.state; report.run_error = result.error ?? null; report.candidate_count = result.candidate_count;
    report.coverage = result.coverage; report.seconds = result.total_seconds;
  } catch (error) { report.status = 'retry_stopped_or_failed'; report.error = safeError(error);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (typeof code === 'string') report.driver_error_code = code;
    process.exitCode = 1; }
  finally {
    if (budget) { report.after = budget.totals(); report.delta = Object.fromEntries(['requests', 'input_tokens', 'output_tokens'].map(k => [k, (report.after[k] ?? 0) - (report.before?.[k] ?? 0)])); }
    await mkdir(target, { recursive: true }); await save(resolve(target, 'retry-report.json'), report); store?.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop); await unlink(lockPath);
  }
  process.stdout.write(JSON.stringify(report) + '\n');
}
