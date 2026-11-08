import { Value } from 'typebox/value';
import { EvidenceCatalogSchema, type EvidenceCatalog, type EvidenceRecord, type EvidenceScope,
  type EvidenceSubmission, type ScopeMatch } from '../../contracts/src/extraction-evidence.js';

export interface ScopeMatchOptions { allowDevelopmentCatalog?: boolean; fixture?: boolean }
type Named = EvidenceCatalog['cancers'][number];
type Term = Pick<Named, 'name' | 'synonyms' | 'source' | 'approval_status'>;
type Observation = EvidenceSubmission['disease_or_lesion'] | EvidenceRecord['disease_or_lesion'];
export const literalFold = (value: string): string => value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();

/** Case/whitespace folding only. This does not invent synonyms, stem words, or traverse a hierarchy. */
export function containsLiteral(source: string, value: string): boolean {
  const needle = literalFold(value);
  if (!needle) return false;
  const haystack = literalFold(source);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // Chinese text normally does not put spaces around CT/MRI or a Chinese disease name.
  const left = /^[\p{Script=Latin}\p{Script=Greek}\p{N}_]/u.test(needle) ? '(?<![\\p{Script=Latin}\\p{Script=Greek}\\p{N}_])' : '';
  const right = /[\p{Script=Latin}\p{Script=Greek}\p{N}_]$/u.test(needle) ? '(?![\\p{Script=Latin}\\p{Script=Greek}\\p{N}_])' : '';
  return new RegExp(`${left}${escaped}${right}`, 'u').test(haystack);
}

function catalogEnabled(catalog: EvidenceCatalog, options: ScopeMatchOptions): boolean {
  return catalog.status === 'approved' && (!catalog.fixture || options.fixture === true) ||
    catalog.status === 'development_only' && options.allowDevelopmentCatalog === true;
}
function usable(entry: { approval_status: EvidenceCatalog['status']; source: string }, catalog: EvidenceCatalog): boolean {
  return catalog.status !== 'unavailable' && entry.approval_status === catalog.status && entry.source.trim().length > 0;
}
function termMatch(value: string, entry: Term, catalog: EvidenceCatalog): { kind: 'canonical' | 'synonym'; term: string; source: string } | null {
  if (!usable(entry, catalog)) return null;
  if (literalFold(value) === literalFold(entry.name)) return { kind: 'canonical', term: entry.name, source: entry.source };
  const synonym = entry.synonyms.find(s => usable(s, catalog) && literalFold(value) === literalFold(s.text));
  return synonym ? { kind: 'synonym', term: synonym.text, source: synonym.source } : null;
}
function observedGrounding(observation: Observation): boolean {
  return observation.status === 'source_observed' && observation.value !== null &&
    observation.evidence.some(e => containsLiteral(e.exact_quote, observation.value!));
}

/** Preflight is also called before a run. An empty approved catalog is not a license to widen a selection. */
export function evidenceScopeIssues(scope: EvidenceScope, catalog: EvidenceCatalog, options: ScopeMatchOptions = {}): string[] {
  if (!Value.Check(EvidenceCatalogSchema, catalog)) return ['evidence_catalog_schema_invalid'];
  const issues: string[] = [];
  if (scope.catalog_version !== catalog.catalog_version) issues.push('catalog_version_mismatch');
  const selected = scope.cancers.mode === 'selected' || scope.image_types.mode === 'selected' || scope.features.mode === 'selected';
  const enabled = catalogEnabled(catalog, options);
  for (const [name, mode, values] of [
    ['cancers', scope.cancers.mode, scope.cancers.ids], ['image_types', scope.image_types.mode, scope.image_types.ids],
    ['features', scope.features.mode, scope.features.binding_ids],
  ] as const) {
    if (mode === 'selected' && !values.length) issues.push(`${name}_selected_empty`);
    if (mode === 'all' && values.length) issues.push(`${name}_all_has_selections`);
    if (new Set(values).size !== values.length) issues.push(`${name}_duplicate_selection`);
  }
  if (selected && !enabled) {
    issues.push(catalog.status === 'development_only' ? 'development_catalog_requires_explicit_enable' : 'restricted_scope_requires_approved_catalog');
    return issues;
  }
  for (const [dimension, selectedIds, entries] of [
    ['cancer', scope.cancers.ids, catalog.cancers], ['modality', scope.image_types.ids, catalog.image_types],
  ] as const) {
    for (const selectedId of selectedIds) {
      const entry = entries.find(e => e.id === selectedId);
      if (!entry || !usable(entry, catalog)) issues.push(`${dimension}_selection_unapproved_or_missing:${selectedId}`);
    }
  }
  for (const selectedId of scope.image_types.ids) {
    const entry = catalog.image_types.find(e => e.id === selectedId);
    if (entry && scope.cancers.mode === 'selected' && !entry.cancer_ids.some(id => scope.cancers.ids.includes(id))) {
      issues.push(`modality_selection_inapplicable:${selectedId}`);
    }
  }
  for (const selectedId of scope.features.binding_ids) {
    const binding = catalog.bindings.find(b => b.binding_id === selectedId);
    const feature = binding && catalog.features.find(f => f.feature_id === binding.feature_id);
    if (!binding || !feature || !usable(binding, catalog) || !usable(feature, catalog)) {
      issues.push(`feature_binding_unapproved_or_missing:${selectedId}`); continue;
    }
    if (scope.cancers.mode === 'selected' && !binding.cancer_ids.some(id => scope.cancers.ids.includes(id))) issues.push(`feature_binding_cancer_inapplicable:${selectedId}`);
    if (scope.image_types.mode === 'selected' && !binding.image_type_ids.some(id => scope.image_types.ids.includes(id))) issues.push(`feature_binding_modality_inapplicable:${selectedId}`);
  }
  return issues;
}

export function matchEvidenceScope(evidence: EvidenceSubmission | EvidenceRecord, scope: EvidenceScope,
  catalog: EvidenceCatalog, options: ScopeMatchOptions = {}): ScopeMatch {
  const preflight = evidenceScopeIssues(scope, catalog, options);
  const result: ScopeMatch = { status: preflight.length ? 'blocked' : 'in_scope', matched_binding_id: null, feature_match: 'none',
    development_catalog_used: catalog.status === 'development_only' && options.allowDevelopmentCatalog === true,
    basis: [], issues: preflight };
  if (preflight.length) return result;
  const mark = (status: 'out_of_scope' | 'needs_context', code: string) => {
    if (result.status !== 'out_of_scope') result.status = status;
    result.issues.push(code);
  };
  const enabled = catalogEnabled(catalog, options);
  const resolveObserved = (dimension: 'cancer' | 'modality', observation: Observation, entries: Named[], selectedIds: string[], mode: 'all' | 'selected'): string[] => {
    if (!observedGrounding(observation)) {
      if (mode === 'selected') mark('needs_context', `${dimension}_not_grounded_in_source`);
      return [];
    }
    const matched = enabled ? entries.flatMap(entry => {
      const match = termMatch(observation.value!, entry, catalog);
      if (!match) return [];
      result.basis.push({ dimension, catalog_id: entry.id, source_text: observation.evidence.map(e => e.exact_quote).join('\n'),
        matched_term: match.term, kind: match.kind, source: match.source });
      return [entry.id];
    }) : [];
    if (mode === 'selected' && !matched.some(id => selectedIds.includes(id))) mark('out_of_scope', `${dimension}_out_of_scope`);
    return matched;
  };
  const cancerIds = resolveObserved('cancer', evidence.disease_or_lesion, catalog.cancers, scope.cancers.ids, scope.cancers.mode);
  const modalityIds = resolveObserved('modality', evidence.modality, catalog.image_types, scope.image_types.ids, scope.image_types.mode);
  const requestedBinding = 'feature_binding_id' in evidence ? evidence.feature_binding_id : evidence.normalized_terms[0]?.binding_id ?? null;
  const matchingBindings = enabled && evidence.feature_name_raw ? catalog.bindings.flatMap(binding => {
    const feature = catalog.features.find(f => f.feature_id === binding.feature_id);
    const match = feature && usable(binding, catalog) ? termMatch(evidence.feature_name_raw!, feature, catalog) : null;
    return match ? [{ binding, feature: feature!, match }] : [];
  }) : [];
  const selectedBindings = matchingBindings.filter(({ binding }) =>
    (scope.features.mode === 'all' || scope.features.binding_ids.includes(binding.binding_id)) &&
    (requestedBinding === null || binding.binding_id === requestedBinding));
  // Open extraction may encounter the same term in another cancer/modality. Preserve it as a new,
  // unmapped candidate instead of forcing an inapplicable catalog binding onto the paper.
  const eligible = scope.features.mode === 'all' && requestedBinding === null ? selectedBindings.filter(({ binding }) =>
    (!cancerIds.length || cancerIds.some(id => binding.cancer_ids.includes(id))) &&
    (!modalityIds.length || modalityIds.some(id => binding.image_type_ids.includes(id))) &&
    (!binding.sequence_or_phase_conditions.length || !evidence.sequence_or_phase || !observedGrounding(evidence.sequence_or_phase) ||
      binding.sequence_or_phase_conditions.some(condition => literalFold(condition) === literalFold(evidence.sequence_or_phase!.value!)))) : selectedBindings;
  if (scope.features.mode === 'selected' && !eligible.length) mark('out_of_scope', 'feature_not_selected_or_explicit_synonym');
  if (requestedBinding !== null && !matchingBindings.some(x => x.binding.binding_id === requestedBinding)) {
    mark('out_of_scope', 'feature_binding_not_supported_by_source_name');
  }
  if (eligible.length > 1) {
    mark('needs_context', 'feature_binding_ambiguous');
  } else if (eligible[0]) {
    const { binding, feature, match } = eligible[0];
    result.matched_binding_id = binding.binding_id; result.feature_match = match.kind;
    result.basis.push({ dimension: 'feature', catalog_id: feature.feature_id, source_text: evidence.feature_name_raw!,
      matched_term: match.term, kind: match.kind, source: match.source });
    if (cancerIds.length && !cancerIds.some(id => binding.cancer_ids.includes(id))) mark('out_of_scope', 'feature_binding_source_cancer_mismatch');
    if (modalityIds.length && !modalityIds.some(id => binding.image_type_ids.includes(id))) mark('out_of_scope', 'feature_binding_source_modality_mismatch');
    if (!cancerIds.length && binding.cancer_ids.length) mark('needs_context', 'feature_binding_cancer_requires_context');
    if (!modalityIds.length && binding.image_type_ids.length) mark('needs_context', 'feature_binding_modality_requires_context');
    if (binding.sequence_or_phase_conditions.length) {
      const observed = evidence.sequence_or_phase;
      if (!observed || !observedGrounding(observed)) mark('needs_context', 'feature_binding_sequence_requires_context');
      else if (!binding.sequence_or_phase_conditions.some(condition => literalFold(condition) === literalFold(observed.value!))) {
        mark('out_of_scope', 'feature_binding_sequence_mismatch');
      }
    }
  } else if (scope.features.mode === 'all') {
    result.feature_match = 'new_term';
    result.issues.push('new_term_pending_human_review');
  }
  return result;
}
