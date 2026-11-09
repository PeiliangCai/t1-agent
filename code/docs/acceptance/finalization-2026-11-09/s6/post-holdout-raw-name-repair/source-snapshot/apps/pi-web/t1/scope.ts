import type { Scope } from "../../../packages/contracts/src/index";
import type { EvidenceCatalog } from "../../../packages/contracts/src/extraction-evidence";
export interface ScopeCatalog {
  catalog: EvidenceCatalog; default_scope: Scope; restricted_available: boolean;
  restricted_reason?: string | null; development_only: boolean;
}
export function applicableChoices(scope: Scope, catalog: EvidenceCatalog) {
  const images = catalog.image_types.filter(image => scope.cancers.mode === "all" || image.cancer_ids.some(id => scope.cancers.ids.includes(id)));
  const bindings = catalog.bindings.filter(binding =>
    (scope.cancers.mode === "all" || binding.cancer_ids.some(id => scope.cancers.ids.includes(id))) &&
    (scope.image_types.mode === "all" || binding.image_type_ids.some(id => scope.image_types.ids.includes(id))));
  return { images, bindings };
}
/** Invalid selections are retained until the user explicitly removes or changes them. */
export function scopeProblems(scope: Scope, data: ScopeCatalog): string[] {
  const { images, bindings } = applicableChoices(scope, data.catalog), issues: string[] = [];
  if (scope.catalog_version !== data.catalog.catalog_version) issues.push("catalog_version_mismatch");
  for (const [key, mode, ids, available] of [
    ["cancers", scope.cancers.mode, scope.cancers.ids, data.catalog.cancers.map(x => x.id)],
    ["image_types", scope.image_types.mode, scope.image_types.ids, images.map(x => x.id)],
    ["features", scope.features.mode, scope.features.binding_ids, bindings.map(x => x.binding_id)],
  ] as const) {
    if (mode === "selected") {
      if (!data.restricted_available) issues.push("restricted_unavailable");
      if (!ids.length) issues.push(`${key}_selected_empty`);
      if (ids.some(id => !available.includes(id))) issues.push(`${key}_invalid`);
    }
  }
  return [...new Set(issues)];
}
