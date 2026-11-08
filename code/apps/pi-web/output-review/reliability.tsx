/* eslint-disable @next/next/no-img-element -- Local original assets in the standalone reader. */
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreview } from "../components/ImagePreview";
import { assetUrl, PdfViewer, type PdfTarget } from "./pdf-viewer";
import { assetPath, costLabel, currentVersion, figureAssets, methodLabel, plainValue, recordsFor, roleLabel, validateReliabilityManifest,
  usageSeconds, versionChanges, versionCount, versionFigures, type ReliabilityEntry, type ReliabilityFigure, type ReliabilityJob, type ReliabilityManifest, type ReliabilityVersion } from "./reliability-model";
import type { Fragment } from "./types";
import "./review.css";
import "./reliability.css";

const number = (value: number) => value.toLocaleString("en-US");
const seconds = (value: number) => `${value.toFixed(2)}秒`;
const evidenceType = (value: string) => ({ feature_mention: "特征提及", definition: "定义", imaging_observation: "成像观察", interpretive_condition: "解释条件", association_conclusion: "关联结论" })[value] ?? value;
const originLabel = (value: string) => ({ study_authors: "本文作者", cited_research: "引用研究", background_definition: "背景定义", unclear: "归属待核" })[value] ?? value;
const issueLabel = (code: string) => ({
  numeric_expression_missing: "数值表达可能缺失，待核对。", coreference_requires_context: "指代关系需要语境核对。",
  new_term_pending_human_review: "新术语待人工核对。", cited_research_reference_missing: "引用来源仍待核对。",
  condition_requires_context: "适用条件需要语境核对。", visual_description_semantics_unverified: "是否属于目标图像描述仍待核对。",
})[code] ?? "另有自动提示，原始代码及说明可展开查看。";

function JobCard({ job, manifest, evidence }: { job: ReliabilityJob; manifest: ReliabilityManifest; evidence: Record<string, string> }) {
  const coverage = job.coverage;
  const entries = manifest.records.filter(entry => entry.job_id === job.job_id);
  const versions = entries.reduce((sum, entry) => sum + entry.versions.length, 0);
  const proposals = entries.reduce((sum, entry) => sum + entry.versions.filter(version => version.version_role === "proposed").length, 0);
  const references = [job.result_path, job.delivery_path, job.summary_path].filter(path => evidence[path]);
  return <article className="reliability-job" data-testid="reliability-job" data-job-id={job.job_id}>
    <h2><span>L05 · {methodLabel(job)}</span><span className="reliability-status">{({ partial: "部分完成", completed: "运行结束", failed: "运行失败", cancelled: "已取消", interrupted: "已中断" })[job.state] ?? job.state} · 仍有待核内容</span></h2>
    <p className="status-line" data-testid="selected-processing"><strong>已选内容：{coverage.selected_source_block_processing_complete ? "处理完成" : "处理未完成"}</strong> · {job.batch_count}批 · 已处理{number(coverage.explicitly_completed_source_blocks)} / 已调度{number(coverage.dispatched_source_blocks)}块</p>
    <p className="status-line" data-testid="summary-status"><span className={`reliability-status ${job.summary.complete ? "summary-done" : "summary-failed"}`}>候选汇总{job.summary.complete ? "已完成" : "未完成"}</span> <span>与原文处理、全文覆盖分别判断</span></p>
    <p data-testid="parser-status">解析待核：{coverage.parser_status === "partial" ? "原解析结果为部分完成" : coverage.parser_status}；{coverage.image_text_unverified_pages.length > 0 ? `第${coverage.image_text_unverified_pages.join("、")}页的图像文字未核验` : "未列出待核验图像文字页"}。</p>
    <p data-testid="selection-scope">本次范围：已调度{number(coverage.dispatched_source_blocks)} / 原范围{number(coverage.assigned_source_blocks)}块。{coverage.unprocessed_source_block_ids.length > 0 ? `另有${number(coverage.unprocessed_source_block_ids.length)}块未在本次选择范围内处理。` : "已选块均已处理，但不表示原PDF内容全部解析或完整召回。"}</p>
    {!job.summary.complete && <p className="reliability-warning" data-testid="summary-failure">汇总未完成：先纠正了一次候选选择器冲突，随后更新因特征标签未通过原文依据校验而被拦截；本次提交原子回滚，已保存候选仍保留原版本。失败提交的具体标签原文未保存，不能指认某个词或医学原因。</p>}
    <p data-testid="job-counts">当前{entries.length}个候选身份 · 保留{versions}个版本{proposals ? `（含${proposals}个未采用提议）` : ""}。版本数不等于有效描述数。</p>
    <p data-testid="job-usage"><strong>{number(job.usage.requests)}次请求</strong> · 输入{number(job.usage.input_tokens)} / 输出{number(job.usage.output_tokens)} tokens · {seconds(usageSeconds(job.usage))}。{costLabel(job.usage)}。</p>
    <details className="technical" data-testid="job-evidence"><summary>{job.summary.complete ? "查看汇总诊断和运行证据" : "查看失败过程与保留证据"}</summary>
      <p>汇总是模型对候选的诊断，不能作为已审核的特征原文。</p>
      {job.summary.text && <blockquote data-testid="summary-text" translate="no">{job.summary.text}</blockquote>}
      {!job.summary.complete && <><p>原始错误：<code>{plainValue(job.error)}</code></p><p>底层错误：<code>{plainValue(job.summary.underlying_error)}</code></p></>}
      {references.map(path => <p key={path}><a href={assetUrl(evidence[path])} target="_blank" rel="noreferrer">{path.split("/").slice(-2).join("/")} ↗</a></p>)}
      <details><summary>原始处理范围与运行字段</summary><pre>{JSON.stringify(job, null, 2)}</pre></details>
    </details>
  </article>;
}

function LiteralSource({ fragments, title, quote, joiner = "\n", onLocate }: { fragments: Fragment[]; title: string; quote?: string; joiner?: string; onLocate: (parts: Fragment[], token: string) => void }) {
  return <section className="reliability-source-section" data-testid={quote === undefined ? "context-section" : "original-section"}>
    <h3>{title}</h3>
    {!fragments.length ? <p className="muted">此版本没有单独保留必要语境；这不证明语境已经足够。</p> : quote !== undefined ? <article className="fragment">
      <div className="fragment-head"><span>PDF第{[...new Set(fragments.map(part => part.physical_page))].join("、")}页</span><button type="button" data-testid="locate-original" onClick={() => onLocate(fragments, title)}>在PDF中定位 ↗</button></div>
      <blockquote className="group-quote" translate="no" lang="und" data-testid="original-quote">{fragments.map((part, index) => <span key={`${part.block_id}:${part.start}:${index}`}><span data-testid="original-span" data-block-id={part.block_id} data-start={part.start} data-end={part.end} data-page={part.physical_page}>{part.exact_quote}</span>{index + 1 < fragments.length ? joiner : ""}</span>)}</blockquote>
      {fragments.length > 1 && <p className="control-hint">由{fragments.length}个源片段组合显示；片段边界和定位可展开，不视为一条连续原句。</p>}
      <details className="reliability-locations"><summary>逐片段原文和定位（{fragments.length}段）</summary>{fragments.map((part, index) => <div key={index}>
        <p><code>第{part.physical_page}页 · {part.block_id} [{part.start}, {part.end})</code><br /><span translate="no" data-testid="original-fragment-quote">{part.exact_quote}</span><br /><button type="button" data-testid="locate-original-fragment" onClick={() => onLocate([part], `${title}:${index}`)}>定位片段{index + 1} ↗</button></p>
      </div>)}</details>
    </article> : fragments.map((part, index) => <div key={`${part.block_id}:${part.start}:${index}`}>
      {index > 0 && <p className="source-break">另一个源片段 · 分开阅读</p>}
      <article className="fragment"><div className="fragment-head"><span>语境{index + 1} · PDF第{part.physical_page}页</span><button type="button" data-testid="locate-context" onClick={() => onLocate([part], `${title}:${index}`)}>在PDF中定位 ↗</button></div>
        <blockquote className="group-quote" translate="no" lang="und" data-testid="context-quote">{part.exact_quote}</blockquote>
        <details className="reliability-locations"><summary>原始定位</summary><code>{part.block_id} [{part.start}, {part.end})</code></details>
      </article>
    </div>)}
  </section>;
}

function FigureCard({ figure, onLocate }: { figure: ReliabilityFigure; onLocate: (parts: Fragment[], token: string) => void }) {
  return <article data-testid="reliability-figure" data-figure-id={figure.figure_id}>
    <strong>L05 · {figure.figure_number ? `Figure ${figure.figure_number}` : "待归属图区域"}</strong>
    <p>原PDF图参考 · 图文对应及整图完整性仍待核验。</p>
    {figureAssets(figure).filter(asset => assetPath(asset)).map(asset => <div key={asset.sha256}>
      <ImagePreview src={assetUrl(assetPath(asset)!)} alt={`Figure ${figure.figure_number ?? "待核"} 原PDF图区域`} className="figure-thumbnail"><img src={assetUrl(assetPath(asset)!)} alt={`Figure ${figure.figure_number ?? "待核"}，点击查看原图`} /><span>查看原PDF图区域</span></ImagePreview>
      <p className="muted">PDF第{asset.physical_page}页 · 实际文件指纹可追溯；不等于医学影像配对通过。</p>
    </div>)}
    {figure.caption_segments.length > 0 && <button type="button" data-testid="locate-figure-caption" onClick={() => onLocate(figure.caption_segments, `figure:${figure.figure_id}`)}>在PDF中看图注 ↗</button>}
    <details><summary>图注原文与追溯信息</summary>{figure.caption_segments.map((part, index) => <blockquote translate="no" data-testid="figure-caption" key={index}>{part.exact_quote}</blockquote>)}<pre>{JSON.stringify(figure, null, 2)}</pre></details>
  </article>;
}

function Changes({ entry, selected }: { entry: ReliabilityEntry; selected: ReliabilityVersion }) {
  const { baseline, changes } = versionChanges(entry, selected);
  return <details className="reliability-changes" data-testid="version-changes"><summary>此版本的原文与标签变化{baseline ? `（对照较早保存的v${baseline.version}）` : "（没有更早保存版本）"}</summary>
    <p>变更保留为同一候选身份，不增加有效描述数，也不代表已审核。提议只作为未采用记录保留。</p>
    {baseline ? changes.length ? <div className="table-wrap"><table><thead><tr><th>字段</th><th>v{baseline.version}</th><th>v{selected.version} · {roleLabel(selected.version_role)}</th></tr></thead><tbody>{changes.map(change => <tr key={change.field} data-testid="version-change"><th>{change.field}</th><td translate="no">{change.before}</td><td translate="no">{change.after}</td></tr>)}</tbody></table></div>
      : <p>所比较的原文和标签没有变化；完整版本与保存原因仍可在追溯信息查看。</p> : <p>这是本记录最早保留的版本；没有补造更早版本。</p>}
  </details>;
}

function Reader({ manifest, evidence }: { manifest: ReliabilityManifest; evidence: Record<string, string> }) {
  const [jobId, setJobId] = useState("all"), [entryId, setEntryId] = useState(manifest.records[0]?.entry_id ?? "");
  const [versionByEntry, setVersionByEntry] = useState<Record<string, number>>({});
  const [located, setLocated] = useState<{ owner: string; target: PdfTarget } | null>(null);
  const entries = recordsFor(manifest, jobId), entry = entries.find(entry => entry.entry_id === entryId) ?? entries[0];
  const selected = entry ? entry.versions.find(version => version.version === versionByEntry[entry.entry_id]) ?? currentVersion(entry) : null;
  const record = selected?.record, job = manifest.jobs.find(job => job.job_id === entry?.job_id);
  const paper = manifest.papers.find(paper => (paper.source_id ?? paper.document_id) === entry?.source_id) ?? manifest.papers[0]!;
  const owner = `${entry?.entry_id ?? "empty"}:${selected?.version ?? "none"}`;
  const first = record?.quote_span.segments[0];
  const target = useMemo<PdfTarget>(() => located?.owner === owner ? located.target : { page: first?.physical_page ?? 1, fragments: first ? [first] : [], token: owner }, [located, owner, first]);
  const locate = (parts: Fragment[], token: string) => {
    if (!parts[0]) return;
    setLocated(previous => ({ owner, target: { page: parts[0].physical_page, fragments: parts.filter(part => part.physical_page === parts[0].physical_page), token: `${owner}:${token}:${Number(previous?.target.token.split(":").pop() ?? 0) + 1}` } }));
    if (matchMedia("(max-width: 900px)").matches) requestAnimationFrame(() => document.querySelector(".pdf-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const index = entries.findIndex(value => value.entry_id === entry?.entry_id);
  const currentFigures = selected ? versionFigures(manifest, selected) : [];
  const proposalCount = manifest.records.reduce((sum, entry) => sum + entry.versions.filter(version => version.version_role === "proposed").length, 0);
  const historicalCount = manifest.records.reduce((sum, entry) => sum + entry.versions.filter(version => version.version_role === "historical_active").length, 0);
  const traces = record ? [record.extraction_trace.provider, record.extraction_trace.model_id].join(" / ") : "";
  return <div className="reliability-app" data-testid="reliability-app">
    <header className="reliability-header"><div><p className="eyebrow">T1 · 工程修复后真实输出</p><h1>两组集成复验 · 原文与版本</h1><p className="muted">L05 · {traces} · 定版于{new Date(manifest.finalized_at).toLocaleString("zh-CN", { hour12: false })}</p></div><nav className="reliability-links"><a href={assetUrl("revalidation.html")} data-testid="previous-revalidation-link">回看旧两轮复验 ↗</a><a href={assetUrl("index.html")} data-testid="legacy-review-link">回看旧35条与原意见 ↗</a></nav></header>
    <p className="intro reliability-boundary" data-testid="reliability-boundary">这是联合工程修复的集成复验，非单因素效果、三方案排名或医学通过。全部新输出仍待人工核验，未获医学或产品批准；旧审核意见不自动用于这些新版本。</p>
    <section className="reliability-totals" data-testid="reliability-totals"><p><strong>{manifest.jobs.length}组 · {number(manifest.usage_totals.requests)}次请求</strong>（含失败与重试）{manifest.usage_totals.provider_reported_requests === manifest.usage_totals.requests && manifest.usage_totals.missing_usage_requests === 0 ? ` · ${manifest.usage_totals.requests}/${manifest.usage_totals.requests}已结算` : ""}</p><p>输入{number(manifest.usage_totals.input_tokens)} / 输出{number(manifest.usage_totals.output_tokens)} tokens</p><p>本次总耗时{seconds(usageSeconds(manifest.usage_totals))}</p><p>{costLabel(manifest.usage_totals)}</p><p className="muted">耗时从已缓存的真实解析结果到候选与汇总，不含重新解析PDF；本页只读，不产生模型调用。</p></section>
    <section className="reliability-jobs" aria-label="两组运行结果">{manifest.jobs.map(job => <JobCard key={job.job_id} job={job} manifest={manifest} evidence={evidence} />)}</section>
    <div className="reliability-section-heading"><h2>逐条阅读真实候选</h2><p data-testid="version-counts">{manifest.records.length}个候选身份 · {versionCount(manifest)}个保留版本（当前{manifest.records.length} / 历史{historicalCount} / 未采用提议{proposalCount}）</p></div>
    <div className="reliability-toolbar"><label>分组<select data-testid="reliability-group" value={jobId} onChange={event => setJobId(event.target.value)}><option value="all">全部分组</option>{manifest.jobs.map(job => <option key={job.job_id} value={job.job_id}>L05 · {methodLabel(job)}</option>)}</select></label>
      <label className="reliability-record-picker">候选<select data-testid="reliability-record" value={entry?.entry_id ?? ""} onChange={event => setEntryId(event.target.value)}>{entries.length ? entries.map((entry, i) => <option key={entry.entry_id} value={entry.entry_id}>{methodLabel(manifest.jobs.find(job => job.job_id === entry.job_id)!)} · 第{i + 1}条 · {entry.current.record.feature_name_raw ?? "未提供特征标签"} · 当前v{entry.current_version}</option>) : <option value="">此组没有保留候选</option>}</select></label>
      <div className="record-step"><button type="button" aria-label="上一条候选" disabled={index <= 0} onClick={() => setEntryId(entries[index - 1]!.entry_id)}>上一条</button><button type="button" aria-label="下一条候选" disabled={index < 0 || index >= entries.length - 1} onClick={() => setEntryId(entries[index + 1]!.entry_id)}>下一条</button></div>
    </div>
    <main className="reliability-columns"><section className="reliability-source" data-testid="reliability-source">
      {entry && selected && record ? <>
        <h2>L05 · {job ? methodLabel(job) : entry.job_id} · 候选{index + 1}</h2>
        <p className="muted" style={{ fontSize: 12 }}>同一候选的版本分别保留；每次切换只改变当前阅读内容。</p>
        <div className="reliability-version-tools"><label>保留版本<select data-testid="reliability-version" value={selected.version} onChange={event => setVersionByEntry(previous => ({ ...previous, [entry.entry_id]: Number(event.target.value) }))}>{entry.versions.map(version => <option key={version.version} value={version.version}>v{version.version} · {roleLabel(version.version_role)}</option>)}</select></label>
          {selected.version_role !== "current_active" && <button type="button" data-testid="back-to-current" onClick={() => setVersionByEntry(previous => ({ ...previous, [entry.entry_id]: entry.current_version }))}>回到当前v{entry.current_version}</button>}
        </div>
        <section className="reliability-version-note" data-testid="version-status" data-role={selected.version_role}><strong>正在看v{selected.version} · {roleLabel(selected.version_role)}</strong><p>{selected.version_role === "proposed" ? `这项提议未采用；当前保存版本仍为v${entry.current_version}。` : selected.version_role === "historical_active" ? `这是较早保存的历史版本；当前保存版本为v${entry.current_version}。` : "这是当前保存的候选版本；当前不代表已审核或有效描述。"} 全部版本均待人工核验。</p></section>
        <dl className="reliability-fields" data-testid="record-labels"><dt>模型特征标签</dt><dd translate="no">{record.feature_name_raw ?? "未提供"}</dd><dt>证据类型</dt><dd>{evidenceType(record.evidence_type)}</dd><dt>疾病或病变</dt><dd translate="no">{record.disease_or_lesion.value ?? "未确定"}</dd><dt>成像方式</dt><dd translate="no">{record.modality.value ?? "未确定"}</dd><dt>序列或期相</dt><dd translate="no">{record.sequence_or_phase?.value ?? "未确定"}</dd><dt>内容归属</dt><dd>{originLabel(record.context.source_attribution.origin)}{record.context.source_attribution.cited_references.length > 0 ? ` · ${record.context.source_attribution.cited_references.join("；")}` : ""}</dd><dt>审核情况</dt><dd>未人工审核 · 未获医学或产品批准</dd></dl>
        <LiteralSource title="原文（逐字保留）" quote={record.original_quote} joiner={record.quote_span.display_joiner} fragments={record.quote_span.segments} onLocate={locate} />
        <LiteralSource title="必要语境（独立保留）" fragments={record.context.fragments} onLocate={locate} />
        <Changes entry={entry} selected={selected} />
        <section className="reliability-checks"><h3>自动检查 · 不能替代人工判断</h3><p>原文位置可追溯；相关性、条件完整性、医学语义和配图关系仍需核验。</p>{record.evidence_validation.issues.length > 0 && <ul>{[...new Set(record.evidence_validation.issues.map(issue => issueLabel(issue.code)))].map(text => <li key={text}>{text}</li>)}</ul>}<details><summary>原始检查字段</summary><pre>{JSON.stringify(record.evidence_validation, null, 2)}</pre></details></section>
        <section className="reliability-figures"><h3>此版本的 Figure 参考</h3><p className="muted">仅展示此版本有来源依据的图引用，不从其他版本继承配图。</p>{currentFigures.length ? currentFigures.map(figure => <FigureCard key={figure.figure_id} figure={figure} onLocate={locate} />) : <p data-testid="no-version-figure">此版本未保留可核的图引用；可在原PDF或下方图目录参考中查看。没有图引用不等于论文没有相关图。</p>}</section>
        <details className="reliability-trace"><summary>此版本完整原始记录与追溯信息</summary><dl><dt>候选ID / 版本</dt><dd><code>{entry.record_id} / v{selected.version}</code></dd><dt>保存原因</dt><dd translate="no">{selected.reason}</dd><dt>保存时间</dt><dd>{selected.created_at}</dd><dt>原PDF SHA256</dt><dd><code>{record.source_version.file_sha256}</code></dd><dt>实际运行</dt><dd><code>{record.extraction_trace.run_id}</code></dd></dl><pre data-testid="full-version-json">{JSON.stringify(selected, null, 2)}</pre></details>
      </> : <><h2>此组没有保留候选</h2><p>零候选不能证明论文没有目标描述，也不代表质量或准确率。</p></>}
    </section><PdfViewer key={paper.public_pdf_path} documentId={entry?.source_id ?? "L05"} pdfPath={paper.public_pdf_path} target={target} /></main>
    <footer className="reliability-footer"><p>所有原始产物、失败证据和版本状态保留。候选数、版本数、处理完成和汇总完成均不等于医学质量通过。</p>
      <details data-testid="figure-catalog"><summary>原PDF Figure 目录参考（{manifest.figures.length}项，非候选配图结论）</summary><p>以下仅说明原PDF存在这些图参考，不把目录中的图自动配给候选。</p><section className="reliability-figures">{manifest.figures.map(figure => <FigureCard key={figure.figure_id} figure={figure} onLocate={locate} />)}</section></details>
      <details data-testid="reliability-provenance"><summary>定版材料、失败证据与文件指纹</summary><p>批次：{manifest.batch_id} · <a href={assetUrl(evidence.__manifest)} target="_blank" rel="noreferrer">完整定版清单 ↗</a> · <a href={assetUrl(evidence.__report)} target="_blank" rel="noreferrer">核心定版审计报告 ↗</a></p><p>以下文件来自此次真实运行；未写入审核决定。</p>{manifest.artifacts.map(artifact => <div className="reliability-artifact" key={artifact.path}>{evidence[artifact.path] ? <a href={assetUrl(evidence[artifact.path])} target="_blank" rel="noreferrer">{artifact.path} ↗</a> : <span>{artifact.path}</span>}<code>{artifact.sha256}</code></div>)}<details><summary>范围与证据限制原文</summary><pre>{JSON.stringify(manifest.limitations, null, 2)}</pre></details></details>
    </footer>
  </div>;
}

async function start() {
  const host = document.getElementById("reliability-app")!;
  try {
    const path = document.querySelector<HTMLMetaElement>('meta[name="t1-reliability-manifest"]')?.content;
    const evidencePath = document.querySelector<HTMLMetaElement>('meta[name="t1-reliability-evidence"]')?.content;
    if (!path || !/^reliability-data-[a-f0-9]{12}\.json$/.test(path) || evidencePath !== "reliability-evidence-map.json") throw new Error("缺少定版材料");
    const [response, evidenceResponse] = await Promise.all([fetch(assetUrl(path), { cache: "no-store" }), fetch(assetUrl(evidencePath), { cache: "no-store" })]);
    if (!response.ok || !evidenceResponse.ok) throw new Error("实际材料读取失败");
    const manifest = validateReliabilityManifest(await response.json());
    const evidence = await evidenceResponse.json() as Record<string, string>;
    if (evidence.__manifest !== path) throw new Error("静态证据映射与定版清单不符");
    createRoot(host).render(<Reader manifest={manifest} evidence={evidence} />);
  } catch {
    host.replaceChildren();
    const notice = document.createElement("p"); notice.className = "startup-error"; notice.setAttribute("role", "alert");
    notice.textContent = "工程修复后复验材料未能载入。请用Live Server打开reliability.html并保留同目录资源；本页没有用模拟或未定版数据代替真实结果。";
    host.appendChild(notice);
  }
}
void start();
