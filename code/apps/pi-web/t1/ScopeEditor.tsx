"use client";
import { useI18n } from "@/hooks/useI18n";
import type { Scope } from "../../../packages/contracts/src/index";
import { applicableChoices, scopeProblems, type ScopeCatalog } from "./scope";

type Props = { scope: Scope; data: ScopeCatalog; onChange: (scope: Scope) => void };
export function ScopeSummary({ scope, data }: { scope: Scope; data?: ScopeCatalog | null }) {
  const { t } = useI18n();
  const names = (key: "cancers" | "image_types" | "features") => {
    const part = scope[key], ids = key === "features" ? scope.features.binding_ids : scope[key].ids;
    if (part.mode === "all") return t("t1.all");
    return ids.map(id => key === "cancers" ? data?.catalog.cancers.find(x => x.id === id)?.name ?? id
      : key === "image_types" ? data?.catalog.image_types.find(x => x.id === id)?.name ?? id
      : data?.catalog.features.find(x => x.feature_id === data.catalog.bindings.find(b => b.binding_id === id)?.feature_id)?.name ?? id).join(" · ") || t("t1.emptySelection");
  };
  return <dl className="t1-scope-summary"><div><dt>{t("t1.cancer")}</dt><dd>{names("cancers")}</dd></div><div><dt>{t("t1.modality")}</dt><dd>{names("image_types")}</dd></div><div><dt>{t("t1.feature")}</dt><dd>{names("features")}</dd></div></dl>;
}
export function ScopeEditor({ scope, data, onChange }: Props) {
  const { t } = useI18n(), { images, bindings } = applicableChoices(scope, data.catalog);
  const layers = [
    { key: "cancers", label: t("t1.cancer"), part: scope.cancers, choices: data.catalog.cancers.map(x => ({ id: x.id, name: x.name })), valid: data.catalog.cancers.map(x => x.id) },
    { key: "image_types", label: t("t1.modality"), part: scope.image_types, choices: data.catalog.image_types.map(x => ({ id: x.id, name: x.name })), valid: images.map(x => x.id) },
    { key: "features", label: t("t1.feature"), part: { mode: scope.features.mode, ids: scope.features.binding_ids }, choices: data.catalog.bindings.map(x => ({ id: x.binding_id, name: `${data.catalog.features.find(f => f.feature_id === x.feature_id)?.name ?? x.feature_id}${x.sequence_or_phase_conditions.length ? ` · ${x.sequence_or_phase_conditions.join(" / ")}` : ""}` })), valid: bindings.map(x => x.binding_id) },
  ] as const;
  function update(key: typeof layers[number]["key"], mode: "all" | "selected", ids: string[]) {
    onChange({ ...scope, [key]: key === "features" ? { mode, binding_ids: ids } : { mode, ids } });
  }
  return <section className="t1-scope-editor"><h2>{t("t1.scopeTitle")}</h2>
    {!data.restricted_available && <p className="t1-notice">{t("t1.restrictedUnavailable")}{data.restricted_reason && data.restricted_reason !== "medical_catalog_not_approved" && <small>{data.restricted_reason}</small>}</p>}
    {data.development_only && data.restricted_available && <p className="t1-badge">{t("t1.fixture")}</p>}
    <div className="t1-scope-layers">{layers.map(layer => <fieldset key={layer.key}><legend>{layer.label}</legend>
      <select aria-label={layer.label} value={layer.part.mode} onChange={e => update(layer.key, e.target.value as "all" | "selected", [])}><option value="all">{t("t1.all")}</option><option value="selected">{t("t1.selected")}</option></select>
      {layer.part.mode === "selected" && <div className="t1-scope-options">
        {!layer.part.ids.length && <p role="alert">{t("t1.emptySelection")}</p>}
        {data.restricted_available ? layer.choices.filter(choice => layer.valid.includes(choice.id) || layer.part.ids.includes(choice.id)).map(choice => {
          const invalid = !layer.valid.includes(choice.id);
          return <label key={choice.id} className={invalid ? "t1-invalid-choice" : ""}><input type="checkbox" checked={layer.part.ids.includes(choice.id)} onChange={e => update(layer.key, "selected", e.target.checked ? [...layer.part.ids, choice.id] : layer.part.ids.filter(id => id !== choice.id))} />{choice.name}{invalid && <small>{t("t1.invalidSelection")}</small>}</label>;
        }) : null}
        {(!data.restricted_available || !layer.valid.length) && <p>{t("t1.noChoices")}</p>}
      </div>}
    </fieldset>)}</div>
    <div className="t1-scope-preview"><strong>{t("t1.scopeSummary")}</strong><ScopeSummary scope={scope} data={data} /></div>
    <p className="t1-footnote">{t("t1.scopeImmutable")}</p><output hidden>{scopeProblems(scope, data).join(",")}</output>
  </section>;
}
