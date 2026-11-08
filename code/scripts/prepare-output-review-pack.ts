import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError, type EvidenceVersion, type FigureAssetCatalog, type LocatedEvidenceFragment } from '@t1/contracts';
import type { ExtractionDocument } from '../packages/agent/src/article-scope.js';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { assertLivePdfSource } from '../packages/agent/src/figure-assets.js';
import { allDeliveredRecords, deliveryRecordCounts, buildEvidenceDelivery, evidenceDigest, type DeliveredEvidence, type EvidenceDelivery } from '../packages/agent/src/evidence-delivery.js';
import { currentEvidenceVersions, exactFragmentGroup, renderReviewPackHtml, REVIEW_PACK_ALGORITHM, REVIEW_PACK_METHOD, REVIEW_PACK_SCHEMA,
  selectVersionedOutputSample, type PackFragment } from '../evaluation/src/output-review-pack.js';

const run = promisify(execFile);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Obj = Record<string, any>;
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Obj;
const assertSame = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new ContractError('review_pack_' + label);
};
const figureStatus = (status: string) => ({ paired: '程序已关联，图文/整图均未人核', pending: '图文待核，未批准',
  not_checked: '未检查图文', no_explicit_reference: '无显式图文关联（不代表无图）' })[status] ?? status;

export async function prepareReviewPack(options: {
  codeRoot: string; directory: string; summaryReport: string; pairedDirectory: string; output: string; seed: string; countPerJob: number;
}) {
  const code = await realpath(options.codeRoot);
  const inside = async (path: string) => {
    const actual = await realpath(resolve(code, path)), rel = relative(code, actual);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('review_pack_path_outside_code');
    return actual;
  };
  const directory = await inside(options.directory), paired = await inside(options.pairedDirectory), summaryPath = await inside(options.summaryReport);
  const output = resolve(code, options.output), outputParent = await inside(dirname(output));
  if (relative(code, output).startsWith('..') || output === code) throw new ContractError('review_pack_output_outside_code');
  if (await stat(output).then(() => true, () => false)) throw new ContractError('review_pack_output_exists');
  const planPath = join(directory, 'plan.json'), reportPath = join(directory, 'execution/report.json');
  const plan = await readJson(planPath), report = await readJson(reportPath), summary = await readJson(summaryPath);
  const manifestPath = join(paired, 'manifest.json'), pairedManifest = await readJson(manifestPath);
  assertSame(sha(await readFile(planPath)), pairedManifest.parent_plan_sha256, 'parent_plan_changed');
  assertSame(sha(await readFile(manifestPath)), summary.manifest_sha256, 'paired_manifest_changed');
  assertSame(sha(await readFile(reportPath)), summary.fixed_baseline_report_sha256, 'baseline_report_changed');
  if (!options.seed.trim() || !Number.isSafeInteger(options.countPerJob) || options.countPerJob < 1) throw new ContractError('review_pack_selection_invalid');

  const protectedPaths = new Set<string>();
  const protectTree = async (path: string) => {
    const actual = await inside(path);
    if ((await stat(actual)).isDirectory()) {
      for (const entry of await readdir(actual, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new ContractError('review_pack_protected_symlink_refused');
        await protectTree(join(actual, entry.name));
      }
    } else protectedPaths.add(actual);
  };
  await protectTree(directory); await protectTree(paired); protectedPaths.add(summaryPath);
  const owner = await readJson(join(directory, 'execution/budget-owner.json')), ledgerPath = await inside(owner.ledger), ledger = await readJson(ledgerPath);
  protectedPaths.add(ledgerPath);
  const counted = { requests: ledger.requests.length, input_tokens: ledger.requests.reduce((sum: number, r: Obj) => sum + r.input_tokens, 0),
    output_tokens: ledger.requests.reduce((sum: number, r: Obj) => sum + r.output_tokens, 0), settled: ledger.requests.filter((r: Obj) => r.finished_at).length,
    missing_usage: ledger.requests.filter((r: Obj) => r.usage_status !== 'provider_reported').length, halted: ledger.halted };
  assertSame(counted, summary.cumulative_ledger_totals, 'ledger_totals_changed');
  assertSame(sha(await readFile(ledgerPath)), summary.ledger_sha256, 'ledger_changed');
  for (const [path, expected] of Object.entries(pairedManifest.baseline_runtime_source_hashes as Record<string, string>)) {
    const actual = await inside(path); assertSame(sha(await readFile(actual)), expected, 'frozen_runtime_source_changed'); protectedPaths.add(actual);
  }
  const frozenCount = Object.keys(pairedManifest.baseline_runtime_source_hashes).length;
  const protectDatabases = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await protectDatabases(next);
      else if (/\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/u.test(entry.name)) protectedPaths.add(next);
    }
  };
  await protectDatabases(join(code, 'runtime-data'));
  const paperMap = new Map<string, { paper: Obj; document: ExtractionDocument; catalog: FigureAssetCatalog }>();
  const inputs: Record<string, string> = {};
  const bindInput = async (path: string, expected?: string) => {
    const actual = await inside(path), digest = sha(await readFile(actual));
    if (expected && digest !== expected) throw new ContractError('review_pack_source_hash_changed');
    protectedPaths.add(actual); inputs[relative(code, actual)] = digest; return actual;
  };
  for (const paper of plan.papers as Obj[]) {
    await bindInput(paper.pdf_path, paper.pdf_sha256);
    const ir = await readJson(await bindInput(paper.ir_path, paper.ir_sha256));
    const document = (ir.document ?? ir) as ExtractionDocument; assertParsedDocument(document); await assertLivePdfSource(document);
    if (document.fixture || document.document_id !== paper.document_id || document.text_version !== paper.text_version || document.file_sha256 !== paper.pdf_sha256) {
      throw new ContractError('review_pack_document_identity_mismatch');
    }
    const catalog = await readJson(await bindInput(paper.figure_catalog_path, paper.figure_catalog_sha256)) as FigureAssetCatalog;
    for (const [path, expected] of Object.entries(paper.assets as Record<string, string>)) await bindInput(path, expected);
    paperMap.set(paper.document_id, { paper, document, catalog });
  }
  await bindInput(planPath); await bindInput(reportPath); await bindInput(summaryPath); await bindInput(manifestPath); await bindInput(ledgerPath);
  await bindInput(join(dirname(directory), 'index.json'));
  await bindInput(join(directory, 'automatic-audit-final/comparison.json'));
  await bindInput(join(directory, 'automatic-audit-final/review.html'));
  const snapshotProtected = async () => {
    const entries = await Promise.all([...protectedPaths].sort().map(async path => [relative(code, path), sha(await readFile(path))]));
    return { count: entries.length, digest: evidenceDigest(entries) };
  };
  const beforeProtected = await snapshotProtected();

  const jobs: Array<{ job: Obj; paper: Obj; document: ExtractionDocument; catalog: FigureAssetCatalog; result: Obj; resultPath: string;
    resultSha: string; delivery: EvidenceDelivery; versions: Map<string, EvidenceVersion> }> = [];
  const reuse = (report.jobs as Obj[]).filter(j => j.independent_model_run !== true).map(j => ({ job_id: j.job_id, representative_job_id: j.representative_job_id,
    independent_model_run: false, extra_sample_count: 0, explanation: '等价输入复用，不作为第6次独立提取或额外样本；成本归属仍引用代表方法。' }));
  for (const row of (report.jobs as Obj[]).filter(j => j.independent_model_run === true)) {
    const documentId = row.job_id.split('-')[0]!, source = paperMap.get(documentId);
    if (!source) throw new ContractError('review_pack_job_document_missing');
    const job = source.paper.methods.jobs.find((j: Obj) => j.job_id === row.job_id);
    if (!job || job.independent_model_run !== true || job.representative_job_id) throw new ContractError('review_pack_job_reuse_mismatch');
    const resultPath = await bindInput(row.result_path), result = await readJson(resultPath), resultSha = inputs[relative(code, resultPath)]!;
    if (result.document_id !== documentId || result.source_selection_digest !== job.source_selection_digest || result.model_id !== plan.config.model.model_id ||
      result.reasoning_effort !== plan.config.model.reasoning_effort || !Array.isArray(result.versions)) throw new ContractError('review_pack_result_identity_mismatch');
    const versions = currentEvidenceVersions(result.versions);
    for (const v of versions.values()) if (v.actor !== 'automatic' || v.record.review_events.length || v.record.extraction_trace.run_id !== result.run_id ||
      v.record.review_status === 'approved') throw new ContractError('review_pack_unexpected_human_or_run_state');
    const delivery = buildEvidenceDelivery(source.document, result.versions, source.catalog);
    assertSame(allDeliveredRecords(delivery).length, row.candidate_count, 'candidate_count_mismatch');
    jobs.push({ job, ...source, result, resultPath, resultSha, delivery, versions });
  }
  const duplicateMap = new Map<string, Obj[]>();
  for (const job of jobs) for (const record of allDeliveredRecords(job.delivery)) {
    const key = exactFragmentGroup(job.document.file_sha256, job.document.text_version, record.original_fragments);
    const occurrences = duplicateMap.get(key) ?? [];
    occurrences.push({ job_id: job.job.job_id, record_id: record.record_id, record_version: record.record_version,
      delivery_fingerprint: record.delivery_fingerprint }); duplicateMap.set(key, occurrences);
  }
  const fragments: PackFragment[] = [];
  const literalGroupIds = new Map([...duplicateMap.keys()].sort().map((key, index) => [key, 'G' + String(index + 1).padStart(3, '0')]));
  const addFragments = (ownerId: string, arm: string, role: string, source: typeof jobs[number], items: readonly LocatedEvidenceFragment[]) => {
    for (const [index, item] of items.entries()) {
      const structure = (source.document as any).structure;
      const units = (structure?.units ?? []).filter((u: Obj) => (u.source_segments ?? []).some((s: Obj) => s.block_id === item.block_id && s.start < item.end && item.start < s.end));
      const tableCells = (structure?.tables ?? []).flatMap((table: Obj) => (table.cells ?? []).filter((c: Obj) =>
        (c.source_segments ?? []).some((s: Obj) => s.block_id === item.block_id && s.start < item.end && item.start < s.end)).map((c: Obj) => `${table.table_id}:${c.cell_id ?? `${c.row_index},${c.column_index}`}`));
      const caption = source.catalog.figures.some(f => f.caption_segments.some(s => s.block_id === item.block_id && s.start < item.end && item.start < s.end));
      const sourceType = caption ? '图注（机器定位；未人核）' : tableCells.length || units.some((u: Obj) => u.kind === 'table_cell') ? '表格（机器定位；未人核）'
        : units.length ? '正文/其他结构源行（机器定位；未人核）' : '未分类源行（待核）';
      fragments.push({ fragment_id: 'F' + String(fragments.length + 1).padStart(5, '0'), owner_id: ownerId, arm, role, ordinal: index + 1,
        document_id: source.document.document_id, physical_page: item.physical_page, block_id: item.block_id, text_version: item.text_version,
        start: item.start, end: item.end, exact_quote: item.exact_quote, bbox: item.bbox, location_precision: item.location_precision,
        source_type: sourceType, source_structure: [...units.map((u: Obj) => `${u.kind}:${u.unit_id}(${u.mapping?.status ?? 'unknown'})`), ...tableCells],
        pdf_path: `pdf/${source.document.document_id}.pdf`, file_sha256: source.document.file_sha256 });
    }
  };
  const makeView = (ownerId: string, arm: string, source: typeof jobs[number], delivered: DeliveredEvidence, version: EvidenceVersion, resultPath: string, resultSha: string) => {
    const record = version.record;
    addFragments(ownerId, arm, '提取原文（独立片段）', source, delivered.original_fragments);
    addFragments(ownerId, arm, '记录上下文（非提取原文）', source, delivered.context_fragments);
    const existing = new Set([...delivered.original_fragments, ...delivered.context_fragments].map(f => evidenceDigest(f)));
    const fieldEvidence = [record.disease_or_lesion, record.modality, record.sequence_or_phase, record.context.source_attribution, record.assertion,
      record.applicability, ...record.numeric_expressions].flatMap((v: any) => v?.evidence ?? []) as LocatedEvidenceFragment[];
    const extra: LocatedEvidenceFragment[] = [];
    for (const fragment of fieldEvidence) if (!existing.has(evidenceDigest(fragment))) { extra.push(fragment); existing.add(evidenceDigest(fragment)); }
    addFragments(ownerId, arm, '字段依据（非提取原文）', source, extra);
    return { document_id: record.document_id, record_id: record.record_id, record_version: version.version, version_actor: version.actor,
      run_id: delivered.run_id, result_path: relative(code, resultPath), result_sha256: resultSha,
      source_record_sha256: delivered.source_record_sha256, text_fingerprint: delivered.text_fingerprint, delivery_fingerprint: delivered.delivery_fingerprint,
      file_sha256: source.document.file_sha256, text_version: source.document.text_version,
      physical_pages: [...new Set(delivered.original_fragments.map(f => f.physical_page))].sort((a, b) => a - b),
      source_types: [...new Set(fragments.filter(f => f.owner_id === ownerId && f.arm === arm && f.role.startsWith('提取')).map(f => f.source_type))],
      original_fragments: delivered.original_fragments, context_fragments: delivered.context_fragments,
      figure_association: delivered.figure_association, figure_status_label: figureStatus(delivered.figure_association.status),
      primary_assessment: delivered.primary_assessment ?? null,
      figure_ids: [...new Set([...delivered.figure_association.figure_ids, ...delivered.figure_association.proposed_figure_ids])],
      fields: { feature_name_raw: record.feature_name_raw, feature_category: record.feature_category, evidence_type: record.evidence_type,
        disease_or_lesion: record.disease_or_lesion, modality: record.modality, sequence_or_phase: record.sequence_or_phase,
        numeric_expressions: record.numeric_expressions, assertion: record.assertion, applicability: record.applicability,
        ...(record.context.supporting_table_evidence ? { supporting_table_evidence: record.context.supporting_table_evidence } : {}),
        ...(record.extraction_trace.evidence_policy_version ? { evidence_policy_version: record.extraction_trace.evidence_policy_version,
          source_evidence_unit_version: record.extraction_trace.source_evidence_unit_version } : {}),
        source_attribution: record.context.source_attribution, context_status: record.context.status, review_status: record.review_status,
        automatic_checks_status: record.evidence_validation.automatic_checks.status,
        automatic_issue_codes: record.evidence_validation.issues.map(i => i.code), automatic_issues: record.evidence_validation.issues,
        duplicate_and_conflict_links: record.duplicate_and_conflict_links },
      human_approved: false, product_export_approved: false };
  };
  const selections = jobs.map(job => ({ job, prepared: selectVersionedOutputSample(job.delivery, { jobId: job.job.job_id, count: options.countPerJob, seed: options.seed }) }));
  const randomSamples: Obj[] = [];
  for (const { job, prepared } of selections) for (const delivered of prepared.records) {
    const id = 'S' + String(randomSamples.length + 1).padStart(2, '0'), key = exactFragmentGroup(job.document.file_sha256, job.document.text_version, delivered.original_fragments);
    randomSamples.push({ id, version_scope: 'original_baseline_current_active_version', job_id: job.job.job_id, method: job.job.label,
      selection_unit: prepared.selection_units[prepared.records.indexOf(delivered)], exact_fragment_group: literalGroupIds.get(key), exact_fragment_group_sha256: key,
      duplicate_occurrences: duplicateMap.get(key), view: makeView(id, 'baseline', job, delivered, job.versions.get(delivered.record_id)!, job.resultPath, job.resultSha) });
  }
  const riskIds = new Map<string, Set<string>>();
  const riskReasons = new Map<string, string[]>();
  const registerRisk = (jobId: string, recordId: string, reason: string) => {
    const ids = riskIds.get(jobId) ?? new Set(); ids.add(recordId); riskIds.set(jobId, ids);
    const key = jobId + '/' + recordId, reasons = riskReasons.get(key) ?? []; reasons.push(reason); riskReasons.set(key, reasons);
  };
  for (const risk of summary.context_and_field_risks as Obj[]) for (const observation of risk.observations as Obj[]) {
    for (const id of observation.record_ids ?? [observation.record_id]) registerRisk(risk.job_id, id, observation.risk);
  }
  for (const pair of summary.pairs as Obj[]) for (const change of pair.remaining_delivery_field_changes as Obj[]) {
    for (const field of change.changes as Obj[]) if (field.field === 'review_status') {
      registerRisk(pair.job_id, change.record_id, `汇总实验自动待核状态由${field.before}变为${field.after}。两者均未获人工批准；请核查语境与状态含义，不能把变化算成人审通过。`);
    }
  }
  const risks: Obj[] = [];
  for (const [jobId, ids] of [...riskIds.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const source = jobs.find(j => j.job.job_id === jobId)!;
    if (!source) throw new ContractError('review_pack_risk_job_missing');
    const pair = (summary.pairs as Obj[]).find(p => p.job_id === jobId)!;
    await bindInput(pair.pair_report_path, pair.pair_report_sha256);
    const arms: Record<string, { result: Obj; versions: Map<string, EvidenceVersion>; delivery: EvidenceDelivery; path: string; sha: string }> = {};
    for (const arm of ['before', 'after']) {
      const path = await bindInput(join(paired, jobId, arm, 'result.json')), result = await readJson(path);
      if (!result.completed || result.actual_human_reviewed_count !== 0 || result.medical_quality_approved !== false) throw new ContractError('review_pack_risk_arm_state_invalid');
      arms[arm] = { result, versions: currentEvidenceVersions(result.versions), delivery: buildEvidenceDelivery(source.document, result.versions, source.catalog), path, sha: sha(await readFile(path)) };
    }
    for (const recordId of [...ids].sort()) {
      const id = 'K' + String(risks.length + 1).padStart(2, '0');
      const views = Object.fromEntries(['before', 'after'].map(arm => {
        const data = arms[arm]!, version = data.versions.get(recordId), delivery = allDeliveredRecords(data.delivery).find(r => r.record_id === recordId);
        if (!version || !delivery || version.actor !== 'automatic' || version.record.review_events.length) throw new ContractError('review_pack_risk_version_missing');
        return [arm, makeView(id, arm, source, delivery, version, data.path, data.sha)];
      })) as Record<string, ReturnType<typeof makeView>>;
      const before = views.before!, after = views.after!;
      assertSame(before.original_fragments, after.original_fragments, 'risk_original_text_changed');
      assertSame(before.context_fragments, after.context_fragments, 'risk_original_context_changed');
      const project = (view: typeof before) => ({
        disease_or_lesion: { value: view.fields.disease_or_lesion.value, status: view.fields.disease_or_lesion.status },
        sequence_or_phase: view.fields.sequence_or_phase ? { value: view.fields.sequence_or_phase.value, status: view.fields.sequence_or_phase.status } : null,
        numeric_expressions: view.fields.numeric_expressions.map(n => ({ original_text: n.original_text, unit_original: n.unit_original })),
        review_status: view.fields.review_status, automatic_issue_codes: view.fields.automatic_issue_codes,
      });
      const oldFields = project(before), newFields = project(after);
      const changes = Object.keys(oldFields).filter(field => JSON.stringify((oldFields as Obj)[field]) !== JSON.stringify((newFields as Obj)[field]))
        .map(field => ({ field, before: (oldFields as Obj)[field], after: (newFields as Obj)[field] }));
      if (!changes.length) throw new ContractError('review_pack_risk_no_actual_difference');
      risks.push({ id, job_id: jobId, method: source.job.label, version_scope: 'fresh_matched_summary_experiment_before_after_not_baseline',
        record_id: recordId, before, after, reasons: riskReasons.get(jobId + '/' + recordId), changes,
        baseline_random_ids: randomSamples.filter(s => s.job_id === jobId && s.view.record_id === recordId).map(s => s.id),
        baseline_current_version: source.versions.get(recordId)?.version, counted_in_random_statistics: false });
    }
  }
  const neededFigures = new Set([...randomSamples.map(s => s.view), ...risks.flatMap(r => [r.before, r.after])]
    .flatMap(v => v.figure_ids.map((id: string) => v.document_id + '/' + id)));
  const figures: Obj[] = [];
  for (const [documentId, source] of paperMap) for (const figure of source.catalog.figures) {
    if (!neededFigures.has(documentId + '/' + figure.figure_id)) continue;
    const job = jobs.find(j => j.document.document_id === documentId)!;
    addFragments(documentId + '-' + figure.figure_id, 'caption', '原图注（独立片段）', job, figure.caption_segments);
    figures.push({ ...figure, document_id: documentId, assets: figure.regions.map(asset => ({ ...asset, pack_path: `figures/${documentId}-${asset.asset_id}.png` })),
      status_label: figure.verification.status === 'mechanically_checked' ? '机械整图检查通过，人工未核' : 'Figure/整图/图注关联待核，人工未核' });
  }
  const pack: Obj = { schema_version: REVIEW_PACK_SCHEMA, generated_at: new Date().toISOString(),
    purpose: '用户选择的开发输出人工筛查；不是医学验收或产品批准', actual_human_reviewed_count: 0, medical_quality_approved: false,
    product_export_approved: false, formal_sample_count: null, quality_thresholds: null, accuracy: null, recall: null, winner: null, paid_calls: 0,
    selection: { seed: options.seed, algorithm: REVIEW_PACK_ALGORITHM, method: REVIEW_PACK_METHOD, per_actual_job: options.countPerJob,
      actual_jobs: jobs.length, independent_papers: paperMap.size, baseline_candidate_count: jobs.reduce((n, j) => n + allDeliveredRecords(j.delivery).length, 0),
      selected_count: randomSamples.length, selected_version_units_sha256: evidenceDigest(selections.flatMap(({ prepared }) => prepared.selection_units)),
      job_samples: selections.map(({ job, prepared }) => ({ job_id: job.job.job_id, method: job.job.label,
        source_result_path: relative(code, job.resultPath), source_result_sha256: job.resultSha, output_count: allDeliveredRecords(job.delivery).length, ...deliveryRecordCounts(job.delivery),
        count: prepared.count, seed: prepared.seed, selected_version_units: prepared.selection_units })), reuse },
    papers: [...paperMap.values()].map(({ paper }) => ({ document_id: paper.document_id, article_family_id: paper.article_family_id,
      pdf_path: paper.pdf_path, pdf_sha256: paper.pdf_sha256, ir_path: paper.ir_path, ir_sha256: paper.ir_sha256, text_version: paper.text_version,
      figure_catalog_path: paper.figure_catalog_path, figure_catalog_sha256: paper.figure_catalog_sha256, source_use: paper.source_use,
      parser_status: paper.parser_status, pack_pdf: `pdf/${paper.document_id}.pdf` })),
    source_inputs: inputs, original_ledger: { path: relative(code, ledgerPath), sha256: sha(await readFile(ledgerPath)), totals: counted },
    random_samples: randomSamples, risks, fragments, figures,
    formal_review: { used: 3, maximum: 3, remaining: 0, new_formal_review_started: false },
    approval_boundary: 'Sampling and workbook readback never write application approvals. Text confirmation does not approve images.' };
  pack.pack_id = evidenceDigest({ schema: pack.schema_version, selection: pack.selection, inputs,
    random: randomSamples.map(s => [s.id, s.view.record_id, s.view.record_version, s.view.delivery_fingerprint]),
    risks: risks.map(r => [r.id, r.job_id, r.record_id, r.before.record_version, r.before.delivery_fingerprint, r.after.record_version, r.after.delivery_fingerprint]) });
  for (const { job, prepared } of selections) assertSame(prepared.selection_units, selectVersionedOutputSample(job.delivery,
    { jobId: job.job.job_id, count: options.countPerJob, seed: options.seed }).selection_units, 'seed_reproduction_failed');
  const stage = await mkdtemp(join(outputParent, '.output-review-build-'));
  let finalCreated = false;
  try {
    await mkdir(join(stage, 'pdf')); await mkdir(join(stage, 'figures'));
    for (const { paper } of paperMap.values()) await cp(await inside(paper.pdf_path), join(stage, `pdf/${paper.document_id}.pdf`), { errorOnExist: true });
    for (const figure of figures) for (const asset of figure.assets) {
      assertSame(sha(await readFile(await inside(asset.path))), asset.sha256, 'figure_asset_hash_changed');
      await cp(await inside(asset.path), join(stage, asset.pack_path), { errorOnExist: true });
    }
    const packPath = join(stage, 'pack-manifest.json');
    await writeFile(packPath, JSON.stringify(pack, null, 2) + '\n', { flag: 'wx' });
    const workbookHelper = join(code, 'scripts/lib/output-review-workbook.py'), python = join(code, '.venv/bin/python');
    const rendered = await run(python, [workbookHelper, 'render', packPath, join(stage, '核验表.xlsx')], { cwd: code, maxBuffer: 2 ** 20 });
    const readback = JSON.parse(rendered.stdout);
    if (!readback.all_manual_fields_blank || readback.random_signed_complete_rows || readback.risk_signed_complete_rows || readback.product_export_approved ||
      readback.random_rows !== randomSamples.length || readback.risk_rows !== risks.length) throw new ContractError('review_pack_blank_human_boundary_failed');
    await writeFile(join(stage, 'review.html'), renderReviewPackHtml(pack), { flag: 'wx' });
    const html = await readFile(join(stage, 'review.html'), 'utf8');
    const anchors = new Set([...html.matchAll(/\bid="([^"]+)"/gu)].map(m => m[1]!));
    let linkCount = 0;
    for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/gu)) {
      const target = match[1]!.replace(/&amp;/gu, '&');
      if (target.startsWith('#')) { if (!anchors.has(target.slice(1))) throw new ContractError('review_pack_anchor_missing'); }
      else {
        const path = target.split('#')[0]!;
        if (/^[a-z]+:/iu.test(path) || path.startsWith('/') || path.split('/').includes('..')) throw new ContractError('review_pack_nonlocal_link');
        await stat(join(stage, path));
      }
      linkCount += 1;
    }
    // Compare exported literals to their bound IR one final time, independently of the workbook renderer.
    for (const fragment of fragments) {
      const document = paperMap.get(fragment.document_id)!.document, block = document.blocks.find(b => b.block_id === fragment.block_id)!;
      assertSame([...block.text].slice(fragment.start, fragment.end).join(''), fragment.exact_quote, 'fragment_literal_not_preserved');
      assertSame(block.page, fragment.physical_page, 'fragment_page_changed');
    }
    const afterProtected = await snapshotProtected();
    assertSame(afterProtected, beforeProtected, 'protected_original_bytes_changed');
    pack.preservation = { protected_file_count: beforeProtected.count, before_sha256: beforeProtected.digest, after_sha256: afterProtected.digest,
      all_protected_bytes_unchanged: true, frozen_runtime_source_count: frozenCount, frozen_runtime_sources_unchanged: true,
      original_database_connections_opened: 0, original_source_or_result_writes: 0 };
    pack.validation = { seed_reproduction: true, random_count: randomSamples.length, count_per_actual_job: options.countPerJob, risk_count: risks.length,
      random_and_risk_versions_separate: true, exact_literal_fragments_checked: fragments.length, local_html_links_checked: linkCount,
      workbook_readback: readback, source_pdf_and_asset_hashes_checked: true, human_or_medical_checks_performed: 0, new_paid_requests: 0,
      ooxml_literal_authority: 'Raw sharedStrings/inlineStr single-pass OOXML decoding; openpyxl unescaped display strings alone are not sufficient for source control characters. No source characters removed or replaced.',
      source_control_codepoints_preserved: true, actual_Office_or_other_spreadsheet_visual_display_verified: false,
      source_control_counts: { pack_fragment_rows: fragments.filter(f => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(f.exact_quote)).length,
        unique_source_blocks: new Set(fragments.filter(f => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(f.exact_quote))
          .map(f => JSON.stringify([f.document_id, f.text_version, f.block_id]))).size,
        interpretation: 'Counts of pack fragment rows and distinct source blocks, not counts of independent PDF errors; original-PDF fidelity is unreviewed.' } };
    pack.artifacts = {};
    for (const path of ['核验表.xlsx', 'review.html', ...pack.papers.map((p: Obj) => p.pack_pdf), ...figures.flatMap(f => f.assets.map((a: Obj) => a.pack_path))]) {
      pack.artifacts[path] = sha(await readFile(join(stage, path)));
    }
    await writeFile(packPath, JSON.stringify(pack, null, 2) + '\n');
    const zipPath = join(stage, '真实输出人工核验包.zip');
    await run(python, ['-c', 'import sys, pathlib, zipfile; root=pathlib.Path(sys.argv[1]); files=sys.argv[3:]; z=zipfile.ZipFile(sys.argv[2],"x",compression=zipfile.ZIP_DEFLATED); [z.write(root/p,p) for p in files]; z.close()', stage, zipPath,
      'pack-manifest.json', ...Object.keys(pack.artifacts)], { cwd: code });
    const inspected = await run(python, [workbookHelper, 'inspect', zipPath], { cwd: code, maxBuffer: 2 ** 20 });
    const zipReadback = JSON.parse(inspected.stdout);
    if (!zipReadback.all_manual_fields_blank || zipReadback.random_rows !== randomSamples.length || zipReadback.risk_rows !== risks.length ||
      zipReadback.product_export_approved) throw new ContractError('review_pack_zip_readback_failed');
    await mkdir(output, { recursive: false }); finalCreated = true;
    const finalZip = join(output, '真实输出人工核验包.zip'); await cp(zipPath, finalZip, { errorOnExist: true });
    const finalManifest = { schema_version: 'offline-output-review-distribution-1', pack_id: pack.pack_id, generated_at: pack.generated_at,
      zip: { path: relative(code, finalZip), sha256: sha(await readFile(finalZip)), bytes: (await stat(finalZip)).size },
      inner_manifest: { path: 'pack-manifest.json', sha256: sha(await readFile(packPath)) },
      workbook_path_in_zip: '核验表.xlsx', start_here: '完整解压ZIP后，先打开核验表.xlsx的说明页；黄色栏人工填写，无法判断选待核；另存核验表-已填写.xlsx。',
      random: { count: randomSamples.length, per_actual_job: options.countPerJob, jobs: selections.map(({ job, prepared }) => ({ job_id: job.job.job_id, count: prepared.count })),
        seed: options.seed, algorithm: REVIEW_PACK_ALGORITHM, selected_version_units_sha256: pack.selection.selected_version_units_sha256,
        baseline_candidates: pack.selection.baseline_candidate_count, independent_papers: paperMap.size, reuse },
      risk: { count: risks.length, independent_from_random_statistics: true, version_scope: 'summary experiment before/after; not baseline',
        records: risks.map(r => ({ risk_id: r.id, job_id: r.job_id, record_id: r.record_id, before_version: r.before.record_version,
          after_version: r.after.record_version, baseline_random_ids: r.baseline_random_ids })) },
      contents: { worksheets: ['说明', '30条随机样本', '原文与出处', '5条实验风险'], source_pdfs: paperMap.size, original_image_assets: figures.reduce((n, f) => n + f.assets.length, 0),
        source_fragment_rows: fragments.length, archive_files: Object.keys(pack.artifacts).length + 1 },
      preservation: pack.preservation, verification: pack.validation, zip_readback: zipReadback,
      actual_human_reviewed_count: 0, new_paid_requests: 0, product_export_approved: false, medical_quality_approved: false,
      formal_sample_count: null, quality_thresholds: null, accuracy: null, recall: null, winner: null,
      inspect_returned_workbook: '在code/运行：.venv/bin/python scripts/lib/output-review-workbook.py inspect <本ZIP路径> <返回的已填写XLSX路径>；只读回核对，不写产品审批或原数据库。',
      limitations: ['尚未进行真实人工/医学核验；此材料本身不是阶段验收。', 'PDF锚点可在部分阅读器中被忽略，须按标明物理页定位。', '原始Figure目录inventory_complete=false；机械检查不等于人工整图核验。', '源文本层的U+0007等控制字符原样保留并提示；Office/各表格软件实际视觉显示尚未验证，须回看PDF，不将控制字符当成已确认论文文字。', '只记录工作样本，不冻结正式验收样本量/阈值，不声称医学准确率、全文召回或赢家。'],
      generator_sources: Object.fromEntries(await Promise.all(['scripts/prepare-output-review-pack.ts', 'scripts/lib/output-review-workbook.py', 'evaluation/src/output-review-pack.ts']
        .map(async path => [path, sha(await readFile(join(code, path)))]))) };
    await writeFile(join(output, 'manifest.json'), JSON.stringify(finalManifest, null, 2) + '\n', { flag: 'wx' });
    return { output: relative(code, output), zip: relative(code, finalZip), manifest: relative(code, join(output, 'manifest.json')),
      random_count: randomSamples.length, job_counts: finalManifest.random.jobs, risk_count: risks.length, source_fragments: fragments.length,
      figure_assets: finalManifest.contents.original_image_assets, protected_files_unchanged: beforeProtected.count, frozen_sources_unchanged: frozenCount,
      actual_human_reviewed_count: 0, paid_calls: 0, product_export_approved: false };
  } catch (error) {
    if (finalCreated) await rm(output, { recursive: true, force: true });
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help') {
    process.stdout.write('prepare-output-review-pack.ts --directory COMPARISON --summary-report REPORT --paired-directory PAIRED --seed TEXT --per-job N --output NEW_DIRECTORY\nOffline only. Final directory contains one ZIP and checksum manifest. All human fields remain blank.\n'); return;
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--directory', '--summary-report', '--paired-directory', '--seed', '--per-job', '--output'].includes(args[i]!) || !args[i + 1] || flags.has(args[i]!)) {
      throw new ContractError('review_pack_arguments_invalid');
    }
    flags.set(args[i]!, args[i + 1]!);
  }
  if (flags.size !== 6) throw new ContractError('review_pack_arguments_required');
  process.stdout.write(JSON.stringify(await prepareReviewPack({ codeRoot: process.cwd(), directory: flags.get('--directory')!, summaryReport: flags.get('--summary-report')!,
    pairedDirectory: flags.get('--paired-directory')!, output: flags.get('--output')!, seed: flags.get('--seed')!, countPerJob: Number(flags.get('--per-job')) })) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
