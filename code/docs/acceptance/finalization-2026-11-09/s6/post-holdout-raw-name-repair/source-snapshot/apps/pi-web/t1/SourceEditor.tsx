"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchLabels, WorkbenchRecord, WorkbenchRevisionInput, WorkbenchSourceUnit } from "../../../packages/contracts/src/workbench";
import { api, jsonBody, WorkbenchError } from "./api";

interface Draft { version: number; source: string[]; context: string[]; labels: WorkbenchLabels; reviewer: string; reason: string; tagsText?: string }
const prefix = (runId: string, recordId: string) => `t1:source-draft:${encodeURIComponent(runId)}:${encodeURIComponent(recordId)}:`;
function readDraft(runId: string, record: WorkbenchRecord | null): Draft {
  const initial = { version: record?.version ?? 0, source: record?.source_unit_ids ?? [], context: record?.context_unit_ids ?? [], labels: record?.labels ?? {}, reviewer: "", reason: "" };
  try {
    const keys = Object.keys(sessionStorage).filter(key => key.startsWith(prefix(runId, record?.id ?? "new"))).sort((a, b) => Number(b.split(":").at(-1)) - Number(a.split(":").at(-1)));
    if (keys[0]) return JSON.parse(sessionStorage.getItem(keys[0])!) as Draft;
    initial.reviewer = localStorage.getItem("t1:reviewer") ?? "";
  } catch { /* Browser storage is optional. */ }
  return initial;
}

/** Source text is never editable. A draft carries its original expected version across refreshes. */
export function SourceEditor({ runId, record, units, onPage, onSaved, onClose }: { runId: string; record: WorkbenchRecord | null; units: WorkbenchSourceUnit[]; onPage: (page: number) => void; onSaved: () => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => readDraft(runId, record));
  const [search, setSearch] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false), [deleting, setDeleting] = useState(false);
  const storageKey = prefix(runId, record?.id ?? "new") + draft.version;
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* in-memory draft remains usable */ } }, [draft, storageKey]);
  const updateLabel = (value: WorkbenchLabels) => setDraft(current => ({ ...current, labels: { ...current.labels, ...value } }));
  async function save(remove = false) {
    if (!draft.reviewer.trim()) { setError(t("t1.reviewerRequired")); return; }
    if (!remove && !draft.source.length) { setError(t("t1.selectionRequired")); return; }
    setBusy(true); setError("");
    try {
      const path = `workbench/runs/${encodeURIComponent(runId)}/records${record ? `/${encodeURIComponent(record.id)}` : ""}`;
      const input: WorkbenchRevisionInput = { ...(record ? { expected_version: draft.version } : {}), source_unit_ids: draft.source, context_unit_ids: draft.context, labels: { ...draft.labels, tags: (draft.tagsText ?? draft.labels.tags?.join(", ") ?? "").split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }, reviewer: draft.reviewer.trim(), reason: draft.reason };
      await api(path, jsonBody(remove ? "DELETE" : record ? "PATCH" : "POST", input));
      try { sessionStorage.removeItem(storageKey); } catch { /* optional storage */ }
      await onSaved(); onClose();
    } catch (cause) {
      const changed = cause instanceof WorkbenchError && cause.status === 409;
      setConflict(changed); setError(cause instanceof WorkbenchError && cause.code.includes("source_glyph_fidelity_unverified") ? t("t1.sourceGlyphUnreliable") : changed ? t("t1.conflict") : cause instanceof Error ? cause.message : t("t1.requestFailed"));
    } finally { setBusy(false); }
  }
  async function loadCurrent() {
    const value = await api<{ output: { records: WorkbenchRecord[] } }>(`workbench/runs/${encodeURIComponent(runId)}`);
    const latest = value.output.records.find(item => item.id === record?.id) ?? record;
    // A conflict never silently rebases a source selection onto a newer version.
    try { sessionStorage.removeItem(storageKey); } catch { /* optional storage */ }
    setDraft(current => ({ ...current, version: latest?.version ?? 0 }));
    setConflict(false); setError(""); void onSaved();
  }
  const visible = units.filter(unit => !search || unit.text.toLowerCase().includes(search.toLowerCase()) || unit.unit_id.includes(search));
  return <section className="t1-editor" aria-label={t("t1.editTitle")}><div className="t1-section-title"><h2>{t("t1.editTitle")}</h2><button onClick={onClose}>{t("t1.discard")}</button></div>
    <p className="t1-footnote">{t("t1.sourceOnly")}</p><p className="t1-notice">{t("t1.draftRetained")} {record && t("t1.version", { version: draft.version })}</p>
    <label className="t1-field">{t("t1.sourceSearch")}<input aria-label={t("t1.sourceSearch")} value={search} onChange={e => setSearch(e.target.value)} /></label>
    <div className="t1-source-choices">{visible.map(unit => <div className="t1-source-choice" key={unit.unit_id}><div className="t1-source-choice-controls">
      {(["source", "context"] as const).map(part => <label key={part}><input type="checkbox" aria-label={`${t(part === "source" ? "t1.sourceUnits" : "t1.contextUnits")} ${unit.unit_id}`} checked={draft[part].includes(unit.unit_id)} onChange={e => setDraft(current => ({ ...current, [part]: e.target.checked ? [...current[part], unit.unit_id] : current[part].filter(id => id !== unit.unit_id) }))} />{t(part === "source" ? "t1.sourceUnits" : "t1.contextUnits")}</label>)}
      {!!unit.segments[0] && <button className="t1-link" onClick={() => onPage(unit.segments[0].physical_page)}>{t("t1.physicalPage", { page: unit.segments[0].physical_page })}</button>}</div>
      <p className="t1-verbatim">{unit.text}</p><details><summary>{t("t1.sourceVersion")}</summary><code>{unit.unit_id} · {unit.completeness} · {unit.kind}</code>{unit.boundary_reasons.map((reason, i) => <p key={i}>{reason}</p>)}</details>
    </div>)}</div>
    <div className="t1-editor-fields"><label className="t1-field">{t("t1.featureCategory")}<input aria-label={t("t1.featureCategory")} value={draft.labels.feature_category ?? ""} onChange={e => updateLabel({ feature_category: e.target.value })} maxLength={200} /></label>
      <label className="t1-field">{t("t1.evidenceType")}<select aria-label={t("t1.evidenceType")} value={draft.labels.evidence_type ?? ""} onChange={e => updateLabel({ evidence_type: e.target.value as WorkbenchLabels["evidence_type"] || undefined })}><option value="">{t("t1.unknown")}</option>{["feature_mention", "definition", "imaging_observation", "interpretive_condition", "association_conclusion"].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="t1-field">{t("t1.evidenceRole")}<select aria-label={t("t1.evidenceRole")} value={draft.labels.evidence_role ?? record?.evidence_role ?? "primary_candidate"} onChange={e => updateLabel({ evidence_role: e.target.value as WorkbenchLabels["evidence_role"] })}><option value="primary_candidate">{t("t1.primary")}</option><option value="background_suggestion">{t("t1.background")}</option></select></label>
      <label className="t1-field">{t("t1.tags")}<input aria-label={t("t1.tags")} value={draft.tagsText ?? draft.labels.tags?.join(", ") ?? ""} onChange={e => setDraft(current => ({ ...current, tagsText: e.target.value }))} maxLength={1000} /></label></div>
    <label className="t1-field">{t("t1.comment")}<textarea aria-label={t("t1.comment")} value={draft.labels.comment ?? ""} onChange={e => updateLabel({ comment: e.target.value })} maxLength={4000} rows={2} /></label>
    <label className="t1-field">{t("t1.reviewer")}<input aria-label={t("t1.reviewer")} value={draft.reviewer} onChange={e => setDraft(current => ({ ...current, reviewer: e.target.value }))} maxLength={120} /></label>
    <label className="t1-field">{t("t1.reason")}<textarea aria-label={t("t1.reason")} value={draft.reason} onChange={e => setDraft(current => ({ ...current, reason: e.target.value }))} maxLength={4000} rows={2} /></label>
    {error && <div className="t1-alert" role="alert">{error}{conflict && <button onClick={() => void loadCurrent().catch(cause => setError(cause instanceof Error ? cause.message : t("t1.requestFailed")))}>{t("t1.loadCurrent")}</button>}</div>}
    <div className="t1-actions"><button className="t1-primary" disabled={busy || conflict || !draft.reviewer.trim() || !draft.source.length} onClick={() => void save()}>{t(record ? "t1.saveRevision" : "t1.add")}</button>
      {record && !deleting && <button disabled={busy} onClick={() => setDeleting(true)}>{t("t1.deleteRecord")}</button>}{deleting && <button disabled={busy || conflict || !draft.reviewer.trim()} onClick={() => void save(true)}>{t("t1.confirmDelete")}</button>}</div>
  </section>;
}
