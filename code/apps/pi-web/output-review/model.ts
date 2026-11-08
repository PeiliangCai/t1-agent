import type { RecordView, ReviewItem, ReviewPack } from "./types";

export const QUESTIONNAIRE_VERSION = "ordinary-screening-2026-11-05-v1";
export const RESULTS_SCHEMA = "output-review-screening-results-1";
export const ROLE = "non_medical_user";
export const PACK_ID = "cc939653193b71c047cdc1e3314f923b234ebef7aefbfaf2f8cbf9adfa20845f";
export const ZIP_SHA256 = "4e52ce034979bbad2777e66a88f69879e9b43cf6ae7883e88da5cf43f192b5fd";
export const MANIFEST_SHA256 = "9c88aede860464d5e32a53596e45e2e752ff8d290bc6244049aa6a7c9c76f80c";

export const PENDING_PROFESSIONAL = Object.freeze({ context: "pending", terminology: "pending", attribution: "pending", medical_pairing: "pending" });
export const ANSWER_OPTIONS = {
  text_match: ["found", "problem", "uncertain"],
  image_description: ["looks_like", "not_like", "uncertain"],
  figure_match: ["looks_matched", "mismatch", "uncertain", "not_checked"],
  risk_notice: ["notice_problem", "no_obvious_problem", "uncertain"],
} as const;
export type AnswerKey = keyof typeof ANSWER_OPTIONS;
export type Answer = typeof ANSWER_OPTIONS[AnswerKey][number];
export type Answers = { [K in AnswerKey]: (typeof ANSWER_OPTIONS)[K][number] | null };

export type ViewBinding = {
  record_id: string;
  record_version: number;
  source_record_sha256: string;
  text_fingerprint: string;
  delivery_fingerprint: string;
  text_version: string;
  file_sha256: string;
};
export type ItemBinding = {
  job_id: string;
  version_scope: string;
  baseline: ViewBinding | null;
  before: ViewBinding | null;
  after: ViewBinding | null;
};
export type ItemResult = {
  id: string;
  kind: "random" | "risk";
  source_binding: ItemBinding;
  reviewer_role: typeof ROLE;
  disposition: "draft" | "recorded" | "deferred";
  answers: Answers;
  answer_times: Record<AnswerKey, string | null>;
  note: string;
  updated_at: string | null;
  recorded_at: string | null;
  professional_review: typeof PENDING_PROFESSIONAL;
};
export type Results = {
  schema_version: typeof RESULTS_SCHEMA;
  questionnaire_version: typeof QUESTIONNAIRE_VERSION;
  pack_id: string;
  frozen_zip_sha256: string;
  frozen_manifest_sha256: string;
  scope: "ordinary_user_screening_only";
  reviewer_role: typeof ROLE;
  reviewer_name: string;
  created_at: string;
  updated_at: string;
  exported_at: string | null;
  medical_quality_approved: false;
  product_export_approved: false;
  stage_passed: false;
  professional_review: typeof PENDING_PROFESSIONAL;
  items: ItemResult[];
};

export function itemsForPack(pack: ReviewPack): ReviewItem[] {
  return [...pack.random_samples.map(sample => ({ id: sample.id, kind: "random" as const, sample })), ...pack.risks.map(sample => ({ id: sample.id, kind: "risk" as const, sample }))];
}

function bindView(view: RecordView): ViewBinding {
  const { record_id, record_version, source_record_sha256, text_fingerprint, delivery_fingerprint, text_version, file_sha256 } = view;
  return { record_id, record_version, source_record_sha256, text_fingerprint, delivery_fingerprint, text_version, file_sha256 };
}

export function bindingFor(item: ReviewItem): ItemBinding {
  return {
    job_id: item.sample.job_id,
    version_scope: item.sample.version_scope,
    baseline: item.kind === "random" ? bindView(item.sample.view) : null,
    before: item.kind === "risk" ? bindView(item.sample.before) : null,
    after: item.kind === "risk" ? bindView(item.sample.after) : null,
  };
}

export function emptyItem(item: ReviewItem): ItemResult {
  return {
    id: item.id, kind: item.kind, source_binding: bindingFor(item), reviewer_role: ROLE, disposition: "draft",
    answers: { text_match: null, image_description: null, figure_match: item.kind === "random" && !item.sample.view.figure_ids.length ? "not_checked" : null, risk_notice: null },
    answer_times: { text_match: null, image_description: null, figure_match: null, risk_notice: null },
    note: "", updated_at: null, recorded_at: null, professional_review: { ...PENDING_PROFESSIONAL },
  };
}

export function emptyResults(pack: ReviewPack, now = new Date().toISOString()): Results {
  return {
    schema_version: RESULTS_SCHEMA, questionnaire_version: QUESTIONNAIRE_VERSION, pack_id: pack.pack_id,
    frozen_zip_sha256: ZIP_SHA256, frozen_manifest_sha256: MANIFEST_SHA256,
    scope: "ordinary_user_screening_only", reviewer_role: ROLE, reviewer_name: "", created_at: now, updated_at: now, exported_at: null,
    medical_quality_approved: false, product_export_approved: false, stage_passed: false,
    professional_review: { ...PENDING_PROFESSIONAL }, items: itemsForPack(pack).map(emptyItem),
  };
}

export function canRecord(result: ItemResult): boolean {
  return result.kind === "risk" ? result.answers.risk_notice !== null : result.answers.text_match !== null && result.answers.image_description !== null && result.answers.figure_match !== null;
}

export function answerItem(result: ItemResult, key: AnswerKey, value: Answer, now: string): ItemResult {
  if (!(ANSWER_OPTIONS[key] as readonly string[]).includes(value)) throw new Error("无效选项");
  if ((result.kind === "risk") !== (key === "risk_notice")) throw new Error("问题与样本类型不匹配");
  return { ...result, answers: { ...result.answers, [key]: value }, answer_times: { ...result.answer_times, [key]: now }, disposition: "draft", recorded_at: null, updated_at: now };
}

export function commitItem(result: ItemResult, defer: boolean, now: string): ItemResult {
  let next = result;
  if (defer) {
    for (const key of result.kind === "risk" ? ["risk_notice" as const] : ["text_match" as const, "image_description" as const, "figure_match" as const]) {
      if (!next.answers[key]) next = answerItem(next, key, "uncertain", now);
    }
  }
  if (!canRecord(next)) throw new Error("请先选择本条问题，或选择留待专业人员");
  return { ...next, disposition: defer ? "deferred" : "recorded", updated_at: now, recorded_at: now };
}

export function needsExpert(result: ItemResult): boolean {
  return result.disposition === "deferred" || (result.disposition === "recorded" && Object.values(result.answers).includes("uncertain"));
}

export function counts(items: ItemResult[]) {
  return { recorded: items.filter(x => x.disposition !== "draft" && !needsExpert(x)).length, deferred: items.filter(needsExpert).length, unseen: items.filter(x => x.disposition === "draft").length };
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map(key => JSON.stringify(key) + ":" + canonical(obj[key])).join(",") + "}";
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(path + "格式错误");
  return value as Record<string, unknown>;
}
function exactKeys(obj: Record<string, unknown>, keys: string[], path: string) {
  if (Object.keys(obj).length !== keys.length || Object.keys(obj).some(k => !keys.includes(k))) throw new Error(path + "含未知字段或缺少字段");
}
function timestamp(value: unknown, nullable: boolean, path: string): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(path + "时间格式错误");
}

/** Accept observations only. Imported text, approval fields and source mutations are never applied. */
export function validateResults(input: unknown, pack: ReviewPack): Results {
  const root = object(input, "备份");
  const template = emptyResults(pack, "2026-11-05T00:00:00.000Z");
  exactKeys(root, Object.keys(template), "备份");
  const mismatchMessages = {
    schema_version: "备份格式版本不匹配", questionnaire_version: "备份使用的是另一版核验问题", pack_id: "备份属于另一份核验材料",
    frozen_zip_sha256: "备份绑定的原始核验包不匹配", frozen_manifest_sha256: "备份绑定的核验材料清单不匹配",
    scope: "备份不是本页面接受的普通用户初筛意见", reviewer_role: "备份的核验人角色不匹配，本页面只接受普通用户观察",
    medical_quality_approved: "备份包含医学质量批准，本页面无权接收此批准", product_export_approved: "备份包含产品导出批准，本页面无权接收此批准",
    stage_passed: "备份包含阶段验收通过，本页面不能确认阶段通过", professional_review: "备份已填写专业核验结论，本页面只接受专业内容仍待核的初筛意见",
  };
  for (const key of ["schema_version", "questionnaire_version", "pack_id", "frozen_zip_sha256", "frozen_manifest_sha256", "scope", "reviewer_role", "medical_quality_approved", "product_export_approved", "stage_passed", "professional_review"] as const) {
    if (canonical(root[key]) !== canonical(template[key])) throw new Error(mismatchMessages[key]);
  }
  if (typeof root.reviewer_name !== "string" || root.reviewer_name.length > 100) throw new Error("核验人称呼格式错误");
  timestamp(root.created_at, false, "创建"); timestamp(root.updated_at, false, "更新"); timestamp(root.exported_at, true, "导出");
  if (!Array.isArray(root.items) || root.items.length !== template.items.length) throw new Error("样本数量不匹配");
  const byId = new Map(template.items.map(item => [item.id, item]));
  const seen = new Set<string>();
  for (const raw of root.items) {
    const r = object(raw, "单条");
    exactKeys(r, Object.keys(template.items[0]!), "单条");
    if (typeof r.id !== "string" || seen.has(r.id)) throw new Error("样本ID重复或无效");
    seen.add(r.id);
    const expected = byId.get(r.id);
    if (!expected) throw new Error("备份包含其他样本");
    for (const key of ["kind", "source_binding", "reviewer_role", "professional_review"] as const) {
      if (canonical(r[key]) !== canonical(expected[key])) throw new Error("其中一条记录的版本、原文绑定或核验人角色不匹配，可能来自旧材料");
    }
    if (!["draft", "recorded", "deferred"].includes(String(r.disposition))) throw new Error("记录状态无效");
    if (typeof r.note !== "string" || r.note.length > 4000) throw new Error("备注过长或格式错误");
    const answers = object(r.answers, "选项");
    const times = object(r.answer_times, "操作时间");
    exactKeys(answers, Object.keys(ANSWER_OPTIONS), "选项"); exactKeys(times, Object.keys(ANSWER_OPTIONS), "操作时间");
    for (const key of Object.keys(ANSWER_OPTIONS) as AnswerKey[]) {
      const val = answers[key];
      if (val !== null && !(ANSWER_OPTIONS[key] as readonly unknown[]).includes(val)) throw new Error("选项枚举无效");
      const applicable = expected.kind === "risk" ? key === "risk_notice" : key !== "risk_notice";
      if (!applicable && (val !== null || times[key] !== null)) throw new Error("样本存在不适用的问题答案");
      timestamp(times[key], true, "操作");
      if (val === null && times[key] !== null) throw new Error("未回答选项不能有操作时间");
      const automaticNotChecked = key === "figure_match" && expected.answers.figure_match === "not_checked" && val === "not_checked";
      if (val !== null && times[key] === null && !automaticNotChecked) throw new Error("已回答选项缺少操作时间");
      if (key === "figure_match" && expected.answers.figure_match === "not_checked" && val !== "not_checked") throw new Error("无明确图片对照的项目必须保持未检查");
    }
    timestamp(r.updated_at, true, "单条更新"); timestamp(r.recorded_at, true, "记录");
    if (r.disposition === "draft" && r.recorded_at !== null) throw new Error("草稿不能含记录时间");
    if (r.disposition !== "draft" && (r.recorded_at === null || r.updated_at === null || !canRecord(r as unknown as ItemResult))) throw new Error("已记录项目缺少答案或真实操作时间");
    if ((r.note !== "" || Object.values(times).some(Boolean)) && r.updated_at === null) throw new Error("已操作项目缺少更新时间");
  }
  // Reorder only by the frozen sample order; no source content is read from the import.
  const result = JSON.parse(JSON.stringify(input)) as Results;
  const imported = new Map(result.items.map(item => [item.id, item]));
  result.items = template.items.map(item => imported.get(item.id)!);
  return result;
}

export function parseResults(text: string, pack: ReviewPack): Results {
  if (text.length > 2_000_000) throw new Error("备份文件过大");
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error("不是有效的JSON备份，当前进度已保留"); }
  return validateResults(input, pack);
}

export function storageKey(pack: ReviewPack): string { return `t1-output-review:${pack.pack_id}:${QUESTIONNAIRE_VERSION}`; }

export function assertPack(pack: ReviewPack): void {
  if (pack.schema_version !== "offline-output-review-pack-1" || pack.pack_id !== PACK_ID || pack.random_samples.length !== 30 || pack.risks.length !== 5 || pack.fragments.length !== 286 || pack.figures.length !== 3) throw new Error("核验材料不是本次冻结的30随机+5风险包");
  if (new Set(itemsForPack(pack).map(item => item.id)).size !== 35 || pack.risks.some(r => r.counted_in_random_statistics !== false)) throw new Error("核验样本绑定异常");
}
