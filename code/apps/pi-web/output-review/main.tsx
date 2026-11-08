/* eslint-disable @next/next/no-img-element -- This static entry has no Next image server; original local images must remain directly viewable. */
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreview } from "../components/ImagePreview";
import { PdfViewer, assetUrl, type PdfTarget } from "./pdf-viewer";
import { answerItem, assertPack, bindingFor, canRecord, commitItem, counts, emptyResults, itemsForPack, needsExpert, parseResults, storageKey, type Answer, type AnswerKey, type ItemResult, type Results } from "./model";
import { parseSaved, ProgressConflict, saveUnchanged, type SavedState, type StoragePort } from "./storage";
import { fallbackGroups, validateSourceGroups, type SourceGroup, type SourceGroups } from "./source-groups";
import type { Figure, Fragment, RecordView, ReviewItem, ReviewPack, RiskSample } from "./types";
import "./review.css";

const now = () => new Date().toISOString();
const humanDate = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });

function downloadResults(results: Results) {
  const exported = { ...results, exported_at: now() };
  const blob = new Blob([JSON.stringify(exported, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `普通用户初筛-${results.pack_id.slice(0, 8)}-${exported.exported_at.slice(0, 19).replaceAll(":", "-")}.json`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

function initialProgress(pack: ReviewPack) {
  let storage: StoragePort | null = null;
  let raw: string | null = null;
  try {
    storage = window.localStorage;
    raw = storage.getItem(storageKey(pack));
    const saved = raw === null ? null : parseSaved(raw, pack);
    return { storage, raw, saved, error: "" };
  } catch {
    return { storage: null, raw, saved: null, error: "浏览器保存不可用，或旧进度损坏。本页可继续填写并导出；未覆盖原有浏览器内容。刷新前请导出备份。" };
  }
}

function useProgress(pack: ReviewPack) {
  const [initial] = useState(() => initialProgress(pack));
  const [results, setResults] = useState<Results>(() => initial.saved?.results ?? emptyResults(pack));
  const [status, setStatus] = useState<"ready" | "saved" | "error" | "conflict">(initial.error ? "error" : initial.saved ? "saved" : "ready");
  const [message, setMessage] = useState(initial.error);
  const [savedAt, setSavedAt] = useState(initial.saved?.saved_at ?? "");
  const latest = useRef(results);
  const raw = useRef(initial.raw);
  const revision = useRef(initial.saved?.revision ?? 0);
  const conflict = useRef(false);
  const [writer] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  const key = storageKey(pack);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if ((event.key === key || event.key === null) && event.newValue !== raw.current) {
        conflict.current = true; setStatus("conflict");
        setMessage("另一标签页或窗口已修改进度。本页内容已保留在内存中，自动写入已暂停，避免覆盖。请先导出本页，再载入另一页进度。");
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [key]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (status === "error" || status === "conflict") { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  const persist = (next: Results, draftIfSaveFails?: Results): boolean => {
    latest.current = next; setResults(next);
    const keepDraft = () => { if (draftIfSaveFails) { latest.current = draftIfSaveFails; setResults(draftIfSaveFails); } };
    if (conflict.current) { keepDraft(); return false; }
    if (!initial.storage) { keepDraft(); setStatus("error"); return false; }
    try {
      const saved_at = now();
      const nextSaved: SavedState = { storage_schema: "output-review-browser-1", revision: revision.current + 1, writer_id: writer, saved_at, results: next };
      raw.current = saveUnchanged(initial.storage, key, raw.current, nextSaved);
      revision.current = nextSaved.revision;
      setSavedAt(saved_at); setStatus("saved"); setMessage("");
      return true;
    } catch (error) {
      keepDraft();
      if (error instanceof ProgressConflict) {
        conflict.current = true; setStatus("conflict");
        setMessage("另一标签页有不同进度，本页未覆盖它。本页改动暂在内存中，请导出备份后处理。");
      } else {
        setStatus("error");
        setMessage("未能保存到浏览器（可能容量不足或存储被禁用）。本页内容仍在内存中；请立即导出备份，刷新可能丢失本页改动。");
      }
      return false;
    }
  };
  const update = (change: (value: Results) => Results) => persist({ ...change(latest.current), updated_at: now(), exported_at: null });
  const updateItem = (id: string, change: (value: ItemResult) => ItemResult) => update(previous => ({ ...previous, items: previous.items.map(value => value.id === id ? change(value) : value) }));
  const recordAndSave = (id: string, defer: boolean) => {
    const time = now();
    const next = { ...latest.current, updated_at: time, exported_at: null, items: latest.current.items.map(item => item.id === id ? commitItem(item, defer, time) : item) };
    const fallback = { ...next, items: next.items.map(item => item.id === id ? { ...item, disposition: "draft" as const, recorded_at: null } : item) };
    return persist(next, fallback);
  };
  const loadOther = () => {
    downloadResults(latest.current);
    try {
      const currentRaw = window.localStorage.getItem(key);
      if (!currentRaw) throw new Error("另一页进度已被移除，当前内容保留，请使用导出的备份。");
      const saved = parseSaved(currentRaw, pack);
      raw.current = currentRaw; revision.current = saved.revision; conflict.current = false;
      latest.current = saved.results; setResults(saved.results); setSavedAt(saved.saved_at); setStatus("saved");
      setMessage("已导出本页备份，并载入浏览器中另一页的进度。");
    } catch {
      setMessage("另一页进度无法读取或与当前包不匹配。本页内容保持不变，刚才已导出备份。");
    }
  };
  return { results, status, message, savedAt, update, updateItem, recordAndSave, loadOther, replace: (value: Results) => persist(value), canRetry: Boolean(initial.storage), retry: () => persist(latest.current) };
}

const FIELD_LABELS: Record<string, string> = { review_status: "人工核验待办状态", disease_or_lesion: "疾病或病变名称", sequence_or_phase: "成像序列或期相", numeric_expressions: "数字表达", automatic_issue_codes: "自动提示（仍需人工）" };
const VALUE_LABELS: Record<string, string> = {
  needs_context: "需补充上下文（未人工核验）", pending: "待人工核验", unknown: "未确定", source_observed: "系统判断原文中出现过（未人工确认归属）",
  sequence_or_phase_not_grounded_in_source: "序列或期相是否有原文依据，待核", numeric_expression_missing: "数字表达可能漏填，待核", new_term_pending_human_review: "术语需人工确认", cross_block_field_relationship_requires_review: "跨片段的字段关系需人工确认",
};
function readable(value: unknown): string {
  if (value === null || value === undefined) return "未填写";
  if (typeof value === "string") return VALUE_LABELS[value] ?? value;
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(readable).join("；") : "空（未保留值）";
  const obj = value as Record<string, unknown>;
  if ("original_text" in obj) return readable(obj.original_text);
  if ("value" in obj) return `${readable(obj.value)}${obj.status ? ` · ${readable(obj.status)}` : ""}`;
  return Object.values(obj).map(readable).join("；");
}

function RiskChanges({ risk }: { risk: RiskSample }) {
  const guidance = risk.id === "K01" || risk.id === "K04"
    ? "这里比较的是系统对“待人工核验”状态的改动。两种状态都没有获得人工批准；原文是否足以支持变化，仍需专业人员确认。"
    : risk.id === "K05"
      ? "可先找图注里的 D-F，再看紧接它的句子。附近出现 AIS，并不能仅凭“出现过”判断它属于 D-F。无需你判断医学亚型；看不懂就留待专业人员。另留意小图编号与“× 100”的字段变化。"
      : "可简单观察：A-C / G-I 是否像小图编号，却被填入“成像序列或期相”；原句仍有“× 100”，但数字字段变为空。无需判断医学意义。";
  return <section className="risk-changes" data-testid="risk-changes">
    <h2>这条为什么单独拿出来看</h2><p>{guidance}</p>
    <div className="change-table" role="table" aria-label="改动前后对照"><div className="change-row change-head" role="row"><span role="columnheader">检查位置</span><span role="columnheader">改动前</span><span role="columnheader">改动后</span></div>
      {risk.changes.map(change => <div className="change-row" role="row" key={change.field}><strong role="cell">{FIELD_LABELS[change.field] ?? change.field}</strong><span role="cell" translate="no">{readable(change.before)}</span><span role="cell" translate="no">{readable(change.after)}</span></div>)}
    </div>
  </section>;
}

function FragmentList({ groups, originals, context, selected, onLocate }: { groups: SourceGroup[]; originals: Fragment[]; context?: boolean; selected: string; onLocate: (fragments: Fragment[], token: string) => void }) {
  let offset = 0;
  return <div className="fragment-list">{groups.map((group, index) => {
    const prefix = context ? "context" : "quote";
    const start = offset; offset += group.segments.length;
    const token = `${prefix}:group:${index}`;
    const hasControls = group.segments.some(fragment => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(fragment.exact_quote));
    const isSelected = selected === token || group.segments.some((_, i) => selected === `${prefix}:${start + i}`);
    return <div className="source-group-wrapper" key={group.group_id}>
      {index > 0 && <p className="source-break" data-testid={context ? "context-break" : "source-break"}>{group.completeness !== "complete" || groups[index - 1]?.completeness !== "complete" ? "候选片段在此断开 · 请分开核对，不可连成原句" : "另一个源句段 · 与上段分开核对"}</p>}
      <article className={`fragment source-group ${isSelected ? "active" : ""}`} data-testid={context ? "context-group" : "source-group"} data-completeness={group.completeness}>
        <div className="fragment-head"><span>{context ? "上下文句段" : "源句段"} {index + 1} · PDF第{[...new Set(group.segments.map(fragment => fragment.physical_page))].join("、")}页</span><button type="button" onClick={() => onLocate(group.segments, token)}>在PDF中定位 ↗</button></div>
        <blockquote className="group-quote" data-testid={context ? "context-group-quote" : "source-group-quote"} translate="no" lang="und">{group.segments.map((fragment, i) => <span key={`${fragment.block_id}:${fragment.start}:${i}`}><span className="source-quote" data-testid={context ? "context-quote" : "source-quote"} data-block-id={fragment.block_id} data-start={fragment.start} data-end={fragment.end} data-page={fragment.physical_page} data-text-version={fragment.text_version} data-occurrence={fragment.occurrence} data-bbox={JSON.stringify(fragment.bbox)}>{fragment.exact_quote}</span>{i < group.segments.length - 1 ? group.display_joiner : ""}</span>)}</blockquote>
        {group.completeness !== "complete" && <p className="completeness-hint" data-testid="completeness-hint">{group.completeness === "incomplete" ? "旧候选文字不完整：本框只显示原有片段，缺失文字未补入。请回看PDF。" : "句段连续性尚未确认，按原有片段显示；请回看PDF。"}</p>}
        {hasControls && <p className="control-hint">含不可见字符，显示可能异常；原文已保留，请回看PDF。</p>}
        <details className="fragment-locations"><summary>逐片段定位与原始范围（{group.segments.length}段）</summary><ol>{group.segments.map((fragment, i) => {
          const originalIndex = originals.findIndex(value => value.block_id === fragment.block_id && value.text_version === fragment.text_version && value.start <= fragment.start && value.end >= fragment.end);
          const original = originals[originalIndex] ?? fragment;
          return <li key={i} data-testid={context ? "context-fragment" : "fragment"} data-original-index={originalIndex} data-original-start={original.start} data-original-end={original.end}>
            <span>原片段{originalIndex + 1} · PDF第{fragment.physical_page}页 · <code>{fragment.block_id} [{original.start}, {original.end})</code>{original.start !== fragment.start || original.end !== fragment.end ? ` · 本句范围 [${fragment.start}, ${fragment.end})` : ""}</span>
            <button type="button" onClick={() => onLocate([original], `${prefix}:${start + i}`)} aria-label={`${context ? "上下文" : "片段"}${start + i + 1}定位到PDF`}>定位此原片段 ↗</button>
          </li>;
        })}</ol></details>
      </article>
    </div>;
  })}</div>;
}

function FigureCard({ figure, onLocate }: { figure: Figure; onLocate: (fragments: Fragment[], token: string) => void }) {
  return <article className="figure-card"><strong>{figure.document_id === "L01" ? "论文一" : "论文二"} · 图 {figure.figure_number}</strong>
    {figure.assets.length ? figure.assets.map(asset => <div key={asset.pack_path}>
      <ImagePreview src={assetUrl(asset.pack_path)} alt={`论文${figure.document_id}原图${figure.figure_number}`} className="figure-thumbnail"><img src={assetUrl(asset.pack_path)} alt={`原整图${figure.figure_number}，点击放大`} loading="lazy" /><span>点击查看原整图</span></ImagePreview>
      <p className="muted">整图机械检查已做，人工对应关系仍待核。只看图号和内容是否明显对应。</p>
    </div>) : <p className="muted">尚无确认可用的独立整图。可以回看原PDF，不能据此认定论文无图。</p>}
    <p className="muted">图号关联仅供回看原PDF，医学影像配对仍待核验；能看到图不表示配对已完成。</p>
    {figure.document_id === "L05" && figure.figure_number === "2" && <p className="completeness-hint" data-testid="statistical-figure-hint">原图注写的是Lasso回归筛选风险因素。这一图号提议不能作为已配对肿瘤医学影像的结论。</p>}
    {figure.caption_segments[0] && <button type="button" data-testid="figure-pdf-link" onClick={() => onLocate([figure.caption_segments[0]], `figure:${figure.figure_id}`)}>去PDF看图注位置（第{figure.caption_segments[0].physical_page}页）</button>}
    <details><summary>展开图注原文</summary>{figure.caption_segments.map((f, i) => <blockquote key={i} className="source-quote" translate="no">{f.exact_quote}</blockquote>)}</details>
  </article>;
}

function Questions({ result, item, disabled, onAnswer, onNote, onCommit }: { result: ItemResult; item: ReviewItem; disabled: boolean; onAnswer: (key: AnswerKey, answer: Answer) => void; onNote: (note: string) => void; onCommit: (defer: boolean) => void }) {
  const question = (key: AnswerKey, title: string, options: [Answer, string][]) => <fieldset><legend>{title}</legend><div className="choices">{options.map(([value, label]) => <label key={value} className={result.answers[key] === value ? "chosen" : ""}><input type="radio" name={`${item.id}-${key}`} value={value} checked={result.answers[key] === value} onChange={() => onAnswer(key, value)} data-testid={`answer-${key}-${value}`} />{label}</label>)}</div></fieldset>;
  return <section className="question-panel" aria-label="记录简单观察" data-testid="question-panel">
    <h2>你的观察</h2>
    {item.kind === "risk" ? question("risk_notice", "看完这处改动，你能看出问题吗？", [["notice_problem", "能看出可能有问题"], ["no_obvious_problem", "暂未看出明显问题"], ["uncertain", "看不懂 / 无法判断"]]) : <>
      {question("text_match", "1. 能在论文中找到，且看起来一致吗？", [["found", "能找到且一致"], ["problem", "有明显问题"], ["uncertain", "不确定 / 没找到"]])}
      {question("image_description", "2. 像是在描述图像里的外观或测量吗？", [["looks_like", "像是"], ["not_like", "不像 / 只是统计等"], ["uncertain", "看不懂"]])}
      <details className="question-help" data-testid="question-help"><summary>第2题和已有答案怎样理解</summary><p>“像是”只记录表面观察，不表示候选可接受、应当提取或医学正确。特征名字、测量清单、P值比较不等于目标形态描述；一般定义也可能含可提取内容。请结合备注回看，原有选项和备注按原问卷保留。</p></details>
      {item.sample.view.figure_ids.length ? question("figure_match", "3. 图号或内容是否明显对应？", [["looks_matched", "看起来对应"], ["mismatch", "明显不对应"], ["uncertain", "无法判断"], ["not_checked", "未能查看 / 未检查"]]) : <div className="no-figure-question"><strong>3. 图片：未检查</strong><span>（无明确关联图号，仍可翻阅PDF）</span></div>}
    </>}
    <label className="note-label">备注（可选）<textarea data-testid="review-note" value={result.note} maxLength={4000} rows={1} onChange={e => onNote(e.target.value)} /></label>
    <div className="record-actions"><button type="button" className="primary" data-testid="save-record" disabled={!canRecord(result) || disabled} onClick={() => onCommit(false)}>记录并下一条</button><button type="button" data-testid="defer-record" disabled={disabled} onClick={() => onCommit(true)}>看不懂，先留待核验</button></div>
    <p role="status" data-testid="item-status" className="item-status">{result.disposition === "draft" ? "选择会尝试暂存，点击“记录”完成本条。" : needsExpert(result) ? "本条已留待专业人员。" : "已记录本条观察。"}</p>
  </section>;
}

function ReviewApp({ pack, sourceGroups }: { pack: ReviewPack; sourceGroups: SourceGroups | null }) {
  const progress = useProgress(pack);
  const allItems = useMemo(() => itemsForPack(pack), [pack]);
  const [group, setGroup] = useState<"random" | "risk">("random");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("S01");
  const [retainedId, setRetainedId] = useState<string | null>(null);
  const [arm, setArm] = useState<"before" | "after">("after");
  const [selectedFragment, setSelectedFragment] = useState<{ owner: string; arm: string; token: string; target: PdfTarget } | null>(null);
  const [importMessage, setImportMessage] = useState("");
  const [pendingImport, setPendingImport] = useState<Results | null>(null);
  const [feedback, setFeedback] = useState("");
  const resultById = new Map(progress.results.items.map(item => [item.id, item]));
  const visible = allItems.filter(item => item.kind === group).filter(item => {
    if (item.id === retainedId) return true;
    const r = resultById.get(item.id)!;
    return filter === "all" || (filter === "unseen" ? r.disposition === "draft" : filter === "notes" ? r.note.length > 0 : needsExpert(r));
  });
  const current = visible.find(item => item.id === selectedId) ?? visible[0];
  const result = current ? resultById.get(current.id)! : null;
  const view: RecordView | null = current ? current.kind === "random" ? current.sample.view : current.sample[arm] : null;
  const grouped = sourceGroups?.views.find(value => value.owner_id === current?.id && value.arm === (current?.kind === "random" ? "baseline" : arm));
  const ordinal = current ? allItems.filter(item => item.kind === group).findIndex(item => item.id === current.id) + 1 : 0;
  const index = current ? visible.indexOf(current) : -1;
  const defaultFragment = view?.original_fragments[0] ?? view?.context_fragments[0];
  const selected = selectedFragment?.owner === current?.id && selectedFragment?.arm === arm ? selectedFragment : null;
  const target: PdfTarget = useMemo(() => selected?.target ?? { page: defaultFragment?.physical_page ?? 1, fragments: defaultFragment ? [defaultFragment] : [], token: `${current?.id}:${arm}:default` }, [selected?.target, defaultFragment, current?.id, arm]);
  const totals = counts(progress.results.items);
  const groupCounts = (kind: "random" | "risk") => counts(progress.results.items.filter(item => item.kind === kind));
  const changeGroup = (value: "random" | "risk") => { setGroup(value); setFilter("all"); setRetainedId(null); setSelectedId(value === "random" ? "S01" : "K01"); setFeedback(""); };
  const selectItem = (id: string) => { setSelectedId(id); setRetainedId(null); setFeedback(""); };
  const locate = (fragments: Fragment[], token: string) => {
    if (!current || !fragments.length) return;
    setSelectedFragment(previous => ({
      owner: current.id, arm, token,
      target: { page: fragments[0].physical_page, fragments, token: `${current.id}:${arm}:${token}|${(Number(previous?.target.token.split("|").pop()) || 0) + 1}` },
    }));
  };

  const importFile = async (file?: File) => {
    setPendingImport(null); setImportMessage("");
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error("备份文件超过2MB，未导入");
      const imported = parseResults(await file.text(), pack);
      setPendingImport(imported);
      const c = counts(imported.items);
      setImportMessage(`备份校验通过：已记录${c.recorded}，待专业${c.deferred}，未看${c.unseen}。确认后替换当前浏览器进度；建议先导出当前进度。`);
    } catch (error) { setImportMessage(`导入失败：${error instanceof Error ? error.message : "无法读取文件"}。当前进度保持不变。`); }
  };

  return <div data-testid="review-app" className="review-app">
    <header className="app-header"><div><p className="eyebrow">T1 · 基于 Pi Web</p><h1>真实输出 · 简单核验</h1><p className="subtitle">先找原文，再看是否像图像描述。看不懂，就交给专业人员。</p></div><div className="progress-box" data-testid="progress-summary" aria-live="polite"><strong>已记录 {totals.recorded} · 待专业 {totals.deferred} · 未看 {totals.unseen}</strong><progress value={35 - totals.unseen} max={35} aria-label="已记录或留待专业的条目数" /><span>{35 - totals.unseen} / 35 条已留下意见</span></div></header>
    <section className="intro">只看明显问题，不懂就留待核验；专业部分后续确认。选项和备注均为观察，不代表接受或批准。</section>
    <div className="save-toolbar"><label className="reviewer-label">你的称呼（可选）<input data-testid="reviewer-name" value={progress.results.reviewer_name} maxLength={100} placeholder="如：小张" onChange={e => progress.update(value => ({ ...value, reviewer_name: e.target.value }))} /></label><div className="backup-actions"><button type="button" data-testid="export-results" onClick={() => { downloadResults(progress.results); setFeedback("已发起JSON下载；请在浏览器下载列表确认文件已保存。可把此文件交回或导入继续。"); }}>导出结果 / 备份</button><label className="file-button">导入备份继续<input type="file" accept="application/json,.json" data-testid="import-results" onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ""; }} /></label></div></div>
    <div className={`storage-status ${progress.status === "error" || progress.status === "conflict" ? "notice" : ""}`} data-testid="storage-status" role={progress.status === "error" ? "alert" : "status"} title={progress.savedAt ? `最近保存：${humanDate(progress.savedAt)}` : undefined}>
      {progress.status === "saved" ? "已保存在当前浏览器。" : progress.status === "ready" ? "选择后会尝试自动保存。" : progress.message}
      <span>导出可备份，换浏览器或网址可导入继续；不会自动写回服务器文件。</span>
      {progress.status === "error" && progress.canRetry && <button type="button" onClick={progress.retry}>重试浏览器保存</button>}
    </div>
    {progress.status === "conflict" && <div className="notice" role="alert" data-testid="conflict-banner"><strong>检测到其他标签页的不同进度，已暂停自动写入。</strong><p>{progress.message}</p><button type="button" onClick={progress.loadOther}>先导出本页，再载入另一页进度</button></div>}
    {(importMessage || pendingImport) && <section className="notice" data-testid="import-status" role="alert"><p>{importMessage}</p>{pendingImport && <div className="inline-actions"><button type="button" data-testid="confirm-import" disabled={progress.status === "conflict"} onClick={() => { progress.replace(pendingImport); setPendingImport(null); setImportMessage("已载入校验通过的备份。请留意上方浏览器保存状态。"); }}>用此备份继续（替换当前进度）</button><button type="button" onClick={() => { setPendingImport(null); setImportMessage("已取消导入，当前进度保持不变。"); }}>取消</button></div>}</section>}
    {feedback && <p className="feedback" role="status" data-testid="action-status">{feedback}</p>}
    <details className="notes-review" data-testid="notes-review"><summary>回看已载入进度中的备注（{progress.results.items.filter(item => item.note.length > 0).length}条）</summary><p>此处显示当前浏览器进度或你明确导入并校验通过的备份；备注与原选项一起保留，不自动解释为接受或专业结论。</p><div className="notes-list">{progress.results.items.filter(item => item.note.length > 0).map(item => <article key={item.id} data-testid="note-review-row"><button type="button" onClick={() => { setGroup(item.kind); setFilter("all"); selectItem(item.id); }}>{item.id} · 查看原文与原选项</button><blockquote translate="no" data-testid="recorded-note">{item.note}</blockquote></article>)}{!progress.results.items.some(item => item.note.length > 0) && <p>当前进度没有备注。可用“导入备份继续”载入已有意见。</p>}</div></details>
    <nav className="group-tabs" aria-label="分组">{(["random", "risk"] as const).map(kind => { const c = groupCounts(kind); return <button data-testid={`group-${kind}`} type="button" key={kind} className={kind === group ? "selected" : ""} aria-pressed={kind === group} onClick={() => changeGroup(kind)}><strong>{kind === "random" ? "30 条随机样本" : "5 条额外风险"}</strong><span>已记录 {c.recorded} · 待专业 {c.deferred} · 未看 {c.unseen}</span></button>; })}</nav>
    <p className="group-note">{group === "random" ? "随机30条：每个实际提取任务6条，同一版本已固定，不会重新抽样。" : "这5条是专门挑出的风险对照，单独记录，不并入30条随机统计。"}</p>
    <div className="browse-toolbar"><label>筛选 <select data-testid="filter-status" value={filter} onChange={e => { setFilter(e.target.value); setRetainedId(null); }}><option value="all">全部</option><option value="unseen">未看 / 未记录完</option><option value="uncertain">不确定 / 待专业</option><option value="notes">有备注</option></select></label><label className="item-select-label">选择条目 <select data-testid="item-select" value={current?.id ?? ""} onChange={e => selectItem(e.target.value)}>{!visible.length && <option value="">此筛选下没有条目</option>}{visible.map(item => { const n = allItems.filter(x => x.kind === group).indexOf(item) + 1; const r = resultById.get(item.id)!; return <option key={item.id} value={item.id}>{kindLabel(item.kind)}第{n}条 · {r.disposition === "draft" ? "未看" : needsExpert(r) ? "待专业" : "已记录"}{r.note.length > 0 ? " · 有备注" : ""}</option>; })}</select></label><div className="inline-actions"><button type="button" data-testid="previous-item" disabled={index <= 0} onClick={() => selectItem(visible[index - 1].id)}>← 上一条</button><button type="button" data-testid="next-item" disabled={index < 0 || index >= visible.length - 1} onClick={() => selectItem(visible[index + 1].id)}>下一条 →</button></div></div>
    {!current || !result || !view ? <section className="empty-state">这个筛选下没有条目。可以切换“全部”继续查看。</section> : <>
      <div className="item-heading"><h2>{kindLabel(current.kind)}第 {ordinal} 条 <small> / {group === "random" ? 30 : 5}</small></h2><span>{view.document_id === "L01" ? "论文一" : "论文二"} · 原文物理页 {view.physical_pages.join("、")}</span></div>
      <div className="review-columns"><div className="left-workspace"><section className="source-panel" aria-label="独立原文与上下文" data-testid="source-scroll" key={`${current.id}:${arm}`}>
        {current.kind === "risk" && <RiskChanges risk={current.sample} />}
        <div className="source-heading"><h2>原文片段</h2>{current.kind === "risk" && <div className="arm-tabs" aria-label="风险原文版本"><button type="button" data-testid="risk-before" aria-pressed={arm === "before"} onClick={() => setArm("before")}>改动前原文</button><button type="button" data-testid="risk-after" aria-pressed={arm === "after"} onClick={() => setArm("after")}>改动后原文</button></div>}</div>
        <p className="muted">按已核对的连续源句段合框阅读；不同句段明确分开。逐片段范围和PDF定位仍可展开查看，旧候选缺字不会补入。</p>
        {!sourceGroups && <p className="completeness-hint" data-testid="source-groups-unavailable">连续句段辅助材料未通过校验，暂按原有片段显示。</p>}
        <FragmentList groups={grouped?.original_groups ?? fallbackGroups(view.original_fragments)} originals={view.original_fragments} selected={selected?.token ?? "quote:0"} onLocate={locate} />
        {!!view.context_fragments.length && <section className="context-section"><h3>必要上下文（不是新增提取原文）</h3><FragmentList groups={grouped?.context_groups ?? fallbackGroups(view.context_fragments)} originals={view.context_fragments} context selected={selected?.token ?? ""} onLocate={locate} /></section>}
        <section className="associated-figures"><h3>图号提议与原PDF回看</h3>{view.figure_ids.length ? <><p className="muted">以下为待核图号提议，尚未完成医学影像配对。保留原有问题，仅观察是否明显对应。</p>{pack.figures.filter(figure => view.figure_ids.includes(figure.figure_id)).map(figure => <FigureCard figure={figure} key={figure.figure_id} onLocate={locate} />)}</> : <p className="muted">本条没有明确关联图号，尚未检查是否能配图；不能据此认定论文没有图片。</p>}</section>
      </section><Questions result={result} item={current} disabled={false} onAnswer={(key, value) => { setRetainedId(current.id); progress.updateItem(current.id, r => answerItem(r, key, value, now())); setFeedback(""); }} onNote={note => { setRetainedId(current.id); progress.updateItem(current.id, r => ({ ...r, note, updated_at: now() })); }} onCommit={defer => {
        if (progress.recordAndSave(current.id, defer)) {
          setRetainedId(null);
          if (visible[index + 1]) setSelectedId(visible[index + 1].id);
          setFeedback("");
        } else {
          setSelectedId(current.id); setRetainedId(current.id);
          setFeedback("本条尚未完成保存，已留在当前条。选择和备注保留在本页，请先导出备份。");
        }
      }} /></div><PdfViewer key={view.document_id} documentId={view.document_id} pdfPath={pack.papers.find(p => p.document_id === view.document_id)!.pack_pdf} target={target} /></div>
      <details className="trace-info"><summary>追溯信息（需要时再展开）</summary><dl><dt>条目</dt><dd>{current.id} · {current.sample.method}</dd><dt>固定核验包</dt><dd>{pack.pack_id}</dd><dt>版本与指纹</dt><dd><pre>{JSON.stringify(bindingFor(current), null, 2)}</pre></dd><dt>控制字符说明</dt><dd>包内14个片段行涉及4个源块的不可见控制字符，不等于14个医学错误；仍须以PDF实际显示核对。</dd><dt>专业核验</dt><dd>语境、术语、归属、医学配对全部待核。医学质量批准=false，产品导出批准=false，阶段通过=false。</dd></dl></details>
    </>}
    <footer><p>仅作开发输出的普通用户初筛。导出JSON交回后，还需依据确切原文版本继续核验。</p><details><summary>全部图资料（仅1份独立整图，其余待核）</summary><div className="figure-library">{pack.figures.map(figure => <article key={figure.figure_id}><strong>{figure.document_id === "L01" ? "论文一" : "论文二"} · 图 {figure.figure_number}</strong>{figure.assets.length ? figure.assets.map(asset => <ImagePreview key={asset.pack_path} src={assetUrl(asset.pack_path)} alt={`原整图${figure.figure_number}`} className="figure-thumbnail"><img src={assetUrl(asset.pack_path)} alt={`原整图${figure.figure_number}`} loading="lazy" /><span>点击查看原整图</span></ImagePreview>) : <p>未确认独立整图；请回看对应PDF，不表示无图。</p>}</article>)}</div></details></footer>
  </div>;
}
function kindLabel(kind: "random" | "risk") { return kind === "random" ? "随机" : "风险"; }

async function start() {
  const host = document.getElementById("app")!;
  try {
    const response = await fetch(assetUrl("pack-manifest.json"), { cache: "no-store" });
    if (!response.ok) throw new Error("材料读取失败");
    const pack = await response.json() as ReviewPack;
    assertPack(pack);
    let sourceGroups: SourceGroups | null = null;
    try {
      const groupedResponse = await fetch(assetUrl("source-groups.json"), { cache: "no-store" });
      if (groupedResponse.ok) sourceGroups = validateSourceGroups(await groupedResponse.json(), pack);
    } catch { /* Frozen source and progress remain usable if auxiliary grouping is invalid. */ }
    createRoot(host).render(<ReviewApp pack={pack} sourceGroups={sourceGroups} />);
  } catch {
    host.replaceChildren();
    const notice = document.createElement("div");
    notice.className = "startup-error"; notice.setAttribute("role", "alert");
    notice.textContent = "核验材料未能载入。请用 Live Server 打开本文件夹里的 index.html，并保留旁边全部文件；不要直接双击为 file:// 地址。刷新后仍无法读取，请检查文件夹是否完整。";
    host.appendChild(notice);
  }
}
void start();
