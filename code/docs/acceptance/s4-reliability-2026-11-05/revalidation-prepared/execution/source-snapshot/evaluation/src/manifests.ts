import { Value } from 'typebox/value';
import { SourceManifestSchema, SplitManifestSchema } from './contracts.js';

/** Structural/leakage checks only. These checks cannot establish medical applicability. */
export function manifestIssues(sources: unknown, splits: unknown): string[] {
  if (!Value.Check(SourceManifestSchema, sources) || !Value.Check(SplitManifestSchema, splits)) return ['manifest_schema_validation_failed'];
  const issues: string[] = [];
  const ids = sources.sources.map(s => s.source_id);
  if (new Set(ids).size !== ids.length) issues.push('duplicate_source_id');
  const familySplits = new Map<string, Set<string>>();
  const assigned = new Set<string>();
  for (const a of splits.assignments) {
    const choices = familySplits.get(a.article_family_id) ?? new Set<string>();
    choices.add(a.split); familySplits.set(a.article_family_id, choices);
    for (const id of a.source_ids) {
      const source = sources.sources.find(s => s.source_id === id);
      if (!source) { issues.push('unknown_source:' + id); continue; }
      if (assigned.has(id)) issues.push('source_assigned_twice:' + id);
      assigned.add(id);
      if (source.article_family_id !== a.article_family_id) issues.push('source_family_mismatch:' + id);
      if (a.split === 'independent_acceptance' && !source.exposure.independent_acceptance_eligible) issues.push('exposed_source_not_independent:' + id);
      if (a.status === 'sealed' && source.access.file_verified === false) issues.push('unavailable_file_cannot_be_sealed:' + id);
    }
  }
  for (const [family, parts] of familySplits) if (parts.size > 1) issues.push('article_family_crosses_splits:' + family);
  for (const s of sources.sources) {
    if (!assigned.has(s.source_id)) issues.push('source_not_in_family_register:' + s.source_id);
    const a = s.access;
    if (a.file_verified && (!a.local_path || !a.sha256 || !a.bytes || !a.retrieved_at)) issues.push('verified_file_identity_incomplete:' + s.source_id);
    if (!a.file_verified && [a.local_path, a.sha256, a.bytes, s.current_composition.physical_pages].some(v => v !== null)) issues.push('historical_values_must_not_be_current:' + s.source_id);
    if (s.permission.status === 'unknown' && s.permission.redistribution !== 'not_established') issues.push('permission_not_established:' + s.source_id);
  }
  return [...new Set(issues)].sort();
}
