import type { EvidenceSubmission, EvidenceValidationContext, LocatedEvidenceFragment, ValidationIssue } from '@t1/contracts';
import { buildSourceEvidenceUnits, classifySourceSpan, sourceUnitMissingSpans } from './source-evidence-units.js';
import { verbatimOmissionIssues } from './verbatim-policy.js';

export const VISUAL_STATEMENT_POLICY_VERSION = 'visual-statements-2' as const;
type Document = EvidenceValidationContext['document'];
export interface LocatedTableSupport { table_id: string; reference_evidence: LocatedEvidenceFragment[]; fragments: LocatedEvidenceFragment[] }
const contains = (a: LocatedEvidenceFragment, b: LocatedEvidenceFragment) => a.block_id === b.block_id && a.text_version === b.text_version && a.start <= b.start && a.end >= b.end;
const overlaps = (a: LocatedEvidenceFragment, b: LocatedEvidenceFragment) => a.block_id === b.block_id && a.start < b.end && b.start < a.end;
const tableMarkers = (value: string) => [...value.matchAll(/\bTable\s*(\d+)\b|表\s*([0-9０-９]+)/giu)]
  .map(m => (m[1] ?? m[2])!.replace(/[０-９]/gu, c => String(c.charCodeAt(0) - 0xff10)));

/** Only mechanical evidence roles, source spans and explicit table identities are hard checks.
 * Neither a model's label nor these lexical checks establish medical visual semantics. */
export function visualStatementIssues(document: Document, submission: Pick<EvidenceSubmission, 'evidence_type'>, source: LocatedEvidenceFragment[],
  context: LocatedEvidenceFragment[], fieldEvidence: LocatedEvidenceFragment[], support: LocatedTableSupport[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, severity: ValidationIssue['severity'], path: string, detail: string) => {
    if (!issues.some(i => i.code === code && i.path === path)) issues.push({ code, severity, path, detail });
  };
  for (const f of source) if (['table', 'table_caption'].includes(classifySourceSpan(document, f))) {
    add('table_evidence_cannot_be_primary', 'reject', 'source_fragments',
      'Primary evidence must be a visual source statement in prose/caption; explicitly cited table values belong only in supporting_table_evidence.');
  }
  const units = buildSourceEvidenceUnits(document), uncertain: LocatedEvidenceFragment[] = [];
  for (const u of units.filter(u => u.segments.some(s => source.some(f => overlaps(s, f))))) {
    if (u.completeness === 'complete') {
      const missing = sourceUnitMissingSpans(u, source);
      if (missing.some(s => {
        const b = document.blocks.find(b => b.block_id === s.block_id)!;
        return Array.from(b.text).slice(s.start, s.end).join('').trim();
      })) add('incomplete_source_statement', 'reject', 'source_fragments',
        'Select the complete original sentence, including preceding/following source spans: ' + JSON.stringify(missing));
    } else {
      uncertain.push(...source.filter(f => u.segments.some(s => overlaps(s, f))));
      add('source_statement_boundary_requires_review', 'requires_review', 'source_fragments',
        'The source sentence/paragraph boundary cannot be established safely; do not merge columns, pages, native units or case identities.');
    }
  }
  // Known complete sentence spans already preserve every character. Unmapped/uncertain
  // boundaries retain the historical whole-line qualifier/number guard.
  for (const issue of verbatimOmissionIssues(document, uncertain)) add(issue.code, issue.severity, issue.path, issue.detail);
  for (const u of units.filter(u => u.completeness === 'complete' && u.segments.some(s => context.some(f => overlaps(s, f))))) {
    const missing = sourceUnitMissingSpans(u, [...source, ...context]);
    if (missing.some(s => Array.from(document.blocks.find(b => b.block_id === s.block_id)!.text).slice(s.start, s.end).join('').trim())) {
      add('incomplete_context_statement', 'reject', 'context_fragments', 'Necessary context must retain its complete known source statement: ' + JSON.stringify(missing));
    }
  }

  for (const [index, s] of support.entries()) {
    const path = `supporting_table_evidence[${index}]`;
    const table = document.schema_version === '3' ? document.structure.tables.find(t => t.table_id === s.table_id) : undefined;
    if (!table) { add('supporting_table_not_found', 'reject', path, 'No table with this ID exists in the bound source version.'); continue; }
    if (table.association_status === 'conflict') add('supporting_table_caption_conflict', 'reject', path, 'The table/caption association is explicitly conflicted.');
    if (!s.reference_evidence.length || !s.reference_evidence.every(f => source.some(p => contains(p, f)))) {
      add('supporting_table_reference_not_in_primary', 'reject', path, 'The literal table reference must belong to the primary visual statement.');
    }
    const captionUnits = document.schema_version === '3' ? document.structure.units.filter(u => table.caption_unit_ids.includes(u.unit_id) &&
      ['exact', 'normalized_alignment'].includes(u.mapping.status)) : [];
    const caption = captionUnits.flatMap(u => u.source_segments.map(s => {
      const b = document.blocks.find(b => b.block_id === s.block_id);
      return b ? Array.from(b.text).slice(s.start, s.end).join('') : '';
    })).join('\n');
    const numbers = [...new Set(tableMarkers(caption))], references = tableMarkers(s.reference_evidence.map(f => f.exact_quote).join('\n'));
    if (numbers.length !== 1 || !references.includes(numbers[0]!)) add('supporting_table_explicit_reference_required', 'reject', path,
      'An exact numbered table reference in the primary statement must match a uniquely mapped table caption.');
    const tableUnitIds = new Set([table.table_id, ...table.cells.map(c => c.unit_id)]);
    const tableUnits = document.schema_version === '3' ? document.structure.units.filter(u => tableUnitIds.has(u.unit_id) &&
      ['exact', 'normalized_alignment'].includes(u.mapping.status)) : [];
    if (!s.fragments.length || !s.fragments.every(f => tableUnits.some(u => u.source_segments.some(p => p.block_id === f.block_id && p.text_version === f.text_version && p.start <= f.start && p.end >= f.end)))) {
      add('supporting_table_value_source_mismatch', 'reject', path, 'Supporting values must be exact mapped source spans of the named table.');
    }
    if (!s.fragments.some(f => /[0-9０-９]/u.test(f.exact_quote))) add('supporting_table_numeric_value_required', 'reject', path, 'Attach literal values, not an independent table feature-name list.');
    add('supporting_table_value_relationship_requires_review', 'requires_review', path,
      'The numbered reference and literal table values are located; the semantic value/feature relationship remains unverified.');
  }
  const supporting = support.flatMap(s => s.fragments);
  for (const f of [...context, ...fieldEvidence]) if (['table', 'table_caption'].includes(classifySourceSpan(document, f)) && !supporting.some(s => contains(s, f))) {
    add('table_context_requires_explicit_support', 'reject', 'context_fragments', 'Table text/values cannot be attached through context or fields without explicit supporting_table_evidence.');
  }
  if (['feature_mention', 'association_conclusion'].includes(submission.evidence_type)) add('visual_statement_purpose_requires_review', 'requires_review', 'evidence_type',
    'A feature-name list, statistical association or study conclusion alone is not a visual description. Source semantics require review; a declared evidence type does not prove them.');
  add('visual_description_semantics_unverified', 'info', 'source_fragments',
    'Mechanical checks do not establish visual-description meaning, terminology, case attribution or medical pairing.');
  return issues;
}
