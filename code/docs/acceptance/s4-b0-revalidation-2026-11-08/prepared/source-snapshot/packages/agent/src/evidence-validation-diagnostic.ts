import { createHash } from 'node:crypto';
import type { EvidenceValidationContext, ValidationIssue } from '@t1/contracts';
import { locateEvidenceFragment } from './evidence-validation.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const MAX_PREVIEW = 80, MAX_REFERENCES = 16, MAX_ARRAY_ITEMS = 8;
const credentialLike = /(?:bearer|authorization|api[_ -]?key|password|secret|access[_ -]?token|https?:\/\/|\b(?:sk|pk)[-_]|\bAKIA|[A-Za-z\d_+/-]{32,})/iu;
function textSample(value: unknown) {
  if (typeof value !== 'string') return { value_type: value === null ? 'null' : typeof value, preview: null };
  let codePoints = 0, preview = '';
  for (const character of value) { if (codePoints < MAX_PREVIEW) preview += character; codePoints++; }
  const redacted = credentialLike.test(value);
  return { value_type: 'string', code_points: codePoints, utf8_bytes: Buffer.byteLength(value), sha256: sha(value),
    preview: redacted ? null : preview.replace(/[\u0000-\u001f\u007f]/gu, '�'),
    preview_truncated: codePoints > MAX_PREVIEW, preview_redacted: redacted };
}

/** Local rejection evidence only. Never serialize arbitrary objects, prompts, wire bodies or source quotes. */
export function validationFailureDiagnostic(value: unknown, issues: readonly ValidationIssue[],
  document: EvidenceValidationContext['document'], readBlockIds: ReadonlySet<string>, inputPath: string) {
  const submission = object(value), references: Array<Record<string, unknown>> = [];
  let truncated = false;
  const fragments = (value: unknown, role: string) => {
    if (!Array.isArray(value)) return;
    if (value.length > MAX_ARRAY_ITEMS) truncated = true;
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      if (references.length >= MAX_REFERENCES) { truncated = true; break; }
      const f = object(item), index = typeof f.block_id === 'string' ? document.blocks.findIndex(b => b.block_id === f.block_id) : -1;
      const block = document.blocks[index], quote = typeof f.exact_quote === 'string' ? f.exact_quote : null;
      const occurrence = Number.isSafeInteger(f.occurrence) && Number(f.occurrence) >= 0 ? Number(f.occurrence) : undefined;
      let span: { start: number; end: number } | null = null;
      if (block && quote) try { span = locateEvidenceFragment(document, { block_id: block.block_id, exact_quote: quote, occurrence }); } catch { /* Unresolved remains explicit. */ }
      references.push({ role, document_line_index: block ? index : null, block_id: block?.block_id ?? null,
        text_version: block?.text_version ?? null, physical_page: block?.page ?? null,
        quote_sha256: quote === null ? null : sha(quote), quote_utf8_bytes: quote === null ? null : Buffer.byteLength(quote),
        occurrence: occurrence ?? null, span: span ? { start: span.start, end: span.end } : null,
        read_in_current_window: !!block && readBlockIds.has(block.block_id) });
    }
  };
  fragments(submission.source_fragments, 'primary'); fragments(submission.context_fragments, 'context');
  for (const key of ['disease_or_lesion', 'modality', 'sequence_or_phase', 'assertion', 'applicability', 'provenance'])
    fragments(object(submission[key]).evidence, key);
  const nested = (value: unknown, table: boolean) => {
    if (!Array.isArray(value)) return;
    if (value.length > MAX_ARRAY_ITEMS) truncated = true;
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      const entry = object(item);
      if (table) { fragments(entry.reference_fragments, 'table_reference'); fragments(entry.value_fragments, 'table_value'); }
      else fragments(entry.evidence, 'numeric');
    }
  };
  nested(submission.numeric_expressions, false); nested(submission.supporting_table_evidence, true);
  return { schema_version: 'bounded-validation-failure-1', input_path: inputPath, local_only: true,
    field_samples: issues.some(i => i.path === 'feature_name_raw' && i.severity === 'reject') ?
      [{ path: inputPath + '.feature_name_raw', ...textSample(submission.feature_name_raw) }] : [],
    source_reference_coordinates: 'host_bound_document_line_index_and_unicode_code_point_span',
    source_references: references, source_references_truncated: truncated,
    limits: { field_preview_code_points: MAX_PREVIEW, source_references: MAX_REFERENCES, sampled_array_items: MAX_ARRAY_ITEMS },
    original_arguments_or_source_quotes_saved: false };
}
