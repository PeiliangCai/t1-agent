import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, open, unlink, rename } from 'node:fs/promises';
import { resolve, dirname, relative, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { ContractError, assertSchema, EvidenceRecordSchema, RunInputSchema, type RunInput, type EvidenceValidationContext,
  type FigureAssetCatalog } from '@t1/contracts';
import { ExtractionStore, type StoredEvidenceVersion } from '../packages/agent/src/extraction-store.js';
import { ExtractionSummaryTools } from '../packages/agent/src/extraction-summary.js';
import { buildArticleScope, type ExtractionDocument } from '../packages/agent/src/article-scope.js';
import { createExtractionSession, developmentProfile, promptExtractionSession } from '../packages/agent/src/extraction-pi.js';
import { ExtractionBudget } from '../packages/agent/src/extraction-budget.js';
import { comparisonBudgetOwner, comparisonBudgetAuthorization, validateComparisonAuthorization } from '../packages/agent/src/experiment-authorization.js';
import { allDeliveredRecords, deliveryRecordCounts, buildEvidenceDelivery, evidenceDigest, exportEvidenceDelivery, type EvidenceDelivery } from '../packages/agent/src/evidence-delivery.js';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { assertLivePdfSource } from '../packages/agent/src/figure-assets.js';
import { isSourceSelectionCondition, type SourceSelectionManifest } from '../packages/agent/src/source-selection.js';
import { assertCurrentComparisonPlan } from '../packages/agent/src/method-comparison.js';
import { loadModelConfig, safeError } from '../packages/agent/src/config.js';
import { SummaryTimeBudget, validateSummaryTimeAuthorization, type SummaryTimeRuntime } from './lib/summary-time-window.js';

const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const save = async (p: string, v: unknown, exclusive = false) => { const text = JSON.stringify(v, null, 2) + '\n';
  if (exclusive) await writeFile(p, text, { flag: 'wx', mode: 0o600 });
  else { await writeFile(p + '.tmp', text, { mode: 0o600 }); await rename(p + '.tmp', p); } };

export const ORIGINAL_SUMMARY_PROMPT = 'Perform single-paper whole-document reconciliation. Identity is host-bound: do not include run/document IDs in tool arguments. ' +
  'Call get_document_context to read ALL candidates with exact source segments. Check same-paper duplicates/conflicts, disease/modality applicability, pronouns and later conditions. ' +
  'Use read_document_blocks to resolve missing source context; keep ambiguity explicit. Keep original conflicting statements separately. ' +
  'This baseline summarizes and proposes possible duplicate/conflict/context links; per-record independent semantic review is not required. ' +
  'If semantic_audit_cases are present, they are neutral development questions, not gold or predetermined exclusions. Read every required source/context block using read_document_blocks, then report_context_issue for each audit_case_id with an unapproved conclusion and reasons. ' +
  'Specifically distinguish acquisition/reconstruction conditions and standalone clinical associations from independently supported visual evidence; preserve ambiguity and do not apply a keyword-only rule. ' +
  'Call submit_candidate_records to save a short Chinese summary, reviews, possible links, validated source-backed updates if needed (otherwise updates=[]), and summary_complete=true. ' +
  'Never mark medical/human approval, never overwrite human revisions. Finish after successful saving.';
export const TARGETED_REREAD_ADDITION = '\nContext rereading policy for this experimental variant: Examine the exact candidate fragments and supplied context returned by get_document_context first. Do not re-read the whole paper, all authorized indices, or all omitted/deferred/excluded blocks merely to fill processing coverage. Use read_document_blocks only for a concrete unresolved current-candidate question about negation, pronouns, attribution, numbers/units or table headers, Figure/case/modality or conditions; request the minimal sufficient neighboring original lines. Necessary omitted lines remain readable; never omit required context to save tokens. Report unresolved questions with report_context_issue and keep uncertainty explicit. summary_complete concerns candidate reconciliation, not rereading or extraction of every original block. Never mark omitted/unread blocks completed.';

interface Cohort {
  job_id: string; document_id: string; input: RunInput; metadata: EvidenceValidationContext['metadata'];
  versions: StoredEvidenceVersion[]; batches: Array<{ batch_id: string; status: string }>;
  source: { ir_path: string; ir_sha256: string; figure_catalog_path: string; figure_catalog_sha256: string };
  selection: SourceSelectionManifest; parent_result_path: string; parent_result_sha256: string;
  baseline_summary_path: string; baseline_first_request_sha256: string; baseline_packet_metrics: Record<string, unknown>;
  first_summary_event_seq: number; packet_sha256: string; inherited_batch_coverage: Record<string, unknown>;
}
type SummaryContext = Omit<EvidenceValidationContext, 'allowedBlockIds' | 'readBlockIds' | 'toolCallId' | 'quarantinedBlockIds'>;

/** Restore only immutable pre-summary versions into a NEW experimental store. Never writes the source DB. */
export function restoreSummaryCohort(store: ExtractionStore, cohort: Cohort) {
  assertSchema(RunInputSchema, cohort.input); store.create(cohort.input, cohort.metadata); store.transition(cohort.input.run_id, 'extracting');
  for (const v of cohort.versions) {
    assertSchema(EvidenceRecordSchema, v.record);
    if (v.actor !== 'automatic' || v.record.extraction_trace.run_id !== cohort.input.run_id || v.record.document_id !== cohort.document_id ||
      v.record.source_version.file_sha256 !== cohort.input.file_sha256 || v.record.review_status === 'approved' || v.record.review_events.length ||
      v.record.handoff_status !== 'candidate_only') throw new ContractError('summary_replay_unapproved_bound_automatic_cohort_required');
    assert.deepEqual(v.record.extraction_trace.scope, cohort.input.scope);
    store.db.prepare('INSERT INTO s4_versions VALUES(?,?,?,?)').run(cohort.input.run_id, v.record.record_id, v.version, JSON.stringify(v));
  }
  for (const b of cohort.batches) store.batch(cohort.input.run_id, b.batch_id, b);
  store.transition(cohort.input.run_id, 'reconciling');
}
export function neutralInitialPayload(value: Record<string, any>, prompt: string): Record<string, any> {
  const copy = structuredClone(value); let replaced = 0;
  for (const m of copy.input ?? []) {
    if (m.role !== 'user') continue;
    if (m.content === prompt) { m.content = '$ONLY_CHANGED_SUMMARY_REREAD_PROMPT'; replaced++; }
    else if (Array.isArray(m.content)) for (const c of m.content) if (c.type === 'input_text' && c.text === prompt) {
      c.text = '$ONLY_CHANGED_SUMMARY_REREAD_PROMPT'; replaced++;
    }
  }
  if (replaced !== 1) throw new ContractError('summary_replay_unique_prompt_not_found_in_actual_payload'); return copy;
}
export function deliveredContentDiff(before: EvidenceDelivery, after: EvidenceDelivery) {
  const b = new Map(allDeliveredRecords(before).map(r => [r.record_id, r])), a = new Map(allDeliveredRecords(after).map(r => [r.record_id, r]));
  const common = [...b.keys()].filter(id => a.has(id));
  const changed = (key: 'original_fragments' | 'context_fragments' | 'figure_association' | 'primary_assessment') => common.filter(id => evidenceDigest(b.get(id)![key] ?? null) !== evidenceDigest(a.get(id)![key] ?? null));
  return { added_record_ids: [...a.keys()].filter(id => !b.has(id)), removed_record_ids: [...b.keys()].filter(id => !a.has(id)),
    original_fragment_changes: changed('original_fragments'), context_fragment_changes: changed('context_fragments'),
    figure_association_changes: changed('figure_association'), primary_assessment_changes: changed('primary_assessment'),
    before_groups: deliveryRecordCounts(before), after_groups: deliveryRecordCounts(after), medical_quality_change_assessed: false };
}
async function cohortPacket(cohort: Cohort, document: ExtractionDocument, catalog: any, figures: FigureAssetCatalog) {
  const store = new ExtractionStore(':memory:');
  try {
    restoreSummaryCohort(store, cohort);
    const context: SummaryContext = { input: cohort.input, metadata: cohort.metadata, document, catalog };
    const tools = new ExtractionSummaryTools(context, buildArticleScope(document), store, 'baseline', [], cohort.selection);
    const tool = tools.definitions().find(t => t.name === 'get_document_context')!;
    const response = await tool.execute('offline-cohort-identity-check', {}, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
    const text = response.content.find(c => c.type === 'text')!.text;
    const metrics = store.events(cohort.input.run_id).find(e => e.type === 'summary_context_model_view').detail;
    for (const k of ['original_JSON_bytes', 'packet_JSON_bytes', 'all_candidate_count', 'source_fragment_count']) assert.equal(metrics[k], cohort.baseline_packet_metrics[k]);
    buildEvidenceDelivery(document, store.current(cohort.input.run_id), figures);
    return { text, sha256: hash(text), metrics };
  } finally { store.close(); }
}

async function main() {
  const args = process.argv.slice(2), action = args.shift(), flags = new Map<string, string>();
  if (action === '--help') { process.stdout.write('summary-reread-replay.ts prepare --parent PREPARED_BASELINE --directory NEW_DIR\nsummary-reread-replay.ts execute --directory REPLAY_DIR --authorization ORIGINAL_AUTH [--jobs L01-F,L01-B0,...] [--time-authorization EXPLICIT_TIME_GRANT]\nOnly an explicitly authorized experimental summary-stage replay; never product checkpoint resume or a fresh full extraction. All arms use the same cumulative budget owner.\n'); return; }
  for (let i = 0; i < args.length; i += 2) {
    if (!['--parent', '--directory', '--authorization', '--jobs', '--time-authorization'].includes(args[i]!) || !args[i + 1] || flags.has(args[i]!)) throw new ContractError('summary_replay_arguments_invalid');
    flags.set(args[i]!, args[i + 1]!);
  }
  if (!['prepare', 'execute'].includes(action ?? '') || !flags.has('--directory')) throw new ContractError('summary_replay_action_required');
  const code = await realpath(process.cwd()), directory = resolve(flags.get('--directory')!);
  const inside = async (p: string) => { const actual = await realpath(resolve(code, p)), rel = relative(code, actual);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('summary_replay_path_outside_code'); return actual; };
  await inside(action === 'prepare' ? dirname(directory) : directory);
  const driverPath = fileURLToPath(import.meta.url);
  if (action === 'prepare') {
    if (!flags.has('--parent') || flags.has('--authorization') || flags.has('--jobs') || flags.has('--time-authorization')) throw new ContractError('summary_replay_prepare_arguments_invalid');
    const parent = await inside(flags.get('--parent')!), planBytes = await readFile(join(parent, 'plan.json')), plan = JSON.parse(planBytes.toString('utf8'));
    assertCurrentComparisonPlan(plan);
    const run = await json(join(parent, 'execution/report.json'));
    if (run.status !== 'finished_runs_human_quality_and_selection_pending') throw new ContractError('summary_replay_wait_for_fixed_baseline_completion');
    for (const [p, expected] of Object.entries(plan.source_hashes)) assert.equal(hash(await readFile(await inside(p))), expected);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const db = new DatabaseSync(join(parent, 'execution/evidence.sqlite'), { readOnly: true }), cohorts = [];
    try {
      for (const entry of run.jobs.filter((r: any) => r.independent_model_run)) {
        if (!entry.result_path) throw new ContractError('summary_replay_baseline_result_missing');
        const resultPath = await inside(entry.result_path), resultBytes = await readFile(resultPath), result = JSON.parse(resultBytes.toString('utf8'));
        if (result.error || !result.coverage.selected_source_block_processing_complete || !result.coverage.whole_document_summary_complete) throw new ContractError('summary_replay_requires_completed_baseline_stage');
        const marker = result.events.find((e: any) => e.type === 'summary_context_model_view');
        const before = result.events.filter((e: any) => e.seq < marker.seq);
        const keys = new Set(before.filter((e: any) => e.type === 'candidate' || e.type === 'candidate_proposal').map((e: any) => e.detail.record_id + ':' + e.detail.record_version));
        const versions = result.versions.filter((v: any) => keys.has(v.record.record_id + ':' + v.version)); assert.equal(versions.length, keys.size);
        const sourceRun = db.prepare('SELECT input_json,metadata_json FROM s4_runs WHERE id=?').get(result.run_id)!;
        const paper = plan.papers.find((p: any) => p.document_id === result.document_id), summaryPath = join(dirname(resultPath), 'whole-document-summary.json');
        const summary = await json(summaryPath), selection = await json(join(dirname(resultPath), 'source-selection.json'));
        if (!isSourceSelectionCondition(selection.condition)) throw new ContractError('summary_replay_current_two_method_selection_required');
        const cohort: Cohort = { job_id: entry.job_id, document_id: result.document_id, input: JSON.parse(sourceRun.input_json as string),
          metadata: JSON.parse(sourceRun.metadata_json as string), versions,
          batches: before.filter((e: any) => e.type === 'batch').map((e: any) => ({ batch_id: e.detail.batch_id, status: e.detail.status })),
          source: { ir_path: paper.ir_path, ir_sha256: paper.ir_sha256, figure_catalog_path: paper.figure_catalog_path, figure_catalog_sha256: paper.figure_catalog_sha256 },
          selection, parent_result_path: relative(code, resultPath), parent_result_sha256: hash(resultBytes), baseline_summary_path: relative(code, summaryPath),
          baseline_first_request_sha256: summary.request_accounting[0].payload_sha256, baseline_packet_metrics: marker.detail,
          first_summary_event_seq: marker.seq, packet_sha256: '', inherited_batch_coverage: result.coverage };
        const document = (await json(await inside(paper.ir_path))).document, figures = await json(await inside(paper.figure_catalog_path));
        const packet = await cohortPacket(cohort, document, plan.config.catalog, figures); cohort.packet_sha256 = packet.sha256;
        const file = entry.job_id + '-cohort.json'; await save(join(directory, file), cohort, true);
        cohorts.push({ job_id: entry.job_id, file, sha256: hash(await readFile(join(directory, file))), packet_sha256: packet.sha256,
          candidate_count: packet.metrics.all_candidate_count, original_packet_counters_match: true });
      }
    } finally { db.close(); }
    const manifest = { schema_version: 'summary-reread-paired-experiment-1', replay_id: 'summary-reread-' + randomUUID(), prepared_at: new Date().toISOString(),
      parent_directory: relative(code, parent), parent_plan_sha256: hash(planBytes), parent_batch_id: plan.batch_id,
      driver_path: relative(code, driverPath), driver_sha256: hash(await readFile(driverPath)), baseline_runtime_source_hashes: plan.source_hashes,
      single_variable: 'summary_user_prompt_context_rereading_policy_only', before_prompt: ORIGINAL_SUMMARY_PROMPT,
      after_prompt: ORIGINAL_SUMMARY_PROMPT + TARGETED_REREAD_ADDITION, after_is_exact_before_plus_one_policy: true,
      controls: { model: plan.config.model, scope: plan.config.scope, catalog: plan.config.catalog, operation_limits: plan.config.proposed_limits,
        batch_extraction_repeated: false, source_rules_or_batch_size_changed: false, tools_or_source_context_changed: false,
        needed_omitted_lines_remain_readable: true, original_completion_gates_unchanged: true }, cohorts,
      actual_original_HTTP_body_replay_claimed: false, old_log_recovery_evidence: 'candidate version event boundary plus four recorded packet counters under identical runtime source',
      actual_fresh_payload_validation: 'both fresh arms save first actual request and first packet-visible request only; compare host controls, tool schema and identical packet SHA; later behavior differs as a measured outcome',
      mode: 'controlled_summary_stage_experiment_not_product_checkpoint_resume_or_fresh_end_to_end_extraction',
      medical_quality_approved: false, winner: null };
    await save(join(directory, 'manifest.json'), manifest, true);
    process.stdout.write(JSON.stringify({ prepared: true, directory: relative(code, directory), cohort_count: cohorts.length,
      first_required_pair: 'L01-F', new_model_calls: 0, single_variable: manifest.single_variable }) + '\n'); return;
  }
  if (!flags.has('--authorization') || flags.has('--parent')) throw new ContractError('summary_replay_original_authorization_required');
  const manifestBytes = await readFile(join(directory, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString('utf8'));
  const driverSha = hash(await readFile(driverPath));
  if (manifest.schema_version !== 'summary-reread-paired-experiment-1' || manifest.before_prompt !== ORIGINAL_SUMMARY_PROMPT ||
    manifest.after_prompt !== ORIGINAL_SUMMARY_PROMPT + TARGETED_REREAD_ADDITION ||
    !flags.has('--time-authorization') && manifest.driver_sha256 !== driverSha) throw new ContractError('summary_replay_manifest_or_driver_changed');
  const parent = await inside(manifest.parent_directory), planBytes = await readFile(join(parent, 'plan.json')), plan = JSON.parse(planBytes.toString('utf8'));
  assertCurrentComparisonPlan(plan);
  assert.equal(hash(planBytes), manifest.parent_plan_sha256);
  for (const [p, expected] of Object.entries(manifest.baseline_runtime_source_hashes)) assert.equal(hash(await readFile(await inside(p))), expected);
  const grant = await json(await inside(flags.get('--authorization')!)), auth = validateComparisonAuthorization(grant, { plan_sha256: hash(planBytes), batch_id: plan.batch_id,
    model_id: plan.config.model.model_id, reasoning_effort: plan.config.model.reasoning_effort, provider: plan.config.model.provider,
    api: plan.config.model.api, proposed_limits: plan.config.proposed_limits });
  if (grant.authorized_scope?.old_ledger_reuse !== false || !['L01', 'L05'].every(id => grant.authorized_scope.papers.includes(id))) throw new ContractError('summary_replay_outside_authorized_followup_scope');
  const chosen = flags.has('--jobs') ? flags.get('--jobs')!.split(',') : ['L01-F'];
  if (new Set(chosen).size !== chosen.length || chosen.some(id => !manifest.cohorts.some((c: any) => c.job_id === id))) throw new ContractError('summary_replay_jobs_invalid');
  let timeAuthorizationBytes: string | undefined, timeRuntime: SummaryTimeRuntime | undefined;
  if (flags.has('--time-authorization')) {
    timeAuthorizationBytes = await readFile(await inside(flags.get('--time-authorization')!), 'utf8');
    const pausePath = join(dirname(parent), 'user-pause-2026-11-05.json'), pauseBytes = await readFile(pausePath);
    const pause = JSON.parse(pauseBytes.toString('utf8'));
    timeRuntime = { authorization_id: auth.authorization_id, replay_id: manifest.replay_id, replay_manifest_sha256: hash(manifestBytes),
      original_driver_sha256: manifest.driver_sha256, resumed_driver_sha256: driverSha,
      time_module_sha256: hash(await readFile(new URL('./lib/summary-time-window.ts', import.meta.url))),
      pause_record_sha256: hash(pauseBytes), paused_at: pause.recorded_at, jobs: chosen };
    validateSummaryTimeAuthorization(JSON.parse(timeAuthorizationBytes), timeRuntime);
  }
  const firstPair = join(directory, 'L01-F', 'pair-report.json');
  if (chosen.some(id => id !== 'L01-F')) {
    const pilot = await json(firstPair);
    if (!pilot.mechanical_source_checks_passed || !pilot.actual_payload_controls_equal || !pilot.candidate_packet_sha_equal) throw new ContractError('summary_replay_first_pair_must_pass_before_expansion');
  }
  const config = loadModelConfig();
  if (config.provider !== plan.config.model.provider || config.baseUrl !== plan.config.model.endpoint) throw new ContractError('summary_replay_provider_changed');
  const owner = await inside(comparisonBudgetOwner(auth.authorization_id)), lockPath = join(owner, 'active-owner.lock'), lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, replay_id: manifest.replay_id, same_original_authorization: auth.authorization_id })); await lock.close();
  let budget: ExtractionBudget;
  try {
    const options = { limits: auth.limits, authorization: comparisonBudgetAuthorization(auth), responseModelAliasPolicy: plan.config.response_model_alias_policy };
    budget = timeAuthorizationBytes && timeRuntime ? new SummaryTimeBudget(join(owner, 'call-ledger.json'), config.baseUrl,
      { ...options, timeAuthorizationBytes, runtime: timeRuntime }) :
      new ExtractionBudget(join(owner, 'call-ledger.json'), config.baseUrl, Date.now, options);
  }
  catch (cause) { await unlink(lockPath); throw cause; }
  const controller = new AbortController(), stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const results = [];
  try {
    for (const id of chosen) {
      budget.check(); const item = manifest.cohorts.find((c: any) => c.job_id === id)!;
      const cohortBytes = await readFile(join(directory, item.file)); assert.equal(hash(cohortBytes), item.sha256);
      const cohort = JSON.parse(cohortBytes.toString('utf8')) as Cohort;
      if (!isSourceSelectionCondition(cohort.selection.condition) || !plan.papers.some((p: any) => p.methods.jobs.some((j: any) =>
        j.job_id === id && j.condition === cohort.selection.condition))) throw new ContractError('summary_replay_current_two_method_selection_required');
      assert.equal(hash(await readFile(await inside(cohort.parent_result_path))), cohort.parent_result_sha256);
      assert.equal(hash(await readFile(await inside(cohort.source.ir_path))), cohort.source.ir_sha256);
      assert.equal(hash(await readFile(await inside(cohort.source.figure_catalog_path))), cohort.source.figure_catalog_sha256);
      const document = (await json(await inside(cohort.source.ir_path))).document as ExtractionDocument; assertParsedDocument(document); await assertLivePdfSource(document);
      const figures = await json(await inside(cohort.source.figure_catalog_path)) as FigureAssetCatalog;
      const packet = await cohortPacket(cohort, document, plan.config.catalog, figures); assert.equal(packet.sha256, item.packet_sha256);
      const pairDir = join(directory, id); await mkdir(pairDir, { recursive: false, mode: 0o700 });
      const arms: Record<string, any> = {}, deliveries: Record<string, EvidenceDelivery> = {};
      for (const arm of ['before', 'after'] as const) {
        budget.check(); const armDir = join(pairDir, arm); await mkdir(armDir, { recursive: false, mode: 0o700 });
        const store = new ExtractionStore(join(armDir, 'isolated-candidates.sqlite')); restoreSummaryCohort(store, cohort);
        const pre = buildEvidenceDelivery(document, store.current(cohort.input.run_id), figures), start = performance.now(), startRequest = budget.ledger.requests.length;
        const prompt = arm === 'before' ? manifest.before_prompt : manifest.after_prompt;
        let tools = new ExtractionSummaryTools({ input: cohort.input,
          metadata: cohort.metadata, document, catalog: plan.config.catalog }, buildArticleScope(document), store, 'baseline', [], cohort.selection);
        const traces: Array<Record<string, unknown>> = [], captures: Array<Record<string, any>> = [], originalGuard = budget.guardedFetch.bind(budget);
        const allReadBlocks = new Set<string>(), allIssues: string[] = [], attemptReports: Array<Record<string, unknown>> = [];
        let observedPacket: string | null = null, contextSaved = false, failure: unknown;
        const definitions = () => tools.definitions().map(def => ({ ...def, execute: async (...args: Parameters<typeof def.execute>) => {
          const value = await def.execute(...args);
          if (def.name === 'get_document_context') { const text = value.content.find(c => c.type === 'text')!.text;
            if (observedPacket === null) { assert.equal(hash(text), cohort.packet_sha256); observedPacket = text; } }
          if (def.name === 'read_document_blocks') traces.push({ call_id: args[0], requested: args[1], issues_reported_before_read: [...tools.issues] });
          return value;
        } }));
        budget.guardedFetch = (...options: Parameters<ExtractionBudget['guardedFetch']>) => {
          const guarded = originalGuard(...options);
          return async (input, init) => {
            const raw = await new Request(input, init).clone().text();
            if (raw.includes(config.apiKey())) throw new ContractError('summary_replay_request_body_must_not_contain_credentials');
            const body = JSON.parse(raw), hasPacket = observedPacket !== null && (body.input ?? []).some((m: any) => m.type === 'function_call_output' && m.output === observedPacket);
            if (!captures.length && (arm === 'before' && hash(raw) !== cohort.baseline_first_request_sha256 ||
              arm === 'after' && hash(JSON.stringify(neutralInitialPayload(body, prompt))) !== arms.before.actual_payload_control_sha256)) {
              await writeFile(join(armDir, 'not-sent-initial-payload-mismatch.body.json'), raw, { flag: 'wx', mode: 0o600 });
              throw new ContractError('summary_replay_initial_payload_controls_mismatch_before_network');
            }
            let bodyFile: string | null = null;
            if (!captures.length || hasPacket && !contextSaved) {
              bodyFile = !captures.length ? 'first-actual-request.body.json' : 'first-candidate-context-request.body.json';
              await writeFile(join(armDir, bodyFile), raw, { flag: 'wx', mode: 0o600 }); if (hasPacket) contextSaved = true;
            }
            captures.push({ index: captures.length, payload_sha256: hash(raw), bytes: Buffer.byteLength(raw), candidate_packet_visible: hasPacket, body_file: bodyFile });
            return guarded(input, init);
          };
        };
        try {
          let finalResponse: Awaited<ReturnType<typeof promptExtractionSession>> | undefined;
          for (let attempt = 0; attempt <= auth.limits.transient_retries; attempt++) {
            budget.check();
            if (attempt) tools = new ExtractionSummaryTools({ input: cohort.input, metadata: cohort.metadata, document, catalog: plan.config.catalog },
              buildArticleScope(document), store, 'baseline', [], cohort.selection);
            const session = await createExtractionSession(config, developmentProfile(plan.config.model.model_id, plan.config.model.api), definitions(),
              join(armDir, 'attempt-' + attempt), budget, manifest.replay_id + ':' + id + ':' + arm, attempt, auth.limits.batch_responses);
            const previous = session.session.agent.finishTurn;
            session.session.agent.finishTurn = async (turn, signal) => { const decision = await previous?.(turn, signal); return tools.completed ? { action: 'end' } : decision ?? undefined; };
            finalResponse = await promptExtractionSession(session, prompt, budget, controller.signal,
              Math.max(1, auth.limits.document_seconds * 1000 - (performance.now() - start)));
            tools.readBlocks.forEach(b => allReadBlocks.add(b)); allIssues.push(...tools.issues);
            attemptReports.push({ attempt, completed: !finalResponse.error && tools.completed, response: finalResponse,
              request_ids: session.entries.map(e => e.id), read_block_ids: [...tools.readBlocks] });
            if (!finalResponse.error && tools.completed) break;
            if (!finalResponse.transient_error || budget.ledger.halted || controller.signal.aborted || attempt === auth.limits.transient_retries)
              throw new ContractError(finalResponse.error?.code ?? 'summary_replay_summary_incomplete');
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          }
          if (!finalResponse || !tools.completed) throw new ContractError('summary_replay_summary_incomplete');
          const requests = budget.ledger.requests.slice(startRequest);
          captures.forEach((c, i) => { c.actual_ledger_request_id = requests[i]?.payload_sha256 === c.payload_sha256 ? requests[i]!.id : null; });
          if (!observedPacket || !contextSaved || !captures.some(c => c.candidate_packet_visible && c.actual_ledger_request_id)) throw new ContractError('summary_replay_candidate_packet_not_observed_in_actual_request');
          const first = JSON.parse(await readFile(join(armDir, 'first-actual-request.body.json'), 'utf8'));
          if (arm === 'before') assert.equal(hash(await readFile(join(armDir, 'first-actual-request.body.json'))), cohort.baseline_first_request_sha256,
            'fresh control initial actual request must match the original recorded initial-payload SHA');
          const delivery = buildEvidenceDelivery(document, store.current(cohort.input.run_id), figures); deliveries[arm] = delivery;
          const exported = await exportEvidenceDelivery(document, store.current(cohort.input.run_id), { codeRoot: code, directory: join(armDir, 'candidate-export'),
            mode: 'candidates', catalog: figures, coverage: { inherited_batch_coverage: cohort.inherited_batch_coverage,
              experimental_summary_only_replay: true, summary_reread_never_completes_omitted_blocks: true } });
          assert.deepEqual(exported.delivery, delivery);
          arms[arm] = { arm, completed: true, actual_payload_control_sha256: hash(JSON.stringify(neutralInitialPayload(first, prompt))),
            packet_sha256: hash(observedPacket), actual_candidate_packet_visible: true,
            requests: requests.length, input_tokens: requests.reduce((n, r) => n + (r.input_tokens ?? r.input_ceiling), 0),
            output_tokens: requests.reduce((n, r) => n + (r.output_tokens ?? r.output_ceiling), 0),
            seconds: (performance.now() - start) / 1000, reread_blocks: [...allReadBlocks],
            omitted_reread_blocks: [...allReadBlocks].filter(b => !cohort.selection.kept_block_ids.includes(b)),
            source_checks_passed: true, output_count: allDeliveredRecords(delivery).length, ...deliveryRecordCounts(delivery), changes_from_same_pre_summary: deliveredContentDiff(pre, delivery),
            summary: tools.summary, context_issues: allIssues, attempts: attemptReports, capture_files: captures, request_accounting: requests,
            inherited_batch_coverage: cohort.inherited_batch_coverage, original_batch_results_modified: false,
            actual_human_reviewed_count: 0, medical_quality_approved: false, actual_cost: null, cost_status: 'unknown_gateway_billing' };
          await save(join(armDir, 'result.json'), { ...arms[arm], versions: store.versions(cohort.input.run_id) }, true);
        } catch (cause) { failure = safeError(cause); await save(join(armDir, 'failure.json'), { error: failure, captures, traces,
          requests: budget.ledger.requests.slice(startRequest), original_batch_unchanged: true }, true); throw cause; }
        finally { budget.guardedFetch = originalGuard; await save(join(armDir, 'read-trace.json'), { reads: traces, error: failure ?? null }, true); store.close(); }
        process.stdout.write(JSON.stringify({ job_id: id, arm, completed: true, requests: arms[arm].requests, input_tokens: arms[arm].input_tokens,
          output_tokens: arms[arm].output_tokens, reread: arms[arm].reread_blocks.length, omitted_reread: arms[arm].omitted_reread_blocks.length,
          seconds: arms[arm].seconds, shared_totals: budget.totals() }) + '\n');
      }
      assert.equal(arms.before.actual_payload_control_sha256, arms.after.actual_payload_control_sha256);
      assert.equal(arms.before.packet_sha256, arms.after.packet_sha256);
      const report = { schema_version: 'summary-reread-pair-result-1', replay_id: manifest.replay_id, job_id: id,
        single_variable: manifest.single_variable, actual_payload_controls_equal: true, candidate_packet_sha_equal: true,
        mechanical_source_checks_passed: true, before: arms.before, after: arms.after,
        content_changes_after_vs_before: deliveredContentDiff(deliveries.before!, deliveries.after!),
        scope: manifest.mode, cumulative_totals: budget.totals(), authorization_id: auth.authorization_id,
        limitation: 'One stochastic fresh pair; timing and supplier caching may vary. This is stage-only cost/mechanical evidence, not general performance, medical quality, or a winner.',
        ...(budget instanceof SummaryTimeBudget ? { time_window_extension: budget.timeWindowEvidence() } : {}),
        actual_human_reviewed_count: 0, medical_quality_approved: false, winner: null };
      await save(join(pairDir, 'pair-report.json'), report, true); results.push({ job_id: id, path: relative(code, join(pairDir, 'pair-report.json')) });
    }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await unlink(lockPath); }
  process.stdout.write(JSON.stringify({ completed_pairs: results, shared_totals: budget.totals(), medical_quality_approved: false, winner: null }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
