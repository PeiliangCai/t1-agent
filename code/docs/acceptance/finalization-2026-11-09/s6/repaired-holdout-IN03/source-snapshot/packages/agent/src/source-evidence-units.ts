import type { DocumentIR, LocatedEvidenceFragment } from '@t1/contracts';
import { isTableSourceSpan, checkedTableCaptionContains, checkedTableFootnoteContains, checkedSourceGrid } from './document-structure-context.js';

type Document = Exclude<DocumentIR, { schema_version: '1' }>;
export function sourceGlyphCheckStatus(document: Document): 'engineering_fixture' | 'checked_with_gaps' | 'checked_no_detected_gaps' | 'legacy_not_checked' {
  if (document.fixture) return 'engineering_fixture';
  if (document.parser.config.font_glyph_guard_version !== 'sparse-embedded-font-no-unicode-1') return 'legacy_not_checked';
  return document.blocks.some(b => b.source_glyph_issues?.length) ? 'checked_with_gaps' : 'checked_no_detected_gaps';
}
export const SOURCE_EVIDENCE_UNIT_VERSION = 'literal-source-sentences-4' as const;
export type SourceSpan = Pick<LocatedEvidenceFragment, 'block_id' | 'text_version' | 'start' | 'end'>;
export type SourceEvidenceType = 'body' | 'figure_caption' | 'table' | 'table_caption' | 'footnote' | 'unknown';
export interface SourceEvidenceUnit {
  unit_id: string;
  kind: 'sentence' | 'paragraph_fragment' | 'table_cell';
  source_type: SourceEvidenceType;
  segments: LocatedEvidenceFragment[];
  display_joiner: '\n';
  completeness: 'complete' | 'unverified';
  boundary_reasons: string[];
  structure_unit_ids: string[];
}
export interface SourceEvidenceGroup {
  group_id: string;
  kind: SourceEvidenceUnit['kind'];
  source_type: SourceEvidenceType;
  segments: LocatedEvidenceFragment[];
  display_joiner: '\n';
  completeness: 'complete' | 'incomplete' | 'unverified';
  boundary_reasons: string[];
  missing_source_spans: SourceSpan[];
}

const overlap = (a: SourceSpan, b: SourceSpan) => a.block_id === b.block_id && a.text_version === b.text_version && a.start < b.end && b.start < a.end;
const contains = (a: SourceSpan, b: SourceSpan) => a.block_id === b.block_id && a.text_version === b.text_version && a.start <= b.start && a.end >= b.end;
const span = (f: SourceSpan): SourceSpan => ({ block_id: f.block_id, text_version: f.text_version, start: f.start, end: f.end });
const unique = (values: string[]) => [...new Set(values)];

/** Construct a literal subspan. No Unicode, spacing, hyphen or source spelling normalization occurs. */
function literal(document: Document, source: SourceSpan): LocatedEvidenceFragment {
  const b = document.blocks.find(b => b.block_id === source.block_id);
  if (!b || source.text_version !== document.text_version || source.start < 0 || source.end > Array.from(b.text).length || source.start >= source.end) throw new Error('invalid_source_unit_span');
  const cps = Array.from(b.text), quote = cps.slice(source.start, source.end), matches: number[] = [];
  for (let i = 0; i <= cps.length - quote.length; i++) if (quote.every((c, j) => c === cps[i + j])) matches.push(i);
  return { ...span(source), exact_quote: quote.join(''), occurrence: matches.indexOf(source.start), physical_page: b.page,
    bbox: [...b.bbox], location_precision: 'whole_textline_not_exact_glyph' };
}

/** Reliable here means only exact/aligned character mapping, never an approved native semantic relationship. */
export function classifySourceSpan(document: Document, source: SourceSpan): SourceEvidenceType {
  if (document.schema_version !== '3') return 'unknown';
  if (checkedTableCaptionContains(document, source)) return 'table_caption';
  if (checkedTableFootnoteContains(document, source)) return 'footnote';
  if (isTableSourceSpan(document, source)) return 'table';
  const superseded = new Set(document.structure.tables.filter(t => checkedSourceGrid(document, t)).flatMap(t => t.cells.map(c => c.unit_id)));
  const units = document.structure.units.filter(u => !superseded.has(u.unit_id) && ['exact', 'normalized_alignment'].includes(u.mapping.status) && u.source_segments.some(s => contains(s, source)));
  if (units.some(u => u.kind === 'table_cell' || u.kind === 'table')) return 'table';
  const tableCaptions = new Set(document.structure.tables.filter(t => t.association_status !== 'conflict').flatMap(t => t.caption_unit_ids));
  if (units.some(u => tableCaptions.has(u.unit_id))) return 'table_caption';
  if (units.some(u => u.kind === 'caption')) return 'figure_caption';
  if (units.some(u => u.kind === 'footnote')) return 'footnote';
  if (units.some(u => u.kind === 'text' || u.kind === 'list_item')) return 'body';
  return 'unknown';
}

function boundary(document: Document, a: LocatedEvidenceFragment, b: LocatedEvidenceFragment): string | null {
  if (a.block_id === b.block_id) return a.end === b.start ? null : 'nonadjacent_source_spans';
  if (document.schema_version === '3' && document.structure.organization?.continuation_recovery?.relations.some(edge => {
    const left = document.structure.units.find(u => u.unit_id === edge.from_unit_id)?.source_segments.at(-1);
    const right = document.structure.units.find(u => u.unit_id === edge.to_unit_id)?.source_segments[0];
    return left?.block_id === a.block_id && left.end === a.end && right?.block_id === b.block_id && right.start === b.start;
  })) return null;
  const x = document.blocks.find(v => v.block_id === a.block_id)!, y = document.blocks.find(v => v.block_id === b.block_id)!;
  if (x.page !== y.page) return 'physical_page_boundary';
  if (y.reading_order !== x.reading_order + 1) return 'nonadjacent_source_blocks';
  const height = Math.max(x.bbox[3]! - x.bbox[1]!, y.bbox[3]! - y.bbox[1]!, 1);
  const width = Math.min(x.bbox[2]! - x.bbox[0]!, y.bbox[2]! - y.bbox[0]!);
  const xOverlap = Math.min(x.bbox[2]!, y.bbox[2]!) - Math.max(x.bbox[0]!, y.bbox[0]!);
  if (Math.abs(x.bbox[0]! - y.bbox[0]!) > Math.max(30, height * 3) || xOverlap < Math.min(width * 0.7, 20)) return 'column_or_horizontal_boundary';
  if (y.bbox[1]! <= x.bbox[1]! || y.bbox[1]! - x.bbox[3]! > Math.max(14, height * 1.75)) return 'vertical_layout_boundary';
  const identity = (text: string) => [...text.matchAll(/\b(?:case|patient|lesion)\s*(?:no\.?\s*)?(\d+)\b|(?:病例|患者|病灶)\s*(\d+)/giu)].map(m => m[0].replace(/\s+/g, '').toLowerCase());
  const left = identity(a.exact_quote), right = identity(b.exact_quote);
  if (left.length && right.length && !left.some(id => right.includes(id))) return 'explicit_case_or_lesion_boundary';
  return null;
}

function terminalAt(cps: string[], i: number): boolean {
  const c = cps[i]!;
  if ('。！？'.includes(c)) return true;
  if (!'.!?'.includes(c)) return false;
  if (c === '.' && /\d/u.test(cps[i - 1] ?? '') && /\d/u.test(cps[i + 1] ?? '')) return false;
  const prefix = cps.slice(Math.max(0, i - 16), i + 1).join('');
  if (c === '.' && /\b(?:figs?|eqs?|dr|mrs?|ms|prof|vs|al|no|e\.g|i\.e)\.$/iu.test(prefix)) return false;
  if (c === '.' && /(?:^|\s)[A-Z]\.$/u.test(prefix)) return false;
  return !cps[i + 1] || /[\s\u201d\u2019"')\]]/u.test(cps[i + 1]!);
}

/** Sentence boundaries are presentation hints over original spans. Uncertain edges remain explicit. */
function splitRun(document: Document, segments: LocatedEvidenceFragment[], sourceType: SourceEvidenceType,
  structureIds: string[], startKnown: boolean, endKnown: boolean, reasons: string[]): Omit<SourceEvidenceUnit, 'unit_id'>[] {
  if (sourceType === 'table' || sourceType === 'table_caption') return segments.map(s => ({ kind: 'table_cell', source_type: sourceType,
    segments: [s], display_joiner: '\n', completeness: 'unverified', boundary_reasons: ['table_is_supporting_evidence_only'], structure_unit_ids: structureIds }));
  const cps: string[] = [], offsets: Array<{ fragment: LocatedEvidenceFragment; start: number; end: number }> = [];
  for (const s of segments) {
    if (cps.length) cps.push('\n');
    const start = cps.length; cps.push(...Array.from(s.exact_quote)); offsets.push({ fragment: s, start, end: cps.length });
  }
  const cuts = [0];
  for (let i = 0; i < cps.length; i++) if (terminalAt(cps, i)) {
    let end = i + 1;
    while (/[\u201d\u2019"')\]】）]/u.test(cps[end] ?? '') && end < cps.length) end++;
    cuts.push(end); i = end - 1;
  }
  if (cuts.at(-1) !== cps.length) cuts.push(cps.length);
  const result: Omit<SourceEvidenceUnit, 'unit_id'>[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const lo = cuts[i]!, hi = cuts[i + 1]!;
    const pieces = offsets.flatMap(o => {
      const a = Math.max(lo, o.start), b = Math.min(hi, o.end);
      return a < b ? [literal(document, { ...o.fragment, start: o.fragment.start + a - o.start, end: o.fragment.start + b - o.start })] : [];
    });
    if (!pieces.length) continue;
    // Whitespace belongs to the preceding sentence; it is never deleted from a source fragment.
    if (!pieces.some(p => p.exact_quote.trim())) {
      if (result.length) result.at(-1)!.segments.push(...pieces);
      else result.push({ kind: 'paragraph_fragment', source_type: sourceType, segments: pieces, display_joiner: '\n', completeness: 'unverified', boundary_reasons: ['sentence_boundary_unverified'], structure_unit_ids: structureIds });
      continue;
    }
    const starts = i > 0 || startKnown;
    const ended = [...Array(hi - lo).keys()].some(j => terminalAt(cps, lo + j));
    const complete = starts && ended;
    result.push({ kind: complete ? 'sentence' : 'paragraph_fragment', source_type: sourceType, segments: pieces, display_joiner: '\n',
      completeness: complete ? 'complete' : 'unverified', structure_unit_ids: structureIds,
      boundary_reasons: unique([...reasons, ...(!starts ? ['sentence_start_unverified'] : []), ...(!ended ? [endKnown ? 'sentence_end_unverified' : 'source_unit_boundary_unverified'] : [])]) });
  }
  return result;
}

/** Browser-safe, deterministic, lossless source units. Geometry alone never joins different native units. */
export function buildSourceEvidenceUnits(document: Document): SourceEvidenceUnit[] {
  const byId = new Map(document.blocks.map(b => [b.block_id, b]));
  const supersededTableCells = new Set(document.schema_version === '3' ? document.structure.tables.filter(t => checkedSourceGrid(document, t)).flatMap(t => t.cells.map(c => c.unit_id)) : []);
  const incomingContinuation = new Set(document.schema_version === '3' ?
    document.structure.organization?.paragraph_continuations.map(c => c.to_unit_id) ?? [] : []);
  const nativeCandidates = document.schema_version === '3' ? document.structure.units.filter(u =>
    !supersededTableCells.has(u.unit_id) && ['exact', 'normalized_alignment'].includes(u.mapping.status) && !['table', 'picture'].includes(u.kind) && u.source_segments.length) : [];
  const relations = document.schema_version === '3' ? document.structure.organization?.continuation_recovery?.relations ?? [] : [];
  const outgoing = new Map(relations.map(r => [r.from_unit_id, r])), incoming = new Set(relations.map(r => r.to_unit_id));
  const candidates = nativeCandidates.filter(u => !incoming.has(u.unit_id)).map(u => {
    const chain = [u], seen = new Set([u.unit_id]);
    for (let edge = outgoing.get(u.unit_id); edge; edge = outgoing.get(chain.at(-1)!.unit_id)) {
      const next = nativeCandidates.find(c => c.unit_id === edge.to_unit_id);
      if (!next || seen.has(next.unit_id)) break;
      chain.push(next); seen.add(next.unit_id);
    }
    return { ...u, source_segments: chain.flatMap(c => c.source_segments), member_unit_ids: chain.map(c => c.unit_id),
      source_type_override: chain.length > 1 ? outgoing.get(u.unit_id)?.source_type : undefined };
  });
  const claims = new Map<string, Array<{ id: string; source: SourceSpan }>>();
  for (const u of candidates) for (const s of u.source_segments) {
    if (!byId.has(s.block_id) || s.text_version !== document.text_version || s.start >= s.end || s.end > Array.from(byId.get(s.block_id)!.text).length) continue;
    const values = claims.get(s.block_id) ?? []; values.push({ id: u.unit_id, source: s }); claims.set(s.block_id, values);
  }
  const covered = new Map<string, SourceSpan[]>(), raw: Omit<SourceEvidenceUnit, 'unit_id'>[] = [];
  for (const u of candidates) {
    const pieces = u.source_segments.filter(s => byId.has(s.block_id) && s.text_version === document.text_version && s.start < s.end && s.end <= Array.from(byId.get(s.block_id)!.text).length &&
      !claims.get(s.block_id)!.some(c => c.id !== u.unit_id && overlap(c.source, s))).map(s => literal(document, s));
    if (u.member_unit_ids.length === 1) pieces.sort((a, b) => byId.get(a.block_id)!.reading_order - byId.get(b.block_id)!.reading_order || a.start - b.start);
    if (!pieces.length) continue;
    for (const p of pieces) { const old = covered.get(p.block_id) ?? []; old.push(span(p)); covered.set(p.block_id, old); }
    let run: LocatedEvidenceFragment[] = [], reasons: string[] = [];
    const flush = (last: boolean) => {
      if (!run.length) return;
      const firstText = run[0]!.exact_quote.trimStart();
      const startKnown = run[0] === pieces[0] && !incomingContinuation.has(u.unit_id) && /^[\p{Lu}\p{Script=Han}\d（(“"'\u2018]/u.test(firstText);
      raw.push(...splitRun(document, run, u.source_type_override ?? classifySourceSpan(document, run[0]!), u.member_unit_ids, startKnown, last && pieces.length === u.source_segments.length, reasons));
      run = [];
    };
    for (const p of pieces) {
      const why = run.length ? boundary(document, run.at(-1)!, p) : null;
      if (why) { reasons.push(why); flush(false); reasons = [why]; }
      run.push(p);
    }
    flush(true);
  }
  for (const b of document.blocks) {
    const spans = (covered.get(b.block_id) ?? []).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const s of [...spans, { start: Array.from(b.text).length, end: Array.from(b.text).length }]) {
      if (s.start > cursor) {
        const f = literal(document, { block_id: b.block_id, text_version: document.text_version, start: cursor, end: s.start });
        raw.push(...splitRun(document, [f], classifySourceSpan(document, f), [], false, false, ['native_source_mapping_unverified']));
      }
      cursor = Math.max(cursor, s.end);
    }
  }
  raw.sort((a, b) => byId.get(a.segments[0]!.block_id)!.reading_order - byId.get(b.segments[0]!.block_id)!.reading_order || a.segments[0]!.start - b.segments[0]!.start);
  return raw.map((u, i) => {
    const unsafe = u.segments.some(s => byId.get(s.block_id)?.source_glyph_issues?.some(g => g.start < s.end && s.start < g.end));
    return { unit_id: 'su-' + String(i + 1).padStart(6, '0'), ...u,
      ...(unsafe ? { completeness: 'unverified' as const, boundary_reasons: unique([...u.boundary_reasons, 'source_glyph_fidelity_unverified']) } : {}) };
  });
}

/** Whole affected literal sentences stay out of model input. Blocks are the
 * transport atom: preserve their source bytes and expose the omitted IDs as gaps,
 * never join the surviving text across them into a replacement statement. */
export function sourceGlyphQuarantine(document: Document): string[] {
  const unsafe = new Set(document.blocks.filter(b => b.source_glyph_issues?.length).map(b => b.block_id));
  if (!unsafe.size) return [];
  for (const unit of buildSourceEvidenceUnits(document)) {
    if (unit.boundary_reasons.includes('source_glyph_fidelity_unverified')) unit.segments.forEach(s => unsafe.add(s.block_id));
  }
  return document.blocks.filter(b => unsafe.has(b.block_id)).map(b => b.block_id);
}

function missingSpans(expected: readonly SourceSpan[], selected: readonly SourceSpan[]): SourceSpan[] {
  return expected.flatMap(e => {
    const pieces = selected.filter(s => overlap(s, e)).sort((a, b) => a.start - b.start), missing: SourceSpan[] = [];
    let cursor = e.start;
    for (const s of pieces) { if (s.start > cursor) missing.push({ ...span(e), start: cursor, end: Math.min(s.start, e.end) }); cursor = Math.max(cursor, Math.min(s.end, e.end)); }
    if (cursor < e.end) missing.push({ ...span(e), start: cursor });
    return missing;
  });
}

/** Group only supplied bytes. Missing sentence parts are spans for diagnostics, never inserted source text. */
export function groupEvidenceFragments(document: Document, fragments: readonly LocatedEvidenceFragment[], units = buildSourceEvidenceUnits(document)): SourceEvidenceGroup[] {
  const groups: Array<SourceEvidenceGroup & { source_unit: SourceEvidenceUnit }> = [];
  for (const f of fragments) {
    const matching = units.filter(u => u.segments.some(s => overlap(s, f)));
    for (const u of matching) for (const s of u.segments.filter(s => overlap(s, f))) {
      const part = literal(document, { ...f, start: Math.max(s.start, f.start), end: Math.min(s.end, f.end) });
      const previous = groups.at(-1);
      if (previous?.source_unit.unit_id === u.unit_id && !boundary(document, previous.segments.at(-1)!, part)) previous.segments.push(part);
      else groups.push({ group_id: '', kind: u.kind, source_type: u.source_type, segments: [part], display_joiner: '\n',
        completeness: u.completeness, boundary_reasons: [...u.boundary_reasons], missing_source_spans: [], source_unit: u });
    }
  }
  return groups.map(({ source_unit: u, ...g }, i) => {
    const missing = missingSpans(u.segments, g.segments);
    return { ...g, group_id: u.unit_id + '-g' + (i + 1), missing_source_spans: missing,
      completeness: missing.length ? 'incomplete' : g.completeness,
      boundary_reasons: unique([...g.boundary_reasons, ...(missing.length ? ['selected_source_statement_incomplete'] : [])]) };
  });
}

export function sourceUnitMissingSpans(unit: SourceEvidenceUnit, selected: readonly SourceSpan[]): SourceSpan[] { return missingSpans(unit.segments, selected); }

/** Add only literal sentence boundary context. Assigned/source-selection coverage never changes. */
export function addSourceStatementContext<T extends { assigned_block_ids: string[]; context_block_ids: string[]; warnings: string[] }>(
  document: Document, batches: readonly T[], articleEligibleIds: readonly string[]): T[] {
  const units = buildSourceEvidenceUnits(document), eligible = new Set(articleEligibleIds);
  return batches.map(batch => {
    const assigned = new Set(batch.assigned_block_ids), context = [...batch.context_block_ids], warnings = [...batch.warnings];
    const originalBoundaryContext = new Set(batch.context_block_ids);
    for (const u of units.filter(u => u.completeness === 'complete' && u.segments.some(s => assigned.has(s.block_id) || originalBoundaryContext.has(s.block_id)))) {
      const additional = [...new Set(u.segments.map(s => s.block_id))].filter(id => eligible.has(id) && !assigned.has(id) && !context.includes(id));
      if (assigned.size + context.length + additional.length > 256) {
        warnings.push('source_statement_context_capacity_exceeded'); continue;
      }
      if (additional.length) { context.push(...additional); warnings.push('complete_source_statement_boundary_context_added'); }
    }
    return { ...batch, context_block_ids: context, warnings: unique(warnings) };
  });
}
