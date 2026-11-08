/** Offline audit/reader material from actual run artifacts only. Never calls a model. */
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import assert from 'node:assert/strict';
import { allDeliveredRecords, deliveryRecordCounts, buildEvidenceDelivery, exportEvidenceDelivery } from '../packages/agent/src/evidence-delivery.js';
import { groupEvidenceFragments, SOURCE_EVIDENCE_UNIT_VERSION } from '../packages/agent/src/source-evidence-units.js';
import { ledgerAccounting } from './audit-method-comparison.js';
import { comparisonBudgetOwner } from '../packages/agent/src/experiment-authorization.js';
import { ExtractionTools } from '../packages/agent/src/extraction-tools.js';
import { ExtractionStore } from '../packages/agent/src/extraction-store.js';
import { buildArticleScope } from '../packages/agent/src/article-scope.js';

const code = resolve(import.meta.dirname, '..'), parentRoot = resolve(code, 'docs/acceptance/user-feedback-2026-11-05/revalidation');
const isChild = process.argv[2] === '--child', root = isChild ? resolve(parentRoot, 'metric-context-revision') : parentRoot;
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const read = async (p: string) => JSON.parse(await readFile(resolve(code, p), 'utf8'));
const save = async (p: string, value: unknown) => writeFile(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const pathOf = (p: string) => relative(code, p);
const artifacts = new Map<string, string>();
async function bind(p: string, wanted?: string) { const v = sha(await readFile(resolve(code, p))); if (wanted) assert.equal(v, wanted, p); artifacts.set(p, v); return v; }
const planPath = pathOf(resolve(root, 'prepared/plan.json')), plan = await read(planPath);
await bind(planPath, isChild ? 'c2369db87b88efb1f40e695a616449eac27fdb4b9b92550d512e5bf0fda6a96f' : '7c995ed66a85bb9f2f5fbcdde84788394022ae5d43bdd1d64049e10abecbdbf4');
const authPath = pathOf(resolve(root, 'authorization.json')), auth = await read(authPath); await bind(authPath);
const ledgerPath = comparisonBudgetOwner(auth.authorization_id) + '/call-ledger.json';
try { await access(resolve(code, dirname(ledgerPath), 'active-owner.lock')); throw new Error('owner_still_running'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const ledgerBytes = await readFile(resolve(code, ledgerPath)), ledger = JSON.parse(ledgerBytes.toString('utf8'));
assert.equal(ledger.authorization.id, auth.authorization_id); assert.deepEqual(ledger.limits, auth.limits);
assert.ok(ledger.requests.every((r: any) => r.finished_at), 'unsettled_request_blocks_final_audit');
for (const [p, wanted] of Object.entries(plan.source_hashes)) {
  await bind(p, wanted as string); await bind(pathOf(resolve(root, 'prepared/execution/source-snapshot', p)), wanted as string);
}
const protectedBefore = await read('docs/acceptance/user-feedback-2026-11-05/protected-before.json');
for (const p of protectedBefore.files) assert.equal(sha(await readFile(resolve(code, p.path))), p.actual_sha256, p.path);
const initialPath = pathOf(resolve(root, 'prepared/execution/report.json')), initial = await read(initialPath); await bind(initialPath);
const ownerBefore = (await read(pathOf(resolve(root, 'prepared/execution/budget-owner.json')))).totals_before_this_plan;
assert.notEqual(initial.status, 'running');
const pack = await read('apps/pi-web/public/output-review/pack-manifest.json');
const feedbackPath = 'apps/pi-web/public/output-review/普通用户初筛-cc939653-2026-11-05T06-08-53.json';
await bind(feedbackPath, 'e53f669c7086761f9d0ef209448979aae488068c7b1e2a80d1f5590e422b6a28');
const feedback = await read(feedbackPath), oldGroups = await read('docs/acceptance/user-feedback-2026-11-05/source-groups.json');
const output = resolve(root, 'final-audit'); await mkdir(output, { recursive: false });
await writeFile(resolve(output, 'new-ledger-snapshot.json'), ledgerBytes, { flag: 'wx' }); await bind(pathOf(resolve(output, 'new-ledger-snapshot.json')));
const documents = new Map<string, any>(), catalogs = new Map<string, any>(), jobs: any[] = [], records: any[] = [], figures: any[] = [], audits: any[] = [];
const equivalence: any[] = [];
const charge = (r: any) => ({ requests: r.requests ?? 0, input_tokens: r.input_tokens_including_conservative_missing_usage ?? r.delta?.input_tokens ?? 0,
  output_tokens: r.output_tokens_including_reasoning_or_missing_usage_reservation ?? r.delta?.output_tokens ?? 0,
  actual_cost: null, cost_status: 'unknown_gateway_billing' });
const sumCharge = (items: any[]) => ({ requests: items.reduce((n, a) => n + a.requests, 0), input_tokens: items.reduce((n, a) => n + a.input_tokens, 0),
  output_tokens: items.reduce((n, a) => n + a.output_tokens, 0), actual_cost: null, cost_status: 'unknown_gateway_billing' });
const codepointRows = (xs: any[]) => xs.flatMap(f => Array.from(f.exact_quote).map((c, i) => [f.block_id, f.text_version, f.start + i, c]));
for (const paper of plan.papers) {
  for (const [p, wanted] of [[paper.pdf_path, paper.pdf_sha256], [paper.ir_path, paper.ir_sha256], [paper.figure_catalog_path, paper.figure_catalog_sha256], ...Object.entries(paper.assets)]) await bind(p, wanted);
  const doc = (await read(paper.ir_path)).document, catalog = await read(paper.figure_catalog_path);
  documents.set(paper.document_id, doc); catalogs.set(paper.document_id, catalog);
  const fJob = paper.methods.jobs.find((j: any) => j.condition === 'F'), rJob = paper.methods.jobs.find((j: any) => j.condition === 'R');
  if (fJob.model_source_input_sha256 === rJob.model_source_input_sha256) {
    const views: any[] = [];
    for (const job of [fJob, rJob]) {
      const input: any = { schema_version: '1', run_id: 'offline-equal-model-view', document_id: doc.document_id, file_sha256: doc.file_sha256,
        fixture: false, scope: plan.config.scope, rule_version: 'verbatim-three-method-comparison-1', runtime_profile: { provider: plan.config.model.provider,
          model_id: plan.config.model.model_id, endpoint: plan.config.model.endpoint, pi_version: '1.4.0', version: plan.common.profile.profile_version } };
      const metadata: any = { task_id: input.run_id, article_family_id: paper.article_family_id, source_version: { file_sha256: doc.file_sha256,
        source_kind: 'public_published_pdf_development', version: doc.file_sha256, obtained_at: 'offline-comparison-only' }, created_at: 'offline-comparison-only' };
      const store = new ExtractionStore(':memory:'); store.create(input, metadata); store.transition(input.run_id, 'extracting');
      const batches: any[] = [];
      for (const batch of job.batches) {
        const tools = new ExtractionTools({ input, metadata, document: doc, catalog: plan.config.catalog, evidencePolicyVersion: 'visual-statements-2' }, batch, buildArticleScope(doc), store, 'batch_lines');
        const defs = tools.definitions(); const context = await defs.find(d => d.name === 'get_document_context')!.execute('offline-context', {}, undefined, undefined, {} as any);
        const source = await defs.find(d => d.name === 'read_document_blocks')!.execute('offline-read', {}, undefined, undefined, {} as any);
        batches.push({ schemas: defs.map(d => ({ name: d.name, description: d.description, parameters: d.parameters })), context: context.content, read: source.content });
      }
      views.push(batches); store.close();
    }
    assert.deepEqual(views[0], views[1]);
    equivalence.push({ document_id: paper.document_id, F_R_input_digest_equal: true, all_batch_tool_schemas_context_and_read_views_equal_offline: true,
      batch_count: views[0].length, compared_source: 'Actual bound real-paper IR and unchanged 52 production sources; no extra provider call',
      F_actual_payload_evidence: ledger.requests.filter((r: any) => r.purpose.includes('source-' + paper.document_id + ':input-' + fJob.model_source_input_sha256.slice(0, 12)))
        .map((r: any) => ({ request_id: r.id, payload_sha256: r.payload_sha256, payload_bytes: r.payload_bytes })),
      second_independent_R_provider_payload_observed: false, full_body_replay_claimed: false });
  } else equivalence.push({ document_id: paper.document_id, F_R_input_digest_equal: false, independent_F_and_R_provider_runs_required: true });
  for (const f of catalog.figures) figures.push({ figure_id: f.figure_id, document_id: paper.document_id, figure_number: f.figure_number,
    caption_segments: f.caption_segments, panel_labels: f.panel_labels, status_label: f.verification.status + '；医学图像类型及配对待核',
    verification: f.verification, purpose_review: /Lasso|nomogram|recruit|flow.?chart/iu.test(f.caption_segments.map((s: any) => s.exact_quote).join('\n')) ?
      '原图注含实验/统计用途线索；不能仅据图号当医学图像配对' : '图像用途/病例和医学配对仍未批准',
    assets: f.regions.map((a: any, i: number) => ({ pack_path: `revalidation-assets/${paper.document_id}-${f.figure_id}-${i}.png`,
      source_path: a.path, sha256: a.sha256, width_px: a.width_px, height_px: a.height_px, physical_page: a.physical_page })) });
  for (const preparedJob of paper.methods.jobs) {
    if (!preparedJob.independent_model_run) continue;
    const row = initial.jobs.find((r: any) => r.job_id === preparedJob.job_id); assert.ok(row?.result_path);
    const attempts: any[] = [{ attempt: 0, result_path: row.result_path, state: row.state, error: row.error ?? null, seconds: row.seconds, candidate_count: row.candidate_count,
      ...charge(row), outcome_reason: row.error ? '首次实际运行失败，保留原记录和全部耗费' : '首次实际运行，医学及产品批准未发生' }];
    let effective = row.result_path;
    let retryNames: string[] = []; try { retryNames = await readdir(resolve(root, 'retries')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    for (const name of retryNames.filter(n => new RegExp('^' + preparedJob.job_id + '-attempt-[12]$').test(n)).sort()) {
      const reportPath = pathOf(resolve(root, 'retries', name, 'retry-report.json')), retry = await read(reportPath); await bind(reportPath);
      assert.equal(retry.authorization_id, auth.authorization_id); assert.ok(!['running'].includes(retry.status));
      const entry = { attempt: retry.attempt, result_path: retry.result_path ?? null, state: retry.state ?? 'failed', error: retry.run_error ?? retry.error ?? null,
        candidate_count: retry.candidate_count ?? 0,
        seconds: retry.seconds ?? 0, ...charge({ ...retry, requests: retry.delta?.requests }), report_path: reportPath,
        outcome_reason: '同输入必要重试；未纠ID、未放宽schema，耗费与首次失败同计' }; attempts.push(entry);
      if (retry.result_path) effective = retry.result_path;
    }
    for (const a of attempts) if (a.result_path) a.result_sha256 = await bind(a.result_path);
    for (const a of attempts.filter(a => a.error && a.result_path && a.result_path !== effective)) {
      const partialPath = pathOf(resolve(dirname(resolve(code, a.result_path)), 'delivery.json')); await bind(partialPath);
      const partial = await read(partialPath), actual = await read(a.result_path);
      assert.deepEqual(partial, buildEvidenceDelivery(doc, actual.versions, catalog));
      a.partial_records = partial.records.map((d: any) => ({ record_id: d.record_id, record_version: d.record_version, document_id: d.document_id,
        job_id: preparedJob.job_id, source_record_sha256: d.source_record_sha256, text_fingerprint: d.text_fingerprint,
        delivery_fingerprint: d.delivery_fingerprint, actual_delivery_path: partialPath,
        original_groups: groupEvidenceFragments(doc, d.original_fragments), context_groups: groupEvidenceFragments(doc, d.context_fragments),
        figure_ids: [...new Set([...d.figure_association.figure_ids, ...d.figure_association.proposed_figure_ids])],
        figure_association: d.figure_association, review_status: d.review_status,
        automatic_checks: [{ code: 'partial_failed_attempt_retained', status: 'pending', detail: '失败尝试已实际保存的候选，原样保留；不与最终路径合计为有效描述，不继承核验。' }],
        human_approved: false, product_export_approved: false }));
    }
    const result = await read(effective), deliveryPath = pathOf(resolve(dirname(resolve(code, effective)), 'delivery.json'));
    await bind(deliveryPath); const actualDelivery = await read(deliveryPath), delivery = buildEvidenceDelivery(doc, result.versions, catalog);
    assert.deepEqual(delivery, actualDelivery, 'Actual written delivery must match exact current bound-source audit');
    await exportEvidenceDelivery(doc, result.versions, { codeRoot: code, directory: resolve(output, preparedJob.job_id + '-candidates'),
      mode: 'candidates', catalog, coverage: result.coverage });
    const current = new Map<string, any>();
    for (const v of result.versions) if (v.status !== 'proposed' && (!current.has(v.record.record_id) || current.get(v.record.record_id).version < v.version)) current.set(v.record.record_id, v);
    const diagnostics = result.events.filter((e: any) => ['candidate_validation_rejected', 'tool_protocol_rejected', 'protocol_diagnostic_pause'].includes(e.type));
    const exactQuoteGroups = new Map<string, string[]>();
    for (const d of allDeliveredRecords(delivery)) {
      const key = JSON.stringify(d.original_fragments.map(s => ({ block_id: s.block_id, text_version: s.text_version, start: s.start, end: s.end, exact_quote: s.exact_quote })));
      exactQuoteGroups.set(key, [...(exactQuoteGroups.get(key) ?? []), d.record_id]);
    }
    const repeatedQuoteIds = new Set([...exactQuoteGroups.values()].filter(ids => ids.length > 1).flat());
    let summaryDiagnostic: any = null;
    const summaryDiagnosticPath = pathOf(resolve(root, preparedJob.job_id + '-summary-diagnostic.json'));
    try { summaryDiagnostic = await read(summaryDiagnosticPath); assert.equal(summaryDiagnostic.actual_result_path, effective); await bind(summaryDiagnosticPath); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    let primaryTables = 0, incomplete = 0;
    for (const d of allDeliveredRecords(delivery)) {
      const raw = current.get(d.record_id).record, originalGroups = groupEvidenceFragments(doc, d.original_fragments), contextGroups = groupEvidenceFragments(doc, d.context_fragments);
      assert.deepEqual(codepointRows(originalGroups.flatMap(g => g.segments)), codepointRows(d.original_fragments));
      assert.deepEqual(codepointRows(contextGroups.flatMap(g => g.segments)), codepointRows(d.context_fragments));
      primaryTables += originalGroups.some(g => ['table', 'table_caption'].includes(g.source_type)) ? 1 : 0;
      incomplete += originalGroups.some(g => g.completeness === 'incomplete') ? 1 : 0;
      const text = raw.original_quote, semanticNotes: string[] = [];
      if (/CTR was calculated|diameter of the solid compo-/iu.test(text)) semanticNotes.push('用户已确认测量指标定义/计算方式仅作必要背景，不作独立交付；保留这一实际候选，不删除或改写原模型结果。');
      if (/underestimat|diagnos|疗效|相关性/iu.test(text)) semanticNotes.push('含诊断/疗效或关联解释；是否直接视觉描述仍待用户及专业核验，不能声称已排除全部结论。');
      records.push({ record_id: d.record_id, job_id: preparedJob.job_id, document_id: paper.document_id, record_version: d.record_version,
        source_record_sha256: d.source_record_sha256, text_fingerprint: d.text_fingerprint, delivery_fingerprint: d.delivery_fingerprint,
        actual_result_path: effective, actual_delivery_path: deliveryPath, original_groups: originalGroups, context_groups: contextGroups,
        figure_ids: [...new Set([...d.figure_association.figure_ids, ...d.figure_association.proposed_figure_ids])], figure_association: d.figure_association,
        automatic_checks: [{ code: 'exact_bound_source_and_delivery_spans', status: 'passed', detail: '逐字源span/offset/page/bbox及实际写出delivery机械核对；不证明医学语义。' },
          ...raw.evidence_validation.issues.map((i: any) => ({ code: i.code, status: i.severity === 'requires_review' ? 'pending' : i.severity === 'reject' ? 'failed' : 'info', detail: i.detail })),
          ...semanticNotes.map(detail => ({ code: 'business_or_visual_purpose_pending', status: 'pending', detail })),
          ...(repeatedQuoteIds.has(d.record_id) ? [{ code: 'identical_primary_source_multiple_records', status: 'pending', detail: '同一实际任务有多条主原文字面及span完全相同的记录，字段/归属可能不同；保留全部，不当多条有效描述。' }] : []),
          { code: 'medical_semantics_and_pairing', status: 'pending', detail: '专业医学及逐条产品批准未发生；旧反馈不继承。' }],
        semantic_review_notes: semanticNotes, supporting_table_evidence: d.supporting_table_evidence ?? [], fields: { feature_name_raw: raw.feature_name_raw,
          evidence_type: raw.evidence_type, disease_or_lesion: raw.disease_or_lesion, modality: raw.modality, sequence_or_phase: raw.sequence_or_phase,
          numeric_expressions: raw.numeric_expressions, assertion: raw.assertion, applicability: raw.applicability, source_attribution: raw.context.source_attribution },
        duplicate_and_conflict_links: raw.duplicate_and_conflict_links,
        review_status: raw.review_status, human_approved: false, product_export_approved: false });
    }
    const charges = sumCharge(attempts);
    jobs.push({ job_id: preparedJob.job_id, document_id: paper.document_id, method: preparedJob.condition, label: preparedJob.label, state: result.state,
      independent_model_run: true, candidate_count: result.candidate_count, delivered_count: allDeliveredRecords(delivery).length, attempts, ...charges,
      effective_result_path: effective, effective_delivery_path: deliveryPath, seconds: attempts.reduce((n, a) => n + (a.seconds ?? 0), 0),
      summary_complete: result.coverage.whole_document_summary_complete, source_processing_complete: result.coverage.selected_source_block_processing_complete,
      full_source_processing_complete: result.coverage.source_block_processing_complete,
      outcome_reason: result.error ? `${result.error.code ?? 'run_error'}；保留实际${allDeliveredRecords(delivery).length}条候选、失败链和全部耗费，不当汇总完成或质量通过。` : '已选源块及汇总处理结果如实保留；parser仍partial，医学与产品质量待核',
      notes: summaryDiagnostic ? ['汇总15响应中1次候选上下文读取、5次提交失败、11次源补读（2次错误），读源union615块/10页；未保存逐次参数，不能证明完全相同请求重复。',
        '达到既有application_context_estimate_limit，汇总未完成；不提高限制、不追加新优化。', 'AAH主原文出现2条完全相同记录，全部保留；不能算两条有效描述。'] : [],
      summary_diagnostic_path: summaryDiagnostic ? summaryDiagnosticPath : null,
      diagnostic_counts: { effective_diagnostics: diagnostics.length, primary_table_records: primaryTables, incomplete_primary_statements: incomplete },
      model_source_input_sha256: preparedJob.model_source_input_sha256, medical_quality_approved: false });
    audits.push({ job_id: preparedJob.job_id, effective_result_path: effective, actual_delivery_sha256: artifacts.get(deliveryPath),
      bound_source_and_actual_delivery_passed: true, primary_table_records: primaryTables, incomplete_primary_statements: incomplete,
      supporting_table_records: allDeliveredRecords(delivery).filter(r => r.supporting_table_evidence?.length).length,
      parser_status: doc.parser.status, candidate_count: allDeliveredRecords(delivery).length, ...deliveryRecordCounts(delivery), error: result.error ?? null,
      source_processing_complete: result.coverage.selected_source_block_processing_complete, summary_complete: result.coverage.whole_document_summary_complete,
      semantic_review_notes: records.filter(r => r.job_id === preparedJob.job_id).flatMap(r => r.semantic_review_notes), diagnostics });
  }
}
for (const paper of plan.papers) for (const p of paper.methods.jobs.filter((j: any) => !j.independent_model_run)) {
  const representative = jobs.find(j => j.job_id === p.representative_job_id); assert.ok(representative);
  jobs.push({ job_id: p.job_id, document_id: paper.document_id, method: p.condition, label: p.label, state: representative.state,
    independent_model_run: false, reused_from_job_id: representative.job_id, candidate_count: representative.candidate_count, delivered_count: representative.delivered_count,
    attempts: [], requests: 0, input_tokens: 0, output_tokens: 0, actual_cost: null, cost_status: 'unknown_gateway_billing',
    representative_measurement: { requests: representative.requests, input_tokens: representative.input_tokens, output_tokens: representative.output_tokens,
      actual_cost: null, cost_status: 'unknown_gateway_billing', seconds: representative.seconds },
    summary_complete: representative.summary_complete, source_processing_complete: representative.source_processing_complete,
    outcome_reason: '离线等价输入复用F最终实际产物；0新增调用不是零成本策略收益，非独立证据。', model_source_input_sha256: p.model_source_input_sha256 });
}
jobs.sort((a, b) => ['L01-B0', 'L01-F', 'L01-R', 'L05-B0', 'L05-F', 'L05-R'].indexOf(a.job_id) - ['L01-B0', 'L01-F', 'L01-R', 'L05-B0', 'L05-F', 'L05-R'].indexOf(b.job_id));
assert.equal(new Set(records.map(r => r.record_id)).size, records.length);
const accounting = ledgerAccounting(ledger.requests), usage = { requests: accounting.physical_requests,
  input_tokens: accounting.input_tokens_including_cache_and_missing_usage_reservation, output_tokens: accounting.output_tokens_including_reasoning_and_missing_usage_reservation,
  actual_cost: null, cost_status: 'unknown_gateway_billing' };
const roundUsage = { ...usage, requests: usage.requests - ownerBefore.requests, input_tokens: usage.input_tokens - ownerBefore.input_tokens,
  output_tokens: usage.output_tokens - ownerBefore.output_tokens };
assert.deepEqual(sumCharge(jobs), roundUsage, 'Every failed/successful physical attempt in this round must count once; reuse adds zero physical charge.');
const overlap = (a: any, b: any) => a.block_id === b.block_id && a.text_version === b.text_version && a.start < b.end && b.start < a.end;
const issues = feedback.items.filter((i: any) => i.note).map((item: any) => {
  const sample = pack.random_samples.find((s: any) => s.id === item.id), v = sample.view, old = oldGroups.views.find((s: any) => s.owner_id === item.id && s.arm === 'baseline');
  const links = records.filter(r => r.document_id === v.document_id).map(r => ({ record_id: r.record_id,
    primary_source_overlap: r.original_groups.some((g: any) => g.segments.some((s: any) => v.original_fragments.some((f: any) => overlap(s, f)))),
    context_source_overlap: r.context_groups.some((g: any) => g.segments.some((s: any) => v.original_fragments.some((f: any) => overlap(s, f)))) })).filter(r => r.primary_source_overlap || r.context_source_overlap);
  const observations = ['仅原block/码点span重叠建立来源联系，不表示一对一修复、正确率或旧意见继承。'];
  if (['S01', 'S02', 'S16'].includes(item.id)) observations.push(`本轮最终五唯一产物机械识别的独立表格主记录共${audits.reduce((n, a) => n + a.primary_table_records, 0)}；不推断表格数值行列语义归属。`);
  if (item.id === 'S03') observations.push('一般形态定义并未要求具体病例/图片；原not_like与允许提取备注均保留。新抽取的句范围逐条展示，不声称覆盖所有一般定义。');
  if (item.id === 'S09') observations.push('旧Note原已在IR/其他候选出现；新L01 Figure1目录按原span保留Note与Caption，图资产像素未改。是否被新模型实际提取按新记录显示。');
  if (item.id === 'S15') observations.push('L05图2原图注明确LASSO实验用途；旧looks_matched不转为医学配图批准。当前实验图/医学用途仍待核。');
  if (item.id === 'S18') observations.push('完整源句应保留分类语境及<5mm尺寸；已知缺句不补进旧记录，新记录按原始完整span展示。');
  if (['S06', 'S11', 'S20', 'S21'].includes(item.id)) observations.push('纯结论、评估清单、实验设置不能仅凭视觉术语当形态描述；当前含测量/诊断关联的新句仍显式待核，不声称全部语义已排除。');
  return { old_item_id: item.id, old_note: item.note, old_answers: item.answers, document_id: v.document_id,
    old_original_groups: old.original_groups, old_context_groups: old.context_groups, old_source_binding: item.source_binding,
    new_record_ids: links.map(l => l.record_id), source_links: links, relation: links.length ? 'source_overlap_only' : 'no_direct_match',
    automatic_observations: observations, old_feedback_inherited: false, medical_quality_approved: false };
});
const oldLedgerPath = Object.keys(pack.source_inputs).find(p => p.endsWith('call-ledger.json'))!, oldLedger = await read(oldLedgerPath);
assert.equal(oldLedger.requests.length, 189); assert.equal(sha(await readFile(resolve(code, oldLedgerPath))), pack.source_inputs[oldLedgerPath]);
const finalized = new Date().toISOString();
const report = { schema_version: 'feedback-real-revalidation-audit-1', finalized_at: finalized, batch_id: plan.batch_id, authorization_id: auth.authorization_id,
  runtime_sources_unchanged: 52, original_protected_files_unchanged: protectedBefore.files.length, source_evidence_unit_version: SOURCE_EVIDENCE_UNIT_VERSION,
  new_accounting: accounting, usage_totals: roundUsage, shared_usage_totals: usage, round_started_with: ownerBefore, jobs, automatic_audits: audits, issues,
  F_R_equivalence_checks: equivalence,
  original_ledger: { path: oldLedgerPath, sha256: pack.source_inputs[oldLedgerPath], requests: 189, unchanged: true },
  combined_request_count: 189 + usage.requests, original_wallclock: { start: ledger.experiment_started_at, deadline_utc: new Date(Date.parse(ledger.experiment_started_at) + auth.limits.seconds * 1000).toISOString(), limits: auth.limits },
  protocol_failure_evidence: 'tool-failure-reproduction.json; offline counterfactuals never enter actual outputs',
  body_replay_limit: 'Ledger preserves real request/response hashes and sizes, not recoverable full HTTP request bodies. F/R equality is checked from bound input, batch/context and frozen model/tool code, not claimed as independently observed second paid output.',
  table_support_limit: 'Only selected literal headers/values persist; full row/column semantics are not automatically reconstructed or approved.',
  business_scope_confirmation: '用户已确认CTR等计算定义仅作必要context、不独立交付；父轮当时待定的实际候选完整保留，子轮仅这一scope prompt变化。小实性成分/诊断低估关联句仍需重点核验。',
  multi_change_attribution: 'Many corrections changed together. Differences from old outputs cannot be attributed to one factor; counts are not precision/recall or a method winner.',
  medical_quality_approved: false, product_export_approved: false, stage_passed: false, winner: null, accuracy: null, recall: null,
  old_feedback_inherited: false, owner_lock_present: false, unsettled_requests: 0, formal_reviews_used: 3, formal_review_limit: 3 };
await save(resolve(output, 'report.json'), report); await bind(pathOf(resolve(output, 'report.json')));
const manifest = { schema_version: 'feedback-revalidation-reader-1', batch_id: plan.batch_id, finalized_at: finalized, actual_model_outputs: true,
  papers: plan.papers.map((p: any) => ({ document_id: p.document_id, pdf_path: 'pdf/' + p.document_id + '.pdf', pdf_sha256: p.pdf_sha256 })),
  source_artifacts: [...artifacts].map(([path, sha256]) => ({ path, sha256 })), usage_totals: roundUsage, shared_usage_totals: usage, jobs, records, figures, issues,
  source_evidence_unit_version: SOURCE_EVIDENCE_UNIT_VERSION, original_feedback_sha256: artifacts.get(feedbackPath),
  model: plan.config.model, actual_cost_known: false, medical_quality_approved: false, product_export_approved: false,
  old_feedback_inherited: false, stage_passed: false, winner: null,
  limitations: [report.business_scope_confirmation, report.body_replay_limit, report.table_support_limit, report.multi_change_attribution] };
await save(resolve(root, 'reader-manifest.json'), manifest);
process.stdout.write(JSON.stringify({ report: pathOf(resolve(output, 'report.json')), manifest: pathOf(resolve(root, 'reader-manifest.json')),
  records: records.length, jobs: jobs.length, actual_unique_inputs: audits.length, round_requests: roundUsage.requests, shared_requests: usage.requests, old_requests_unchanged: 189,
  primary_table_records: audits.reduce((n, a) => n + a.primary_table_records, 0), incomplete_primary_statements: audits.reduce((n, a) => n + a.incomplete_primary_statements, 0),
  medical_quality_approved: false, winner: null }) + '\n');
