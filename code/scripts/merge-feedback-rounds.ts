/** Assemble two immutable actual rounds for review. No model call or source rewriting. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';
import { ledgerAccounting } from './audit-method-comparison.js';
import { comparisonBudgetOwner } from '../packages/agent/src/experiment-authorization.js';
const code = resolve(import.meta.dirname, '..'), root = resolve(code, 'docs/acceptance/user-feedback-2026-11-05/revalidation');
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const rel = (p: string) => relative(code, p), artifacts = new Map<string, string>();
async function bind(path: string, wanted?: string) { const actual = sha(await readFile(resolve(code, path))); if (wanted) assert.equal(actual, wanted, path); artifacts.set(path, actual); return actual; }
const descriptors = [{ round_id: 'round1', label: '修复流程首次真实复验（保留当时CTR实际候选）', directory: root,
  rule_note: '当时计算定义边界待确认；用户现已确认仅可作必要背景。13条真实候选和首次失败/重试完整保留，不转为当前独立交付批准。' },
{ round_id: 'round2', label: '最新：计算定义仅必要背景的单项prompt复验', directory: resolve(root, 'metric-context-revision'),
  rule_note: '公共system只新增测量指标/计算定义不得独立主描述的规则；一般形态定义及直接尺寸/CT值保留。证据schema、validator、工具、选块、其他语义策略未变。' }];
const rounds: any[] = [], jobs: any[] = [], records: any[] = [], issues = new Map<string, any>(), figures = new Map<string, any>(), freeze: any[] = [], reports: any[] = [];
let sharedUsage: any;
const isFormula = (text: string) => /CTR\s+(?:was|is)\s+calculated\s+as/iu.test(text);
for (const d of descriptors) {
  const manifestPath = resolve(d.directory, 'reader-manifest.json'), manifest = await json(manifestPath);
  const planPath = resolve(d.directory, 'prepared/plan.json'), plan = await json(planPath), sourceRoot = resolve(d.directory, 'prepared/execution/source-snapshot');
  await bind(rel(manifestPath)); await bind(rel(planPath)); await bind(rel(resolve(d.directory, 'authorization.json')));
  await bind(rel(resolve(d.directory, 'final-audit/report.json')));
  for (const a of manifest.source_artifacts) {
    // Current source may legitimately be at the child revision. Each historical round
    // is proven against its saved actual execution source bytes, never today's code.
    const path = Object.hasOwn(plan.source_hashes, a.path) ? rel(resolve(sourceRoot, a.path)) : a.path;
    await bind(path, a.sha256);
  }
  for (const [p, h] of Object.entries(plan.source_hashes)) await bind(rel(resolve(sourceRoot, p)), h as string);
  freeze.push({ round_id: d.round_id, plan_path: rel(planPath), source_root: rel(sourceRoot) });
  const prefix = (id: string) => d.round_id + ':' + id;
  for (const j of manifest.jobs) jobs.push({ ...j, round_id: d.round_id, actual_job_id: j.job_id, job_id: prefix(j.job_id),
    attempts: j.attempts.map((a: any) => ({ ...a, ...(a.partial_records ? { partial_records: a.partial_records.map((r: any) => ({ ...r, round_id: d.round_id, actual_job_id: r.job_id, job_id: prefix(r.job_id) })) } : {}) })),
    ...(j.reused_from_job_id ? { reused_from_job_id: prefix(j.reused_from_job_id) } : {}) });
  for (const source of manifest.records) {
    const r = structuredClone(source), text = r.original_groups.flatMap((g: any) => g.segments).map((s: any) => s.exact_quote).join('\n');
    r.round_id = d.round_id; r.actual_job_id = r.job_id; r.job_id = prefix(r.job_id);
    r.automatic_checks = r.automatic_checks.filter((c: any) => c.code !== 'business_or_visual_purpose_pending' || !/业务取舍待定|是否可独立收录/gu.test(c.detail));
    r.semantic_review_notes = (r.semantic_review_notes ?? []).filter((s: string) => !/业务取舍待定|是否可独立收录/gu.test(s));
    if (isFormula(text)) {
      r.current_scope_disposition = 'context_only_not_independent_delivery';
      r.automatic_checks.push({ code: 'confirmed_metric_definition_context_only', status: 'pending', detail: '用户已确认：计算指标定义仅作必要背景，不独立交付。此条实际输出原样保留；旧轮属于原边界产物，若最新轮仍出现则须如实指出未遵从。' });
    }
    records.push(r);
  }
  for (const f of manifest.figures) {
    if (figures.has(f.figure_id)) assert.deepEqual(figures.get(f.figure_id), f); else figures.set(f.figure_id, f);
  }
  for (const i of manifest.issues) {
    const prior = issues.get(i.old_item_id);
    if (!prior) issues.set(i.old_item_id, { ...i, source_links: i.source_links.map((l: any) => ({ ...l, round_id: d.round_id })),
      round_observations: { [d.round_id]: i.automatic_observations } });
    else {
      assert.equal(prior.old_note, i.old_note);
      prior.new_record_ids.push(...i.new_record_ids); prior.new_record_ids = [...new Set(prior.new_record_ids)];
      prior.source_links.push(...i.source_links.map((l: any) => ({ ...l, round_id: d.round_id })));
      prior.round_observations[d.round_id] = i.automatic_observations;
      prior.relation = prior.new_record_ids.length ? 'source_overlap_only' : 'no_direct_match';
    }
  }
  const roundRecords = records.filter(r => r.round_id === d.round_id);
  const primaryFormula = roundRecords.filter(r => isFormula(r.original_groups.flatMap((g: any) => g.segments).map((s: any) => s.exact_quote).join('\n')));
  const contextFormula = roundRecords.filter(r => isFormula(r.context_groups.flatMap((g: any) => g.segments).map((s: any) => s.exact_quote).join('\n')));
  const rawReport = await json(resolve(d.directory, 'final-audit/report.json')); reports.push(rawReport);
  rounds.push({ round_id: d.round_id, label: d.label, rule_note: d.rule_note, finalized_at: manifest.finalized_at, usage_totals: manifest.usage_totals,
    actual_unique_inputs: manifest.jobs.filter((j: any) => j.independent_model_run).length, logical_conditions: manifest.jobs.length,
    actual_record_count: manifest.records.length, literal_CTR_definition_primary_records: primaryFormula.length,
    literal_CTR_definition_context_records: contextFormula.length, source_report_path: rel(resolve(d.directory, 'final-audit/report.json')),
    semantic_or_medical_success_inferred: false });
  sharedUsage = manifest.shared_usage_totals ?? manifest.usage_totals;
}
assert.equal(new Set(records.map(r => r.record_id)).size, records.length);
const auth = await json(resolve(root, 'authorization.json')), ledgerPath = comparisonBudgetOwner(auth.authorization_id) + '/call-ledger.json';
const ledger = await json(resolve(code, ledgerPath)), a = ledgerAccounting(ledger.requests);
const usage = { requests: a.physical_requests, input_tokens: a.input_tokens_including_cache_and_missing_usage_reservation,
  output_tokens: a.output_tokens_including_reasoning_and_missing_usage_reservation, actual_cost: null, cost_status: 'unknown_gateway_billing' };
assert.deepEqual(sharedUsage, usage);
for (const key of ['requests', 'input_tokens', 'output_tokens'] as const) assert.equal(jobs.reduce((n, j) => n + j[key], 0), usage[key]);
assert.equal(a.settled_requests, a.physical_requests);
const output = resolve(root, 'final-two-rounds'); await mkdir(output, { recursive: false });
await writeFile(resolve(output, 'shared-ledger-snapshot.json'), await readFile(resolve(code, ledgerPath)), { flag: 'wx' }); await bind(rel(resolve(output, 'shared-ledger-snapshot.json')));
await bind(rel(resolve(root, 'metric-context-confirmation.json'))); await bind(rel(resolve(root, 'metric-context-revision/prompt-change.json')));
const finalTime = new Date().toISOString();
const report = { schema_version: 'two-round-feedback-revalidation-audit-1', finalized_at: finalTime, authorization_id: auth.authorization_id,
  original_start: ledger.experiment_started_at, deadline_utc: new Date(Date.parse(ledger.experiment_started_at) + auth.limits.seconds * 1000).toISOString(),
  limits: auth.limits, usage_totals: usage, original_189_requests_unchanged: true, combined_historical_and_current_requests: 189 + usage.requests,
  rounds, jobs, source_audits: reports.map(r => ({ automatic_audits: r.automatic_audits, F_R_equivalence_checks: r.F_R_equivalence_checks })),
  business_rule_confirmation: '测量指标/计算方式仅作必要context，不独立交付；一般视觉形态定义和原文直接量值保留。',
  confirmed_CTR_primary_counts: rounds.map(r => ({ round_id: r.round_id, primary: r.literal_CTR_definition_primary_records, context: r.literal_CTR_definition_context_records })),
  interpretation: '以上是实际source-span/原文角色检查；不是医学准确率/召回率、单次输出的普遍保证或三方法赢家。诊断低估/小实性成分关联句仍待核。首轮多项修复不能单因素归因；父子轮设计仅一条system范围规则变化，未保存父轮全线上body，不能宣称所有实际payload仅此差异。',
  actual_human_or_medical_reviews_on_new_outputs: 0, old_feedback_inherited: false, medical_quality_approved: false, product_export_approved: false,
  stage_passed: false, winner: null, formal_reviews_used: 3, formal_review_limit: 3, owner_lock_present: false, unsettled_requests: 0 };
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); await bind(rel(resolve(output, 'report.json')));
const manifest = { schema_version: 'feedback-revalidation-reader-1', batch_id: reports.at(-1).batch_id, finalized_at: finalTime, actual_model_outputs: true,
  rounds, default_round_id: 'round2', freeze_plans: freeze, source_artifacts: [...artifacts].map(([path, sha256]) => ({ path, sha256 })),
  usage_totals: usage, jobs, records, figures: [...figures.values()], issues: [...issues.values()],
  papers: (await json(resolve(root, 'reader-manifest.json'))).papers, model: (await json(resolve(root, 'metric-context-revision/reader-manifest.json'))).model,
  medical_quality_approved: false, product_export_approved: false, stage_passed: false, old_feedback_inherited: false, winner: null,
  limitations: [report.interpretation, '父轮实际CTR定义依用户最新确认仅作背景，不从历史结果中删除；两轮失败和重试均计入同一预算。', '表格值的完整行列头和语义归属未自动推断。'] };
await writeFile(resolve(output, 'reader-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ report: rel(resolve(output, 'report.json')), manifest: rel(resolve(output, 'reader-manifest.json')),
  manifest_sha256: sha(await readFile(resolve(output, 'reader-manifest.json'))), usage_totals: usage, rounds }) + '\n');
