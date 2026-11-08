import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allDeliveredRecords, deliveryRecordCounts, type EvidenceDelivery } from '../packages/agent/src/evidence-delivery.js';
import { comparisonBudgetOwner } from '../packages/agent/src/experiment-authorization.js';
import { deliveredContentDiff, neutralInitialPayload } from './summary-reread-replay.js';
import { sha256 } from './lib/summary-time-window.js';

const read = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const count = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(v => [v, values.filter(x => x === v).length]));
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const table = (headers: string[], rows: unknown[][]) => '<div class="scroll"><table><thead><tr>' + headers.map(h => '<th>' + escape(h) + '</th>').join('') +
  '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => '<td>' + escape(cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
const number = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });
const changedFields = (before: Record<string, any>, after: Record<string, any>, excluded: string[] = []) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !excluded.includes(key) &&
    (Object.hasOwn(before, key) !== Object.hasOwn(after, key) || sha256(JSON.stringify(before[key] ?? null)) !== sha256(JSON.stringify(after[key] ?? null)))).map(field =>
      ({ field, before: Object.hasOwn(before, field) ? before[field] : { field_absent: true }, after: Object.hasOwn(after, field) ? after[field] : { field_absent: true } }));
function nestedChanges(before: any, after: any, path: string): Array<{ field: string; before: any; after: any }> {
  if (sha256(JSON.stringify(before ?? null)) === sha256(JSON.stringify(after ?? null))) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return changedFields(before, after).flatMap(c => nestedChanges(c.before, c.after, path + '.' + c.field));
  }
  return [{ field: path, before: before ?? null, after: after ?? null }];
}

/** Offline aggregation only: no model runtime, no budget instance, no rewriting baseline or pair evidence. */
async function main() {
  const [directoryArg, outputArg] = process.argv.slice(2);
  assert.ok(directoryArg && outputArg && process.argv.length === 4, 'replay directory and output prefix required');
  const code = process.cwd(), directory = resolve(directoryArg), output = resolve(outputArg);
  for (const p of [directory, output]) assert.ok(!relative(code, p).startsWith('..'), 'artifacts must stay under code/');
  const manifestBytes = await readFile(join(directory, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString('utf8'));
  const parent = join(code, manifest.parent_directory), baselineBytes = await readFile(join(parent, 'execution/report.json'));
  const baseline = JSON.parse(baselineBytes.toString('utf8')), authorization = await read(join(parent, 'authorization.json'));
  const owner = join(code, comparisonBudgetOwner(authorization.authorization_id));
  assert.equal(existsSync(join(owner, 'active-owner.lock')), false, 'wait for all paired execution to release its owner lock');
  const ledgerBytes = await readFile(join(owner, 'call-ledger.json')), ledger = JSON.parse(ledgerBytes.toString('utf8'));
  assert.equal(ledger.halted, null); assert.ok(ledger.requests.every((r: any) => r.finished_at && r.usage_status === 'provider_reported'));
  const currentById = new Map<string, any>(ledger.requests.map((r: any) => [r.id, r]));
  const timeGrant = await read(join(code, 'docs/acceptance/s0-s4-current-2026-11-04/summary-time-resume-authorization.json'));
  assert.equal(sha256(JSON.stringify(ledger.requests.slice(0, timeGrant.ledger_anchor.request_count))), timeGrant.ledger_anchor.requests_sha256);
  assert.equal(ledger.experiment_started_at, timeGrant.ledger_anchor.experiment_started_at);
  assert.deepEqual(ledger.limits, timeGrant.ledger_anchor.limits);
  for (const [p, hash] of Object.entries(manifest.baseline_runtime_source_hashes)) assert.equal(sha256(await readFile(join(code, p))), hash);
  const pairs: any[] = [], contextAndFieldRisks: any[] = [], requestIds = new Set<string>();
  for (const item of manifest.cohorts) {
    const cohortBytes = await readFile(join(directory, item.file)); assert.equal(sha256(cohortBytes), item.sha256);
    const cohort = JSON.parse(cohortBytes.toString('utf8'));
    assert.equal(sha256(await readFile(join(code, cohort.parent_result_path))), cohort.parent_result_sha256);
    assert.equal(sha256(await readFile(join(code, cohort.source.ir_path))), cohort.source.ir_sha256);
    assert.equal(sha256(await readFile(join(code, cohort.source.figure_catalog_path))), cohort.source.figure_catalog_sha256);
    const pairPath = join(directory, item.job_id, 'pair-report.json'), pairBytes = await readFile(pairPath), pair = JSON.parse(pairBytes.toString('utf8'));
    assert.ok(pair.actual_payload_controls_equal && pair.candidate_packet_sha_equal && pair.mechanical_source_checks_passed);
    const arms: Record<string, any> = {}, deliveries: Record<string, EvidenceDelivery> = {}, records: Record<string, Map<string, any>> = {};
    for (const arm of ['before', 'after'] as const) {
      const armPath = join(directory, item.job_id, arm), result = await read(join(armPath, 'result.json'));
      const delivery = await read(join(armPath, 'candidate-export/delivery.json')) as EvidenceDelivery;
      const audit = await read(join(armPath, 'candidate-export/sample-audit.json'));
      assert.ok(result.completed && result.source_checks_passed && result.actual_candidate_packet_visible);
      assert.equal(result.packet_sha256, item.packet_sha256);
      assert.equal(audit.sampled_count, 0); assert.equal(result.actual_human_reviewed_count, 0);
      const firstBytes = await readFile(join(armPath, 'first-actual-request.body.json'));
      const first = JSON.parse(firstBytes.toString('utf8'));
      assert.equal(sha256(JSON.stringify(neutralInitialPayload(first, arm === 'before' ? manifest.before_prompt : manifest.after_prompt))), result.actual_payload_control_sha256);
      if (arm === 'before') assert.equal(sha256(firstBytes), cohort.baseline_first_request_sha256);
      for (const request of result.request_accounting) {
        assert.equal(requestIds.has(request.id), false); requestIds.add(request.id);
        assert.deepEqual(request, currentById.get(request.id));
      }
      const versions = new Map<string, any>(result.versions.map((v: any) => [v.record.record_id + ':' + v.version, v.record]));
      records[arm] = new Map(allDeliveredRecords(delivery).map(r => [r.record_id, versions.get(r.record_id + ':' + r.record_version)]));
      assert.ok([...records[arm]!.values()].every(Boolean));
      const tools = result.attempts.flatMap((a: any) => a.response.events.filter((e: any) => e.type === 'tool_execution_end' && e.error).map((e: any) => e.tool));
      arms[arm] = { completed: true, first_request_at: result.request_accounting[0].started_at,
        last_request_finished_at: result.request_accounting.at(-1).finished_at,
        requests: result.requests, input_tokens: result.input_tokens, output_tokens: result.output_tokens,
        seconds: result.seconds, reread_blocks: result.reread_blocks.length, omitted_reread_blocks: result.omitted_reread_blocks.length,
        candidates: result.output_count, ...deliveryRecordCounts(delivery), review_status: count(allDeliveredRecords(delivery).map(r => r.review_status)),
        context_status: count([...records[arm]!.values()].map(r => r.context.status)),
        assertion_status: count([...records[arm]!.values()].map(r => r.assertion.value)),
        applicability_status: count([...records[arm]!.values()].map(r => r.applicability.status)),
        evidence_type: count([...records[arm]!.values()].map(r => r.evidence_type)),
        automatic_check_status: count([...records[arm]!.values()].map(r => r.evidence_validation.automatic_checks.status)),
        validation_issue_codes: count([...records[arm]!.values()].flatMap(r => (r.evidence_validation.issues ?? []).map((issue: any) => issue.code))),
        figure_association_status: count(allDeliveredRecords(delivery).map(r => r.figure_association.status)),
        automatic_context_issues: result.context_issues, recovered_tool_errors: count(tools),
        attempt_count: result.attempts.length, response_failures: result.attempts.filter((a: any) => a.response.error).length,
        request_failures: result.request_accounting.filter((r: any) => r.error_code || r.status !== 200).map((r: any) => ({ id: r.id, status: r.status, error_code: r.error_code ?? null })),
        response_model_status: count(result.request_accounting.map((r: any) => r.response_model_identity_status ?? 'unknown')),
        source_checks_passed: true, original_batch_coverage: result.inherited_batch_coverage,
        summary: result.summary, human_reviewed: 0, observed_medical_errors: null, medical_accuracy: null };
      deliveries[arm] = delivery;
    }
    const sourceDiff = deliveredContentDiff(deliveries.before!, deliveries.after!);
    assert.deepEqual(sourceDiff, pair.content_changes_after_vs_before);
    const commonIds = [...records.before!.keys()].filter(id => records.after!.has(id));
    const annotations = commonIds.map(id => {
      const before = records.before!.get(id), after = records.after!.get(id);
      return { record_id: id, changes: [...changedFields(before, after, ['extraction_trace']).flatMap(c => nestedChanges(c.before, c.after, c.field)),
        ...changedFields(before.extraction_trace, after.extraction_trace, ['read_block_ids', 'provided_block_ids', 'tool_call_ids'])
          .flatMap(c => nestedChanges(c.before, c.after, 'extraction_trace.' + c.field))] };
    }).filter(r => r.changes.length);
    const traceChanges = commonIds.map(id => {
      const changes = changedFields(records.before!.get(id).extraction_trace, records.after!.get(id).extraction_trace)
        .filter(c => ['read_block_ids', 'provided_block_ids', 'tool_call_ids'].includes(c.field));
      return { record_id: id, changes: changes.map(c => ({ field: 'extraction_trace.' + c.field,
        before_count: c.before.length, after_count: c.after.length, before_sha256: sha256(JSON.stringify(c.before)), after_sha256: sha256(JSON.stringify(c.after)) })) };
    }).filter(r => r.changes.length);
    const deliveryChanges = commonIds.map(id => ({ record_id: id, changes: changedFields(
      allDeliveredRecords(deliveries.before!).find(r => r.record_id === id)!, allDeliveredRecords(deliveries.after!).find(r => r.record_id === id)!,
      ['record_version', 'run_id', 'source_record_sha256', 'text_fingerprint', 'delivery_fingerprint', 'original_fragments', 'context_fragments', 'figure_association'])
    })).filter(r => r.changes.length);
    const derivedDeliveryChanges = commonIds.map(id => ({ record_id: id, changes: changedFields(
      allDeliveredRecords(deliveries.before!).find(r => r.record_id === id)!, allDeliveredRecords(deliveries.after!).find(r => r.record_id === id)!)
      .filter(c => ['record_version', 'run_id', 'source_record_sha256', 'text_fingerprint', 'delivery_fingerprint'].includes(c.field))
    })).filter(r => r.changes.length);
    const changedIds = new Set([...sourceDiff.original_fragment_changes, ...sourceDiff.context_fragment_changes, ...sourceDiff.figure_association_changes]);
    const changedSourceRecords = [...changedIds].map(id => ({ record_id: id,
      before: allDeliveredRecords(deliveries.before!).find(r => r.record_id === id), after: allDeliveredRecords(deliveries.after!).find(r => r.record_id === id) }));
    const clinicalChanges = annotations.filter(r => r.changes.some(c => ['disease_or_lesion', 'sequence_or_phase', 'numeric_expressions'].some(field => c.field.startsWith(field))))
      .map(r => { const record = records.after!.get(r.record_id); return { record_id: r.record_id,
        source_page: record.source_location.physical_page, original_quote: record.original_quote, original_source_segments: record.quote_span.segments,
        changes: r.changes, review_status: record.review_status, automatic_checks_status: record.evidence_validation.automatic_checks.status,
        automatic_issues: record.evidence_validation.issues, human_approved: false }; });
    if (item.job_id === 'L05-R') {
      assert.equal(clinicalChanges.length, 3);
      assert.equal(records.after!.get('ev-f366a4b2cbaeea9c78cf64df27db286dfd96ad94').disease_or_lesion.value, 'AIS');
      const ir = (await read(join(code, cohort.source.ir_path))).document;
      const captionLines = ir.blocks.filter((b: any) => b.page === 8 && /-l0000(18|19|20|21)$/.test(b.block_id))
        .map((b: any) => ({ block_id: b.block_id, page: b.page, bbox: b.bbox, exact_text: b.text, text_version: b.text_version }));
      assert.equal(captionLines.length, 4);
      contextAndFieldRisks.push({ job_id: 'L05-R', figure: 'Fig.4', physical_page: 8,
        basis: 'Offline original-caption sentence/field inspection; no medical sign-off or new model inference.', source_anchors: captionLines,
        observations: [
          { record_id: 'ev-f366a4b2cbaeea9c78cf64df27db286dfd96ad94', risk: 'D-F记录的disease_or_lesion由unknown变为AIS。第19行AIS收尾前一句A-C；D-F句子跨到第20行才接with MIA in FS and IAC in FP。逐行找到AIS不能证明它属于D-F，此处存在具体跨句归属风险。' },
          { record_ids: clinicalChanges.map(r => r.record_id), risk: '三条sequence_or_phase由unknown变为A-C / D-F / G-I。这些是图版面板编号，填入成像序列/期相字段存在字段类型混淆风险。' },
          { record_ids: clinicalChanges.map(r => r.record_id), risk: '三条numeric_expressions从× 100变为空数组，原文片段中的× 100仍保留；numeric_expression_missing待核问题未消失，不能把结构化数字字段减少写成质量改善。' }
        ], after_states: clinicalChanges.map(r => ({ record_id: r.record_id, review_status: r.review_status, automatic_checks_status: r.automatic_checks_status,
          automatic_issues: r.automatic_issues, human_approved: false })) });
    }
    pairs.push({ job_id: item.job_id, execution_period: item.job_id === 'L01-F' ? 'completed_before_user_pause_on_2026-11-04_UTC' : 'continued_after_explicit_time_authorization_on_2026-11-05_UTC',
      pair_report_path: relative(code, pairPath), pair_report_sha256: sha256(pairBytes),
      before: arms.before, after: arms.after, source_content_changes: sourceDiff, model_annotation_changes: annotations,
      remaining_delivery_field_changes: deliveryChanges, runtime_trace_changes: traceChanges,
      delivery_envelope_changes: changedFields(deliveries.before!, deliveries.after!, ['records']),
      runtime_and_derived_delivery_changes: derivedDeliveryChanges,
      field_comparison_boundary: 'All current full-record business fields and remaining delivered fields compared. Only wrapper version/creation metadata, run IDs, derived fingerprints and read/provided/tool-call trace arrays are separated as runtime evidence; source_version, scope, automatic checks and human confirmation are never excluded.',
      changed_source_records: changedSourceRecords,
      clinical_metadata_changes_with_source: clinicalChanges,
      initial_payload_and_packet_controls_passed: true, medical_quality_approved: false, winner: null });
  }
  const baselineRequestCount = baseline.totals.requests;
  assert.deepEqual([...requestIds].sort(), ledger.requests.slice(baselineRequestCount).map((r: any) => r.id).sort(), 'every actual paired request is counted exactly once');
  const sums = Object.fromEntries(['before', 'after'].map(arm => [arm, Object.fromEntries(['requests', 'input_tokens', 'output_tokens', 'seconds', 'reread_blocks', 'omitted_reread_blocks'].map(k =>
    [k, pairs.reduce((n, p) => n + p[arm as 'before' | 'after'][k], 0)]))]));
  const ledgerTotals = { requests: ledger.requests.length, input_tokens: ledger.requests.reduce((n: number, r: any) => n + r.input_tokens, 0),
    output_tokens: ledger.requests.reduce((n: number, r: any) => n + r.output_tokens, 0), settled: ledger.requests.length, missing_usage: 0, halted: ledger.halted };
  const report = { schema_version: 'summary-reread-comparison-1', status: 'all_five_pairs_complete_medical_and_selection_pending', generated_at: new Date().toISOString(),
    method_labels: { B0: '单独智能体', F: '正向规则选块＋智能体', R: '反向删减无关块＋智能体' },
    single_variable: manifest.single_variable, fixed_baseline_totals: baseline.totals, pair_count: pairs.length, pairs, paired_totals: sums,
    actual_pair_execution_order: [...pairs].sort((a, b) => Date.parse(a.before.first_request_at) - Date.parse(b.before.first_request_at)).map(p =>
      ({ job_id: p.job_id, period: p.execution_period, first_request_at: p.before.first_request_at, finished_at: p.after.last_request_finished_at })),
    paired_requests: requestIds.size, cumulative_ledger_totals: ledgerTotals, ledger_sha256: sha256(ledgerBytes),
    original_156_request_prefix_preserved: true, original_start_and_limits_preserved: true, original49_runtime_sources_unchanged: true,
    manifest_sha256: sha256(manifestBytes), fixed_baseline_report_sha256: sha256(baselineBytes),
    time_authorization: { path: 'docs/acceptance/s0-s4-current-2026-11-04/summary-time-resume-authorization.json',
      resume_at: timeGrant.resume_at, deadline_utc: timeGrant.deadline_utc, resume_seconds: timeGrant.resume_seconds },
    engineering_recommendation: 'Assess per-group tradeoffs in input/output/time, recovered errors and candidate/context changes. Keep the targeted-reread prompt as an experimental option until human relevance/context/Figure review; do not change the production default or name a medical winner from token reductions.',
    limitations: ['五组各仅一次随机配对、仅两篇开发论文；同文不同方法并非独立样本，不作显著性推断。',
      '固定同一pre-summary候选包，只复验汇总阶段；不能换算整篇抽取性能，也不是产品断点续跑。',
      '必要原文和遗漏块仍可补读；汇总补读不补齐未抽取覆盖，也不降低原完成门槛。',
      '自动检查对照绑定IR和Figure资产；PDF逐字忠实性、语境和医学正确性未完成人工核验。',
      '人核/医核0；准确率、全文召回、有效描述数和正式赢家均未确定，不能据此选出医学最佳。',
      '重读减少不保证请求或总体token成本下降。真实账单未知；输入含缓存、输出含推理，耗时与缓存效果可能波动。'],
    context_and_field_risks: contextAndFieldRisks,
    actual_human_reviewed_count: 0, medical_quality_approved: false, winner: null, actual_cost: null, cost_status: 'unknown_gateway_billing' };
  const rows = pairs.flatMap(p => ['before', 'after'].map(arm => { const r = p[arm as 'before' | 'after']; return [p.job_id, arm === 'before' ? '原提示' : '按候选需要补读', r.candidates,
    r.first_request_at, r.requests, number(r.input_tokens), number(r.output_tokens), number(r.seconds), r.reread_blocks, r.omitted_reread_blocks,
    JSON.stringify(r.review_status), JSON.stringify(r.recovered_tool_errors)]; }));
  const baselineRows = baseline.jobs.map((j: any) => {
    const representative = j.independent_model_run ? j : baseline.jobs.find((r: any) => r.job_id === j.representative_job_id);
    assert.ok(representative);
    return [j.job_id, j.independent_model_run ? '独立真实运行' : '复用F，非独立；成本继承F', representative.candidate_count,
      representative.requests, number(representative.input_tokens_including_conservative_missing_usage),
      number(representative.output_tokens_including_reasoning_or_missing_usage_reservation), number(representative.seconds), j.state];
  });
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>汇总补读单因素复验</title>' +
    '<style>body{font:16px/1.6 system-ui,sans-serif;max-width:1500px;margin:36px auto;padding:0 20px;color:#18212b}h1,h2{line-height:1.25}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #ccd5de;padding:8px;text-align:left;vertical-align:top}th{background:#eef3f7}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7f9;padding:16px}details{border-bottom:1px solid #ccd5de;padding:12px 0}.notice{background:#fff3d6;padding:16px}a{color:#175da8}</style>' +
    '<h1>汇总补读：五组单因素真实复验</h1><p class="notice">这是工程与开销对照。人核/医核均为0，正式默认提示与方法未改，未选出医学最佳方法。</p>' +
    '<p><strong>B0</strong>＝单独智能体；<strong>F</strong>＝正向规则选块＋智能体；<strong>R</strong>＝反向删减无关块＋智能体。L01/L05是两篇开发论文，表中每组各比较原汇总提示与按候选需要补读提示。</p>' +
    '<p>仅改变summary用户提示的补读策略。同一候选包、模型Luna medium、工具、PDF/IR/Figure及完成门槛保持；必要遗漏行仍可补读。首轮结果与L01-F已完成对照均保留。</p>' +
    '<p>L01-F是暂停前11月4日UTC已完成的单对pilot；今天11月5日UTC依次执行L01-B0、L05-B0、L05-F、L05-R。它们各只有一次随机配对，跨日缓存与耗时会波动，不作显著性或医学优越性推断。</p>' +
    '<h2>实际请求与开销</h2>' + table(['组别', '汇总策略', '候选数', '首请求UTC', '请求', '输入token含缓存', '输出token含推理', '秒', '补读块', '遗漏区补读', '候选待核状态', '已恢复工具错误'], rows) +
    '<p class="notice">重读减少不保证总体token成本下降。请同时看请求、输入、输出和耗时；真实账单未知。</p>' +
    '<p>五组原提示合计：' + number(sums.before!.requests!) + '请求 / ' + number(sums.before!.input_tokens!) + '输入 / ' + number(sums.before!.output_tokens!) + '输出 / ' + number(sums.before!.seconds!) + '秒；按需补读合计：' +
    number(sums.after!.requests!) + '请求 / ' + number(sums.after!.input_tokens!) + '输入 / ' + number(sums.after!.output_tokens!) + '输出 / ' + number(sums.after!.seconds!) + '秒。以下源文/上下文/配图与错误变化必须一起判断。</p>' +
    '<h2>逐组原文、上下文、配图与待核变化</h2>' + pairs.map(p => '<details><summary>' + escape(p.job_id) + '：源片段变化' + p.source_content_changes.original_fragment_changes.length + '，上下文片段变化' +
      p.source_content_changes.context_fragment_changes.length + '，Figure关联变化' + p.source_content_changes.figure_association_changes.length + '，自动标注变化记录' + p.model_annotation_changes.length + '</summary><pre>' +
      escape(JSON.stringify({ source_content_changes: p.source_content_changes, changed_source_records: p.changed_source_records, model_annotation_changes: p.model_annotation_changes,
        clinical_metadata_changes_with_source: p.clinical_metadata_changes_with_source,
        remaining_delivery_field_changes: p.remaining_delivery_field_changes, delivery_envelope_changes: p.delivery_envelope_changes,
        runtime_trace_changes: p.runtime_trace_changes, runtime_and_derived_delivery_changes: p.runtime_and_derived_delivery_changes,
        field_comparison_boundary: p.field_comparison_boundary,
        before: { context_status: p.before.context_status, assertion_status: p.before.assertion_status, applicability_status: p.before.applicability_status,
          evidence_type: p.before.evidence_type, automatic_check_status: p.before.automatic_check_status, validation_issue_codes: p.before.validation_issue_codes,
          figure_association_status: p.before.figure_association_status, context_issues: p.before.automatic_context_issues, summary: p.before.summary },
        after: { context_status: p.after.context_status, assertion_status: p.after.assertion_status, applicability_status: p.after.applicability_status,
          evidence_type: p.after.evidence_type, automatic_check_status: p.after.automatic_check_status, validation_issue_codes: p.after.validation_issue_codes,
          figure_association_status: p.after.figure_association_status, context_issues: p.after.automatic_context_issues, summary: p.after.summary } }, null, 2)) + '</pre></details>').join('') +
    '<h2>需保留的具体语境与字段风险</h2><p>L01-B0有一条needs_context→pending；pending仍是未人审候选。L05-R还有一条pending→needs_context。原文、上下文片段及Figure关联相同，不表示全部输出相同；候选链接、未批准模型复核与警告、以下三条结构化字段都有差异。</p>' +
    contextAndFieldRisks.map(r => '<p class="notice">' + r.observations.map((o: any) => escape(o.risk)).join('<br>') + '</p><details><summary>L05-R：物理第8页Fig.4四行原文、三条具体记录和自动待核状态</summary><pre>' +
      escape(JSON.stringify({ source_anchors: r.source_anchors, observations: r.observations, after_states: r.after_states }, null, 2)) + '</pre></details>').join('') +
    '<h2>首轮三方法背景</h2>' + table(['逻辑条件', '独立性', '未审候选', '方法请求(复用行继承代表)', '方法输入', '方法输出', '方法秒', '运行状态'], baselineRows) +
    '<p>L01-R的0新增请求表示复用F；完整输入等价已核验，它没有独立计时或零成本优势，方法成本应继承代表F。实际唯一账本只计一次。所有partial与人核遗留保留。</p>' +
    '<p><a href="three-method-proposal/automatic-audit-final/review.html">首轮148条原文/Figure可读审查包</a> · <a href="' + escape(output.split('/').at(-1)) + '.json">本报告完整JSON</a></p>' +
    '<h2>使用建议与边界</h2><p>逐组兼顾输入、输出、耗时、工具错误和候选上下文变化。保留按需补读作为实验选项；先核对语境与Figure，再决定正式采用。当前不修改默认提示或方法。</p><ul>' +
    report.limitations.map(l => '<li>' + escape(l) + '</li>').join('') + '</ul><p>累计账本：' + number(ledgerTotals.requests) + '请求 / ' + number(ledgerTotals.input_tokens) + '输入 / ' + number(ledgerTotals.output_tokens) +
    '输出，全部结清。原156条前缀、原start与上限保持。唯一续窗：' + escape(timeGrant.resume_at) + ' → ' + escape(timeGrant.deadline_utc) + '，共11520秒。</p></html>';
  await writeFile(output + '.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(output + '.html', html, { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ pairs: pairs.length, paired_totals: sums, ledger: ledgerTotals, report_json: relative(code, output + '.json'), report_html: relative(code, output + '.html'), new_model_calls: 0 }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
