import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { assertSchema, ContractError, EvidenceCatalogSchema, ScopeSchema, type EvidenceCatalog, type EvidenceFragment,
  type EvidenceVersion, type LocatedEvidenceFragment, type RunInput, type Scope } from '@t1/contracts';
import { buildArticleScope, planExtractionBatches } from './article-scope.js';
import { selectSourceBlocks, taskSourceBlockIds, SOURCE_SELECTION_VERSION, BIBLIOGRAPHY_SCOPE_RULE_VERSION } from './source-selection.js';
import { addSourceStatementContext, SOURCE_EVIDENCE_UNIT_VERSION } from './source-evidence-units.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from './visual-evidence-policy.js';
import { PRIMARY_ASSESSMENT_POLICY_VERSION, DIAGNOSTIC_VISUAL_SCOPE_RULE_VERSION, NORMAL_ANATOMIC_SCOPE_RULE_VERSION } from './primary-evidence-assessment.js';
import { STRICT_SOURCE_GROUPING_POLICY_VERSION } from './strict-source-groups.js';
import { developmentProfile, VISUAL_SCOPE_PROMPT_VERSION } from './extraction-pi.js';
import { locateEvidenceFragment } from './evidence-validation.js';
import { exportEvidenceDelivery } from './evidence-delivery.js';
import { ExtractionStore } from './extraction-store.js';
import { ExtractionBudget, S4_LIMITS, type ExtractionBudgetLimits, type ResponseModelAliasPolicy } from './extraction-budget.js';
import { loadModelConfig, safeError } from './config.js';
import { runExtractionDocument } from './extraction-run.js';
import { comparisonDigest } from './method-comparison.js';
import { evidenceScopeIssues } from './scope-matching.js';
import { B0_REVALIDATION_PURPOSE, validateB0RevalidationAuthorization, b0RevalidationBudgetAuthorization, comparisonBudgetOwner } from './experiment-authorization.js';
import { insideCode, readPreparedExtractionSources, extractionRuntimeSourceHashes, sourceBytesDigest, assertFrozenRuntimeSources,
  type PreparedExtractionSourceSpec } from './prepared-extraction-sources.js';

export const B0_REVALIDATION_PLAN_SCHEMA = 'b0-prepared-revalidation-1' as const;
export interface B0RevalidationConfig {
  schema_version: 'b0-revalidation-config-1'; status: 'prepared_pending_new_user_authorization'; execute_model_calls: false;
  purpose: typeof B0_REVALIDATION_PURPOSE; method: 'B0'; papers: PreparedExtractionSourceSpec[];
  model: { provider: string; endpoint: string; model_id: string; reasoning_effort: 'medium'; api: 'openai-responses' | 'openai-completions' };
  scope: Scope; catalog: EvidenceCatalog; batch_options: { maxCodePoints: number; maxBlocks: number; contextBlocks: number };
  proposed_limits: ExtractionBudgetLimits; response_model_alias_policy?: ResponseModelAliasPolicy; observation_spec: string;
}
interface ObservationSpec {
  schema_version: 'b0-source-observations-1'; complete_gold: false;
  cases: Array<{ case_id: string; document_id: string; concern: string; judgement_basis: string; question: string;
    source_fragments: EvidenceFragment[]; historical_evidence?: string[] }>;
}
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path: string, value: unknown, exclusive = false) => {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  else { await writeFile(path + '.tmp', bytes, { mode: 0o600 }); await rename(path + '.tmp', path); }
};
const policies = () => ({ evidence_policy_version: VISUAL_STATEMENT_POLICY_VERSION, source_evidence_unit_version: SOURCE_EVIDENCE_UNIT_VERSION,
  primary_assessment_policy_version: PRIMARY_ASSESSMENT_POLICY_VERSION, diagnostic_visual_scope_rule_version: DIAGNOSTIC_VISUAL_SCOPE_RULE_VERSION,
  normal_anatomic_scope_rule_version: NORMAL_ANATOMIC_SCOPE_RULE_VERSION, source_grouping_policy_version: STRICT_SOURCE_GROUPING_POLICY_VERSION,
  bibliography_scope_rule_version: BIBLIOGRAPHY_SCOPE_RULE_VERSION, source_selection_rule_version: SOURCE_SELECTION_VERSION, visual_scope_prompt: VISUAL_SCOPE_PROMPT_VERSION });
function assertConfig(c: B0RevalidationConfig) {
  if (c.schema_version !== 'b0-revalidation-config-1' || c.status !== 'prepared_pending_new_user_authorization' || c.execute_model_calls !== false ||
    c.purpose !== B0_REVALIDATION_PURPOSE || c.method !== 'B0' || c.model.reasoning_effort !== 'medium' ||
    !['openai-responses', 'openai-completions'].includes(c.model.api) || !/^[A-Za-z0-9_./:@+-]{1,160}$/u.test(c.model.model_id) ||
    !c.papers.length || new Set(c.papers.map(p => p.source_id)).size !== c.papers.length ||
    c.papers.some(p => !/^[A-Za-z0-9._-]{1,120}$/u.test(p.source_id))) throw new ContractError('b0_revalidation_config_invalid');
  const endpoint = new URL(c.model.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ContractError('comparison_endpoint_invalid');
  assertSchema(EvidenceCatalogSchema, c.catalog); assertSchema(ScopeSchema, c.scope);
  if (evidenceScopeIssues(c.scope, c.catalog).length) throw new ContractError('b0_revalidation_scope_invalid');
  const l = c.proposed_limits, caps = { requests: 128, input_tokens: 2_500_000, output_tokens: 160_000, seconds: 3600 };
  if (!l || Object.keys(l).length !== Object.keys(S4_LIMITS).length || Object.entries(caps).some(([k, cap]) => !Number.isSafeInteger(l[k as keyof typeof l]) || l[k as keyof typeof l] < 1 || l[k as keyof typeof l] > cap) ||
    l.request_seconds !== 120 || l.document_seconds < 1 || l.document_seconds > 1800 || !Number.isSafeInteger(l.document_seconds) ||
    l.transient_retries !== 2 || l.response_output_tokens !== 8192 || !Number.isSafeInteger(l.batch_responses) || l.batch_responses < 1 || l.batch_responses > 16)
    throw new ContractError('b0_revalidation_proposed_limits_invalid');
}
export async function makeB0RevalidationPlan(config: B0RevalidationConfig, configPath: string) {
  assertConfig(config);
  const sources = await readPreparedExtractionSources(config.papers), spec = await json(await insideCode(config.observation_spec)) as ObservationSpec;
  if (spec.schema_version !== 'b0-source-observations-1' || spec.complete_gold !== false || !spec.cases.length ||
    new Set(spec.cases.map(c => c.case_id)).size !== spec.cases.length) throw new ContractError('b0_observation_spec_invalid');
  const sourceHashes = await extractionRuntimeSourceHashes({ scripts: ['scripts/revalidate-b0.ts'], responseModelAliasPolicy: config.response_model_alias_policy,
    extraPaths: [configPath, config.observation_spec, 'evaluation/manifests/source-register.json', 'evaluation/manifests/independent-intake.json'] });
  const common = { ...policies(), model: config.model, profile: developmentProfile(config.model.model_id, config.model.api), scope: config.scope,
    catalog: config.catalog, batch_options: config.batch_options, strategy: 'baseline', concurrency: 1, runtime_source_sha256: comparisonDigest(sourceHashes) };
  const papers = sources.map(s => {
    const article = buildArticleScope(s.document), selection = selectSourceBlocks(s.document, article, 'B0');
    const batches = addSourceStatementContext(s.document, planExtractionBatches(s.document, { ...article, included_block_ids: selection.kept_block_ids }, config.batch_options), taskSourceBlockIds(s.document, article));
    return { ...s.source_binding, language: s.source.language, parser_status: s.document.parser.status,
      source_use: { ...s.use, use: 'development_revalidation' }, job_id: s.document.document_id + '-B0', method: 'B0', selection, batches,
      model_source_input_sha256: comparisonDigest({ common, source: s.source_binding, selection_digest: selection.digest, batches }) };
  });
  const observations = spec.cases.map(c => {
    const source = sources.find(s => s.document.document_id === c.document_id); if (!source) throw new ContractError('b0_observation_source_missing');
    const allowed = new Set(taskSourceBlockIds(source.document, buildArticleScope(source.document)));
    const fragments = c.source_fragments.map(f => locateEvidenceFragment(source.document, f));
    if (!fragments.length || fragments.some(f => !allowed.has(f.block_id))) throw new ContractError('b0_observation_outside_task_scope');
    return { ...c, source_fragments: fragments, file_sha256: source.document.file_sha256, text_version: source.document.text_version,
      complete_gold: false, sent_to_model_as_answers: false, medical_approval: false };
  });
  return { schema_version: B0_REVALIDATION_PLAN_SCHEMA, purpose: B0_REVALIDATION_PURPOSE, method: 'B0',
    batch_id: 'b0-revalidation-' + randomUUID(), prepared_at: new Date().toISOString(), status: 'prepared_no_model_calls_pending_new_user_authorization',
    config_path: configPath, config, common, source_hashes: sourceHashes, papers, observations,
    execution_order: papers.map(p => p.job_id), real_model_provider_requests: 0, medical_quality_approved: false, stage_passed: false,
    scope_note: 'One B0 run per paper, sequential, shared new budget. Development regression only; no method comparison, complete gold or independent medical acceptance. Old authorizations, balances and execution directories cannot be resumed.' };
}
export type B0RevalidationPlan = Awaited<ReturnType<typeof makeB0RevalidationPlan>>;

export async function prepareB0Revalidation(configPath: string, directory: string) {
  const code = await realpath(process.cwd()), actualConfig = await insideCode(configPath), relConfig = relative(code, actualConfig);
  await insideCode(dirname(directory)); const plan = await makeB0RevalidationPlan(await json(actualConfig), relConfig);
  await mkdir(directory, { recursive: false, mode: 0o700 }); await save(resolve(directory, 'plan.json'), plan, true);
  const planSha = sourceBytesDigest(await readFile(resolve(directory, 'plan.json')));
  const inputs = Object.assign({}, ...plan.papers.map(p => ({ [p.pdf_path!]: p.pdf_sha256, [p.ir_path]: p.ir_sha256,
    [p.figure_catalog_path]: p.figure_catalog_sha256, ...p.assets })));
  for (const [folder, files] of [['source-snapshot', plan.source_hashes], ['input-snapshot', inputs]] as const) for (const [path, expected] of Object.entries(files)) {
    const bytes = await readFile(await insideCode(path)); if (sourceBytesDigest(bytes) !== expected) throw new ContractError('b0_snapshot_input_changed');
    const target = resolve(directory, folder, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  await save(resolve(directory, 'authorization-template.json'), { schema_version: 'b0-revalidation-authorization-1', status: 'pending_user_confirmation',
    authorization_id: null, user_confirmation_source: null, approved_at: null, prepared_plan_sha256: planSha, batch_id: plan.batch_id,
    purpose: B0_REVALIDATION_PURPOSE, method: 'B0', document_ids: plan.papers.map(p => p.document_id), ...plan.config.model,
    limits: plan.config.proposed_limits, notice: 'UNSIGNED PROPOSAL. No model call authorized. Requires a new explicit user confirmation bound to this plan; old paid rounds/balances are closed. All failures/retries share these caps and one clock starting at the first request. No automatic second round, budget expansion or resume.' }, true);
  return { plan, plan_sha256: planSha };
}

export async function preflightB0Revalidation(directory: string, authorizationPath?: string) {
  await insideCode(directory);
  const bytes = await readFile(resolve(directory, 'plan.json')), plan = JSON.parse(bytes.toString('utf8')) as B0RevalidationPlan;
  if (plan.schema_version !== B0_REVALIDATION_PLAN_SCHEMA || plan.purpose !== B0_REVALIDATION_PURPOSE || plan.method !== 'B0') throw new ContractError('b0_prepared_plan_required');
  assertConfig(plan.config); await assertFrozenRuntimeSources(plan.source_hashes, resolve(directory, 'source-snapshot'));
  const rebuilt = await makeB0RevalidationPlan(plan.config, plan.config_path);
  for (const key of ['common', 'papers', 'observations', 'execution_order'] as const)
    if (comparisonDigest(plan[key]) !== comparisonDigest(rebuilt[key])) throw new ContractError('b0_prepared_input_or_observation_changed');
  for (const p of plan.papers) for (const [path, expected] of Object.entries({ [p.pdf_path!]: p.pdf_sha256, [p.ir_path]: p.ir_sha256,
    [p.figure_catalog_path]: p.figure_catalog_sha256, ...p.assets }))
    if (sourceBytesDigest(await readFile(resolve(directory, 'input-snapshot', path))) !== expected) throw new ContractError('b0_frozen_input_snapshot_changed');
  const authorization = authorizationPath ? validateB0RevalidationAuthorization(await json(await insideCode(authorizationPath)), {
    plan_sha256: sourceBytesDigest(bytes), batch_id: plan.batch_id, ...plan.config.model, proposed_limits: plan.config.proposed_limits,
    document_ids: plan.papers.map(p => p.document_id) }) : undefined;
  const report = { schema_version: 'b0-offline-preflight-1', plan_sha256: sourceBytesDigest(bytes), method: 'B0', purpose: B0_REVALIDATION_PURPOSE,
    status: authorization ? 'offline_bindings_valid_no_execution' : 'offline_inputs_ready_pending_new_user_authorization',
    execution_order: plan.execution_order, source_snapshot_files: Object.keys(plan.source_hashes).length, papers: plan.papers.length,
    observations: plan.observations.length, model: plan.config.model, proposed_limits: plan.config.proposed_limits,
    raw_parser_partial_is_not_task_failure: true, authorization_binding_checked: Boolean(authorization),
    this_report_is_not_user_authorization: true, execution_started: false, model_provider_requests: 0, stage_passed: false, medical_quality_approved: false };
  return { plan, authorization, report };
}

export function b0CompletionIssues(result: Awaited<ReturnType<typeof runExtractionDocument>>) {
  const issues: string[] = [];
  if (result.error) issues.push(result.error.code ?? 'run_error');
  if (result.task_processing_complete !== true || result.coverage.selected_source_block_processing_complete !== true ||
    result.coverage.task_scope_source_block_processing_complete !== true) issues.push('b0_task_processing_incomplete');
  if (result.coverage.whole_document_summary_complete !== true || result.primary_assessment_validation.status !== 'complete_unapproved') issues.push('b0_summary_assessment_incomplete');
  if (result.records.some(v => { const r = v.record.evidence_validation.model_semantic_review; return r.status !== 'reviewed_unapproved' ||
    r.assessment_policy_version !== PRIMARY_ASSESSMENT_POLICY_VERSION || !r.primary_assessment || !r.model_id; })) issues.push('b0_current_record_assessment_missing');
  if (result.delivery_validation.status !== 'passed') issues.push(result.delivery_validation.error?.code ?? 'b0_delivery_invalid');
  return [...new Set(issues)];
}
/** The production scheduler is also tested with offline callbacks; those callbacks prove no model semantics. */
export async function runB0Sequence(jobs: readonly string[], perform: (job: string) => Promise<Record<string, unknown> & { failure_codes: string[] }>,
  totals: () => unknown, persist: (report: Record<string, unknown>) => Promise<unknown>) {
  const report = { purpose: B0_REVALIDATION_PURPOSE, method: 'B0', status: 'running', jobs: [] as Array<Record<string, unknown>>,
    not_started_job_ids: [...jobs], totals: totals(), medical_quality_approved: false, stage_passed: false };
  for (const job of jobs) {
    try {
      const row = await perform(job); report.jobs.push(row);
      if (row.failure_codes.length) { report.status = 'stopped_after_failure'; break; }
    } catch (error) { report.jobs.push({ job_id: job, status: 'failed', error: safeError(error) }); report.status = 'stopped_after_failure'; break; }
    finally { report.totals = totals(); report.not_started_job_ids = jobs.slice(report.jobs.length); await persist(report); }
  }
  if (report.status === 'running') report.status = 'finished_b0_runs_outputs_unreviewed';
  report.totals = totals(); await persist(report); return report;
}

export async function executeB0Revalidation(directory: string, authorizationPath: string) {
  const { plan, authorization } = await preflightB0Revalidation(directory, authorizationPath);
  if (!authorization) throw new ContractError('new_b0_revalidation_user_authorization_required');
  const model = loadModelConfig();
  if (model.provider !== plan.config.model.provider || model.baseUrl !== plan.config.model.endpoint) throw new ContractError('comparison_provider_endpoint_mismatch');
  const code = await realpath(process.cwd()), execution = resolve(directory, 'execution'), owner = resolve(code, comparisonBudgetOwner(authorization.authorization_id));
  try { await access(execution); throw new ContractError('b0_execution_already_exists_no_resume'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(owner), { recursive: true });
  try { await mkdir(owner, { recursive: false, mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ContractError('b0_budget_owner_already_exists_no_reuse'); throw error; }
  await mkdir(execution, { recursive: false, mode: 0o700 });
  const lockPath = resolve(owner, 'active-owner.lock'), lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, batch_id: plan.batch_id })); await lock.close();
  const controller = new AbortController(), stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const store = new ExtractionStore(resolve(execution, 'evidence.sqlite'));
  const budget = new ExtractionBudget(resolve(owner, 'call-ledger.json'), model.baseUrl, Date.now, { limits: authorization.limits,
    authorization: b0RevalidationBudgetAuthorization(authorization), responseModelAliasPolicy: plan.config.response_model_alias_policy });
  try {
    await save(resolve(execution, 'authorization.json'), authorization, true);
    await save(resolve(execution, 'budget-owner.json'), { ledger: relative(code, budget.path), authorization_id: authorization.authorization_id,
      original_totals: budget.totals(), shared_across_all_papers_and_retries: true, resume_or_budget_reset_allowed: false }, true);
    return await runB0Sequence(plan.execution_order, async jobId => {
      if (controller.signal.aborted) throw new ContractError('run_cancelled'); budget.check();
      await assertFrozenRuntimeSources(plan.source_hashes, resolve(directory, 'source-snapshot'));
      const paper = plan.papers.find(p => p.job_id === jobId)!, source = (await readPreparedExtractionSources([plan.config.papers.find(p => p.source_id === paper.document_id)!]))[0]!;
      if (comparisonDigest(source.source_binding) !== comparisonDigest(Object.fromEntries(Object.keys(source.source_binding).map(k => [k, paper[k as keyof typeof paper]]))))
        throw new ContractError('b0_execution_source_changed');
      const before = budget.totals(), profile = developmentProfile(plan.config.model.model_id, plan.config.model.api), runId = plan.batch_id + ':source-' + paper.document_id;
      const input: RunInput = { schema_version: '1', run_id: runId, document_id: paper.document_id, file_sha256: paper.pdf_sha256, fixture: false,
        scope: plan.config.scope, rule_version: 'b0-source-revalidation-1', runtime_profile: { provider: model.provider, model_id: profile.model_id,
          endpoint: model.baseUrl, pi_version: '1.4.0', version: profile.profile_version } };
      const result = await runExtractionDocument({ input, document: source.document, catalog: plan.config.catalog, profile, config: model, budget, store,
        directory: resolve(execution, jobId), strategy: 'baseline', batchOptions: plan.config.batch_options, sourceSelectionCondition: 'B0',
        figureCatalog: source.figures, figureDiscovery: 'not_requested', documentTimeoutMs: authorization.limits.document_seconds * 1000,
        batchMaxResponses: authorization.limits.batch_responses, executionConcurrency: 1, signal: controller.signal,
        metadata: { task_id: runId, article_family_id: source.source.article_family_id, created_at: new Date().toISOString(),
          source_version: { file_sha256: paper.pdf_sha256, source_kind: 'public_published_pdf_development', version: paper.pdf_sha256,
            obtained_at: source.source.access.retrieved_at ?? new Date().toISOString() } } });
      const failureCodes = b0CompletionIssues(result);
      if (!failureCodes.length) try {
        await exportEvidenceDelivery(source.document, store.current(runId), { codeRoot: code,
          directory: resolve(execution, jobId, 'candidate-export'), mode: 'candidates', catalog: source.figures, coverage: result.coverage });
      } catch (error) { failureCodes.push(safeError(error).code ?? 'candidate_export_failed'); }
      return { job_id: jobId, status: failureCodes.length ? 'failed_contract_or_delivery' : 'completed_outputs_unreviewed', failure_codes: failureCodes,
        result_path: relative(code, resolve(execution, jobId, 'result.json')), state: result.state, task_processing_complete: result.task_processing_complete,
        coverage: result.coverage, delivery_validation: result.delivery_validation, primary_assessment_validation: result.primary_assessment_validation,
        candidate_count: result.candidate_count, unique_source_group_count: result.unique_source_group_count,
        requests: budget.totals().requests - before.requests, input_tokens: budget.totals().input_tokens - before.input_tokens,
        output_tokens: budget.totals().output_tokens - before.output_tokens, seconds: result.total_seconds, error: result.error };
    }, () => budget.totals(), report => save(resolve(execution, 'report.json'), report));
  } finally { store.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); await unlink(lockPath); }
}
