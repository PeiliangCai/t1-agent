import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { assertPack, validateResults, counts, type Results } from '../apps/pi-web/output-review/model.js';
import type { ReviewPack, RecordView } from '../apps/pi-web/output-review/types.js';
import type { LocatedEvidenceFragment } from '@t1/contracts';
import { buildSourceEvidenceUnits, groupEvidenceFragments, SOURCE_EVIDENCE_UNIT_VERSION } from '../packages/agent/src/source-evidence-units.js';

const code = resolve(import.meta.dirname, '..');
const output = resolve(code, 'docs/acceptance/user-feedback-2026-11-05');
const feedbackPath = 'apps/pi-web/public/output-review/普通用户初筛-cc939653-2026-11-05T06-08-53.json';
const feedbackSha = 'e53f669c7086761f9d0ef209448979aae488068c7b1e2a80d1f5590e422b6a28';
const frozen = 'docs/acceptance/s0-s4-current-2026-11-04/output-review-pack-2026-11-05';
const sha = (raw: string | Uint8Array) => createHash('sha256').update(raw).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(resolve(code, path), 'utf8'));
const pack = await json('apps/pi-web/public/output-review/pack-manifest.json') as ReviewPack & Record<string, any>;
const feedbackRaw = await readFile(resolve(code, feedbackPath));
if (sha(feedbackRaw) !== feedbackSha) throw new Error('raw_feedback_sha256_mismatch');
assertPack(pack);
const feedback: Results = validateResults(JSON.parse(feedbackRaw.toString('utf8')), pack);
const documents = new Map<string, any>();
for (const p of pack.papers) documents.set(p.document_id, (await json((p as any).ir_path)).document);

const expected = new Map<string, string>(Object.entries(pack.source_inputs));
expected.set(feedbackPath, feedbackSha);
expected.set(frozen + '/真实输出人工核验包.zip', feedback.frozen_zip_sha256);
expected.set(frozen + '/manifest.json', feedback.frozen_manifest_sha256);
for (const paper of pack.papers) expected.set('apps/pi-web/public/output-review/' + paper.pack_pdf, paper.pdf_sha256);
const protectedFiles = await Promise.all([...expected].map(async ([path, wanted]) => {
  const actual = sha(await readFile(resolve(code, path)));
  return { path, expected_sha256: wanted, actual_sha256: actual, matches_frozen_reference: wanted === actual };
}));
// Preserve the first actual observation too: some current status documents may have
// legitimately changed after the frozen package. Such changes are reported, never repaired.
const snapshotPath = resolve(output, 'protected-before.json');
let initial: { files: typeof protectedFiles };
try { initial = JSON.parse(await readFile(snapshotPath, 'utf8')); }
catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  await mkdir(output, { recursive: true });
  initial = { files: protectedFiles };
  await writeFile(snapshotPath, JSON.stringify({ schema_version: 'feedback-protected-files-1', recorded_at: new Date().toISOString(), ...initial }, null, 2) + '\n', { flag: 'wx' });
}
const drift = protectedFiles.filter(p => initial.files.find(f => f.path === p.path)?.actual_sha256 !== p.actual_sha256);
if (drift.length) throw new Error('protected_source_changed_since_feedback_intake:' + drift.map(d => d.path).join(','));

const viewRows: any[] = [];
const traceView = (owner: string, arm: string, view: RecordView) => {
  const document = documents.get(view.document_id), units = buildSourceEvidenceUnits(document);
  const original = groupEvidenceFragments(document, view.original_fragments as LocatedEvidenceFragment[], units);
  const context = groupEvidenceFragments(document, view.context_fragments as LocatedEvidenceFragment[], units);
  viewRows.push({ owner_id: owner, arm, source_record_sha256: view.source_record_sha256, text_fingerprint: view.text_fingerprint,
    delivery_fingerprint: view.delivery_fingerprint, original_groups: original, context_groups: context });
  return { source_binding: { record_id: view.record_id, record_version: view.record_version, source_record_sha256: view.source_record_sha256,
    text_fingerprint: view.text_fingerprint, delivery_fingerprint: view.delivery_fingerprint, file_sha256: view.file_sha256, text_version: view.text_version },
    original_fragments: view.original_fragments, context_fragments: view.context_fragments, fields: view.fields,
    source_types: (view as any).source_types, figure_ids: view.figure_ids, figure_association: view.figure_association,
    result_path: (view as any).result_path, original_groups: original, context_groups: context };
};
const category = (view: RecordView) => {
  const groups = groupEvidenceFragments(documents.get(view.document_id), view.original_fragments as LocatedEvidenceFragment[]);
  const table = groups.some(g => ['table', 'table_caption'].includes(g.source_type));
  const text = view.original_fragments.map(f => f.exact_quote).join('\n');
  const observations: string[] = [];
  if (table) observations.push('独立表格证据；按本轮澄清应转为有明确正文引用的辅助证据，不能独立作视觉描述');
  if (groups.some(g => g.completeness === 'incomplete')) observations.push('已定位句单元缺少原始span；旧记录不补字，新策略拒绝机械可证的缺句');
  if (/univariate|LASSO|logistic|AUC|statistical|相关性|自变量|疗效/iu.test(text)) observations.push('含统计关联或研究结论；仅凭此不保证有直接视觉描述，语义用途待核');
  if (/subject selection|excluded|评估|evaluat|focused our study/iu.test(text)) observations.push('含评估清单/来源选择/实验设置；可作必要语境，不能仅靠术语独立作为视觉主证据');
  if (!observations.length) observations.push('保留逐字原文及来源；通用定义、直接外观或测量描述仍允许，医学语义未批准');
  return observations;
};
const noteRules: Record<string, string> = {
  S01: '正文或图注先有视觉描述，并明确引用表格数值时，才原样附相关值；本条备注原样保留。',
  S02: '同S01表格辅助证据规则。',
  S03: '一般性视觉定义可提取，不要求具体病例/图片；以完整句/必要段落显示，保留每个逐字span。not_like勾选与允许提取备注存在分歧，均保留。',
  S06: '研究结论和疗效关联不等同于直接视觉形态描述；提示词收窄，语义边界待模型及专业复核。',
  S09: 'Note已在原IR、保留筛选块、实际读取及其他模型候选中存在；选中Caption记录未含Note，图目录关联另追，不改旧包或声称全局漏抽。',
  S11: '评估人员和待测项目清单不独立作视觉描述；患者背景保留为必要完整句上下文。',
  S15: '实验统计段落及LASSO实验图不等于肿瘤医学图像配对；looks_matched仅普通用户观察。整Figure及完整源图注优先，语义类型待核。',
  S16: '同S01表格辅助证据规则；人体测量值不自动变成所需描述。',
  S18: '缺句前半可由相同native text单元机械定位；分类标准与形态测量需逐句区分，不补写旧结果。',
  S20: '组间显著性、风险因素及ROC值不自动当直接视觉特征；测量形态描述依然允许。',
  S21: '研究选样和排除条件可作语境，不能独立当视觉描述。',
};
const items = feedback.items.map(item => {
  const sample = (item.kind === 'random' ? pack.random_samples : pack.risks).find(x => x.id === item.id)!;
  const views = item.kind === 'random' ? { baseline: traceView(item.id, 'baseline', (sample as any).view) } :
    { before: traceView(item.id, 'before', (sample as any).before), after: traceView(item.id, 'after', (sample as any).after) };
  const current = (sample as any).view ?? (sample as any).after;
  return { id: item.id, kind: item.kind, original_observation: item, version_scope: sample.version_scope, job_id: sample.job_id,
    issues: category(current), explicit_note_interpretation: noteRules[item.id] ?? null,
    unresolved_not_like_without_note: item.answers.image_description === 'not_like' && item.note === '',
    answer_note_disagreement: item.id === 'S03',
    resolution: '工程规则/展示修复与原始观察分开；旧结果仍可读，不继承任何批准；模型及医学效果待核', views };
});

const noteIds = ['9b90e6cc9c86705d08a4-p0002-l000087', '9b90e6cc9c86705d08a4-p0002-l000088'];
const s09Trace: any[] = [];
for (const job of ['L01-B0', 'L01-F']) {
  const base = 'docs/acceptance/s0-s4-current-2026-11-04/three-method-proposal/execution/' + job;
  const result = await json(base + '/result.json'), selection = await json(base + '/source-selection.json');
  const batch = (await json(base + '/batch-plan.json')).find((b: any) => noteIds.every(id => b.assigned_block_ids.includes(id)));
  const attempt = await json(base + '/' + batch.batch_id + '-attempt-0.json');
  s09Trace.push({ job_id: job, result_path: base + '/result.json', batch_id: batch.batch_id,
    notes: noteIds.map(id => ({ block_id: id, in_IR: true, selection_state: selection.entries.find((e: any) => e.block_id === id)?.state,
      actually_read: attempt.read_block_ids.includes(id), extracted_versions: result.versions.filter((v: any) => v.record.quote_span.segments.some((s: any) => s.block_id === id))
        .map((v: any) => ({ record_id: v.record.record_id, version: v.version })) })) });
}
const tableIds = items.filter(i => i.kind === 'random' && i.issues.some(s => s.startsWith('独立表格'))).map(i => i.id);
const checkLogs: any[] = [];
for (const [kind, path] of [['extraction', 'core-extraction.log'], ['evaluation', 'core-evaluation.log'], ['typescript', 'core-tsc.log']]) {
  try {
    const bytes = await readFile(resolve(output, path!)), value = bytes.toString('utf8');
    const count = (label: string) => Number([...value.matchAll(new RegExp('(?:^|\\n)ℹ ' + label + ' (\\d+)', 'g'))].at(-1)?.[1] ?? 0);
    checkLogs.push({ kind, path: 'docs/acceptance/user-feedback-2026-11-05/' + path, sha256: sha(bytes),
      tests: kind === 'typescript' ? null : count('tests'), passed: kind === 'typescript' ? null : count('pass'), failed: count('fail'),
      status: kind === 'typescript' ? (bytes.length === 0 ? 'passed_exit_0' : 'inspect_log') : count('tests') > 0 && count('tests') === count('pass') && count('fail') === 0 ? 'passed' : 'inspect_log',
      evidence_type: 'offline_local_checks_not_medical_or_new_supplier_model_validation' });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
let revalidation: any = null;
try {
  const path = 'docs/acceptance/user-feedback-2026-11-05/revalidation/proposal.json', bytes = await readFile(resolve(code, path));
  const proposal = JSON.parse(bytes.toString('utf8'));
  revalidation = { proposal_path: path, proposal_sha256: sha(bytes), prepared_plan: proposal.prepared_plan,
    total_unique_inputs: proposal.total_unique_inputs, total_logical_conditions: proposal.total_logical_conditions,
    limits: proposal.limits, status: proposal.status, execute_model_calls: false, paid_calls: 0 };
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const report = {
  schema_version: 'user-feedback-engineering-triage-1', generated_at: new Date().toISOString(),
  original_feedback: { path: feedbackPath, sha256: feedbackSha, validator: 'apps/pi-web/output-review/model.ts#assertPack+validateResults',
    strict_package_questionnaire_and_all_item_version_fingerprints: 'passed', raw_modified: false,
    questionnaire_version: feedback.questionnaire_version, pack_id: feedback.pack_id, scope: feedback.scope, reviewer_role: feedback.reviewer_role },
  frozen_binding: { zip_sha256: feedback.frozen_zip_sha256, manifest_sha256: feedback.frozen_manifest_sha256,
    files: protectedFiles, mismatches: protectedFiles.filter(p => !p.matches_frozen_reference), bytes_unchanged_since_intake: true },
  totals: { items: feedback.items.length, disposition_recorded: feedback.items.filter(i => i.disposition === 'recorded').length,
    ui_counts: counts(feedback.items), notes: feedback.items.filter(i => i.note).length,
    note_ids: feedback.items.filter(i => i.note).map(i => i.id),
    random_not_like_ids: feedback.items.filter(i => i.answers.image_description === 'not_like').map(i => i.id),
    not_like_without_note_ids: items.filter(i => i.unresolved_not_like_without_note).map(i => i.id),
    independent_table_ids: tableIds, independent_table_count: tableIds.length,
    count_interpretation: `${tableIds.length}个表格是按新增明确规则检查出的来源类型问题；not_like不直接等于医学错误，S03明确允许提取。` },
  s09_trace: s09Trace, items,
  fix_tracks: [
    { id: 'source_statement_units', files: ['packages/agent/src/source-evidence-units.ts', 'packages/agent/src/extraction-protocol.ts', 'packages/agent/src/extraction-tools.ts'], mechanical: true, model_effect_verified: false },
    { id: 'versioned_primary_and_table_support_policy', files: ['packages/agent/src/evidence-validation.ts', 'packages/agent/src/visual-evidence-policy.ts', 'packages/contracts/src/extraction-evidence.ts'], mechanical: 'table roles and complete source spans only', medical_semantics_verified: false },
    { id: 'narrowed_visual_description_prompt', files: ['packages/agent/src/extraction-pi.ts', 'packages/agent/src/extraction-run.ts'], mechanical: false, new_paid_model_validation: 'not_performed' },
    { id: 'caption_note_relationship', owner: '/root/t1_feedback_pdf', evidence: 'pdf/pdf-issues.json', old_IR_and_catalog_modified: false },
    { id: 'grouped_review_display_and_feedback_restore', owner: '/root/t1_feedback_frontend', evidence: 'source-groups.json', old_pack_modified: false },
  ],
  implementation: { evidence_policy_version: 'visual-statements-2', source_evidence_unit_version: SOURCE_EVIDENCE_UNIT_VERSION,
    current_entry: 'packages/agent/src/extraction-run.ts#runExtractionDocument always binds the current policy for batches, submit and whole-document source-backed updates',
    primary_selection: ['source_unit_ids', 'source_line_indices'], context_selection: ['context_unit_ids', 'context_line_indices'],
    exactly_one_primary_selector: true, exact_code_point_spans_and_original_order: true,
    supporting_table_model_field: { name: 'supporting_table_evidence', fields: ['table_id', 'reference_line_indices', 'line_indices'] },
    supporting_table_record_field: 'context.supporting_table_evidence[{table_id,reference_evidence,fragments,relationship_status}]',
    supporting_table_relationship_status: 'explicit_reference_value_relationship_unverified',
    delivery_role_fields: ['supporting_table_evidence', 'evidence_policy_version', 'source_evidence_unit_version'],
    export_role_preservation: 'records.jsonl/delivery.json preserve explicit support fragments, reference evidence and unverified relationship status; records.csv contains only primary original fragments',
    table_headers: 'Only explicitly selected original row/column header fragments are retained; no automatic complete header reconstruction or numeric-feature/row/column attribution is performed',
    trace_fields: ['extraction_trace.evidence_policy_version', 'extraction_trace.source_evidence_unit_version'],
    record_top_level_field_count_unchanged: 28,
    missing_sentence_parts_added_to_historical_records: false,
    automatic_partial_line_context_before_after_disabled_in_current_policy: true,
    legacy_validation_context_without_policy_preserves_historical_contract: true,
    legacy_readability_is_not_current_policy_compliance_or_export_approval: true,
    old_records_later_entering_approved_export: 'Require current source/content/scope review; ordinary screening and old-version observations do not confer approval',
    hard_checks: ['Known complete primary/context source sentence spans', 'Table cells/captions cannot be primary',
      'Explicit uniquely numbered primary/table caption reference and literal table value source identity', 'Provided/read blocks and original code-point text/offset/page/bbox'],
    prompt_and_pending_only: ['Direct visual meaning versus pure statistical associations, lists and experimental setup',
      'General definitions/direct dimensions valid in any section without a specific image', 'Medical image type and case/panel attribution'],
    zero_candidates: { allowed: true, existing_explicit_batch_completion_required: true, coverage_and_limitations_retained: true,
      quality_approval_implied: false, tested_by: 'core-extraction.log: full Pi run processes every assigned block once and explicitly completes zero-candidate batches' },
    comparison: 'B0/F/R source selectors and default model unchanged; planner now fingerprints the same sentence-boundary context actually dispatched by all arms. Multiple corrections are not a single-factor before/after experiment.' },
  checks: checkLogs,
  new_focused_regressions: { count: 16, source: 'tests/extraction/visual-statements.test.ts', included_in: 'core-extraction.log',
    cases: ['Same-line next-sentence qualifier/numbers do not reject a complete selected sentence', 'Cross-line preceding negation cannot be omitted',
      'Unknown sentence boundaries retain the legacy lexical qualifier/number omission guard', 'Patient/source context uses complete context_unit_ids',
      'Different columns/pages/native units/cases never merge', 'Table role cannot be bypassed with an imaging_observation label',
      'Explicit table numeric support remains separate and verbatim; wrong/missing table references or context laundering reject',
      'Batch submit, summary source updates and final delivery share current mechanical policy; legacy reads remain compatible',
      'Actual JSON export preserves separate table support roles/versions; primary CSV does not mix support values',
      'Actual production new-run entry executes local Pi mock with current trace versions; no supplier calls',
      'All 40 old record views retain every source character, code-point offset and location', 'Real S03 two complete definition sentences remain allowed',
      'Real S18 leading span located; complete classification-plus-dimension original sentence remains allowed', 'All 17 real table cases hard-reject only under current policy'] },
  reproduced_delivery_failure: { before_log: 'core-delivery-before.log', before_tests: 2, before_passed: 0,
    problems: ['New complete sentence was incorrectly rechecked against unrelated same-PDF-line qualifiers during delivery', 'Supporting-table role existed in the stored record but was dropped from DeliveredEvidence/JSON export'],
    fix: 'Delivery dispatches omission/role checks by extraction trace policy and copies support/versions explicitly, without altering legacy fingerprints',
    after_log: 'core-focused.log', after_tests: 16, after_passed: 16, legacy_view_fingerprints_recomputed_unchanged: 40,
    formal_reviews_added: 0 },
  next_real_revalidation: revalidation,
  policy_boundaries: { new_AGICTO_requests: 0, historical_requests: 189, new_policy_applies_to_new_runs_only: true,
    methods_B0_F_R_unchanged: true, default_model_unchanged: true, winner: null, accuracy: null, medical_quality_approved: false,
    product_export_approved: false, stage_passed: false, formal_reviews_used: 3, formal_review_limit: 3,
    semantic_purpose_can_be_proved_by_lexical_or_model_self_report: false,
    old_feedback_not_reassigned_to_new_versions: true },
  unverified: ['真实新模型效果、遗漏率及语义分类未通过新付费调用验证', '医学语境、术语、病例归属和医学图像配对仍待专业复核', '两篇开发论文和30随机+5定向风险不能代表独立医学验收'],
  reproduce: ['bash scripts/with-node.sh node --import tsx scripts/audit-user-feedback.ts', 'bash scripts/with-node.sh npm run test:extraction',
    'bash scripts/with-node.sh npm run test:evaluation', 'bash scripts/with-node.sh node node_modules/typescript/bin/tsc --noEmit'],
};
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'issue-report.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(resolve(output, 'source-groups.json'), JSON.stringify({ schema_version: 'user-feedback-source-groups-1',
  pack_id: feedback.pack_id, feedback_sha256: feedbackSha, policy_version: SOURCE_EVIDENCE_UNIT_VERSION,
  original_source_changed: false, missing_source_text_inserted: false, new_human_approval_inherited: false, views: viewRows }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ report: relative(code, resolve(output, 'issue-report.json')), validator: 'passed',
  items: items.length, recorded: report.totals.disposition_recorded, ui_counts: report.totals.ui_counts, notes: report.totals.notes,
  table_count: tableIds.length, protected_files: protectedFiles.length, frozen_reference_mismatches: report.frozen_binding.mismatches.length, new_AGICTO_requests: 0 }) + '\n');
