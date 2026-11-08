import type { DocumentIR, LocatedEvidenceFragment, ValidationIssue } from '@t1/contracts';

export const VERBATIM_OUTPUT_POLICY = 'verbatim-fragments-1' as const;
/** Delimiters describe a presentation boundary; words can never be inserted between source fragments. */
export const isSourceBoundaryDelimiter = (value: string) => /^[\s…|]*$/u.test(value);

/** Conservative omission guard. This is lexical protection, never proof of medical semantics. */
export function verbatimOmissionIssues(document: Exclude<DocumentIR, { schema_version: '1' }>, fragments: readonly LocatedEvidenceFragment[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const id of new Set(fragments.map(f => f.block_id))) {
    const block = document.blocks.find(b => b.block_id === id)!;
    const selected = fragments.filter(f => f.block_id === id);
    const cues = /\b(?:no|not|without|neither|absence|absent|negative|if|when|unless|only|provided|depending|may|might|could|possible|possibly|uncertain|versus|compared)\b|未见|未发现|不存在|没有|不伴|无(?:明显|证据|强化|毛刺|浸润)|如果|仅(?:在|当|适用)|可能|可疑|不能排除|尚不确定|(?:[<>≤≥≈~±+]\s*)?\d+(?:\.\d+)?(?:\s*(?:mm|cm|µm|μm|HU|%|毫米|厘米))?/giu;
    for (const match of block.text.matchAll(cues)) {
      const start = Array.from(block.text.slice(0, match.index)).length, end = start + Array.from(match[0]).length;
      if (!selected.some(f => f.start <= start && f.end >= end)) {
        issues.push({ code: 'source_qualifier_or_number_omitted', severity: 'reject', path: 'source_fragments',
          detail: `A qualifier/numerical token was omitted from source block ${id}; select the complete source statement.` });
        break;
      }
    }
  }
  return issues;
}
