/* eslint-disable @next/next/no-img-element -- Standalone static reader reuses original local images. */
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreview } from "../components/ImagePreview";
import { assetUrl, PdfViewer, type PdfTarget } from "./pdf-viewer";
import { filteredRecords, firstFragment, methodLabel, partialRecords, roundComparisons, stateLabel, validateReaderManifest, viewJobForRecord, type ReaderJob, type ReaderManifest, type ReaderRecord } from "./revalidation-model";
import type { SourceGroup } from "./source-groups";
import type { Fragment } from "./types";
import "./review.css";
import "./revalidation.css";

const costLabel = (value: number | null | undefined) => value === null || value === undefined ? "费用未返回，不能按0计" : `供应方费用 ${value}`;
const summaryLabel = (value: boolean | undefined) => value === true ? "全文概括汇总已完成" : value === false ? "全文概括汇总未完成" : "全文概括汇总状态未提供";
const comparisonUsage = (job: ReaderJob) => job.reused_from_job_id && job.representative_measurement ? job.representative_measurement : job;
const secondsLabel = (job: ReaderJob) => (job.seconds ?? job.total_seconds)?.toFixed(2);
const CHECK_HELP: Record<string, string> = {
  exact_bound_source_and_delivery_spans: "原文及出处一致性检查通过；内容是否相关仍需人工判断。",
  visual_description_semantics_unverified: "是否属于目标图像描述、术语和归属仍需人工判断。",
  cross_block_field_relationship_requires_review: "不同片段之间的关系仍待核对。",
  new_term_pending_human_review: "新术语待核。",
  medical_semantics_and_pairing: "尚未完成医学与配图核验；不继承旧意见。",
  coreference_requires_context: "指代关系需要上下文核对。",
  numeric_expression_missing: "可能缺少原文中的数字表达，待核对。",
  confirmed_metric_definition_context_only: "用户已确认：计算方法只作必要背景，不单独列为描述；此处保留前轮真实输出。",
  disease_or_lesion_not_grounded_in_source: "疾病或病变字段没有保留为原文事实，待核对。",
  modality_not_grounded_in_source: "成像方式字段没有保留为原文事实，待核对。",
  condition_requires_context: "条件是否完整，需要结合上下文核对。",
  business_or_visual_purpose_pending: "这段可能在解释诊断、疗效或关联；是否属于目标描述仍待判断。",
  identical_primary_source_multiple_records: "同一任务保留了主原文相同的多条记录，待核对；不能据此算成多条有效描述。",
  cited_research_reference_missing: "引用来源需补充核对。",
  partial_failed_attempt_retained: "这条来自失败或部分完成的尝试，单独保留，未计入代表路径；尚未核验。",
};
const plainCheck = (check: { code: string; detail: string }) => CHECK_HELP[check.code] ?? (/[\u3400-\u9fff]/.test(check.detail) ? check.detail : "另有自动提示，仍需人工判断；原始说明可展开查看。");
const plainJobNote = (note: string) => note.includes("application_context_estimate_limit")
  ? "达到本轮已有的上下文容量限制，全文概括汇总未完成；未提高限制，也未追加优化。"
  : note.includes("汇总15响应") ? "汇总阶段多次补读和提交失败；已选原文已经处理，但汇总没有完成。未保留每次请求的完整内容，无法判断是否完全相同。" : note;
const plainOutcome = (job: ReaderJob) => job.reused_from_job_id ? "与F使用相同输入，复用其实际结果；未增加调用，也不代表零成本或更优。"
  : job.summary_complete === false ? "全文概括汇总未完成。已产生的候选、失败过程及全部耗费保留，尚未核验。" : "本次处理结果已保留，原材料解析仍有缺口；内容和配图还需核验。";

function RoundComparison({ manifest }: { manifest: ReaderManifest }) {
  const comparisons = roundComparisons(manifest);
  if (!comparisons.length) return null;
  const primary = comparisons.find(pair => pair.after.document_id === "L05" && pair.after.method === "B0") ?? comparisons[0]!;
  const before = comparisonUsage(primary.before), after = comparisonUsage(primary.after);
  return <section className="reader-comparison" data-testid="reader-comparison"><h2>前后轮实际代价 · 候选数量变化不代表质量变化</h2>
    <p data-testid="reader-primary-comparison"><strong>{primary.after.document_id} · {primary.after.method}：</strong>请求{before.requests} → {after.requests}；输入{before.input_tokens} → {after.input_tokens} / 输出{before.output_tokens} → {after.output_tokens} tokens；实际候选{primary.before.candidate_count} → {primary.after.candidate_count}。{secondsLabel(primary.before) && secondsLabel(primary.after) ? `耗时${secondsLabel(primary.before)} → ${secondsLabel(primary.after)}秒（显示至小数后两位）。` : ""}{summaryLabel(primary.before.summary_complete)} → {summaryLabel(primary.after.summary_complete)}。{costLabel(after.actual_cost)}。</p>
    <p>请求上升、概括未完成或重复候选都应单独看待；更多或更少候选均不能证明结果更好。</p>
    {primary.after.notes?.map((note, i) => <p key={i} data-testid="reader-primary-diagnostic">{plainJobNote(note)}</p>)}
    {primary.after.notes && <details><summary>诊断原始说明</summary>{primary.after.notes.map((note, i) => <p data-testid="reader-primary-diagnostic-original" key={i}>{note}</p>)}</details>}
    <details><summary>展开全部同组前后耗费与概括状态（{comparisons.length}组）</summary><div className="reader-table-scroll"><table><thead><tr><th>同组</th><th>前轮</th><th>后轮</th></tr></thead><tbody>{comparisons.map(pair => <tr key={pair.after.job_id} data-testid="reader-comparison-row"><th>{pair.after.document_id} · {pair.after.method}</th>{[pair.before, pair.after].map(job => { const usage = comparisonUsage(job); return <td key={job.job_id}>{usage.requests}次请求 · 输入{usage.input_tokens} / 输出{usage.output_tokens}<br />实际候选{job.candidate_count} · {summaryLabel(job.summary_complete)}<br />{stateLabel(job.state)} · {costLabel(usage.actual_cost)}{job.reused_from_job_id && <p>复用F代表耗费，新增调用为0；不是零成本方法胜出。</p>}</td>; })}</tr>)}</tbody></table></div></details>
  </section>;
}

function SourceGroups({ groups, title, onLocate }: { groups: SourceGroup[]; title: string; onLocate: (fragments: Fragment[], token: string) => void }) {
  return <section className="reader-source-section"><h3>{title}</h3>{groups.map((group, index) => <div key={`${group.group_id}:${index}`}>
    {index > 0 && <p className="source-break" data-testid="reader-source-break">不同源句段 · 分开核对，不拼成一条原句</p>}
    <article className="fragment" data-testid="reader-source-group" data-completeness={group.completeness}>
      <div className="fragment-head"><span>句段{index + 1} · PDF第{[...new Set(group.segments.map(part => part.physical_page))].join("、")}页</span><button type="button" onClick={() => onLocate(group.segments, `${title}:${index}`)}>在PDF中定位 ↗</button></div>
      <blockquote className="group-quote" translate="no" lang="und" data-testid="reader-group-quote">{group.segments.map((part, i) => <span key={`${part.block_id}:${part.start}:${i}`}><span data-testid="reader-exact-span" data-block-id={part.block_id} data-start={part.start} data-end={part.end} data-page={part.physical_page}>{part.exact_quote}</span>{i + 1 < group.segments.length ? group.display_joiner : ""}</span>)}</blockquote>
      {group.completeness !== "complete" && <p className="completeness-hint">{group.completeness === "incomplete" ? "文字不完整：未补入缺失文字，请回看PDF。" : "连续性待核，请结合PDF阅读。"}</p>}
      <details className="fragment-locations"><summary>展开逐片段范围与定位（{group.segments.length}段）</summary>{group.segments.map((part, i) => <div className="reader-span-location" key={i}><code>第{part.physical_page}页 · {part.block_id} [{part.start}, {part.end})</code><button type="button" data-testid="reader-locate-span" onClick={() => onLocate([part], `${title}:${index}:${i}`)}>定位此片段 ↗</button></div>)}</details>
    </article>
  </div>)}{!groups.length && <p className="muted">未提供独立的必要上下文。</p>}</section>;
}

function Reader({ manifest }: { manifest: ReaderManifest }) {
  const [mode, setMode] = useState<"records" | "issues">("records");
  const [documentId, setDocumentId] = useState("all");
  const [method, setMethod] = useState("all");
  const [roundId, setRoundId] = useState(manifest.default_round_id ?? manifest.rounds.at(-1)!.round_id);
  const [selectedRecord, setSelectedRecord] = useState("");
  const [partial, setPartial] = useState<{ record: ReaderRecord; job: ReaderJob; attempt: number } | null>(null);
  const [selectedIssue, setSelectedIssue] = useState(manifest.issues[0]?.old_item_id ?? "");
  const [located, setLocated] = useState<{ owner: string; target: PdfTarget } | null>(null);
  const jobs = new Map(manifest.jobs.map(job => [job.job_id, job]));
  const roundShort = (id: string) => `第${manifest.rounds.findIndex(round => round.round_id === id) + 1}轮${id === manifest.rounds.at(-1)?.round_id ? "（最新）" : ""}`;
  const describeMethod = (method: string) => { const label = manifest.jobs.find(job => job.method === method)?.label; return label ? `${method} · ${label}` : methodLabel(method); };
  const actualRunCount = manifest.jobs.filter(job => job.independent_model_run).length;
  const perRoundRuns = manifest.rounds.map(round => manifest.jobs.filter(job => job.round_id === round.round_id && job.independent_model_run).length);
  const runCountLabel = manifest.rounds.length === 2 && perRoundRuns[0] === perRoundRuns[1] ? `${actualRunCount}组实际运行（两轮各${perRoundRuns[0]}组）` : `${actualRunCount}组实际运行（按轮次分别统计）`;
  const records = filteredRecords(manifest, documentId, method, roundId);
  const round = manifest.rounds.find(value => value.round_id === roundId);
  const effectiveRecord = records.find(value => value.record_id === selectedRecord) ?? records[0];
  const record = partial?.record ?? effectiveRecord;
  const recordViewJob = record ? partial?.job ?? viewJobForRecord(manifest, record, method) : null;
  const issue = manifest.issues.find(value => value.old_item_id === selectedIssue) ?? manifest.issues[0];
  const relatedRecords = (issue?.new_record_ids ?? []).map(id => manifest.records.find(record => record.record_id === id)!).filter(record => roundId === "all" || jobs.get(record.job_id)!.round_id === roundId);
  const currentDocument = (mode === "records" ? record?.document_id : issue?.document_id) ?? (documentId !== "all" ? documentId : manifest.papers[0]!.document_id);
  const paper = manifest.papers.find(value => value.document_id === currentDocument)!;
  const source = mode === "records" ? record?.original_groups ?? [] : issue?.old_original_groups ?? [];
  const context = mode === "records" ? record?.context_groups ?? [] : issue?.old_context_groups ?? [];
  const owner = mode === "records" ? `record:${record?.record_id ?? "empty"}` : `issue:${issue?.old_item_id ?? "empty"}`;
  const first = firstFragment(source) ?? firstFragment(context);
  const target = useMemo<PdfTarget>(() => located?.owner === owner ? located.target : { page: first?.physical_page ?? 1, fragments: first ? [first] : [], token: owner }, [located, owner, first]);
  const locate = (fragments: Fragment[], token: string) => {
    const first = fragments[0];
    if (!first) return;
    setLocated(previous => ({ owner, target: { page: first.physical_page, fragments: fragments.filter(part => part.physical_page === first.physical_page), token: `${owner}:${token}:${(Number(previous?.target.token.split(":").pop()) || 0) + 1}` } }));
  };
  const openRecord = (value: ReaderRecord) => { setPartial(null); setRoundId(jobs.get(value.job_id)!.round_id); setDocumentId("all"); setMethod("all"); setSelectedRecord(value.record_id); setMode("records"); };
  const openPartial = (record: ReaderRecord, job: ReaderJob, attempt: number) => { setRoundId(job.round_id); setDocumentId("all"); setMethod("all"); setMode("records"); setPartial({ record, job, attempt }); };
  const recordWarnings = record ? [...new Set([...(record.semantic_review_notes ?? []), ...record.automatic_checks.filter(check => ["identical_primary_source_multiple_records", "confirmed_metric_definition_context_only"].includes(check.code)).map(check => check.detail)].filter(Boolean))] : [];
  const currentFigures = mode === "records" && record ? manifest.figures.filter(figure => record.figure_ids.includes(figure.figure_id)) : [];
  const relevantJobs = manifest.jobs.filter(job => (roundId === "all" || job.round_id === roundId) && (documentId === "all" || job.document_id === documentId) && (method === "all" || job.method === method));

  return <div className="revalidation-app" data-testid="revalidation-app">
    <header className="reader-header"><div><p className="eyebrow">T1 · 本轮实际输出</p><h1>真实复验 · 原文与问题对照</h1><p className="muted">结果定版于 {new Date(manifest.finalized_at).toLocaleString("zh-CN", { hour12: false })}</p></div><a href={assetUrl("index.html")} data-testid="legacy-reader-link">回看旧35条与原意见 ↗</a></header>
    <p className="intro" data-testid="reader-boundary">下面是前后轮已产生的真实输出，按轮次分别保留。自动检查不等于用户认可或医学批准；新记录仍待核验，未继承旧35条的任何意见。</p>
    <RoundComparison manifest={manifest} />
    <details className="reader-runs" data-testid="reader-runs"><summary>运行情况：{runCountLabel} · {manifest.jobs.length}个方法视图 · {manifest.records.length}条代表路径候选 · {partialRecords(manifest).length}条失败/部分尝试候选 · 累计{manifest.usage_totals.requests}次请求</summary><p>数量只描述实际产物。机械拒绝、排除或零候选均不能当作准确率；失败和后续尝试按实际结果保留。复用视图不是又一次独立调用。</p><p data-testid="reader-usage-total">本轮累计（含失败与重试）：{manifest.usage_totals.requests}次请求 · 输入{manifest.usage_totals.input_tokens} / 输出{manifest.usage_totals.output_tokens} tokens · {costLabel(manifest.usage_totals.actual_cost)}</p><p className="muted">令牌按运行账本口径，包含推理输出及缺失usage时的保守预留；费用未知不代表免费。</p><div className="reader-table-scroll"><table><thead><tr><th>轮次 / 论文 / 方法</th><th>运行状态</th><th>实际候选 / 可读</th><th>累计耗费</th><th>执行来源与说明</th></tr></thead><tbody>{manifest.jobs.map(job => <tr key={job.job_id} data-testid="reader-job" data-job-id={job.job_id}><th>{manifest.rounds.find(round => round.round_id === job.round_id)?.label}<br />{job.document_id} · {describeMethod(job.method)}</th><td>{stateLabel(job.state)}</td><td>{job.candidate_count} / {job.delivered_count}</td><td>{job.requests}次请求<br />输入{job.input_tokens} / 输出{job.output_tokens}<br />{job.independent_model_run ? costLabel(job.actual_cost) : "复用视图，不新增调用"}</td><td>{job.independent_model_run ? "独立执行" : `复用 ${job.reused_from_job_id ?? "同次实际结果"}`}{job.representative_measurement && <p>代表耗费参照{job.reused_from_job_id}：{job.representative_measurement.requests}次请求，输入{job.representative_measurement.input_tokens} / 输出{job.representative_measurement.output_tokens}，{costLabel(job.representative_measurement.actual_cost)}。复用F不代表零成本方法胜出。</p>}{job.source_processing_complete !== undefined && <p>源处理：{job.source_processing_complete ? "已处理完本次输入（不代表完整召回）" : "未处理完成，覆盖范围仍有限"}</p>}{job.summary_complete !== undefined && <p>全文概括诊断：{job.summary_complete ? "已完成" : "未完成"}（不是可交付特征原文）</p>}{job.outcome_reason && <><p>{plainOutcome(job)}</p><details><summary>原始运行说明</summary><p>{job.outcome_reason}</p></details></>}{job.notes?.map((note, i) => <p key={i}>{plainJobNote(note)}</p>)}{job.diagnostic_counts && <details><summary>自动检查计数（不是准确率）</summary><pre>{JSON.stringify(job.diagnostic_counts, null, 2)}</pre></details>}{job.attempts && job.attempts.length > 0 && <details><summary>实际尝试链（{job.attempts.length}次）</summary>{job.attempts.map((attempt, i) => <div className="reader-attempt" data-testid="reader-attempt" key={i}><p>尝试{attempt.attempt ?? i + 1}：{stateLabel(attempt.state ?? "未提供状态")} {attempt.outcome_reason ?? ""}</p><p>{attempt.requests ?? "未提供"}次请求 · 输入{attempt.input_tokens ?? "未提供"} / 输出{attempt.output_tokens ?? "未提供"} · {costLabel(attempt.actual_cost)}</p>{attempt.partial_records?.map(record => <article className="reader-attempt-record" data-testid="reader-attempt-record" key={record.record_id}><strong>该次失败/部分尝试的实际候选（不计入代表路径列表）</strong>{record.original_groups.map((group, index) => <div key={index}>{index > 0 && <p>另一个源句段，分开核对</p>}<blockquote translate="no">{group.segments.map(part => part.exact_quote).join("\n")}</blockquote></div>)}<button type="button" data-testid="reader-open-partial" onClick={() => openPartial(record, job, i + 1)}>查看完整原文、上下文与PDF ↗</button></article>)}</div>)}</details>}</td></tr>)}</tbody></table></div></details>
    <nav className="reader-tabs" aria-label="阅读内容"><button type="button" data-testid="reader-records-mode" aria-pressed={mode === "records"} onClick={() => { setPartial(null); setMode("records"); }}>本轮新结果</button><button type="button" data-testid="reader-issues-mode" aria-pressed={mode === "issues"} onClick={() => { setPartial(null); setMode("issues"); }}>旧11条备注 · 来源对照</button></nav>
    <div className="reader-toolbar"><label>轮次 <select data-testid="reader-round" value={roundId} onChange={event => { setPartial(null); setRoundId(event.target.value); }}>{manifest.rounds.map(round => <option key={round.round_id} value={round.round_id}>{round.label}</option>)}<option value="all">全部轮次（分别标记）</option></select></label>{mode === "records" ? <><label>论文 <select value={documentId} data-testid="reader-document" onChange={event => { setPartial(null); setDocumentId(event.target.value); }}><option value="all">全部</option>{manifest.papers.map(paper => <option value={paper.document_id} key={paper.document_id}>{paper.document_id === "L01" ? "论文一 · L01" : "论文二 · L05"}</option>)}</select></label><label>方法 <select value={method} data-testid="reader-method" onChange={event => { setPartial(null); setMethod(event.target.value); }}><option value="all">全部</option>{["B0", "F", "R"].map(value => <option key={value} value={value}>{describeMethod(value)}</option>)}</select></label><label className="reader-record-picker">新候选 <select data-testid="reader-record" value={effectiveRecord?.record_id ?? ""} onChange={event => { setPartial(null); setSelectedRecord(event.target.value); }}>{!records.length && <option value="">本筛选下无可读新候选</option>}{records.map((value, i) => <option value={value.record_id} key={value.record_id}>{roundShort(jobs.get(value.job_id)!.round_id)} · {value.document_id} · {viewJobForRecord(manifest, value, method).method} · 第{i + 1}条 · v{value.record_version}</option>)}</select></label></> : <label>旧备注 <select data-testid="reader-issue" value={issue?.old_item_id ?? ""} onChange={event => setSelectedIssue(event.target.value)}>{manifest.issues.map(value => <option key={value.old_item_id} value={value.old_item_id}>{value.old_item_id} · {value.document_id} · {value.old_note.slice(0, 42)}</option>)}</select></label>}</div>
    <section className="reader-round-note"><p data-testid="reader-round-note">{round ? round.round_id === manifest.rounds.at(-1)?.round_id ? "本轮仅新增：计算方法不单独列为描述；形态定义和实际测量仍保留。" : "前轮真实输出原样保留。后续已确认：计算方法仅作必要背景，不单独列为描述。" : "前后轮结果分别保留。每条都标明轮次，旧意见不自动用于新结果。"}</p>{round && <details><summary>规则原始说明</summary><p>{round.rule_note}</p></details>}</section>
    <main className="reader-columns"><section className="reader-source" data-testid="reader-source">
      {mode === "records" && partial && <section className="reader-partial-banner" data-testid="reader-partial-banner"><strong>正在看失败/部分尝试的实际候选</strong><p>{partial.job.actual_job_id ?? partial.job.job_id} · 尝试{partial.attempt}。此处与上方代表路径列表分开，不计为代表路径记录，不继承旧意见或核验结论。</p><button type="button" data-testid="reader-close-partial" onClick={() => setPartial(null)}>返回代表路径候选</button></section>}
      {mode === "issues" && issue && <section className="reader-issue"><h2>{issue.old_item_id} · 用户对旧样本的原备注</h2><blockquote data-testid="reader-old-note" translate="no">{issue.old_note}</blockquote><p className="muted">以下按原文来源对照。新旧候选可能不同，不能逐条等同，也不把旧意见写到新记录上。</p><h3>同源的新结果</h3>{relatedRecords.length ? <><p>当前所选轮次有原block与offset重叠，仅说明来源联系。</p><div className="reader-related">{relatedRecords.map(value => { const id = value.record_id; return <button type="button" data-testid="reader-related-record" key={id} onClick={() => openRecord(value)}>{roundShort(jobs.get(value.job_id)!.round_id)} · {value.document_id} · {jobs.get(value.job_id)?.method} · 查看新候选</button>; })}</div></> : <p data-testid="reader-no-direct-match">当前所选轮次没有直接重叠的新候选；请据实际源片段比较，不能据此认定问题已修复或论文无相关描述。</p>}{issue.automatic_observations.length > 0 && <details><summary>来源自动观察（请按标明轮次核验）</summary>{issue.automatic_observations.map((text, i) => <p key={i}>{text}</p>)}</details>}</section>}
      {mode === "records" && !record ? <section className="reader-empty" data-testid="reader-empty"><h2>本筛选下无可读新候选</h2><p>这不表示论文没有目标描述。请查看实际运行状态和自动检查原因。</p>{relevantJobs.map(job => <p key={job.job_id}>{job.document_id} · {describeMethod(job.method)}：{stateLabel(job.state)}，实际候选{job.candidate_count}条，可读{job.delivered_count}条。{job.outcome_reason}</p>)}</section> : <>
        <h2>{mode === "records" ? "新版本原文" : "旧样本原文（保留原版本）"}</h2>
        {mode === "records" && record && <p className="reader-record-label" data-testid="reader-record-label">{manifest.rounds.find(round => round.round_id === recordViewJob!.round_id)?.label} · {record.document_id} · {describeMethod(recordViewJob!.method)}{recordViewJob?.reused_from_job_id ? `（复用${jobs.get(record.job_id)!.method}同次实际结果）` : ""} · 记录版本 {record.record_version} · 待用户 / 专业核验</p>}
        {mode === "records" && recordWarnings.length > 0 && <section className="reader-partial-banner" data-testid="reader-record-warnings"><strong>待核风险与业务边界</strong>{recordWarnings.map((text, i) => <p key={i}>{text}</p>)}</section>}
        <SourceGroups groups={source} title="原文句段" onLocate={locate} />
        {context.length > 0 && <SourceGroups groups={context} title="必要上下文（独立显示）" onLocate={locate} />}
      </>}
      {mode === "records" && record && <>
        <section className="reader-checks" data-testid="reader-checks"><h3>自动检查 · 仍待用户核验</h3>{record.automatic_checks.length ? <ul>{record.automatic_checks.map((check, i) => <li key={i}><strong>{plainCheck(check)}</strong><span>{({ passed: "原文与出处检查通过", pending: "待核", failed: "检查未通过", warning: "提示", info: "提示" })[check.status] ?? "状态待核"}</span></li>)}</ul> : <p>未提供逐条自动检查结论；原文和医学关系仍待核验。</p>}<details><summary>原始检查详情</summary><pre>{JSON.stringify(record.automatic_checks, null, 2)}</pre></details></section>
        <section className="reader-figures"><h3>配图状态</h3><p className="muted">图目录或提议不等于已完成医学影像配对。主文可无图保留；图是否适合仍须核验。</p>{currentFigures.length ? currentFigures.map(figure => <article key={figure.figure_id} data-testid="reader-figure"><strong>{figure.document_id} · {figure.figure_number ? `图${figure.figure_number}` : "待归属整图区域"}</strong><p>{figure.status_label}</p>{figure.purpose_review && <p>{figure.purpose_review}</p>}{figure.assets.length ? figure.assets.map(asset => <div key={asset.pack_path}><ImagePreview src={assetUrl(asset.pack_path)} alt={`原整图 ${figure.document_id}-${figure.figure_number}`} className="figure-thumbnail"><img src={assetUrl(asset.pack_path)} alt={`图${figure.figure_number}原整图，点击放大`} /><span>查看原整图</span></ImagePreview><p className="muted">整图文件可查看，医学对应关系仍待确认。</p></div>) : <p>没有确认可用的独立整图；可回看原PDF。</p>}{figure.caption_segments[0] && <button type="button" onClick={() => locate(figure.caption_segments, `figure:${figure.figure_id}`)}>在PDF中看图注 ↗</button>}<details><summary>图注原文</summary>{figure.caption_segments.map((part, i) => <blockquote translate="no" key={i}>{part.exact_quote}</blockquote>)}</details></article>) : <p data-testid="reader-no-figure">本条没有配图提议，未完成医学影像配对。</p>}</section>
        <details className="reader-record-trace"><summary>新记录追溯信息</summary><dl><dt>实际job</dt><dd>{jobs.get(record.job_id)?.actual_job_id ?? record.job_id}</dd><dt>轮次引用</dt><dd>{record.job_id}</dd><dt>记录ID</dt><dd>{record.record_id}</dd><dt>实际源记录SHA256</dt><dd>{record.source_record_sha256}</dd></dl></details>
      </>}
    </section><PdfViewer key={paper.document_id} documentId={paper.document_id} pdfPath={paper.pdf_path} target={target} /></main>
    <footer className="reader-footer"><p>这是实际输出的阅读与来源对照，尚未获得新的人审或医学批准。机械数量不代表准确率。</p><details><summary>本轮数据与产物指纹</summary><p>批次：{manifest.batch_id}</p>{manifest.source_artifacts.map(artifact => <p key={artifact.path}><code>{artifact.path}<br />{artifact.sha256}</code></p>)}</details></footer>
  </div>;
}

async function start() {
  const host = document.getElementById("revalidation-app")!;
  try {
    const path = document.querySelector<HTMLMetaElement>('meta[name="t1-revalidation-manifest"]')?.content;
    if (!path || !/^revalidation-data-[a-f0-9]{12}\.json$/.test(path)) throw new Error("缺少定版数据");
    const response = await fetch(assetUrl(path), { cache: "no-store" });
    if (!response.ok) throw new Error("实际结果读取失败");
    const manifest = validateReaderManifest(await response.json());
    createRoot(host).render(<Reader manifest={manifest} />);
  } catch {
    host.replaceChildren();
    const notice = document.createElement("p"); notice.className = "startup-error"; notice.setAttribute("role", "alert");
    notice.textContent = "本轮定版结果未能载入。请用静态Live Server打开并保留同目录资源；当前页面没有使用模拟或未完成数据代替实际结果。";
    host.appendChild(notice);
  }
}
void start();
