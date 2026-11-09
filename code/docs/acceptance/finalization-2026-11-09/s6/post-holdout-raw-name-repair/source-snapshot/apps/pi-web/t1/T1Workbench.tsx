"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { TabBar, type Tab } from "@/components/TabBar";
import { SidebarMenu, type SidebarMenuAnchor } from "@/components/SidebarMenu";
import { SidebarToast, type SidebarToastData } from "@/components/SidebarToast";
import { PlusIcon, RefreshIcon, SearchIcon, ChevronIcon, CloseIcon, EyeIcon, MessageIcon, OpenInNewTabIcon } from "@/components/SidebarIcons";
import { GenericFileIcon } from "@/components/FileIcons";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { movePanelTab } from "@/lib/panel-tab-order";
import { getRightPanelMaxWidth, getSidebarMaxWidth } from "@/lib/panel-layout";
import { useRunEvents } from "./useRunEvents";
import { api, jsonBody, request, WorkbenchError } from "./api";
import { ScopeEditor, ScopeSummary } from "./ScopeEditor";
import { scopeProblems, type ScopeCatalog } from "./scope";
import { FigureView, Fragments } from "./EvidenceSource";
import { RecordReview } from "./RecordReview";
import { SourceEditor } from "./SourceEditor";
import { FigureVerification } from "./FigureVerification";
import { SameSourceMembers } from "./SameSourceMembers";
import { ModelRuntimeNotice } from "./ModelRuntimeNotice";
import { runPresentation } from "./run-presentation";
import type { Scope } from "../../../packages/contracts/src/index";
import type { WorkbenchCapabilities, WorkbenchExportKind, WorkbenchPaper, WorkbenchPaperDetail, WorkbenchRun, WorkbenchRunDetail, WorkbenchScopeCatalog } from "../../../packages/contracts/src/workbench";

const PdfSource = dynamic(() => import("./PdfSource").then(module => module.PdfSource), { ssr: false });
const terminal = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
type RunDetail = WorkbenchRunDetail;
const exportKinds: WorkbenchExportKind[] = ["candidate_jsonl", "candidate_csv", "candidate_package", "approved_jsonl", "approved_csv", "approved_package"];

export function T1Workbench() {
  const { t, locale, setLocale, supportedLocales } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const mobile = useIsMobile(); useViewportHeight();
  const [papers, setPapers] = useState<WorkbenchPaper[]>([]), [runs, setRuns] = useState<WorkbenchRun[]>([]);
  const [capabilities, setCapabilities] = useState<WorkbenchCapabilities | null>(null), [catalog, setCatalog] = useState<ScopeCatalog | null>(null), [scope, setScope] = useState<Scope | null>(null);
  const [paperId, setPaperId] = useState(""), [runId, setRunId] = useState<string | null>(null), [historyId, setHistoryId] = useState(""), [recordId, setRecordId] = useState("");
  const [detail, setDetail] = useState<WorkbenchPaperDetail | null>(null), [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0), [recordQuery, setRecordQuery] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [detailError, setDetailError] = useState("");
  const [activeTab, setActiveTab] = useState("newTask"), [tabIds, setTabIds] = useState(["newTask", "records", "figures", "tasks"]);
  const [showSource, setShowSource] = useState(true), [showSidebar, setShowSidebar] = useState(true);
  const [menu, setMenu] = useState<SidebarMenuAnchor | null>(null), [toast, setToast] = useState<SidebarToastData | null>(null);
  const [file, setFile] = useState<File | null>(null), [title, setTitle] = useState(""), [uploading, setUploading] = useState(false), [starting, setStarting] = useState(false), [actionError, setActionError] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null), [restoreBusy, setRestoreBusy] = useState(false), [deletePaperConfirm, setDeletePaperConfirm] = useState(false);
  const [editor, setEditor] = useState<{ run: string; record: string | null } | null>(null), [download, setDownload] = useState("");
  const refreshRunRef = useRef<(() => Promise<void>) | null>(null);
  const locatedRecordRef = useRef("");
  const initialized = useRef(false), fileInput = useRef<HTMLInputElement>(null), sidebarWidth = useRef(260), sourceWidth = useRef(520);
  const sidebarMax = useCallback(() => getSidebarMaxWidth({ viewportWidth: window.innerWidth, rightPanelOpen: showSource, rightPanelWidth: sourceWidth.current }), [showSource]);
  const sourceMax = useCallback(() => getRightPanelMaxWidth({ viewportWidth: window.innerWidth, sidebarOpen: showSidebar, sidebarWidth: sidebarWidth.current }), [showSidebar]);
  const sidebar = useResizablePanel({ ariaLabel: t("t1.resizeNav"), cssVariable: "--t1-sidebar-width", defaultWidth: 260, getMaxWidth: sidebarMax, growthDirection: "right", minWidth: 180, maxWidth: 480, storageKey: "t1:pi-web:sidebar-width", widthRef: sidebarWidth });
  const source = useResizablePanel({ ariaLabel: t("t1.resizeSource"), cssVariable: "--t1-source-width", defaultWidth: 520, getMaxWidth: sourceMax, growthDirection: "left", minWidth: 300, maxWidth: 1000, storageKey: "t1:pi-web:source-width", widthRef: sourceWidth });
  const { events, connection } = useRunEvents(runId, true);
  const tabs: Tab[] = tabIds.map(id => ({ id, label: t(`t1.${id}`), filePath: t(`t1.${id}`) }));
  const selectedRun = runs.find(run => run.run_id === runId);
  const currentRun = runDetail?.run.run_id === runId ? runDetail : null;
  const currentPaper = detail?.paper.id === paperId ? detail : null;
  const output = runId ? currentRun?.output : currentPaper?.outputs.find(item => item.id === historyId);
  const glyphCoverage = output?.coverage && typeof output.coverage === "object" ? output.coverage as Record<string, unknown> : null;
  const legacyGlyphCheck = Boolean(output && output.fixture !== true && output.origin !== "controlled_fixture" && !glyphCoverage?.source_glyph_check_status);
  const records = output?.records.filter(record => !record.deleted) ?? [];
  const query = recordQuery.trim().toLocaleLowerCase();
  const visibleRecords = query ? records.filter(item => [...item.fragments, ...item.context].some(fragment => fragment.exact_quote.toLocaleLowerCase().includes(query))) : records;
  const record = visibleRecords.find(item => item.id === recordId) ?? visibleRecords[0];
  const selectedRecordId = record?.id;
  const recordPosition = record ? visibleRecords.indexOf(record) : -1;
  const firstSourcePage = record?.fragments[0]?.physical_page;
  const paper = currentRun?.paper ?? currentPaper?.paper ?? papers.find(item => item.id === paperId);
  const figures = currentRun?.figures ?? currentPaper?.figures ?? [];
  const sourceStatus = currentRun?.source_status ?? currentPaper?.source_status ?? (currentPaper?.source_verified ? "valid" : "not_parsed");
  const sourceIssues = currentRun?.source_issues ?? currentPaper?.source_issues ?? [];
  const sourceBlocked = sourceStatus === "missing" || sourceStatus === "mismatch";
  const pdfUrl = currentRun?.pdf_url ?? currentPaper?.pdf_url;
  const units = currentRun?.source_units ?? currentPaper?.source_units ?? [];
  const editable = Boolean(runId && currentRun && capabilities?.persisted_review);
  const paperRuns = runs.filter(run => run.document_id === paperId);

  useEffect(() => { if (mobile) setShowSidebar(false); }, [mobile]);
  useEffect(() => { setRecordQuery(""); }, [paperId, runId, historyId]);
  // Follow a newly selected record once; polling and version updates must not
  // steal a page the reviewer selected manually.
  useEffect(() => {
    if (!selectedRecordId || !firstSourcePage) return;
    const key = `${paperId}:${runId ?? historyId}:${selectedRecordId}`;
    if (locatedRecordRef.current !== key) { locatedRecordRef.current = key; setPage(firstSourcePage); }
  }, [paperId, runId, historyId, selectedRecordId, firstSourcePage]);

  function errorText(cause: unknown) {
    if (cause instanceof WorkbenchError && cause.code.includes("source_glyph_check_missing")) return t("t1.sourceGlyphLegacy");
    if (cause instanceof WorkbenchError && cause.code.includes("source_glyph_fidelity_unverified")) return t("t1.sourceGlyphUnreliable");
    if (cause instanceof WorkbenchError && cause.code === "restore_requires_identical_pdf") return t("t1.restoreMismatch");
    if (cause instanceof WorkbenchError && cause.code === "paper_has_active_runs") return t("t1.activePaperDelete");
    if (cause instanceof WorkbenchError && cause.code.startsWith("source_integrity_blocked")) return t("t1.sourceProblem");
    if (cause instanceof WorkbenchError) return cause.status === 502 ? t("t1.backendUnavailable") : cause.status === 404 ? t("t1.notFound") : cause.status === 409 ? t("t1.conflict") : cause.code;
    return cause instanceof Error ? cause.message : t("t1.requestFailed");
  }
  function openTab(id: string) { setTabIds(current => current.includes(id) ? current : [...current, id]); setActiveTab(id); }
  function selectPaper(id: string) { setDeletePaperConfirm(false); setRestoreFile(null); setPaperId(id); setRunId(runs.find(run => run.document_id === id)?.run_id ?? null); setHistoryId(""); setRecordId(""); setRunDetail(null); setPage(1); setActionError(""); openTab("records"); if (mobile) setShowSidebar(false); }
  function selectRun(run: WorkbenchRun) { setDeletePaperConfirm(false); setRestoreFile(null); setPaperId(run.document_id); setRunId(run.run_id); setHistoryId(""); setRecordId(""); setPage(1); setActionError(""); openTab("records"); }
  function sourcePage(value: number) { setPage(value); setShowSource(true); }
  const refresh = () => setRevision(value => value + 1);
  const reloadCurrent = async () => { await refreshRunRef.current?.(); };


  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api<WorkbenchCapabilities>("workbench/capabilities", { signal: controller.signal }), api<{ papers: WorkbenchPaper[] }>("workbench/papers", { signal: controller.signal }), api<{ runs: WorkbenchRun[] }>("workbench/runs", { signal: controller.signal }), api<WorkbenchScopeCatalog>("workbench/catalog", { signal: controller.signal })])
      .then(([caps, listed, tasks, rawChoices]) => {
        const choices: ScopeCatalog = { ...rawChoices, catalog: rawChoices };
        setCapabilities(caps); setPapers(listed.papers); setRuns(tasks.runs); setCatalog(choices); setScope(current => current ?? choices.default_scope); setError("");
        if (!initialized.current) {
          const params = new URLSearchParams(window.location.search), savedRun = params.get("run"), savedPaper = params.get("paper");
          const run = tasks.runs.find(item => item.run_id === savedRun);
          setPaperId(run?.document_id ?? (listed.papers.some(item => item.id === savedPaper) ? savedPaper! : listed.papers[0]?.id ?? ""));
          setRunId(run?.run_id ?? null); setHistoryId(params.get("history") ?? ""); setRecordId(params.get("record") ?? "");
          setActiveTab(["newTask", "records", "figures", "tasks"].includes(params.get("view") ?? "") ? params.get("view")! : run ? "records" : "newTask");
          initialized.current = true;
        }
      }).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // Locale changes do not restart task I/O.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  useEffect(() => {
    if (!paperId) return;
    const controller = new AbortController(); setDetailError("");
    api<WorkbenchPaperDetail>(`workbench/papers/${encodeURIComponent(paperId)}`, { signal: controller.signal }).then(value => {
      setDetail(value); setHistoryId(current => value.outputs.some(item => item.id === current) ? current : value.outputs.find(item => item.strategy === "B0")?.id ?? value.outputs[0]?.id ?? "");
    }).catch(cause => { if (!controller.signal.aborted) setDetailError(errorText(cause)); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, revision]);
  useEffect(() => {
    if (!runId) { refreshRunRef.current = null; return; }
    const controller = new AbortController(); let flight: Promise<void> | null = null, dirty = false;
    setDetailError("");
    async function load() {
      if (controller.signal.aborted) return;
      if (flight) { dirty = true; return flight; }
      flight = (async () => {
        do {
          dirty = false;
          try {
            const value = await api<RunDetail>(`workbench/runs/${encodeURIComponent(runId!)}`, { signal: controller.signal });
            if (!controller.signal.aborted) { setRunDetail(value); setDetailError(""); setPapers(current => current.map(paper => paper.id === value.paper.id ? value.paper : paper)); }
          } catch (cause) { if (!controller.signal.aborted) setDetailError(errorText(cause)); }
        } while (dirty && !controller.signal.aborted);
      })();
      try { await flight; } finally { flight = null; }
    }
    refreshRunRef.current = load; void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => { controller.abort(); window.clearInterval(timer); if (refreshRunRef.current === load) refreshRunRef.current = null; };
    // Selection changes abort their own reads. Events and polling coalesce behind one request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, revision]);
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    if (paperId) params.set("paper", paperId);
    if (runId) params.set("run", runId); else if (historyId) params.set("history", historyId);
    if (recordId) params.set("record", recordId);
    params.set("view", activeTab);
    window.history.replaceState(null, "", `/?${params}`);
  }, [paperId, runId, historyId, recordId, activeTab]);
  const lastEvent = events.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!lastEvent) return;
    const timer = window.setTimeout(() => { void refreshRunRef.current?.(); }, 350);
    return () => clearTimeout(timer);
  }, [lastEvent]);
  useEffect(() => {
    const controller = new AbortController(); let busy = false;
    const timer = window.setInterval(async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try { const listed = await api<{ runs: WorkbenchRun[] }>("workbench/runs", { signal: controller.signal }); if (!controller.signal.aborted) setRuns(listed.runs); }
      catch { /* The selected run has its own visible connection and read errors. */ }
      finally { busy = false; }
    }, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);


  async function uploadPaper() {
    if (!file || !/\.pdf$/i.test(file.name) || file.size > 50 * 1024 * 1024 || !file.size) { setActionError(t("t1.invalidPdf")); return; }
    setUploading(true); setActionError("");
    try {
      const value = await api<{ paper: WorkbenchPaper }>("workbench/papers", { method: "POST", headers: { "content-type": "application/pdf", "x-t1-filename": encodeURIComponent(file.name), ...(title.trim() ? { "x-t1-title": encodeURIComponent(title.trim()) } : {}) }, body: file });
      setPaperId(value.paper.id); setRunId(null); setFile(null); setTitle(""); if (fileInput.current) fileInput.current.value = ""; refresh(); setToast({ id: Date.now(), message: t("t1.saved"), actions: [] });
    } catch (cause) { setActionError(errorText(cause)); } finally { setUploading(false); }
  }
  async function startRun() {
    if (!paperId || !scope || !catalog || scopeProblems(scope, catalog).length) return;
    setStarting(true); setActionError("");
    try {
      const value = await api<{ run: WorkbenchRun }>(`workbench/papers/${encodeURIComponent(paperId)}/runs`, jsonBody("POST", { scope }));
      selectRun(value.run); refresh();
    } catch (cause) { setActionError(errorText(cause)); } finally { setStarting(false); }
  }
  async function cancelRun(id: string) {
    try { setActionError(""); await api(`workbench/runs/${encodeURIComponent(id)}/cancel`, jsonBody("POST", {})); await reloadCurrent(); } catch (cause) { setActionError(errorText(cause)); }
  }
  async function downloadExport(kind: WorkbenchExportKind) {
    if (!runId) return;
    setDownload(kind); setActionError("");
    try {
      const response = await request(`workbench/runs/${encodeURIComponent(runId)}/exports/${kind}`), blob = await response.blob();
      const url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url;
      anchor.download = `${paperId}-${runId}-${kind}.${kind.endsWith("package") ? "tar.gz" : kind.endsWith("csv") ? "csv" : "jsonl"}`;
      anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setActionError(errorText(cause)); } finally { setDownload(""); }
  }
  async function restoreOriginal() {
    if (!restoreFile || restoreFile.size > 50 * 1024 * 1024) return;
    setRestoreBusy(true); setActionError("");
    try { await api(`workbench/papers/${encodeURIComponent(paperId)}/pdf`, { method: "PUT", headers: { "content-type": "application/pdf" }, body: restoreFile }); setRestoreFile(null); await reloadCurrent(); }
    catch (cause) { setActionError(errorText(cause)); } finally { setRestoreBusy(false); }
  }
  async function deletePaper() {
    try { await api(`workbench/papers/${encodeURIComponent(paperId)}`, jsonBody("DELETE", {})); setPaperId(""); setRunId(null); setDetail(null); setRunDetail(null); setDeletePaperConfirm(false); openTab("newTask"); refresh(); }
    catch (cause) { setActionError(errorText(cause)); }
  }
  function sourceIssueText(issue: string) {
    return t(issue.startsWith("pdf_") ? issue.includes("missing") ? "t1.pdfMissing" : "t1.pdfChanged" : issue.startsWith("ir_") ? "t1.irProblem" : "t1.bindingProblem");
  }
  const state = currentRun?.run.state ?? selectedRun?.state ?? output?.state;
  const presentation = runPresentation(state, output?.coverage);
  function runLabel(run: WorkbenchRun) {
    const saved = currentRun?.run.run_id === run.run_id ? currentRun.output : currentPaper?.outputs.find(item => item.id === run.run_id);
    return t(`t1.${runPresentation(run.state, saved?.coverage).statusKey}`);
  }
  const selectedEditorRecord = editor?.record ? records.find(item => item.id === editor.record) ?? null : null;

  return <div className="t1-workbench" ref={sidebar.panelRef}>
    <header className="t1-topbar"><div className="t1-brand"><span>T1</span><strong>{t("t1.title")}</strong><small>{t("t1.basedOn")}</small></div>
      <div className="t1-top-actions"><select aria-label={t("t1.language")} value={locale} onChange={e => setLocale(e.target.value as typeof locale)}>{supportedLocales.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select><button onClick={refresh} aria-label={t("t1.refresh")} title={t("t1.refresh")}><RefreshIcon size={16} /></button><button aria-label={t("t1.theme")} title={t("t1.theme")} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ kind: "rect", rect, align: "end" }); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20.8 13.2A9 9 0 0 1 10.8 3.1 9 9 0 1 0 20.8 13.2Z" /></svg></button></div>
    </header>
    <div className="t1-body" ref={source.panelRef}>
      {showSidebar && <><aside className="t1-sidebar" aria-label={t("t1.paperNav")}><div className="t1-sidebar-heading"><strong>{t("t1.papers")}</strong><span>{papers.length}</span><button className="t1-sidebar-close" aria-label={t("t1.close")} onClick={() => setShowSidebar(false)}><CloseIcon size={18} /></button></div>
        <button className="t1-new-task" onClick={() => { openTab("newTask"); if (mobile) setShowSidebar(false); }}><PlusIcon size={16} />{t("t1.newTask")}</button>
        <div className="t1-paper-list">{papers.map(item => <button key={item.id} className={paperId === item.id ? "selected" : ""} aria-current={paperId === item.id ? "page" : undefined} title={item.title} onClick={() => selectPaper(item.id)}><span className="t1-paper-label"><GenericFileIcon size={14} /><b>{item.uploaded || item.id.startsWith("paper-") ? t("t1.uploadedPaper") : item.id}</b><small>{item.pages || "—"} {t("t1.pagesShort")}</small></span><strong>{item.title}</strong><em>{item.uploaded ? "PDF" : t("t1.historical")}</em></button>)}</div>
        <div className="t1-sidebar-bottom"><button onClick={() => openTab("tasks")}><MessageIcon size={15} />{t("t1.tasks")}</button><p>{t("t1.separateTasks")}</p><details><summary>{t("t1.aboutWorkbench")}</summary><span>Pi Web 0.15.0 · T1 Pi SDK 1.4.0</span></details></div>
        <SidebarToast toast={toast} onDismiss={() => setToast(null)} dismissLabel={t("t1.close")} /></aside><div className="t1-resize" {...sidebar.separatorProps} /></>}
      <main className="t1-main"><div className="t1-workspace-bar"><button onClick={() => setShowSidebar(value => !value)} aria-label={t("t1.toggleNav")} title={t("t1.toggleNav")} aria-expanded={showSidebar}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg></button><span title={paper?.title}>{paper?.title ?? t("t1.newTask")}</span><button className="t1-source-toggle" aria-pressed={showSource} onClick={() => setShowSource(value => !value)}><EyeIcon size={15} />{t(showSource ? "t1.hideOriginal" : "t1.showOriginal")}</button>{pdfUrl && <a className="t1-mobile-source" href={`${pdfUrl}#page=${page}`} target="_blank" rel="noreferrer"><OpenInNewTabIcon size={14} />{t("t1.openOriginal")}</a>}</div>
        <TabBar tabs={tabs} activeTabId={activeTab} onSelectTab={setActiveTab} onCloseTab={id => { const next = tabIds.filter(tab => tab !== id); setTabIds(next); if (activeTab === id) setActiveTab(next[0] ?? ""); }} onReorderTab={(from, to, after) => setTabIds(current => movePanelTab(current, from, to, after))} />
        <div className="t1-content">
          {loading && <p className="t1-status" role="status">{t("t1.loading")}</p>}
          {error && <div className="t1-alert" role="alert">{error}<button onClick={refresh}>{t("t1.retry")}</button></div>}
          {actionError && <div className="t1-alert" role="alert">{actionError}</div>}
          {detailError && activeTab !== "newTask" && <div className="t1-alert" role="alert">{detailError}<button onClick={refresh}>{t("t1.retry")}</button></div>}
          {sourceBlocked && <div className="t1-alert" role="alert">{t("t1.sourceProblem")}{[...new Set(sourceIssues.map(sourceIssueText))].map((issue, i) => <p key={i}>{issue}</p>)}<details><summary>{t("t1.sourceVersion")}</summary>{sourceIssues.join(" · ")}</details></div>}
          {sourceBlocked && paper && <section className="t1-source-recovery"><p>{t("t1.restoreHelp")}</p><label className="t1-field">{t("t1.selectRestorePdf")}<input type="file" accept="application/pdf,.pdf" aria-label={t("t1.selectRestorePdf")} onChange={e => setRestoreFile(e.target.files?.[0] ?? null)} /></label><button className="t1-primary" disabled={!restoreFile || restoreBusy} onClick={() => void restoreOriginal()}>{t("t1.restorePdf")}</button></section>}
          {capabilities?.controlled_fixture && <p className="t1-fixture-banner">{t("t1.fixture")}</p>}
          {!activeTab && <div className="t1-empty">{["newTask", "records", "figures", "tasks"].map(id => <button key={id} onClick={() => openTab(id)}>{t(`t1.${id}`)}</button>)}</div>}
          {activeTab === "newTask" && <><div className="t1-heading"><h1>{t("t1.newTask")}</h1><span className="t1-badge">B0</span></div>
            <section className="t1-upload"><h2>{t("t1.uploadTitle")}</h2><p className="t1-lead">{t("t1.uploadHelp")}</p><label className="t1-field">{t("t1.choosePdf")}<input aria-label={t("t1.choosePdf")} type="file" accept="application/pdf,.pdf" ref={fileInput} onChange={e => { setFile(e.target.files?.[0] ?? null); setActionError(""); }} /></label><label className="t1-field">{t("t1.paperTitle")}<input aria-label={t("t1.paperTitle")} value={title} onChange={e => setTitle(e.target.value)} maxLength={500} /></label><button className="t1-primary" disabled={!file || uploading || !capabilities?.paper_upload} onClick={() => void uploadPaper()}>{t(uploading ? "t1.uploading" : "t1.upload")}</button></section>
            <label className="t1-field">{t("t1.selectPaper")}<select aria-label={t("t1.selectPaper")} value={paperId} onChange={e => { setPaperId(e.target.value); setRunId(null); setRunDetail(null); }}><option value="">{t("t1.choosePaper")}</option>{papers.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            {scope && catalog && <ScopeEditor scope={scope} data={catalog} onChange={setScope} />}
            {!capabilities?.extraction_start && <p className="t1-notice">{t("t1.extractionUnavailable")}{capabilities?.extraction_unavailable_reason && capabilities.extraction_unavailable_reason !== "server_model_not_enabled" && <small>{capabilities.extraction_unavailable_reason}</small>}</p>}
            <button className="t1-primary t1-start" disabled={starting || !paperId || !scope || !catalog || !capabilities?.extraction_start || sourceBlocked || scopeProblems(scope, catalog).length > 0} onClick={() => void startRun()}>{t(starting ? "t1.starting" : "t1.start")}</button>
            <ModelRuntimeNotice runtime={capabilities?.model_runtime} maxConcurrent={capabilities?.max_concurrent_runs} />
          </>}
          {activeTab === "records" && <><div className="t1-heading"><h1>{t("t1.records")}</h1>{output && <span className="t1-badge">{t(output.origin === "historical_compatibility_replay" ? "t1.historical" : output.fixture ? "t1.fixture" : "t1.pending")}</span>}</div>
            <p className="t1-review-intro">{t("t1.reviewGuide")}</p>
            <div className="t1-output-toolbar"><label>{t("t1.task")}<select aria-label={t("t1.task")} value={runId ? `run:${runId}` : `history:${historyId}`} onChange={e => { const value = e.target.value; setRecordId(""); if (value.startsWith("run:")) { setRunId(value.slice(4)); setHistoryId(""); } else { setRunId(null); setHistoryId(value.slice(8)); } }}>
              {!paperRuns.length && !currentPaper?.outputs.length && <option value="history:">{t("t1.noTasks")}</option>}{paperRuns.map(run => <option key={run.run_id} value={`run:${run.run_id}`}>{run.created_at ? new Date(run.created_at).toLocaleString(locale) : t("t1.task")} · B0{run.fixture ? ` · ${t("t1.controlledTask")}` : ""}</option>)}{currentPaper?.outputs.filter(item => item.origin === "historical_compatibility_replay" && !paperRuns.some(run => run.run_id === item.id)).map(item => <option key={item.id} value={`history:${item.id}`}>{t("t1.historical")} · {item.strategy} · {item.records.length}</option>)}</select></label></div>
            {state && <div className="t1-task-progress" role="status" data-state={state}><strong><span className="t1-status-dot" />{t(`t1.${presentation.statusKey}`)}</strong><span>{t("t1.recordCount", { count: records.length })}</span>{runId && !terminal.has(state) && <button onClick={() => void cancelRun(runId)}>{t("t1.cancel")}</button>}</div>}
            {presentation.sourceLimited && <details className="t1-notice t1-source-limits"><summary><strong>{t("t1.sourceLimitsTitle")}</strong><span>{t("t1.viewDetails")}</span></summary><p>{t("t1.sourceLimitsHint")}</p></details>}
            {(runId || output?.scope) && <details className="t1-task-details"><summary>{t("t1.taskDetails")}</summary><p className="t1-footnote">{t("t1.disclaimer")}</p>{runId && <><p className="t1-footnote">{t(`t1.${presentation.hintKey}`)}</p><p className="t1-stream-status">{t(`t1.${connection}`)}</p></>}{output?.scope && <><h2>{t("t1.runScope")}</h2><ScopeSummary scope={output.scope} data={catalog} /></>}</details>}
            {!records.length ? <div className="t1-empty"><p>{t(output ? "t1.noRecords" : "t1.noRun")}</p><button onClick={() => openTab("newTask")}>{t("t1.newTask")}</button></div> : <>
              <div className="t1-record-nav"><label className="t1-record-search"><SearchIcon size={15} /><input type="search" aria-label={t("t1.findRecord")} placeholder={t("t1.findRecord")} value={recordQuery} onChange={e => setRecordQuery(e.target.value)} /></label><div className="t1-record-step"><label><span className="t1-sr-only">{t("t1.record")}</span><select aria-label={t("t1.record")} value={record?.id ?? ""} onChange={e => setRecordId(e.target.value)}>{!visibleRecords.length && <option value="">{t("t1.noMatchingRecords")}</option>}{visibleRecords.map(item => <option key={item.id} value={item.id}>{records.indexOf(item) + 1} · {item.text_approved ? "✓ " : ""}{item.fragments[0]?.exact_quote.slice(0, 82)}</option>)}</select></label><span className="t1-record-position">{recordPosition + 1} / {visibleRecords.length}</span><button aria-label={t("t1.previousRecord")} title={t("t1.previousRecord")} disabled={recordPosition <= 0} onClick={() => setRecordId(visibleRecords[recordPosition - 1].id)}><ChevronIcon size={15} className="t1-chevron-back" /></button><button aria-label={t("t1.nextRecord")} title={t("t1.nextRecord")} disabled={recordPosition < 0 || recordPosition >= visibleRecords.length - 1} onClick={() => setRecordId(visibleRecords[recordPosition + 1].id)}><ChevronIcon size={15} /></button></div></div>
              {!visibleRecords.length && <p className="t1-empty t1-search-empty" role="status">{t("t1.noMatchingRecords")}</p>}
              {record && <article className="t1-evidence-card" data-record-id={record.id} data-record-version={record.version}><div className="t1-record-meta"><b>{t("t1.record")} {records.indexOf(record) + 1}</b><span>{t("t1.version", { version: record.version })}</span><span className="t1-badge" title={t("t1.evidenceRoleHelp")}>{t(record.evidence_role === "background_suggestion" ? "t1.background" : "t1.primary")}</span></div><div className="t1-section-title t1-evidence-title"><h2>{t("t1.verbatim")}</h2>{firstSourcePage && <button className="t1-locate" onClick={() => sourcePage(firstSourcePage)}><EyeIcon size={14} />{t("t1.locateSource")}</button>}</div><p className="t1-field-hint">{t("t1.fragmentsSeparate")}</p><Fragments fragments={record.fragments} onPage={sourcePage} />
                {!!record.context.length && <details className="t1-context"><summary>{t("t1.context", { count: record.context.length })}</summary><Fragments fragments={record.context} onPage={sourcePage} /></details>}
                <SameSourceMembers index={output?.same_source_review_index} record={record} records={records} onSelect={setRecordId} />
                {record.labels?.comment && <aside className="t1-reviewer-comment"><strong>{t("t1.comment")}</strong><p>{record.labels.comment}</p></aside>}
                <div className="t1-association" data-pairing={record.association}><strong>{t(record.association === "paired" ? "t1.paired" : record.association === "pending" ? "t1.pendingPair" : record.association === "not_checked" ? "t1.notChecked" : "t1.noPair")}</strong>{record.reasons.map((reason, i) => <p key={i}>{reason}</p>)}{record.association === "paired" && record.figure_ids.map(id => { const figure = figures.find(item => item.id === id); return figure ? <FigureView key={id} figure={figure} onPage={sourcePage} paired /> : null; })}</div>
                <details className="t1-context"><summary>{t("t1.sourceVersion")}</summary><code>{record.id} · {record.run_id} · {record.text_fingerprint}</code>{record.model_primary_assessment && <pre>{JSON.stringify(record.model_primary_assessment, null, 2)}</pre>}{record.labels && <pre>{JSON.stringify(record.labels, null, 2)}</pre>}</details>
                {editable && !sourceBlocked && <><RecordReview key={`${runId}:${record.id}:${record.version}`} runId={runId!} record={record} canReviewFigures={record.association === "paired" && record.figure_ids.length > 0} onSaved={reloadCurrent} /><button onClick={() => setEditor({ run: runId!, record: record.id })}>{t("t1.edit")}</button></>}
              </article>}
            </>}
            {editable && !sourceBlocked && <button onClick={() => setEditor({ run: runId!, record: null })}>{t("t1.add")}</button>}
            {editor && editor.run === runId && (editor.record === null || selectedEditorRecord && editor.record === record?.id) && !sourceBlocked && <SourceEditor key={`${editor.run}:${editor.record ?? "new"}`} runId={editor.run} record={selectedEditorRecord} units={units} onPage={sourcePage} onSaved={reloadCurrent} onClose={() => setEditor(null)} />}
            {runId && currentRun && <section className="t1-exports"><h2>{t("t1.exportTitle")}</h2><p className="t1-footnote">{t("t1.exportHelp")}</p>{legacyGlyphCheck && <p className="t1-footnote" role="note">{t("t1.sourceGlyphExportHint")}</p>}<div className="t1-export-groups">{(["candidate", "approved"] as const).map(group => <div className="t1-export-group" key={group}><strong>{t(group === "candidate" ? "t1.candidateDownloads" : "t1.approvedDownloads")}</strong><div className="t1-actions">{exportKinds.filter(kind => kind.startsWith(group)).map(kind => <button key={kind} disabled={Boolean(download) || group === "approved" && (sourceBlocked || !capabilities?.approved_export)} onClick={() => void downloadExport(kind)}>{t(`t1.${kind}`)}</button>)}</div></div>)}</div>{download && <p role="status">{t("t1.downloading")}</p>}</section>}
          </>}
          {activeTab === "figures" && <><div className="t1-heading"><h1>{t("t1.figures")}</h1></div><p className="t1-lead">{t("t1.independentFigure")}</p>{figures.length ? figures.map(figure => <FigureView key={figure.id} figure={figure} onPage={sourcePage} review={editable && !sourceBlocked && currentRun?.figure_catalog_sha256 ? <FigureVerification key={`${runId}:${figure.id}:${currentRun.figure_catalog_sha256}`} runId={runId!} figureId={figure.id} catalogSha={currentRun.figure_catalog_sha256} onSaved={reloadCurrent} /> : undefined} />) : <p className="t1-empty">{t("t1.noFigures")}</p>}</>}
          {activeTab === "tasks" && <><div className="t1-heading"><h1>{t("t1.tasks")}</h1></div><p className="t1-lead">{t("t1.separateTasks")}</p><div className="t1-run-list">{runs.length ? runs.map(run => <div className="t1-task-row" key={run.run_id}><button onClick={() => selectRun(run)}><strong>{papers.find(item => item.id === run.document_id)?.title ?? run.document_id}</strong><span>{runLabel(run)} · {run.candidate_count}{run.fixture && " · fixture"}</span><small>{run.created_at ? new Date(run.created_at).toLocaleString(locale) : ""}</small></button>{!terminal.has(run.state) && <button onClick={() => void cancelRun(run.run_id)}>{t("t1.cancel")}</button>}<details><summary>{t("t1.sourceVersion")}</summary><code>{run.run_id}</code></details></div>) : <p>{t("t1.noTasks")}</p>}</div>
            {paper && <details className="t1-context"><summary>{t("t1.deletePaper")}</summary><p>{t("t1.deletePaperHelp")}</p><button onClick={() => setDeletePaperConfirm(true)}>{t("t1.deletePaper")}</button>{deletePaperConfirm && <button onClick={() => void deletePaper()}>{t("t1.confirmDeletePaper")}</button>}</details>}
            <h2>{t("t1.events")}</h2><div className="t1-stream-status" role="status">{t(`t1.${connection}`)}</div>{events.length ? <ol className="t1-events">{events.map(event => <li key={event.seq}><span>#{event.seq} · {event.type}</span><p>{event.summary}</p><time>{event.timestamp}</time></li>)}</ol> : <p>{t("t1.noEvents")}</p>}
          </>}
        </div>
      </main>
      {showSource && paper && pdfUrl && <><div className="t1-resize" {...source.separatorProps} /><aside className="t1-source" aria-label={t("t1.originalPdf")}><div className="t1-source-heading"><strong><GenericFileIcon size={15} />{t("t1.originalPdf")}</strong><a href={`${pdfUrl}#page=${page}`} target="_blank" rel="noreferrer">{t("t1.openOriginal")}<OpenInNewTabIcon size={13} /></a></div>{sourceBlocked ? <p className="t1-alert">{t("t1.sourceProblem")}</p> : <PdfSource key={`${paper.id}:${paper.sha256}`} url={pdfUrl} sha256={paper.sha256} page={page} pages={paper.pages} onPage={sourcePage} />}<div className="t1-source-footer"><small>{t("t1.sourceUnchanged")}</small><details><summary>{t("t1.sourceVersion")}</summary><code>SHA256 {paper.sha256}</code></details></div></aside></>}
    </div>
    <SidebarMenu open={menu !== null} anchor={menu} sheet={mobile} ariaLabel={t("t1.theme")} title={t("t1.theme")} cancelLabel={t("t1.close")} onClose={() => setMenu(null)} items={([['auto', 'system'], ['light', 'light'], ['dark', 'dark']] as const).map(([id, key]) => ({ type: "item", id, label: t(`t1.${key}`), checked: preference === id, onSelect: () => setThemePreference(id) }))} />
  </div>;
}
