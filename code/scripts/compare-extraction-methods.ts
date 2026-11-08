import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, open, unlink, rename } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { assertSchema, ContractError, EvidenceCatalogSchema, ScopeSchema, type EvidenceCatalog, type Scope, type RunInput } from '@t1/contracts';
import { loadModelConfig, safeError } from '../packages/agent/src/config.js';
import { loadPdfParserSelection } from '../packages/agent/src/parser-selection.js';
import { evidenceScopeIssues } from '../packages/agent/src/scope-matching.js';
import { ExtractionBudget, S4_LIMITS, type ExtractionBudgetLimits, type ResponseModelAliasPolicy } from '../packages/agent/src/extraction-budget.js';
import { comparisonBudgetAuthorization, comparisonBudgetOwner, validateComparisonAuthorization, validateComparisonRevision } from '../packages/agent/src/experiment-authorization.js';
import { developmentProfile, VISUAL_SCOPE_PROMPT_VERSION } from '../packages/agent/src/extraction-pi.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../packages/agent/src/visual-evidence-policy.js';
import { SOURCE_EVIDENCE_UNIT_VERSION } from '../packages/agent/src/source-evidence-units.js';
import { PRIMARY_ASSESSMENT_POLICY_VERSION, DIAGNOSTIC_VISUAL_SCOPE_RULE_VERSION, NORMAL_ANATOMIC_SCOPE_RULE_VERSION } from '../packages/agent/src/primary-evidence-assessment.js';
import { ExtractionStore } from '../packages/agent/src/extraction-store.js';
import { runExtractionDocument } from '../packages/agent/src/extraction-run.js';
import { assertCurrentComparisonPlan, assertSingleOptimization, COMPARISON_METHODS, COMPARISON_PLAN_SCHEMA,
  comparisonDigest, planPaperMethods } from '../packages/agent/src/method-comparison.js';
import { BIBLIOGRAPHY_SCOPE_RULE_VERSION, SOURCE_SELECTION_VERSION } from '../packages/agent/src/source-selection.js';
import { STRICT_SOURCE_GROUPING_POLICY_VERSION } from '../packages/agent/src/strict-source-groups.js';
import { readPreparedExtractionSources, extractionRuntimeSourceHashes } from '../packages/agent/src/prepared-extraction-sources.js';

interface Config {
  schema_version: 'two-method-comparison-config-1'; status: 'prepared_pending_new_user_authorization'; execute_model_calls: false;
  methods: ['B0', 'F'];
  bibliography_scope_rule_version: typeof BIBLIOGRAPHY_SCOPE_RULE_VERSION;
  source_selection_rule_version: typeof SOURCE_SELECTION_VERSION;
  input_readiness_report?: string;
  formal_model_selected: false; papers: Array<{ source_id: string; prepared_directory: string; figure_catalog?: string }>;
  model: { provider: string; endpoint: string; model_id: string; reasoning_effort: 'medium'; api: 'openai-responses' | 'openai-completions' };
  catalog: EvidenceCatalog; scope: Scope; batch_options: { maxCodePoints: number; maxBlocks: number; contextBlocks: number };
  strategy: 'baseline'; concurrency: 1; figure_pairing: string; proposed_limits: ExtractionBudgetLimits;
  response_model_alias_policy?: ResponseModelAliasPolicy;
  optimization: { kind: string; only_comparison_variable: 'source_input_preprocessing'; parent_plan: string | null; declared_change: string | null };
  quality: { full_reference_answer_required: false; sampling_rules: string; actual_human_reviews: 0; sample_count: null; thresholds: null; winner: null };
  price_estimate: unknown;
  visual_scope_prompt?: typeof VISUAL_SCOPE_PROMPT_VERSION;
  /** Optional cohort restriction for a new source-bound integration smoke; never changes an input strategy. */
  execution_job_ids?: string[];
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const args = process.argv.slice(2), action = args.shift() ?? 'prepare', flags = new Map<string, string>();
if (action === '--help') {
  process.stdout.write('compare-extraction-methods.ts prepare --directory NEW_DIRECTORY [--config config/two-method-comparison.json]\ncompare-extraction-methods.ts execute --directory PREPARED_DIRECTORY --authorization NEW_USER_CONFIRMED_FILE\nprepare is offline and creates a paper × B0/F plan, source masks, equal-input groups, and an UNSIGNED authorization template. Historical three-method plans and authorizations are read-only and cannot execute.\n'); process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  if (!['--directory', '--config', '--authorization'].includes(args[i]!) || !args[i + 1] || flags.has(args[i]!)) throw new ContractError('comparison_arguments_invalid');
  flags.set(args[i]!, args[i + 1]!);
}
if (!flags.has('--directory') || !['prepare', 'execute'].includes(action)) throw new ContractError('comparison_action_and_directory_required');
const code = await realpath(process.cwd()), directory = resolve(flags.get('--directory')!), parent = await realpath(action === 'prepare' ? dirname(directory) : directory);
const rel = relative(code, parent);
if (rel.startsWith('..') || isAbsolute(rel) || directory === code) throw new ContractError('comparison_directory_outside_code');
const save = async (path: string, value: unknown, exclusive = false) => {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  else { await writeFile(path + '.tmp', bytes, { mode: 0o600 }); await rename(path + '.tmp', path); }
};
function assertConfig(v: Config) {
  if (v.schema_version !== 'two-method-comparison-config-1' || comparisonDigest(v.methods) !== comparisonDigest(COMPARISON_METHODS.map(m => m.condition)))
    throw new ContractError('comparison_current_two_method_config_required');
  if (v.bibliography_scope_rule_version !== BIBLIOGRAPHY_SCOPE_RULE_VERSION) throw new ContractError('comparison_bibliography_scope_version_mismatch');
  if (v.source_selection_rule_version !== SOURCE_SELECTION_VERSION) throw new ContractError('comparison_source_selection_version_mismatch');
  assertSchema(EvidenceCatalogSchema, v.catalog); assertSchema(ScopeSchema, v.scope);
  if (v.status !== 'prepared_pending_new_user_authorization' || v.execute_model_calls !== false ||
    v.formal_model_selected !== false || v.strategy !== 'baseline' || v.concurrency !== 1 || v.model.reasoning_effort !== 'medium' ||
    !['openai-responses', 'openai-completions'].includes(v.model.api) || !/^[A-Za-z0-9_./:@+-]{1,160}$/u.test(v.model.model_id) ||
    !v.papers.length || new Set(v.papers.map(p => p.source_id)).size !== v.papers.length ||
    v.papers.some(p => !/^[A-Za-z0-9._-]{1,120}$/u.test(p.source_id) ||
      p.figure_catalog !== undefined && (typeof p.figure_catalog !== 'string' || !p.figure_catalog.trim())) || evidenceScopeIssues(v.scope, v.catalog).length ||
    v.quality.full_reference_answer_required !== false || v.quality.actual_human_reviews !== 0 || v.quality.winner !== null ||
    v.optimization.only_comparison_variable !== 'source_input_preprocessing' || Object.keys(v.proposed_limits).length !== Object.keys(S4_LIMITS).length) throw new ContractError('comparison_config_invalid');
  const endpoint = new URL(v.model.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ContractError('comparison_endpoint_invalid');
  for (const key of Object.keys(S4_LIMITS) as Array<keyof ExtractionBudgetLimits>) if (!Number.isSafeInteger(v.proposed_limits[key]) ||
    v.proposed_limits[key] < (key === 'transient_retries' ? 0 : 1)) throw new ContractError('comparison_proposed_limits_invalid');
  if (v.proposed_limits.request_seconds !== 120 || v.proposed_limits.document_seconds > 1800 || v.proposed_limits.batch_responses > 16 ||
    v.proposed_limits.response_output_tokens !== 8192 || v.proposed_limits.transient_retries !== 2) throw new ContractError('comparison_execution_limits_invalid');
  if (v.visual_scope_prompt !== undefined && v.visual_scope_prompt !== VISUAL_SCOPE_PROMPT_VERSION) throw new ContractError('comparison_scope_prompt_version_mismatch');
  if (v.execution_job_ids !== undefined && (!Array.isArray(v.execution_job_ids) || !v.execution_job_ids.length ||
    new Set(v.execution_job_ids).size !== v.execution_job_ids.length || v.execution_job_ids.some(id =>
      typeof id !== 'string' || !v.papers.some(p => COMPARISON_METHODS.some(method => id === p.source_id + '-' + method.condition)))))
    throw new ContractError('comparison_execution_jobs_invalid');
}
async function inside(path: string) {
  const actual = await realpath(resolve(code, path)), rel = relative(code, actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('comparison_source_outside_code'); return actual;
}
async function readSources(config: Config) {
  return readPreparedExtractionSources(config.papers);
}
async function sourceHashes(config: Config) {
  return extractionRuntimeSourceHashes({ scripts: ['scripts/compare-extraction-methods.ts'], responseModelAliasPolicy: config.response_model_alias_policy });
}
type Plan = Awaited<ReturnType<typeof makePlan>>;
const comparisonControls = (c: Config) => ({ papers: c.papers, model: c.model, scope: c.scope, parser: 'fixed-formal-current',
  bibliography_scope_rule_version: c.bibliography_scope_rule_version,
  source_selection_rule_version: c.source_selection_rule_version,
  input_readiness_report: c.input_readiness_report ?? null,
  figure_pairing: c.figure_pairing, catalog: c.catalog, batch_options: c.batch_options, strategy: c.strategy,
  concurrency: c.concurrency, proposed_limits: c.proposed_limits, visual_scope_prompt: c.visual_scope_prompt ?? null,
  execution_job_ids: c.execution_job_ids ?? null });
async function makePlan(config: Config) {
  assertConfig(config);
  if (config.optimization.parent_plan) {
    const parentPlan = await json(await inside(config.optimization.parent_plan)); assertCurrentComparisonPlan(parentPlan);
    const before = parentPlan.config as Config;
    assertSingleOptimization(comparisonControls(before), comparisonControls(config), config.optimization.declared_change ?? '');
  }
  const sources = await readSources(config), parser = loadPdfParserSelection(), hashes = await sourceHashes(config);
  const common = { model: config.model, profile: developmentProfile(config.model.model_id, config.model.api), scope: config.scope, catalog: config.catalog,
    parser_selection: parser, parser_config_digest: sources[0]!.document.parser.config_digest, batch_options: config.batch_options,
    strategy: config.strategy, concurrency: config.concurrency, operation_limits: config.proposed_limits, figure_pairing: config.figure_pairing,
    evidence_policy_version: VISUAL_STATEMENT_POLICY_VERSION, source_evidence_unit_version: SOURCE_EVIDENCE_UNIT_VERSION,
    primary_assessment_policy_version: PRIMARY_ASSESSMENT_POLICY_VERSION,
    diagnostic_visual_scope_rule_version: DIAGNOSTIC_VISUAL_SCOPE_RULE_VERSION,
    normal_anatomic_scope_rule_version: NORMAL_ANATOMIC_SCOPE_RULE_VERSION,
    source_grouping_policy_version: STRICT_SOURCE_GROUPING_POLICY_VERSION,
    bibliography_scope_rule_version: BIBLIOGRAPHY_SCOPE_RULE_VERSION, source_selection_rule_version: SOURCE_SELECTION_VERSION,
    visual_scope_prompt: VISUAL_SCOPE_PROMPT_VERSION,
    runtime_source_sha256: comparisonDigest(hashes), exact_original_fragments_only: true };
  const papers = sources.map(s => ({ ...s.source_binding, source_use: s.use, parser_status: s.document.parser.status,
    methods: planPaperMethods(s.document, { ...common, source: s.source_binding }, config.batch_options) }));
  const executionJobs = papers.flatMap(p => p.methods.jobs).filter(j => !config.execution_job_ids || config.execution_job_ids.includes(j.job_id));
  if (config.execution_job_ids && executionJobs.some(j => j.representative_job_id)) throw new ContractError('reliability_smoke_requires_independent_jobs');
  return { schema_version: COMPARISON_PLAN_SCHEMA, batch_id: 'comparison-' + randomUUID(), prepared_at: new Date().toISOString(),
    status: 'prepared_no_model_calls_pending_new_user_authorization', config, common, source_hashes: hashes,
    input_quality_status: 'source_binding_checked_input_readiness_recorded_separately',
    input_readiness_report: config.input_readiness_report ?? null, offline_preparation_is_input_quality_approval: false,
    papers,
    ...(config.execution_job_ids ? { execution_job_ids: executionJobs.map(j => j.job_id),
      experiment_purpose: 'integrated_reliability_smoke_no_single_variable_gain_or_method_ranking' } : {}),
    paid_calls: 0, actual_human_reviews: 0, medical_quality_approved: false, stage_passed: false, winner: null };
}
if (action === 'prepare') {
  if (flags.has('--authorization')) throw new ContractError('comparison_prepare_is_offline');
  const config = await json(await inside(flags.get('--config') ?? 'config/two-method-comparison.json')) as Config, plan = await makePlan(config);
  await mkdir(directory, { recursive: false, mode: 0o700 }); await save(resolve(directory, 'plan.json'), plan, true);
  const planSha = hash(await readFile(resolve(directory, 'plan.json')));
  await save(resolve(directory, 'authorization-template.json'), { schema_version: 'two-method-authorization-1', status: 'pending_user_confirmation',
    authorization_id: null, user_confirmation_source: null, approved_at: null, prepared_plan_sha256: planSha, batch_id: plan.batch_id,
    input_quality_status: plan.input_quality_status, offline_preparation_is_input_quality_approval: false,
    model_id: config.model.model_id, reasoning_effort: config.model.reasoning_effort, provider: config.model.provider, api: config.model.api,
    limits: config.proposed_limits,
    scope_note: config.execution_job_ids ? `Integrated reliability smoke only for ${config.execution_job_ids.join(',')}; no single-variable performance gain or method ranking. All attempts share the approved caps.` :
      'B0/F comparison proposal only. Papers, model and all paid attempts must be covered by a new explicit user authorization after input-quality validation; old experiments and remaining quotas are closed.',
    budget_owner_policy: 'Keep the same authorization_id, confirmation source and time for authorized follow-ups. A single shared ledger and its original wall clock never reset per method, retry or revision.',
    notice: 'Unsigned proposal only. Old budgets are closed; no model call authorized by this file.' }, true);
  process.stdout.write(JSON.stringify({ status: plan.status, directory: relative(code, directory), plan_sha256: planSha,
    input_quality_status: plan.input_quality_status, offline_preparation_is_input_quality_approval: false,
    papers: plan.papers.map(p => ({ id: p.document_id, methods: p.methods.logical_methods, unique_inputs: p.methods.unique_inputs,
      masks: p.methods.jobs.map(j => ({ job: j.job_id, kept: j.selected_block_count, batches: j.batch_count, equivalent_to: j.representative_job_id })) })),
    proposed_limits: config.proposed_limits, ...(config.execution_job_ids ? { execution_job_ids: plan.execution_job_ids,
      experiment_purpose: plan.experiment_purpose } : {}), paid_calls: 0, winner: null }) + '\n');
} else {
  if (!flags.has('--authorization') || flags.has('--config')) throw new ContractError('new_comparison_user_authorization_required');
  const planBytes = await readFile(resolve(directory, 'plan.json')), plan = JSON.parse(planBytes.toString('utf8')) as Plan;
  assertCurrentComparisonPlan(plan);
  assertConfig(plan.config);
  const authorization = validateComparisonAuthorization(await json(await inside(flags.get('--authorization')!)), {
    plan_sha256: hash(planBytes), batch_id: plan.batch_id, model_id: plan.config.model.model_id, reasoning_effort: plan.config.model.reasoning_effort,
    provider: plan.config.model.provider, api: plan.config.model.api, proposed_limits: plan.config.proposed_limits });
  if (plan.config.optimization.parent_plan) {
    const revision = authorization.revision;
    if (!revision || revision.parent_plan_path !== plan.config.optimization.parent_plan || plan.config.visual_scope_prompt !== VISUAL_SCOPE_PROMPT_VERSION) throw new ContractError('comparison_revision_binding_required');
    const parentPlanPath = await inside(revision.parent_plan_path), parentPlanBytes = await readFile(parentPlanPath), parentPlan = JSON.parse(parentPlanBytes.toString('utf8')) as Plan;
    assertCurrentComparisonPlan(parentPlan);
    const parentAuthBytes = await readFile(await inside(revision.parent_authorization_path));
    const parentAuth = validateComparisonAuthorization(JSON.parse(parentAuthBytes.toString('utf8')), { plan_sha256: hash(parentPlanBytes),
      batch_id: parentPlan.batch_id, ...parentPlan.config.model, proposed_limits: parentPlan.config.proposed_limits });
    const confirmationBytes = await readFile(await inside(revision.rule_confirmation_path));
    assertSingleOptimization(comparisonControls(parentPlan.config), comparisonControls(plan.config), plan.config.optimization.declared_change ?? '');
    validateComparisonRevision(authorization, { parent: parentAuth, parent_authorization_sha256: hash(parentAuthBytes), parent_plan_sha256: hash(parentPlanBytes),
      rule_confirmation_sha256: hash(confirmationBytes), declared_change: plan.config.optimization.declared_change ?? '',
      rule_id: plan.config.visual_scope_prompt, confirmation: JSON.parse(confirmationBytes.toString('utf8')) });
    for (const [path, expected] of Object.entries(parentPlan.source_hashes)) if (hash(await readFile(resolve(dirname(parentPlanPath), 'execution/source-snapshot', path))) !== expected) throw new ContractError('comparison_parent_source_snapshot_changed');
  } else if (authorization.revision) throw new ContractError('comparison_revision_parent_plan_required');
  for (const [path, expected] of Object.entries(plan.source_hashes)) if (hash(await readFile(await inside(path))) !== expected) throw new ContractError('comparison_runtime_source_changed_reprepare_required');
  const sources = await readSources(plan.config); // Same corpus-use guard and current source checks run again before a network call.
  for (const source of sources) {
    const prepared = plan.papers.find(p => p.document_id === source.document.document_id);
    if (!prepared || comparisonDigest(source.source_binding) !== comparisonDigest({ document_id: prepared.document_id,
      article_family_id: prepared.article_family_id, pdf_path: prepared.pdf_path, pdf_sha256: prepared.pdf_sha256, ir_path: prepared.ir_path,
      ir_sha256: prepared.ir_sha256, text_version: prepared.text_version, parser_config_digest: prepared.parser_config_digest,
      figure_catalog_path: prepared.figure_catalog_path, figure_catalog_sha256: prepared.figure_catalog_sha256, assets: prepared.assets }) ||
      comparisonDigest(planPaperMethods(source.document, { ...plan.common, source: source.source_binding }, plan.config.batch_options)) !== comparisonDigest(prepared.methods)) {
      throw new ContractError('comparison_input_or_mask_changed_reprepare_required');
    }
  }
  const config = loadModelConfig();
  if (config.provider !== plan.config.model.provider || config.baseUrl !== plan.config.model.endpoint) throw new ContractError('comparison_provider_endpoint_mismatch');
  const execution = resolve(directory, 'execution'); await mkdir(execution, { recursive: false, mode: 0o700 });
  const budgetOwner = resolve(code, comparisonBudgetOwner(authorization.authorization_id)); await mkdir(budgetOwner, { recursive: true, mode: 0o700 });
  await inside(budgetOwner);
  const lockPath = resolve(budgetOwner, 'active-owner.lock'), lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, batch_id: plan.batch_id })); await lock.close();
  const controller = new AbortController(), stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let store: ExtractionStore | undefined, budget: ExtractionBudget | undefined;
  const report: { batch_id: string; status: string; jobs: Array<Record<string, unknown>>; totals?: unknown; error?: unknown;
    execution_job_ids?: string[]; experiment_purpose?: string;
    winner: null; medical_quality_approved: false; actual_human_reviews: 0; stage_passed: false } = {
    batch_id: plan.batch_id, status: 'running', jobs: [], winner: null, medical_quality_approved: false, actual_human_reviews: 0, stage_passed: false };
  if (plan.config.execution_job_ids) Object.assign(report, { execution_job_ids: plan.execution_job_ids, experiment_purpose: plan.experiment_purpose });
  try {
    for (const path of Object.keys(plan.source_hashes)) {
      const target = resolve(execution, 'source-snapshot', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, await readFile(path), { flag: 'wx' });
    }
    await save(resolve(execution, 'authorization.json'), authorization, true);
    budget = new ExtractionBudget(resolve(budgetOwner, 'call-ledger.json'), config.baseUrl, Date.now, { limits: authorization.limits,
      authorization: comparisonBudgetAuthorization(authorization), responseModelAliasPolicy: plan.config.response_model_alias_policy });
    await save(resolve(execution, 'budget-owner.json'), { path: relative(code, budgetOwner), ledger: relative(code, budget.path),
      totals_before_this_plan: budget.totals(), per_method_retry_or_revision_reset: false }, true);
    store = new ExtractionStore(resolve(execution, 'evidence.sqlite'));
    for (const paper of plan.papers) for (const job of paper.methods.jobs) {
      if (plan.config.execution_job_ids && !plan.config.execution_job_ids.includes(job.job_id)) continue;
      if (controller.signal.aborted) throw new ContractError('comparison_cancelled');
      if (job.representative_job_id) {
        const representative = report.jobs.find(j => j.job_id === job.representative_job_id);
        if (!representative) throw new ContractError('comparison_equivalent_representative_missing');
        report.jobs.push({ job_id: job.job_id, status: 'equivalent_input_reuses_representative', representative_job_id: job.representative_job_id,
          representative_result_path: representative.result_path, state: representative.state, independent_model_run: false,
          task_processing_complete: representative.task_processing_complete ?? null,
          requests: 0, input_method_gain_claimed: false }); continue;
      }
      budget.check(); const before = budget.totals(), source = sources.find(s => s.document.document_id === paper.document_id)!;
      // The model sees opaque execution identity, never a method label that could bias an otherwise equal input.
      const profile = developmentProfile(plan.config.model.model_id, plan.config.model.api),
        runId = plan.batch_id + ':source-' + paper.document_id + ':input-' + job.model_source_input_sha256.slice(0, 12);
      const input: RunInput = { schema_version: '1', run_id: runId, document_id: paper.document_id, file_sha256: paper.pdf_sha256, fixture: false,
        scope: plan.config.scope, rule_version: 'verbatim-two-method-comparison-1', runtime_profile: { provider: config.provider,
          model_id: profile.model_id, endpoint: config.baseUrl, pi_version: '1.4.0', version: profile.profile_version } };
      const result = await runExtractionDocument({ input, document: source.document, catalog: plan.config.catalog, profile, config, budget, store,
        directory: resolve(execution, job.job_id), strategy: 'baseline', batchOptions: plan.config.batch_options, sourceSelectionCondition: job.condition,
        figureCatalog: source.figures, figureDiscovery: 'not_requested', documentTimeoutMs: authorization.limits.document_seconds * 1000,
        batchMaxResponses: authorization.limits.batch_responses, executionConcurrency: 1,
        metadata: { task_id: runId, article_family_id: source.source.article_family_id, created_at: new Date().toISOString(),
          source_version: { file_sha256: paper.pdf_sha256, source_kind: 'public_published_pdf_development', version: paper.pdf_sha256,
            obtained_at: source.source.access.retrieved_at ?? new Date().toISOString() } }, signal: controller.signal });
      report.jobs.push({ job_id: job.job_id, independent_model_run: true, state: result.state, candidate_count: result.candidate_count,
        task_processing_complete: result.task_processing_complete,
        delivery_validation: result.delivery_validation,
        coverage: result.coverage, seconds: result.total_seconds, first_candidate_seconds: result.first_candidate_seconds, error: result.error,
        requests: budget.totals().requests - before.requests, input_tokens_including_conservative_missing_usage: budget.totals().input_tokens - before.input_tokens,
        output_tokens_including_reasoning_or_missing_usage_reservation: budget.totals().output_tokens - before.output_tokens,
        actual_cost: null, cost_status: 'unknown_gateway_billing', actual_human_reviews: 0, human_review_workload: null,
        result_path: relative(code, resolve(execution, job.job_id, 'result.json')) });
      report.totals = budget.totals(); await save(resolve(execution, 'report.json'), report);
      if (result.delivery_validation.status === 'rejected') throw new ContractError(result.delivery_validation.error?.code ?? 'delivery_validation_rejected');
    }
    report.status = 'finished_runs_human_quality_and_selection_pending';
  } catch (cause) { report.status = 'stopped_partial_or_failed'; report.error = safeError(cause); process.exitCode = 1; }
  finally {
    report.totals = budget?.totals(); await save(resolve(execution, 'report.json'), report); store?.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop); await unlink(lockPath);
  }
  process.stdout.write(JSON.stringify(report) + '\n');
}
