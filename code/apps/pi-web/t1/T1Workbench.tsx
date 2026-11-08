"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { TabBar, type Tab } from "@/components/TabBar";
import { ImagePreview } from "@/components/ImagePreview";
import { SidebarMenu, type SidebarMenuAnchor } from "@/components/SidebarMenu";
import { SidebarToast, type SidebarToastData } from "@/components/SidebarToast";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useTheme } from "@/hooks/useTheme";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { movePanelTab } from "@/lib/panel-tab-order";
import { getRightPanelMaxWidth, getSidebarMaxWidth } from "@/lib/panel-layout";
import { useRunEvents } from "./useRunEvents";
import type { WorkbenchCapabilities, WorkbenchFigure, WorkbenchFragment, WorkbenchPaper, WorkbenchPaperDetail, WorkbenchRun } from "../../../packages/contracts/src/workbench";
const PdfSource = dynamic(() => import("./PdfSource").then(module => module.PdfSource), { ssr: false });

async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/t1/${path}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 404 ? "未找到所选论文或任务" : response.status === 502 ? "尚未连接到 T1 服务" : "来源核验或数据读取失败");
  return response.json();
}
const initialTabs: Tab[] = [
  { id: "evidence", label: "原文片段", filePath: "已保留的历史候选原文" },
  { id: "figures", label: "原 Figure 目录", filePath: "独立图源目录，不代表与某条原文相关" },
  { id: "inspector", label: "工程任务", filePath: "S1 状态与业务事件" },
];

function Fragments({ fragments, onPage }: { fragments: WorkbenchFragment[]; onPage: (page: number) => void }) {
  return <div className="t1-fragments">{fragments.map((fragment, index) => <div className="t1-fragment" key={`${fragment.block_id}:${fragment.start}:${index}`}>
    <div className="t1-fragment-location"><button onClick={() => onPage(fragment.physical_page)}>第 {fragment.physical_page} 物理页 ↗</button><span>{fragment.block_id} · {fragment.start}–{fragment.end}</span></div>
    <p className="t1-verbatim">{fragment.exact_quote}</p>
  </div>)}</div>;
}

function FigureView({ figure, onPage, relation = "已明确关联此条原文 · 待人工核对" }: { figure: WorkbenchFigure; onPage: (page: number) => void; relation?: string }) {
  return <section className="t1-figure" aria-label={`原 Figure ${figure.number ?? "待核"}`}>
    <p className="t1-footnote">{relation}</p>
    <div className="t1-section-title"><strong>Figure {figure.number ?? "编号待核"}</strong><span>{figure.verification === "needs_review" ? "完整性待核 · 不作为配图" : "整幅来源已做工程核验 · 医学关联待人工核对"}</span></div>
    {figure.assets.map(asset => <div key={asset.id}>
      <ImagePreview src={asset.url} alt={`Figure ${figure.number ?? "待核"} · 第${asset.page}物理页`}><img src={asset.url} alt={`整幅原 Figure ${figure.number ?? "待核"}`} width={asset.width} height={asset.height} /></ImagePreview>
      <button className="t1-link" onClick={() => onPage(asset.page)}>查看第 {asset.page} 物理页</button>
    </div>)}
    <div className="t1-caption"><span>原图注 · 各原文段分别保留</span><Fragments fragments={figure.caption} onPage={onPage} /></div>
  </section>;
}

export function T1Workbench() {
  const { preference, setThemePreference } = useTheme();
  const mobile = useIsMobile(); useViewportHeight();
  const [papers, setPapers] = useState<WorkbenchPaper[]>([]);
  const [capabilities, setCapabilities] = useState<WorkbenchCapabilities | null>(null);
  const [runs, setRuns] = useState<WorkbenchRun[]>([]);
  const [paperId, setPaperId] = useState("L01");
  const [detail, setDetail] = useState<WorkbenchPaperDetail | null>(null);
  const [outputId, setOutputId] = useState("");
  const [recordIndex, setRecordIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [detailError, setDetailError] = useState(""), [revision, setRevision] = useState(0);
  const [tabs, setTabs] = useState(initialTabs), [activeTab, setActiveTab] = useState("evidence");
  const [runInput, setRunInput] = useState(""), [runId, setRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState(""), [runState, setRunState] = useState("");
  const [showSource, setShowSource] = useState(true), [showSidebar, setShowSidebar] = useState(true);
  const [menu, setMenu] = useState<SidebarMenuAnchor | null>(null);
  const [toast, setToast] = useState<SidebarToastData | null>(null);
  const sidebarWidth = useRef(260), sourceWidth = useRef(520);
  const sidebarMax = useCallback(() => getSidebarMaxWidth({ viewportWidth: window.innerWidth, rightPanelOpen: showSource, rightPanelWidth: sourceWidth.current }), [showSource]);
  const sourceMax = useCallback(() => getRightPanelMaxWidth({ viewportWidth: window.innerWidth, sidebarOpen: showSidebar, sidebarWidth: sidebarWidth.current }), [showSidebar]);
  const sidebar = useResizablePanel({ ariaLabel: "调整论文导航宽度", cssVariable: "--t1-sidebar-width", defaultWidth: 260,
    getMaxWidth: sidebarMax, growthDirection: "right", minWidth: 180, maxWidth: 480, storageKey: "t1:pi-web:sidebar-width", widthRef: sidebarWidth });
  const source = useResizablePanel({ ariaLabel: "调整原文阅读器宽度", cssVariable: "--t1-source-width", defaultWidth: 520,
    getMaxWidth: sourceMax, growthDirection: "left", minWidth: 300, maxWidth: 1000, storageKey: "t1:pi-web:source-width", widthRef: sourceWidth });
  const { events, connection } = useRunEvents(runId);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    Promise.all([api<WorkbenchCapabilities>("workbench/capabilities", controller.signal), api<{ papers: WorkbenchPaper[] }>("workbench/papers", controller.signal), api<{ runs: WorkbenchRun[] }>("workbench/runs", controller.signal)])
      .then(([caps, listed, inspected]) => { setCapabilities(caps); setPapers(listed.papers); setRuns(inspected.runs); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    const controller = new AbortController(); setDetail(null); setDetailError(""); setPage(1); setRecordIndex(0);
    api<WorkbenchPaperDetail>(`workbench/papers/${encodeURIComponent(paperId)}`, controller.signal).then(value => {
      setDetail(value); setOutputId(value.outputs.find(output => output.strategy === "B0")?.id ?? value.outputs[0]?.id ?? "");
    }).catch(cause => { if (!controller.signal.aborted) setDetailError(cause.message); });
    return () => controller.abort();
  }, [paperId, revision]);

  useEffect(() => { if (events.length) setRunState(events.at(-1)!.stage); }, [events]);
  const output = detail?.outputs.find(item => item.id === outputId), record = output?.records[recordIndex];
  const paper = detail?.paper ?? papers.find(item => item.id === paperId);
  function openTab(id: string) {
    if (!tabs.some(tab => tab.id === id)) setTabs(current => [...current, initialTabs.find(tab => tab.id === id)!]);
    setActiveTab(id);
  }
  async function inspectRun(id: string) {
    setRunId(null); setRunError(""); setRunState("");
    try {
      const value = await api<{ state: string }>(`runs/${encodeURIComponent(id)}`);
      setRunState(value.state); setRunId(id); setRunInput(id);
    } catch (cause) { setRunError(cause instanceof Error ? cause.message : "任务读取失败"); }
  }
  function sourcePage(value: number) { setPage(value); setShowSource(true); }
  function refresh() { setRevision(value => value + 1); setToast({ id: Date.now(), message: "正在重新读取并核验来源", actions: [] }); }

  return <div className="t1-workbench" ref={sidebar.panelRef}>
    <header className="t1-topbar"><div className="t1-brand"><span>T1</span><strong>论文原文工作台</strong><small>基于 Pi Web</small></div>
      <div className="t1-top-actions"><button onClick={refresh} aria-label="刷新工作台">↻</button>
        <button aria-label="界面主题" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ kind: "rect", rect, align: "end" }); }}>◐</button>
      </div>
    </header>
    <div className="t1-body" ref={source.panelRef}>
      {showSidebar && <><aside className="t1-sidebar" aria-label="论文导航">
        <div className="t1-sidebar-heading"><strong>论文</strong><span>{papers.length ? `${papers.length} 篇已登记` : "等待数据"}</span><button className="t1-sidebar-close" aria-label="关闭论文导航" onClick={() => setShowSidebar(false)}>×</button></div>
        <p className="t1-sidebar-note">既有开发材料 · 只读查看</p>
        <div className="t1-paper-list">{papers.map(item => <button key={item.id} aria-label={`${item.id} ${item.title}`} className={paperId === item.id ? "selected" : ""} onClick={() => { setPaperId(item.id); openTab("evidence"); if (mobile) setShowSidebar(false); }}>
          <span><b>{item.id}</b><small>{item.language === "zh" ? "中文" : "English"} · {item.pages} 页</small></span><strong>{item.title}</strong><em>{item.output_ids.length ? `${item.output_ids.length} 份历史候选` : "暂无抽取结果"}</em>
        </button>)}</div>
        <div className="t1-sidebar-bottom"><button onClick={() => openTab("inspector")}>◉ 工程任务与事件</button><p>候选尚未人工审核。<br />浏览与工程核验不会批准医学结论。</p><span>Pi Web 0.15.0 · T1 Pi SDK 1.4.0</span></div>
        <SidebarToast toast={toast} onDismiss={() => setToast(null)} dismissLabel="关闭提示" />
      </aside><div className="t1-resize" {...sidebar.separatorProps} /></>}

      <main className="t1-main"><div className="t1-workspace-bar"><button onClick={() => setShowSidebar(value => !value)} aria-label="切换论文导航">☰</button><span>{paper?.id ?? paperId} <b> / </b>{paper?.title ?? "读取论文"}</span><button className="t1-source-toggle" onClick={() => setShowSource(value => !value)}>{showSource ? "收起原件" : "查看原件"}</button>{detail && <a className="t1-mobile-source" href={`${detail.pdf_url}#page=${page}`} target="_blank" rel="noreferrer">原件 ↗</a>}</div>
        <TabBar tabs={tabs} activeTabId={activeTab} onSelectTab={setActiveTab} onCloseTab={id => { const next = tabs.filter(tab => tab.id !== id); setTabs(next); if (activeTab === id) setActiveTab(next[0]?.id ?? ""); }} onReorderTab={(from, to, after) => setTabs(current => movePanelTab(current.map(tab => tab.id), from, to, after).map(id => current.find(tab => tab.id === id)!))} />
        <div className="t1-content">
          {loading && <p className="t1-status" role="status">正在连接 T1 服务…</p>}
          {error && <div className="t1-alert" role="alert"><strong>{error}</strong><p>请启动本地 T1 服务后重试；请确认后台启动状态后重试。</p><button onClick={refresh}>重新连接</button></div>}
          {detailError && activeTab !== "inspector" && <div className="t1-alert" role="alert"><strong>{detailError}</strong><button onClick={refresh}>重新读取来源</button></div>}
          {!activeTab && <div className="t1-empty"><h1>选择工作视图</h1><p>页签已关闭。可随时重新打开。</p>{initialTabs.map(tab => <button key={tab.id} onClick={() => openTab(tab.id)}>{tab.label}</button>)}</div>}
          {activeTab === "evidence" && detail && <>
            <div className="t1-heading"><div><span className="t1-eyebrow">ORIGINAL SOURCE</span><h1>原文片段</h1></div><span className="t1-badge">候选 · 待人工审核</span></div>
            <p className="t1-lead">历史抽取结果按现行原文规则重新核验后展示。各段保留原文、页码与位置，不改写或补全。</p>
            <div className="t1-output-toolbar"><label>历史策略 <select aria-label="历史策略" value={outputId} onChange={event => { setOutputId(event.target.value); setRecordIndex(0); }}>{detail.outputs.length ? detail.outputs.map(item => <option value={item.id} key={item.id}>{item.strategy} · {item.records.length} 条候选</option>) : <option value="">无历史结果</option>}</select></label><span>B0 为默认；F / R / FR 仍为可比较策略，当前只展示已保留的独立结果。</span></div>
            {!output?.records.length ? <div className="t1-empty"><h2>此论文暂无已接入的抽取结果</h2><p>已登记原PDF与图源。当前不会启动新的模型抽取，也不会将空结果解释为“没有证据”。</p><button onClick={() => openTab("figures")}>查看图源目录</button></div> : <>
              <div className="t1-record-nav"><label>原文记录 <select aria-label="原文记录" value={recordIndex} onChange={event => setRecordIndex(Number(event.target.value))}>{output.records.map((item, index) => <option key={item.id} value={index}>{String(index + 1).padStart(2, "0")} · {item.fragments[0]?.exact_quote.slice(0, 72)}</option>)}</select></label><span>共 {output.records.length} 条 · 原运行状态 {output.state}</span></div>
              {record && <article className="t1-evidence-card"><div className="t1-record-meta"><b>记录 {recordIndex + 1}</b><code>{record.id}</code><span>版本 {record.version}</span></div>{record.evidence_role === "background_suggestion" && <p className="t1-badge">仅背景建议，未人工确认 · 不计为独立主目标</p>}<Fragments fragments={record.fragments} onPage={sourcePage} />
                {!!record.context.length && <details className="t1-context"><summary>查看原文上下文 · {record.context.length} 段</summary><Fragments fragments={record.context} onPage={sourcePage} /></details>}
                <div className={`t1-association ${record.association}`}><strong>{record.association === "paired" ? "有明确原文关联的原 Figure" : record.association === "pending" ? "配图待核 · 保留文字" : record.association === "not_checked" ? "配图尚未检查" : "此条未确认明确配图关联"}</strong>{record.reasons.map((reason, index) => <p key={index}>{reason}</p>)}{record.association === "paired" && record.figure_ids.map(id => { const figure = detail.figures.find(item => item.id === id); return figure ? <FigureView key={id} figure={figure} onPage={sourcePage} /> : null; })}</div>
              </article>}
              <p className="t1-footnote">这是旧合同结果的离线兼容回放；未进行新的模型实验，不证明策略优劣、全文召回或医学质量。当前没有已审核导出。</p>
            </>}
          </>}
          {activeTab === "figures" && detail && <><div className="t1-heading"><div><span className="t1-eyebrow">SOURCE FIGURES</span><h1>原 Figure 目录</h1></div><span className="t1-badge">独立图源核对</span></div><p className="t1-lead">此目录用于查看来源。出现在目录中不代表与某条原文相关；只有原文明确关联、整幅来源已核验的图，才进入该条的配图区域。流程图、示意图等图源不会自动认定为肿瘤影像。</p>{!detail.figures.length ? <div className="t1-empty"><h2>暂未取得可用 Figure 条目</h2><p>不代表论文没有图。请在右侧原PDF中核对。</p></div> : detail.figures.map(figure => <FigureView key={figure.id} figure={figure} onPage={sourcePage} relation={detail.outputs.some(output => output.records.some(record => record.figure_ids.includes(figure.id))) ? "历史候选中有明确原文对应 · 关联仍待人工审核" : detail.outputs.some(output => output.records.some(record => record.proposed_figure_ids.includes(figure.id))) ? "待核候选 · 尚未确认原文对应" : "独立图源 · 无明确原文对应"} />)}</>}
          {activeTab === "inspector" && <><div className="t1-heading"><div><span className="t1-eyebrow">BUSINESS EVENTS</span><h1>工程任务与事件</h1></div><span className="t1-badge">S1 检查器</span></div><p className="t1-lead">只读连接已有任务。工程 fixture 与论文抽取结果分开显示；没有任务时不会生成或模拟运行。</p>
            <form className="t1-run-form" onSubmit={event => { event.preventDefault(); if (runInput.trim()) void inspectRun(runInput.trim()); }}><label>已有任务 ID<input aria-label="已有任务 ID" value={runInput} onChange={event => setRunInput(event.target.value)} placeholder="输入任务 ID" /></label><button type="submit">查看任务</button></form>
            <div className="t1-run-list">{runs.length ? runs.map(run => <button key={run.run_id} onClick={() => void inspectRun(run.run_id)}><strong>{run.document_id}</strong><span>{run.state} · {run.fixture ? "工程 fixture" : "原PDF工程探测"}</span><code>{run.run_id}</code></button>) : <p>当前没有已登记的 S1 工程任务。</p>}</div>
            {runError && <p role="alert" className="t1-alert">{runError}</p>}
            <div className="t1-stream-status" role="status">{connection}{runState && ` · 状态 ${runState}`}</div>
            {runId && <ol className="t1-events">{events.map(event => <li key={event.seq}><span>#{event.seq} · {event.type} · {event.fixture ? "fixture" : "工程探测"}</span><p>{event.summary}</p><time>{event.timestamp}</time></li>)}</ol>}
          </>}
          {capabilities && <section className="t1-capabilities"><strong>本轮可用</strong><p>原PDF、原文候选与图源只读查看；已有工程任务与事件。</p><span>论文上传、启动新抽取、真实审核与已审核导出尚未接通。完整 S5 尚未完成。</span></section>}
        </div>
      </main>
      {showSource && detail && <><div className="t1-resize" {...source.separatorProps} /><aside className="t1-source" aria-label="原PDF查看器"><div className="t1-source-heading"><div><strong>原 PDF</strong><span>{detail.paper.id} · {detail.paper.pages} 物理页</span></div><a href={`${detail.pdf_url}#page=${page}`} target="_blank" rel="noreferrer">单独打开 ↗</a></div><p>原文定位请求：第 {page} 物理页 · 文件身份已核验</p><PdfSource key={detail.paper.id} url={detail.pdf_url} sha256={detail.paper.sha256} page={page} pages={detail.paper.pages} onPage={sourcePage} /><div className="t1-source-footer"><span>SHA256 {detail.paper.sha256.slice(0, 16)}…</span><small>原件保留；阅读不会自动标记已审核。</small></div></aside></>}
    </div>
    <SidebarMenu open={menu !== null} anchor={menu} sheet={mobile} ariaLabel="界面主题" title="界面主题" cancelLabel="取消" onClose={() => setMenu(null)} items={([['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([id, label]) => ({ type: "item", id, label, checked: preference === id, onSelect: () => setThemePreference(id) }))} />
  </div>;
}
