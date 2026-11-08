import type { Figure, Fragment } from "./types";
import type { SourceGroup } from "./source-groups";

export type ReaderUsage = { requests: number; input_tokens: number; output_tokens: number; actual_cost: number | null; cost_status: string };
export type ReaderJob = ReaderUsage & {
  job_id: string;
  actual_job_id?: string;
  round_id: string;
  document_id: string;
  method: "B0" | "F" | "R";
  label?: string;
  state: string;
  independent_model_run: boolean;
  reused_from_job_id?: string | null;
  candidate_count: number;
  delivered_count: number;
  diagnostic_counts?: Record<string, number>;
  notes?: string[];
  attempts?: (Partial<ReaderUsage> & { attempt?: number; state?: string; outcome_reason?: string; result_path?: string; candidate_count?: number; partial_records?: ReaderRecord[] })[];
  outcome_reason?: string | null;
  summary_complete?: boolean;
  source_processing_complete?: boolean;
  seconds?: number;
  total_seconds?: number;
  representative_measurement?: ReaderUsage;
};
export type ReaderRecord = {
  record_id: string;
  job_id: string;
  document_id: string;
  record_version: number;
  source_record_sha256: string;
  original_groups: SourceGroup[];
  context_groups: SourceGroup[];
  figure_ids: string[];
  automatic_checks: { code: string; status: string; detail: string }[];
  semantic_review_notes?: string[];
};
export type ReaderIssue = {
  old_item_id: string;
  old_note: string;
  document_id: string;
  old_original_groups: SourceGroup[];
  old_context_groups: SourceGroup[];
  new_record_ids: string[];
  relation: "source_overlap_only" | "no_direct_match";
  automatic_observations: string[];
};
export type ReaderManifest = {
  schema_version: "feedback-revalidation-reader-1";
  batch_id: string;
  finalized_at: string;
  actual_model_outputs: true;
  default_round_id?: string;
  usage_totals: ReaderUsage;
  rounds: { round_id: string; label: string; rule_note: string; finalized_at: string }[];
  freeze_plans: { round_id: string; plan_path: string; source_root: string }[];
  source_artifacts: { path: string; sha256: string }[];
  papers: { document_id: string; pdf_path: string; pdf_sha256: string }[];
  jobs: ReaderJob[];
  records: ReaderRecord[];
  figures: (Omit<Figure, "figure_number"> & { figure_number: string | null; purpose_review?: string; assets: (Figure["assets"][number] & { source_path?: string })[] })[];
  issues: ReaderIssue[];
};

const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function assertUsage(value: ReaderUsage) {
  if (!value || [value.requests, value.input_tokens, value.output_tokens].some(number => !Number.isSafeInteger(number) || number < 0)
    || (value.actual_cost !== null && (typeof value.actual_cost !== "number" || !Number.isFinite(value.actual_cost) || value.actual_cost < 0)) || typeof value.cost_status !== "string" || !value.cost_status) throw new Error("真实累计请求、令牌或费用状态缺失");
}
export function safeAssetPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !/[\\?#:%]/.test(value) && value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}
function assertGroups(groups: SourceGroup[]) {
  if (!Array.isArray(groups)) throw new Error("原文句段格式错误");
  for (const group of groups) {
    if (!group || typeof group.group_id !== "string" || !Array.isArray(group.segments) || !group.segments.length || group.display_joiner !== "\n" || !["complete", "incomplete", "unverified"].includes(group.completeness)) throw new Error("原文句段不完整");
    for (const segment of group.segments) {
      if (typeof segment.block_id !== "string" || typeof segment.text_version !== "string" || typeof segment.exact_quote !== "string"
        || !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || segment.start < 0 || segment.end <= segment.start
        || Array.from(segment.exact_quote).length !== segment.end - segment.start || !Number.isSafeInteger(segment.physical_page) || segment.physical_page < 1
        || !Array.isArray(segment.bbox) || segment.bbox.length !== 4 || segment.bbox.some(value => !Number.isFinite(value))
        || segment.bbox[2] < segment.bbox[0] || segment.bbox[3] < segment.bbox[1]) throw new Error("原文或逐字定位范围无效");
    }
  }
}

/** Only a core-finalized manifest of actual outputs can power the delivered reader. */
export function validateReaderManifest(input: unknown): ReaderManifest {
  const value = input as ReaderManifest;
  if (!value || value.schema_version !== "feedback-revalidation-reader-1" || value.actual_model_outputs !== true || typeof value.batch_id !== "string" || !value.batch_id
    || typeof value.finalized_at !== "string" || Number.isNaN(Date.parse(value.finalized_at)) || !Array.isArray(value.source_artifacts) || !value.source_artifacts.length
    || !Array.isArray(value.papers) || !value.papers.length || !Array.isArray(value.jobs) || !value.jobs.length || !Array.isArray(value.records)
    || !Array.isArray(value.figures) || !Array.isArray(value.issues) || !Array.isArray(value.rounds) || !value.rounds.length || !Array.isArray(value.freeze_plans) || !value.freeze_plans.length) throw new Error("本轮真实复验结果尚未定版或材料格式不符");
  const papers = new Set<string>(), jobs = new Map<string, ReaderJob>(), records = new Set<string>(), figures = new Set<string>(), issues = new Set<string>(), rounds = new Set<string>();
  assertUsage(value.usage_totals);
  for (const round of value.rounds) {
    if (!round.round_id || rounds.has(round.round_id) || typeof round.label !== "string" || typeof round.rule_note !== "string" || Number.isNaN(Date.parse(round.finalized_at))) throw new Error("真实轮次尚未定版或绑定无效");
    rounds.add(round.round_id);
  }
  for (const freeze of value.freeze_plans) if (!rounds.has(freeze.round_id) || !safeAssetPath(freeze.plan_path) || (freeze.source_root !== "." && !safeAssetPath(freeze.source_root))) throw new Error("每轮冻结快照引用无效");
  for (const round of rounds) if (!value.freeze_plans.some(freeze => freeze.round_id === round)) throw new Error("轮次缺少冻结快照引用");
  for (const artifact of value.source_artifacts) if (!safeAssetPath(artifact.path) || !sha(artifact.sha256)) throw new Error("实际产物指纹无效");
  for (const paper of value.papers) {
    if (papers.has(paper.document_id) || !["L01", "L05"].includes(paper.document_id) || paper.pdf_path !== `pdf/${paper.document_id}.pdf` || !sha(paper.pdf_sha256)) throw new Error("原PDF绑定无效");
    papers.add(paper.document_id);
  }
  for (const job of value.jobs) {
    if (!job.job_id || jobs.has(job.job_id) || !rounds.has(job.round_id) || !papers.has(job.document_id) || !["B0", "F", "R"].includes(job.method) || typeof job.state !== "string"
      || /^(?:running|prepared|pending|queued|in_progress)$/.test(job.state) || typeof job.independent_model_run !== "boolean"
      || !Number.isSafeInteger(job.candidate_count) || job.candidate_count < 0 || !Number.isSafeInteger(job.delivered_count) || job.delivered_count < 0) throw new Error("方法运行尚未终态或计数无效");
    jobs.set(job.job_id, job);
    assertUsage(job);
    if (job.representative_measurement) assertUsage(job.representative_measurement);
    for (const attempt of job.attempts ?? []) assertUsage(attempt as ReaderUsage);
  }
  for (const key of ["requests", "input_tokens", "output_tokens"] as const) if (value.jobs.reduce((total, job) => total + job[key], 0) !== value.usage_totals[key]) throw new Error("方法累计耗费与本轮账本总量不符");
  for (const figure of value.figures) {
    if (!figure.figure_id || figures.has(figure.figure_id) || !papers.has(figure.document_id) || !Array.isArray(figure.assets) || !Array.isArray(figure.caption_segments)) throw new Error("图资料绑定无效");
    figures.add(figure.figure_id);
    for (const asset of figure.assets) if (!safeAssetPath(asset.pack_path) || !sha(asset.sha256) || (asset.source_path !== undefined && !safeAssetPath(asset.source_path))) throw new Error("图文件路径或指纹无效");
  }
  for (const job of value.jobs) if (job.reused_from_job_id) {
    const source = jobs.get(job.reused_from_job_id);
    if (!source || source.round_id !== job.round_id || source.document_id !== job.document_id || source.job_id === job.job_id || source.reused_from_job_id || job.independent_model_run) throw new Error("复用视图的实际执行来源无效");
  }
  const allRecordIds = new Set<string>();
  const validateRecord = (record: ReaderRecord, expectedJob?: string) => {
    const job = jobs.get(record.job_id);
    if (!record.record_id || allRecordIds.has(record.record_id) || !job || (expectedJob && record.job_id !== expectedJob) || record.document_id !== job.document_id || !Number.isSafeInteger(record.record_version) || record.record_version < 1
      || !sha(record.source_record_sha256) || !Array.isArray(record.figure_ids) || record.figure_ids.some(id => !figures.has(id)) || !Array.isArray(record.automatic_checks)) throw new Error("新候选版本或方法绑定无效");
    allRecordIds.add(record.record_id);
    if (record.automatic_checks.some(check => typeof check.code !== "string" || typeof check.status !== "string" || typeof check.detail !== "string")) throw new Error("逐条自动检查说明无效");
    assertGroups(record.original_groups); assertGroups(record.context_groups);
    if (!record.original_groups.length) throw new Error("新候选没有可追溯原文");
  };
  for (const record of value.records) { validateRecord(record); records.add(record.record_id); }
  for (const job of value.jobs) for (const attempt of job.attempts ?? []) {
    if (attempt.partial_records !== undefined && !Array.isArray(attempt.partial_records)) throw new Error("失败尝试的实际候选格式无效");
    for (const record of attempt.partial_records ?? []) validateRecord(record, job.job_id);
  }
  for (const issue of value.issues) {
    if (issues.has(issue.old_item_id) || !/^S\d{2}$/.test(issue.old_item_id) || typeof issue.old_note !== "string" || !issue.old_note || !papers.has(issue.document_id)
      || !Array.isArray(issue.new_record_ids) || issue.new_record_ids.some(id => !records.has(id) || value.records.find(record => record.record_id === id)?.document_id !== issue.document_id) || !["source_overlap_only", "no_direct_match"].includes(issue.relation)
      || (issue.relation === "no_direct_match" && issue.new_record_ids.length > 0) || !Array.isArray(issue.automatic_observations) || issue.automatic_observations.some(text => typeof text !== "string")) throw new Error("旧问题来源对照无效");
    issues.add(issue.old_item_id);
    assertGroups(issue.old_original_groups); assertGroups(issue.old_context_groups);
  }
  return value;
}

export const methodLabel = (method: string) => method;
export const stateLabel = (state: string) => ({ completed: "已结束", succeeded: "已结束", failed: "运行失败", partial: "部分完成", stopped: "已停止", reused: "复用同次实际结果", cancelled: "已取消" })[state] ?? state;
export function firstFragment(groups: SourceGroup[]): Fragment | undefined { return groups[0]?.segments[0]; }
export function filteredRecords(manifest: ReaderManifest, documentId: string, method: string, roundId = "all"): ReaderRecord[] {
  const jobs = new Map(manifest.jobs.map(job => [job.job_id, job]));
  return manifest.records.filter(record => (roundId === "all" || jobs.get(record.job_id)?.round_id === roundId) && (documentId === "all" || record.document_id === documentId) && (method === "all" || jobs.get(record.job_id)?.method === method
    || manifest.jobs.some(job => job.method === method && job.reused_from_job_id === record.job_id)));
}
export function viewJobForRecord(manifest: ReaderManifest, record: ReaderRecord, method: string): ReaderJob {
  return manifest.jobs.find(job => job.method === method && job.reused_from_job_id === record.job_id) ?? manifest.jobs.find(job => job.job_id === record.job_id)!;
}
export function roundComparisons(manifest: ReaderManifest): { before: ReaderJob; after: ReaderJob }[] {
  const beforeRound = manifest.rounds.at(-2)?.round_id, afterRound = manifest.rounds.at(-1)?.round_id;
  if (!beforeRound || !afterRound) return [];
  return manifest.jobs.filter(job => job.round_id === afterRound).flatMap(after => {
    const before = manifest.jobs.find(job => job.round_id === beforeRound && job.document_id === after.document_id && job.method === after.method);
    return before ? [{ before, after }] : [];
  });
}
export function partialRecords(manifest: ReaderManifest): ReaderRecord[] { return manifest.jobs.flatMap(job => (job.attempts ?? []).flatMap(attempt => attempt.partial_records ?? [])); }
