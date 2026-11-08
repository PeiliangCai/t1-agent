import type { EvidenceRecord } from "../../../packages/contracts/src/extraction-evidence";
import type { Fragment } from "./types";

export type VersionRole = "current_active" | "historical_active" | "proposed";
type ReaderEvidenceRecord = Omit<EvidenceRecord, "quote_span" | "context"> & {
  quote_span: Omit<EvidenceRecord["quote_span"], "segments"> & { segments: Fragment[] };
  context: Omit<EvidenceRecord["context"], "fragments"> & { fragments: Fragment[] };
};
export type ReliabilityVersion = {
  record: ReaderEvidenceRecord;
  version: number;
  actor: "automatic" | "human";
  status?: "active" | "proposed";
  created_at: string;
  reason: string;
  version_role: VersionRole;
  figure_ids?: string[];
  source_record_sha256?: string;
  proposed_figure_ids?: string[];
  figure_association?: Record<string, unknown>;
  figure_association_provenance?: Record<string, unknown>;
};
export type ReliabilityEntry = {
  entry_id: string;
  job_id: string;
  record_id: string;
  source_id: string;
  current_version: number;
  current: Omit<ReliabilityVersion, "version_role">;
  versions: ReliabilityVersion[];
};
export type ReliabilityUsage = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_seconds?: number;
  elapsed_seconds?: number;
  provider_reported_requests?: number;
  missing_usage_requests?: number;
  actual_cost?: number | null;
  cost_status?: string;
  [key: string]: unknown;
};
export type ReliabilityCoverage = {
  parser_status: string;
  all_source_blocks: number;
  assigned_source_blocks: number;
  dispatched_source_blocks: number;
  explicitly_completed_source_blocks: number;
  selected_source_block_processing_complete: boolean;
  source_block_processing_complete: boolean;
  full_document_extraction_completed: boolean;
  whole_document_summary_complete: boolean;
  image_text_unverified_pages: number[];
  unprocessed_source_block_ids: string[];
  [key: string]: unknown;
};
export type ReliabilityJob = {
  job_id: string;
  source_id?: string;
  method?: string;
  state: string;
  error?: unknown;
  coverage: ReliabilityCoverage;
  summary: { complete: boolean; text: string | null; underlying_error?: unknown; [key: string]: unknown };
  usage: ReliabilityUsage;
  result_path: string;
  delivery_path: string;
  summary_path: string;
  result_sha256: string;
  delivery_sha256: string;
  summary_sha256: string;
  batch_count: number;
  batch_attempts: { result_path: string; result_sha256: string; [key: string]: unknown }[];
  [key: string]: unknown;
};
export type ReliabilityAsset = {
  pack_path?: string;
  public_path?: string;
  public_pack_path?: string;
  source_path?: string;
  path?: string;
  sha256: string;
  physical_page: number;
  width_px: number;
  height_px: number;
  [key: string]: unknown;
};
export type ReliabilityFigure = {
  figure_id: string;
  figure_number: string | null;
  document_id?: string;
  source_id?: string;
  caption_segments: Fragment[];
  regions?: ReliabilityAsset[];
  assets?: ReliabilityAsset[];
  verification?: { status: string; notes: string; [key: string]: unknown };
  [key: string]: unknown;
};
export type ReliabilityArtifact = { path: string; sha256: string; [key: string]: unknown };
export type ReliabilityManifest = {
  schema_version: string;
  batch_id: string;
  finalized_at: string;
  actual_model_outputs?: boolean;
  authorization: Record<string, unknown>;
  usage_totals: ReliabilityUsage;
  jobs: ReliabilityJob[];
  records: ReliabilityEntry[];
  papers: { source_id?: string; document_id?: string; public_pdf_path: string; pdf_path: string; pdf_sha256: string; [key: string]: unknown }[];
  figures: ReliabilityFigure[];
  artifacts: ReliabilityArtifact[];
  limitations: unknown;
  [key: string]: unknown;
};

export const roleLabel = (role: VersionRole) => ({ current_active: "当前保存版本", historical_active: "历史保存版本", proposed: "未采用的提议" })[role];
export const methodLabel = (job: ReliabilityJob) => job.method ?? job.job_id.replace(/^L05-/, "");
export const costLabel = (usage: ReliabilityUsage) => usage.actual_cost === null || usage.actual_cost === undefined
  ? "实际费用未知（供应方账单未提供）" : `实际费用 ${usage.actual_cost}`;
export const recordsFor = (manifest: ReliabilityManifest, jobId: string) => manifest.records.filter(entry => jobId === "all" || entry.job_id === jobId);
export const versionCount = (manifest: ReliabilityManifest) => manifest.records.reduce((sum, entry) => sum + entry.versions.length, 0);
export const currentVersion = (entry: ReliabilityEntry) => entry.versions.find(version => version.version_role === "current_active")!;
export const versionFigures = (manifest: ReliabilityManifest, version: ReliabilityVersion) => manifest.figures.filter(figure => version.figure_ids?.includes(figure.figure_id));
export const figureAssets = (figure: ReliabilityFigure) => figure.assets ?? figure.regions ?? [];
export const assetPath = (asset: ReliabilityAsset) => asset.pack_path ?? asset.public_pack_path ?? asset.public_path;
export const usageSeconds = (usage: ReliabilityUsage) => usage.total_seconds ?? usage.elapsed_seconds ?? Number.NaN;
export const plainValue = (value: unknown): string => value === null || value === undefined || value === "" ? "未提供" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

type Change = { field: string; before: string; after: string };
export function versionChanges(entry: ReliabilityEntry, selected: ReliabilityVersion): { baseline: ReliabilityVersion | null; changes: Change[] } {
  const baseline = entry.versions.filter(version => version.version < selected.version && version.version_role !== "proposed").sort((a, b) => b.version - a.version)[0] ?? null;
  if (!baseline) return { baseline, changes: [] };
  const fields: [string, (record: ReaderEvidenceRecord) => unknown][] = [
    ["原文", record => record.original_quote], ["原文位置", record => record.quote_span.segments],
    ["必要语境", record => record.context.fragments], ["特征标签", record => record.feature_name_raw],
    ["类别", record => record.feature_category], ["证据类型", record => record.evidence_type],
    ["疾病或病变", record => record.disease_or_lesion], ["成像方式", record => record.modality],
    ["序列或期相", record => record.sequence_or_phase], ["断言", record => record.assertion],
    ["适用条件", record => record.applicability], ["数值表达", record => record.numeric_expressions],
    ["引用归属", record => record.context.source_attribution], ["结构引用", record => record.context.structure_references],
    ["规范术语", record => record.normalized_terms], ["中文翻译", record => record.translation_zh],
    ["重复或冲突关联", record => record.duplicate_and_conflict_links], ["审核状态", record => record.review_status],
    ["交接状态", record => record.handoff_status],
  ];
  return { baseline, changes: fields.filter(([, read]) => JSON.stringify(read(baseline.record)) !== JSON.stringify(read(selected.record)))
    .map(([field, read]) => ({ field, before: plainValue(read(baseline.record)), after: plainValue(read(selected.record)) })) };
}

export const safeRelativePath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.startsWith("/")
  && !/[\\?#:%]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
export const sha256Value = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function assertUsage(usage: ReliabilityUsage) {
  if (!usage || ![usage.requests, usage.input_tokens, usage.output_tokens].every(integer) || !Number.isFinite(usageSeconds(usage)) || usageSeconds(usage) < 0
    || (usage.actual_cost !== undefined && usage.actual_cost !== null && (typeof usage.actual_cost !== "number" || !Number.isFinite(usage.actual_cost) || usage.actual_cost < 0))) throw new Error("累计实际耗费缺失或无效");
}
function assertFragments(fragments: Fragment[]) {
  if (!Array.isArray(fragments)) throw new Error("原文定位片段缺失");
  for (const part of fragments) if (!part || !part.block_id || !part.text_version || typeof part.exact_quote !== "string" || !part.exact_quote
    || !integer(part.start) || !integer(part.end) || part.end <= part.start || Array.from(part.exact_quote).length !== part.end - part.start
    || !integer(part.physical_page) || part.physical_page < 1 || !Array.isArray(part.bbox) || part.bbox.length !== 4
    || part.bbox.some(value => !Number.isFinite(value)) || part.bbox[2] < part.bbox[0] || part.bbox[3] < part.bbox[1]) throw new Error("逐字原文或PDF定位无效");
}

/** Validate the core-finalized actual manifest; never fill missing results with samples. */
export function validateReliabilityManifest(input: unknown): ReliabilityManifest {
  const value = input as ReliabilityManifest;
  if (!value || value.schema_version !== "s4-reliability-reader-manifest-1" || value.actual_model_outputs !== true || !value.batch_id || !value.finalized_at || Number.isNaN(Date.parse(value.finalized_at))
    || value.medical_quality_approved !== false || value.product_export_approved !== false || value.stage_passed !== false || value.old_feedback_inherited !== false
    || !Array.isArray(value.jobs) || !value.jobs.length || !Array.isArray(value.records) || !Array.isArray(value.papers) || !value.papers.length
    || !Array.isArray(value.figures) || !Array.isArray(value.artifacts) || !value.artifacts.length || !value.authorization) throw new Error("本轮真实结果尚未定版");
  assertUsage(value.usage_totals);
  const jobs = new Map<string, ReliabilityJob>(), entries = new Set<string>(), figures = new Set<string>();
  for (const job of value.jobs) {
    if (!job.job_id || jobs.has(job.job_id) || !["completed", "partial", "failed", "cancelled", "interrupted"].includes(job.state)
      || !job.coverage || !job.summary || typeof job.summary.complete !== "boolean" || job.summary.complete !== job.coverage.whole_document_summary_complete
      || ![job.result_path, job.delivery_path, job.summary_path].every(safeRelativePath) || ![job.result_sha256, job.delivery_sha256, job.summary_sha256].every(sha256Value)) throw new Error("实际运行状态或来源绑定无效");
    jobs.set(job.job_id, job); assertUsage(job.usage);
  }
  for (const key of ["requests", "input_tokens", "output_tokens"] as const) if (value.jobs.reduce((sum, job) => sum + job.usage[key], 0) !== value.usage_totals[key]) throw new Error("累计请求或令牌与分组不一致");
  for (const paper of value.papers) if (!safeRelativePath(paper.public_pdf_path) || !safeRelativePath(paper.pdf_path) || !sha256Value(paper.pdf_sha256)) throw new Error("原PDF指纹缺失");
  for (const artifact of value.artifacts) if (!safeRelativePath(artifact.path) || !sha256Value(artifact.sha256)) throw new Error("产物指纹或路径无效");
  for (const figure of value.figures) {
    if (!figure.figure_id || figures.has(figure.figure_id)) throw new Error("Figure身份重复");
    figures.add(figure.figure_id); assertFragments(figure.caption_segments);
    for (const asset of figureAssets(figure)) if (!sha256Value(asset.sha256) || (assetPath(asset) !== undefined && !safeRelativePath(assetPath(asset)))
      || (asset.source_path !== undefined && !safeRelativePath(asset.source_path))) throw new Error("Figure资源路径或指纹无效");
  }
  for (const entry of value.records) {
    if (!entry.entry_id || entries.has(entry.entry_id) || !jobs.has(entry.job_id) || !entry.record_id || !Array.isArray(entry.versions) || !entry.versions.length) throw new Error("候选身份或版本缺失");
    entries.add(entry.entry_id);
    const seen = new Set<number>();
    for (const version of entry.versions) {
      const record = version.record;
      if (!integer(version.version) || version.version < 1 || seen.has(version.version) || !["current_active", "historical_active", "proposed"].includes(version.version_role)
        || (version.version_role === "proposed") !== (version.status === "proposed") || !record || record.record_id !== entry.record_id
        || record.extraction_trace.fixture !== false || record.extraction_trace.evidence_kind !== "real_paper" || record.evidence_validation.medical_semantics_verified !== false
        || record.evidence_validation.human_approval !== "not_performed" || record.review_status === "approved" || record.handoff_status !== "candidate_only" || record.review_events.length) throw new Error("版本身份或待核状态无效");
      seen.add(version.version);
      assertFragments(record.quote_span.segments); assertFragments(record.context.fragments);
      if (!record.quote_span.segments.length || record.original_quote !== record.quote_span.segments.map(part => part.exact_quote).join(record.quote_span.display_joiner)
        || (version.figure_ids ?? []).some(id => !figures.has(id))) throw new Error("原文内容或Figure关联不一致");
    }
    const active = entry.versions.filter(version => version.version_role === "current_active");
    if (active.length !== 1 || active[0].version !== entry.current_version || JSON.stringify(active[0].record) !== JSON.stringify(entry.current.record)
      || entry.current.version !== entry.current_version || entry.versions.some(version => version.version_role === "historical_active" && version.version > entry.current_version)) throw new Error("当前版本与历史或提议混淆");
  }
  return value;
}
