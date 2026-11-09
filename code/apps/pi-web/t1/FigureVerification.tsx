"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { api, jsonBody, WorkbenchError } from "./api";

/** A per-Figure source check does not approve any record or medical pairing. */
export function FigureVerification({ runId, figureId, catalogSha, onSaved }: { runId: string; figureId: string; catalogSha: string; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const draftKey = `t1:figure-check-draft:${encodeURIComponent(runId)}:${encodeURIComponent(figureId)}:${catalogSha}`;
  const stored = () => { try { return JSON.parse(sessionStorage.getItem(draftKey) ?? "{}") as { reviewer?: string; notes?: string }; } catch { return {}; } };
  const [panels, setPanels] = useState(false), [caption, setCaption] = useState(false), [reviewer, setReviewer] = useState(() => stored().reviewer ?? ""), [notes, setNotes] = useState(() => stored().notes ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { try { sessionStorage.setItem(draftKey, JSON.stringify({ reviewer, notes })); } catch { /* optional browser storage */ } }, [draftKey, reviewer, notes]);
  async function verify() {
    setBusy(true); setError("");
    try {
      await api(`workbench/runs/${encodeURIComponent(runId)}/figures/${encodeURIComponent(figureId)}/verify`, jsonBody("POST", { expected_catalog_sha256: catalogSha, reviewer: reviewer.trim(), all_panels_included: panels, caption_figure_identity_checked: caption, notes: notes.trim() }));
      try { sessionStorage.removeItem(draftKey); } catch { /* optional storage */ }
      setPanels(false); setCaption(false); await onSaved();
    } catch (cause) { setError(cause instanceof WorkbenchError && cause.code.includes("source_glyph_fidelity_unverified") ? t("t1.sourceGlyphUnreliable") : cause instanceof WorkbenchError && cause.status === 409 ? t("t1.figureConflict") : cause instanceof Error ? cause.message : t("t1.requestFailed")); }
    finally { setBusy(false); }
  }
  return <details className="t1-figure-verification"><summary>{t("t1.verifyFigure")}</summary><p className="t1-footnote">{t("t1.verifyFigureHelp")}</p>
    <label className="t1-check"><input type="checkbox" checked={panels} onChange={e => setPanels(e.target.checked)} />{t("t1.allPanelsChecked")}</label>
    <label className="t1-check"><input type="checkbox" checked={caption} onChange={e => setCaption(e.target.checked)} />{t("t1.figureCaptionChecked")}</label>
    <label className="t1-field">{t("t1.reviewer")}<input aria-label={t("t1.reviewer")} value={reviewer} onChange={e => setReviewer(e.target.value)} maxLength={120} /></label>
    <label className="t1-field">{t("t1.figureNotes")}<textarea aria-label={t("t1.figureNotes")} value={notes} onChange={e => setNotes(e.target.value)} maxLength={4000} rows={2} /></label>
    <button className="t1-primary" disabled={busy || !panels || !caption || !reviewer.trim() || !notes.trim()} onClick={() => void verify()}>{t("t1.saveFigureCheck")}</button>
    {error && <div className="t1-alert" role="alert">{error}<button onClick={() => void onSaved()}>{t("t1.loadCurrent")}</button></div>}
  </details>;
}
