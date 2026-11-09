"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchRecord, WorkbenchReviewInput } from "../../../packages/contracts/src/workbench";
import { api, jsonBody, WorkbenchError } from "./api";

export function RecordReview({ runId, record, canReviewFigures, onSaved }: { runId: string; record: WorkbenchRecord; canReviewFigures: boolean; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const [reviewer, setReviewer] = useState(() => { try { return localStorage.getItem("t1:reviewer") ?? ""; } catch { return ""; } });
  const draftKey = `t1:review-draft:${encodeURIComponent(runId)}:${encodeURIComponent(record.id)}:${record.version}`;
  // A draft belongs to this exact version. Without one, show the saved note for
  // this version instead of losing it on reload or carrying an older note over.
  const [reason, setReason] = useState(() => { try { return sessionStorage.getItem(draftKey) ?? record.review_reason ?? ""; } catch { return record.review_reason ?? ""; } }), [checks, setChecks] = useState([false, false, false, false]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  useEffect(() => { try { sessionStorage.setItem(draftKey, reason); } catch { /* in-memory draft remains usable */ } }, [draftKey, reason]);
  async function review(action: WorkbenchReviewInput["action"]) {
    setBusy(true); setError("");
    try {
      const input: WorkbenchReviewInput = { expected_version: record.version, action, reviewer: reviewer.trim(), reason,
        source_text_checked: checks[0], relevance_checked: checks[1], context_checked: checks[2], figure_pairing_checked: checks[3] };
      await api(`workbench/runs/${encodeURIComponent(runId)}/records/${encodeURIComponent(record.id)}/review`, jsonBody("POST", input));
      try { localStorage.setItem("t1:reviewer", reviewer.trim()); } catch { /* optional preference */ }
      try { sessionStorage.removeItem(draftKey); } catch { /* optional storage */ }
      setChecks([false, false, false, false]); await onSaved();
    } catch (cause) {
      const changed = cause instanceof WorkbenchError && cause.status === 409;
      setConflict(changed); setError(cause instanceof WorkbenchError && cause.code.includes("source_glyph_fidelity_unverified") ? t("t1.sourceGlyphUnreliable") : cause instanceof WorkbenchError && cause.code.includes("source_glyph_check_missing") ? t("t1.sourceGlyphLegacy") : changed ? t("t1.conflict") : cause instanceof Error ? cause.message : t("t1.requestFailed"));
    } finally { setBusy(false); }
  }
  return <section className="t1-review" aria-label={t("t1.reviewTitle")}><div className="t1-section-title"><h2>{t("t1.reviewTitle")}</h2>
    <div className="t1-review-status"><span className="t1-badge" data-status={record.text_approved ? "approved" : record.review_status === "rejected" ? "rejected" : "pending"}>{t(record.text_approved ? "t1.approved" : record.review_status === "rejected" ? "t1.rejected" : "t1.pending")}</span>{canReviewFigures && <span className="t1-badge" data-status={record.figures_approved ? "approved" : "pending"}>{t(record.figures_approved ? "t1.figuresApproved" : "t1.figuresPending")}</span>}</div></div>
    <label className="t1-field">{t("t1.reviewer")}<input aria-label={t("t1.reviewer")} value={reviewer} onChange={e => setReviewer(e.target.value)} autoComplete="name" maxLength={120} /></label>
    <label className="t1-field">{t("t1.reason")}<textarea aria-label={t("t1.reason")} value={reason} onChange={e => setReason(e.target.value)} maxLength={4000} rows={2} /></label>
    <p className="t1-field-hint">{t(record.review_reason && reason === record.review_reason ? "t1.savedReviewNote" : "t1.reviewNoteHelp")}</p>
    <div className="t1-review-checks">{["checkedSource", "checkedRelevance", "checkedContext", "checkedFigures"].map((key, index) => <label className="t1-check" key={key}><input type="checkbox" checked={checks[index]} disabled={busy || index === 3 && !canReviewFigures} onChange={e => setChecks(old => old.map((value, i) => i === index ? e.target.checked : value))} />{t(`t1.${key}`)}</label>)}</div>
    <div className="t1-actions"><button className="t1-primary" disabled={busy || conflict || !reviewer.trim() || !checks.slice(0, 3).every(Boolean)} onClick={() => void review("approve_text")}>{t("t1.approveText")}</button>
      <button disabled={busy || conflict || !reviewer.trim() || !record.text_approved || !checks[3] || !canReviewFigures} onClick={() => void review("approve_figures")}>{t("t1.approveFigures")}</button>
      <button disabled={busy || conflict || !reviewer.trim()} onClick={() => void review("reject")}>{t("t1.reject")}</button><button disabled={busy || conflict || !reviewer.trim()} onClick={() => void review("pending")}>{t("t1.markPending")}</button></div>
    <p className="t1-footnote">{t("t1.textFirst")}</p>
    {error && <div className="t1-alert" role="alert">{error}{conflict && <button onClick={() => { setConflict(false); setError(""); setChecks([false, false, false, false]); void onSaved(); }}>{t("t1.loadCurrent")}</button>}</div>}
  </section>;
}
