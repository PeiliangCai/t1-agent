import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ContractError, type EvidenceVersion, type FigureAssetCatalog } from '@t1/contracts';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { assertLivePdfSource } from '../packages/agent/src/figure-assets.js';
import { allDeliveredRecords, deliveryRecordCounts, buildEvidenceDelivery, evidenceDigest, exportEvidenceDelivery, type EvidenceDelivery } from '../packages/agent/src/evidence-delivery.js';
import { safeError } from '../packages/agent/src/config.js';
import type { ExtractionDocument } from '../packages/agent/src/article-scope.js';
import { COMPARISON_PLAN_SCHEMA } from '../packages/agent/src/method-comparison.js';

interface Job { job_id: string; condition: string; label: string; document_id: string; source_selection_digest: string;
  model_source_input_sha256: string; representative_job_id: string | null; independent_model_run: boolean;
  selection?: { kept_block_ids: string[]; deferred_block_ids: string[]; excluded_block_ids: string[];
    entries: Array<{ block_id: string; physical_page: number; state: string; rule_ids: string[]; reasons: string[] }> } }
interface RunRow { job_id: string; result_path?: string; representative_job_id?: string; independent_model_run: boolean;
  task_processing_complete?: boolean | null; coverage?: unknown;
  requests?: number; input_tokens_including_conservative_missing_usage?: number;
  output_tokens_including_reasoning_or_missing_usage_reservation?: number; seconds?: number; state?: string; error?: unknown }
interface PreparedPaper { document_id: string; pdf_path: string; pdf_sha256: string; ir_path: string; ir_sha256: string;
  figure_catalog_path: string; figure_catalog_sha256: string; assets: Record<string, string>;
  methods: { jobs: Job[] } }
interface Prepared { schema_version?: string; batch_id: string; config: { model: { model_id: string; reasoning_effort: string } };
  source_hashes: Record<string, string>; papers: PreparedPaper[] }

/** Old reports have no task-scope completion claim. Keep that absence explicit. */
export function comparisonCompletion(value: { task_processing_complete?: unknown; coverage?: unknown }) {
  const c = value.coverage && typeof value.coverage === 'object' ? value.coverage as Record<string, unknown> : {};
  const boolean = (v: unknown) => typeof v === 'boolean' ? v : null;
  const count = (v: unknown) => Array.isArray(v) ? v.length : null;
  return { task_processing_complete: boolean(value.task_processing_complete) ?? boolean(c.task_processing_complete),
    task_scope_source_block_processing_complete: boolean(c.task_scope_source_block_processing_complete),
    task_scope_source_blocks: typeof c.task_scope_source_blocks === 'number' ? c.task_scope_source_blocks : null,
    f_unselected_source_blocks: count(c.f_unselected_source_block_ids),
    shared_bibliography_excluded_source_blocks: count(c.shared_bibliography_excluded_source_block_ids),
    source_text_layer_decode_complete: boolean(c.source_text_layer_decode_complete),
    image_text_unverified_pages: count(c.image_text_unverified_pages) };
}

/** Presentation follows the saved plan; reading a legacy report never upgrades its experiment. */
export function comparisonPresentation(plan: { schema_version?: string;
  papers: Array<{ methods: { jobs: Array<Pick<Job, 'job_id' | 'condition' | 'representative_job_id'>> } }> }) {
  const jobs = plan.papers.flatMap(p => p.methods.jobs), conditions = [...new Set(jobs.map(j => j.condition))];
  const countLabel = conditions.length === 2 ? '两' : conditions.length === 3 ? '三' : String(conditions.length);
  const reused = jobs.filter(j => j.representative_job_id).map(j => `${j.job_id}复用${j.representative_job_id}`);
  return { conditions, logical_method_count: conditions.length, title: countLabel + '方案',
    report_schema_version: plan.schema_version === COMPARISON_PLAN_SCHEMA ? 'two-method-automatic-comparison-1' : 'three-method-automatic-comparison-1',
    reuse_explanation: reused.length ? reused.join('；') + '。复用条件引用同一代表结果的成本耗时，非独立测量；0新增请求不能解释为零成本策略收益。' :
      '当前计划没有相同输入复用；是否实际测量见运行状态。' };
}

/** Method attribution and total billing are separate: reuse inherits its representative measurement. */
export function comparisonMeasurement(job: Job, actual: RunRow[], auditedCounts: Record<string, number> = {}) {
  const own = actual.find(r => r.job_id === job.job_id);
  if (!own) return { job_id: job.job_id, condition: job.condition, label: job.label, document_id: job.document_id,
    ...comparisonCompletion({}),
    status: 'not_run', state: null, independent_measurement: false, representative_job_id: job.representative_job_id, candidate_count: null,
    method_requests: null, method_input_tokens: null, method_output_tokens: null, method_seconds: null, additional_physical_requests: 0 };
  const representativeId = job.representative_job_id ?? job.job_id;
  const representative = actual.find(r => r.job_id === representativeId);
  if (!representative || representative.independent_model_run !== true) throw new ContractError('comparison_reuse_missing_unique_representative');
  return { job_id: job.job_id, condition: job.condition, label: job.label, document_id: job.document_id,
    ...comparisonCompletion(representative),
    status: job.representative_job_id ? 'reused_not_independently_measured' : 'actual_unique_input_measured',
    independent_measurement: job.representative_job_id === null, representative_job_id: representativeId,
    representative_result_path: representative.result_path ?? null, state: representative.state ?? null,
    candidate_count: auditedCounts[representativeId] ?? null, method_requests: representative.requests ?? null,
    method_input_tokens: representative.input_tokens_including_conservative_missing_usage ?? null,
    method_output_tokens: representative.output_tokens_including_reasoning_or_missing_usage_reservation ?? null,
    method_seconds: representative.seconds ?? null, additional_physical_requests: job.representative_job_id ? 0 : representative.requests ?? null,
    actual_cost: null, cost_status: 'unknown_gateway_billing', human_effective_description_count: null,
    actual_human_reviewed_count: 0, quality_approved: false, reuse_is_not_a_zero_cost_efficiency_gain: Boolean(job.representative_job_id) };
}
export function ledgerAccounting(requests: Array<Record<string, any>>) {
  return { physical_requests: requests.length, settled_requests: requests.filter(r => r.finished_at).length,
    input_tokens_including_cache_and_missing_usage_reservation: requests.reduce((n, r) => n + (r.input_tokens ?? r.input_ceiling), 0),
    output_tokens_including_reasoning_and_missing_usage_reservation: requests.reduce((n, r) => n + (r.output_tokens ?? r.output_ceiling), 0),
    cache_read_tokens_included_in_input: requests.reduce((n, r) => n + (r.cache_read_tokens ?? 0), 0),
    reasoning_tokens_subset_already_in_output: requests.reduce((n, r) => n + (r.reasoning_tokens ?? 0), 0),
    missing_usage_requests: requests.filter(r => r.usage_status !== 'provider_reported').length,
    response_model_status_counts: Object.fromEntries([...new Set(requests.map(r => r.response_model_identity_status ?? 'unknown'))]
      .map(s => [s, requests.filter(r => (r.response_model_identity_status ?? 'unknown') === s).length])),
    total_is_not_sum_of_method_rows: true, actual_cost: null, cost_status: 'unknown_gateway_billing' };
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const countBy = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(k => [k, values.filter(v => v === k).length]));

async function main() {
  const args = process.argv.slice(2), flags = new Map<string, string>();
  if (args[0] === '--help') { process.stdout.write('audit-method-comparison.ts --directory PREPARED_COMPARISON --output NEW_DIRECTORY\nOffline source/Figure audit, candidate exports and non-independent-reuse-aware comparison; never makes a model call or approves evidence.\n'); return; }
  for (let i = 0; i < args.length; i += 2) {
    if (!['--directory', '--output'].includes(args[i]!) || !args[i + 1] || flags.has(args[i]!)) throw new ContractError('comparison_audit_arguments_invalid');
    flags.set(args[i]!, args[i + 1]!);
  }
  if (flags.size !== 2) throw new ContractError('comparison_audit_directory_and_output_required');
  const code = await realpath(process.cwd()), directory = await realpath(resolve(flags.get('--directory')!)), output = resolve(flags.get('--output')!);
  const inside = async (path: string) => { const p = await realpath(resolve(code, path)), rel = relative(code, p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('comparison_audit_path_outside_code'); return p; };
  await inside(directory); await inside(dirname(output));
  const planBytes = await readFile(join(directory, 'plan.json')), plan = JSON.parse(planBytes.toString('utf8')) as Prepared;
  const presentation = comparisonPresentation(plan);
  const authorization = await json(join(directory, 'authorization.json'));
  assert.equal(authorization.prepared_plan_sha256, hash(planBytes)); assert.equal(authorization.status, 'authorized');
  const execution = join(directory, 'execution'), run = await json(join(execution, 'report.json')) as { status: string; jobs: RunRow[] };
  const owner = await json(join(execution, 'budget-owner.json')), ledger = await json(await inside(owner.ledger));
  assert.equal(ledger.authorization.id, authorization.authorization_id); assert.deepEqual(ledger.limits, authorization.limits);
  for (const [path, expected] of Object.entries(plan.source_hashes)) {
    if (hash(await readFile(join(execution, 'source-snapshot', path))) !== expected) throw new ContractError('comparison_runtime_snapshot_changed');
  }
  await mkdir(output, { recursive: false, mode: 0o700 });
  const audits: Array<Record<string, any>> = [], deliveries = new Map<string, { delivery: EvidenceDelivery; paper: PreparedPaper; exportDirectory: string }>();
  const errors: Array<Record<string, unknown>> = [], counts: Record<string, number> = {};
  for (const paper of plan.papers) {
    for (const [path, expected] of [[paper.pdf_path, paper.pdf_sha256], [paper.ir_path, paper.ir_sha256],
      [paper.figure_catalog_path, paper.figure_catalog_sha256], ...Object.entries(paper.assets)]) {
      if (hash(await readFile(await inside(path!))) !== expected) throw new ContractError('comparison_audit_source_or_asset_changed');
    }
    const parsed = await json(await inside(paper.ir_path)), document = parsed.document as ExtractionDocument;
    assertParsedDocument(document); await assertLivePdfSource(document);
    const figures = await json(await inside(paper.figure_catalog_path)) as FigureAssetCatalog;
    for (const job of paper.methods.jobs.filter(j => j.independent_model_run)) {
      const entry = run.jobs.find(r => r.job_id === job.job_id); if (!entry?.result_path) continue;
      try {
        const result = await json(await inside(entry.result_path)), versions = result.versions as EvidenceVersion[];
        if (!Array.isArray(versions) || result.document_id !== paper.document_id || result.model_id !== plan.config.model.model_id ||
          result.reasoning_effort !== plan.config.model.reasoning_effort || result.source_selection_digest !== job.source_selection_digest) throw new ContractError('comparison_audit_result_identity_mismatch');
        for (const v of versions) if (v.record.extraction_trace.run_id !== result.run_id || v.record.extraction_trace.fixture) throw new ContractError('comparison_audit_record_run_mismatch');
        const delivery = buildEvidenceDelivery(document, versions, figures), exportDirectory = join(output, job.job_id + '-candidates');
        const exported = await exportEvidenceDelivery(document, versions, { codeRoot: code, directory: exportDirectory,
          mode: 'candidates', catalog: figures, coverage: result.coverage });
        assert.deepEqual(exported.delivery, delivery); counts[job.job_id] = allDeliveredRecords(delivery).length;
        deliveries.set(job.job_id, { delivery, paper, exportDirectory });
        const records = versions.filter(v => v.status !== 'proposed');
        const current = new Map(records.map(v => [v.record.record_id, v]));
        const exactSets = new Set(allDeliveredRecords(delivery).map(r => evidenceDigest({ source: r.original_fragments, context: r.context_fragments })));
        const events = (result.events ?? []) as Array<{ type: string; detail: unknown }>;
        const rejected = events.filter(e => ['candidate_validation_rejected', 'tool_rejected', 'protocol_diagnostic_pause'].includes(e.type));
        rejected.forEach(e => errors.push({ job_id: job.job_id, category: e.type, detail: e.detail, medical_adjudication: 'not_performed' }));
        const audit = { job_id: job.job_id, run_id: result.run_id, source_file_sha256: document.file_sha256, text_version: document.text_version,
          automatic_source_and_asset_checks_passed: true, authority: 'exact_bound_IR_plus_actual_PDF_and_asset_hash_not_human_PDF_fidelity',
          output_count: allDeliveredRecords(delivery).length, ...deliveryRecordCounts(delivery),
          primary_assessment_policy_version: delivery.primary_assessment_policy_version ?? null,
          exact_fragment_set_count: exactSets.size, exact_sets_are_not_medically_effective_count: true,
          record_automatic_check_states: countBy([...current.values()].map(v => v.record.evidence_validation.automatic_checks.status)),
          figure_associations: countBy(allDeliveredRecords(delivery).map(r => r.figure_association.status)),
          selected_processing_complete: result.coverage.selected_source_block_processing_complete,
          whole_document_summary_complete: result.coverage.whole_document_summary_complete,
          full_source_processing_complete: result.coverage.source_block_processing_complete,
          ...comparisonCompletion(result),
          state: result.state, error: result.error ?? null, coverage: result.coverage,
          diagnostic_or_rejection_events: rejected.length, source_pdf_human_fidelity_checked: false,
          human_reviewed_count: 0, unreviewed_count: allDeliveredRecords(delivery).length, human_effective_description_count: null,
          medical_quality_approved: false, candidate_export: relative(code, exportDirectory) };
        audits.push(audit);
        await writeFile(join(exportDirectory, 'human-review-preparation.json'), JSON.stringify({ schema_version: 'comparison-human-review-preparation-1',
          selected_sample_count: null, formal_sample_count: null, actual_human_reviewed_count: 0, selection_method: null,
          status: 'all_outputs_indexed_for_later_real_human_sample_selection', reviewer: null, reviewed_at: null,
          full_reference_answer_required: false, records: allDeliveredRecords(delivery).map(r => ({ record_id: r.record_id, record_version: r.record_version,
            delivery_fingerprint: r.delivery_fingerprint, original_pages: [...new Set(r.original_fragments.map(f => f.physical_page))],
            figure_status: r.figure_association.status, primary_assessment: r.primary_assessment ?? null,
            relevance: 'not_checked', context: 'not_checked', source_pdf_fidelity: 'not_checked',
            figure_pairing_and_completeness: 'not_checked' })) }, null, 2) + '\n', { flag: 'wx' });
      } catch (cause) { errors.push({ job_id: job.job_id, category: 'automatic_source_or_export_audit_failed', error: safeError(cause), medical_adjudication: 'not_performed' }); }
    }
  }
  const rows = plan.papers.flatMap(p => p.methods.jobs.map(j => {
    const row = comparisonMeasurement(j, run.jobs, counts), audit = audits.find(a => a.job_id === (j.representative_job_id ?? j.job_id));
    return { ...row, parser_status: audit?.coverage.parser_status ?? null,
      primary_assessment_policy_version: audit?.primary_assessment_policy_version ?? null,
      primary_candidate_count: audit?.primary_candidate_count ?? null, background_suggestion_count: audit?.background_suggestion_count ?? null,
      ...(audit ? comparisonCompletion(audit) : {}),
      selected_source_block_processing_complete: audit?.selected_processing_complete ?? null,
      whole_document_summary_complete: audit?.whole_document_summary_complete ?? null,
      full_source_block_processing_complete: audit?.full_source_processing_complete ?? null,
      full_document_extraction_completed: audit?.coverage.full_document_extraction_completed ?? null,
      input_selected_blocks: j.selection?.kept_block_ids.length ?? null,
      input_deferred_blocks: j.selection?.deferred_block_ids.length ?? null,
      input_excluded_blocks: j.selection?.excluded_block_ids.length ?? null,
      input_omissions_are_not_completed: true };
  }));
  const accounting = ledgerAccounting(ledger.requests), report = { schema_version: presentation.report_schema_version, recorded_at: new Date().toISOString(),
    method_conditions: presentation.conditions, logical_method_count: presentation.logical_method_count,
    batch_id: plan.batch_id, execution_status: run.status, authorization_id: authorization.authorization_id,
    started_at: ledger.experiment_started_at, halted: ledger.halted, limits: ledger.limits, accounting, rows, automatic_audits: audits,
    error_case_count: errors.length, actual_human_reviewed_count: 0, medical_quality_approved: false, winner: null, stage_passed: false,
    cost_rule: 'Reuse rows inherit the same representative cost/time, are not independent measurements, and never imply a zero-cost win. Total ledger counts real requests once.',
    quality_rule: 'Candidates/automatic exact-source checks are not precision or recall. Human relevance/context/original-PDF/Figure checking and thresholds remain pending.' };
  await writeFile(join(output, 'comparison.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(output, 'error-cases.json'), JSON.stringify({ schema_version: 'comparison-error-cases-1', cases: errors,
    medical_errors_adjudicated: false, full_reference_answer_required: false }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(output, 'input-selection-inventory.json'), JSON.stringify({ schema_version: 'comparison-input-selection-inventory-1',
    original_pdf_changed: false, rule_omissions_are_not_completed: true, medical_rules_approved: false,
    methods: plan.papers.flatMap(p => p.methods.jobs.map(j => ({ document_id: p.document_id, job_id: j.job_id,
      condition: j.condition, representative_result: j.representative_job_id, source_selection_digest: j.source_selection_digest,
      model_source_input_sha256: j.model_source_input_sha256, selection: j.selection ?? null }))) }, null, 2) + '\n', { flag: 'wx' });
  const columns = ['job_id', 'label', 'status', 'representative_job_id', 'state', 'parser_status', 'selected_source_block_processing_complete',
    'task_processing_complete', 'task_scope_source_block_processing_complete', 'task_scope_source_blocks', 'f_unselected_source_blocks',
    'shared_bibliography_excluded_source_blocks', 'source_text_layer_decode_complete', 'image_text_unverified_pages',
    'whole_document_summary_complete', 'full_source_block_processing_complete', 'input_selected_blocks', 'input_deferred_blocks', 'input_excluded_blocks',
    'candidate_count', 'primary_candidate_count', 'background_suggestion_count', 'primary_assessment_policy_version',
    'method_requests', 'method_input_tokens', 'method_output_tokens', 'method_seconds', 'additional_physical_requests'];
  const csv = (v: unknown) => '"' + String(v ?? '').replace(/"/gu, '""') + '"';
  await writeFile(join(output, 'comparison.csv'), '\ufeff' + columns.join(',') + '\n' + rows.map(r => columns.map(c => csv((r as Record<string, unknown>)[c])).join(',')).join('\n') + '\n', { flag: 'wx' });
  const rowHtml = rows.map(r => `<tr><td>${esc(r.job_id)}</td><td>${esc(r.label)}</td><td>${esc(r.status)}</td><td>${esc(r.representative_job_id)}</td><td>${esc(r.state)}</td><td>${esc(r.parser_status)}</td><td>${esc(r.selected_source_block_processing_complete)}</td><td>${esc(r.task_processing_complete)}</td><td>${esc(r.task_scope_source_blocks)}</td><td>${esc(r.f_unselected_source_blocks)}</td><td>${esc(r.full_source_block_processing_complete)}</td><td>${esc(r.candidate_count)}</td><td>${esc(r.method_requests)}</td><td>${esc(r.method_input_tokens)}</td><td>${esc(r.method_output_tokens)}</td><td>${esc(r.method_seconds)}</td></tr>`).join('');
  const detailHtml = [...deliveries].map(([jobId, { delivery, paper, exportDirectory }]) => {
    const pdf = encodeURI(relative(output, resolve(code, paper.pdf_path)));
    return `<section><h2>${esc(jobId)}：${allDeliveredRecords(delivery).length} 条未审核候选</h2><p><a href="${esc(relative(output, join(exportDirectory, 'human-review-preparation.json')))}">待抽查条目索引</a></p>` + allDeliveredRecords(delivery).map(r => {
      const figures = delivery.figures.filter(f => r.figure_association.proposed_figure_ids.includes(f.figure_id));
      return `<details><summary>${esc(r.record_id)} · ${r.primary_assessment?.effective_role === 'background_suggestion' ? '仅背景建议，未人工确认' : '主目标候选，待核'} · 配图 ${esc(r.figure_association.status)}</summary>` +
        r.original_fragments.map((f, i) => `<p>原文片段 ${i + 1} · <a href="${esc(pdf)}#page=${f.physical_page}">原PDF第${f.physical_page}页</a> · [${f.start},${f.end})</p><pre>${esc(f.exact_quote)}</pre>`).join('') +
        (r.context_fragments.length ? '<h3>独立保存的必要上下文</h3>' + r.context_fragments.map(f => `<pre>${esc(f.exact_quote)}</pre>`).join('') : '') +
        figures.map(f => `<h3>Figure ${esc(f.figure_number)} · ${esc(f.verification.status)} · 未经人工批准</h3>` +
          f.caption_segments.map(c => `<pre>${esc(c.exact_quote)}</pre>`).join('') + f.regions.map(a => `<p>原图资产：<a href="${esc(encodeURI(relative(output, resolve(code, a.path))))}">${esc(a.asset_id)}</a></p>`).join('')).join('') + '</details>';
    }).join('') + '</section>';
  }).join('');
  await writeFile(join(output, 'review.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>T1${esc(presentation.title)}真实输出抽查材料</title><style>body{font:16px/1.6 system-ui;margin:28px;max-width:1500px}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:8px}pre{white-space:pre-wrap;background:#f5f5f5;padding:12px}details{border:1px solid #ddd;padding:10px;margin:12px 0}summary{cursor:pointer}h3{font-size:16px}</style><h1>${esc(presentation.title)}自动来源审计与待抽查输出</h1><p>本页所有候选均未人工审核。自动原文定位不等于医学质量通过；没有完整召回、准确率或赢家结论。抽样数量及正式门槛待共同确定。运行状态、本次选中输入处理及汇总、任务范围和原PDF限制分别记录；共同明确书目在本次范围之外，F未选块另列且不算已处理。选中处理完成不代表图内文字已OCR或医学通过；历史运行缺少新字段时留空，<a href="input-selection-inventory.json">块清单及规则理由</a>可逐项查看。</p><p>${esc(presentation.reuse_explanation)}总账真实请求${accounting.physical_requests}次，含预留输入${accounting.input_tokens_including_cache_and_missing_usage_reservation}，输出${accounting.output_tokens_including_reasoning_and_missing_usage_reservation}，实际账单未知。</p><table><thead><tr><th>条件</th><th>方法</th><th>测量状态</th><th>代表来源</th><th>运行状态</th><th>解析状态</th><th>已选块处理完成</th><th>本次选中处理及汇总完成</th><th>任务范围原始块</th><th>F未选原始块</th><th>全部原始源块处理完成</th><th>未审核候选</th><th>归属请求</th><th>归属输入token</th><th>归属输出token</th><th>归属秒数</th></tr></thead><tbody>${rowHtml}</tbody></table>${detailHtml}</html>\n`, { flag: 'wx' });
  process.stdout.write(JSON.stringify({ output: relative(code, output), audited_unique_jobs: audits.length, logical_rows: rows.length,
    candidates: Object.values(counts).reduce((a, b) => a + b, 0), error_cases: errors.length, actual_human_reviewed: 0, paid_calls_by_this_audit: 0, winner: null }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
