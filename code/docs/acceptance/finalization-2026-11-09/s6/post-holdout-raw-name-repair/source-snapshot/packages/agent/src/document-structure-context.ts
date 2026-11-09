import type { DocumentIR, StructureUnit, StructuredDocumentIR } from '@t1/contracts';

type Document = Exclude<DocumentIR, { schema_version: '1' }>;
type Table = StructuredDocumentIR['structure']['tables'][number];
type Span = StructureUnit['source_segments'][number];
const reliable = (u: StructureUnit) => ['exact', 'normalized_alignment'].includes(u.mapping.status);

/** Decoded rows identify source location only; they do not approve native cell or header semantics. */
export function isTableSourceSpan(document: Document, source: Span): boolean {
  if (document.schema_version !== '3') return false;
  const block = document.blocks.find(b => b.block_id === source.block_id);
  if (!block || source.text_version !== document.text_version) return false;
  return document.structure.tables.some(t => {
    const grid = checkedSourceGrid(document, t);
    if (grid) return grid.cells.some(c => c.source_segments.some(s => s.block_id === source.block_id && s.text_version === source.text_version && s.start < source.end && s.end > source.start));
    if (t.source_layout?.source_rows.some(r => r.source_segments.some(s => s.block_id === source.block_id &&
      s.text_version === source.text_version && s.start <= source.start && s.end >= source.end))) return true;
    // Backward-compatible conservative region check for frozen IR. Only a whole
    // decoded line contained by the vendor table region qualifies; adjacent body
    // text/captions are never classified by vocabulary or a nearby number.
    const parent = document.structure.units.find(u => u.unit_id === t.table_id);
    return parent?.provenance.some(p => p.physical_page === block.page && p.bbox &&
      block.bbox[0]! >= p.bbox[0]! - 1 && block.bbox[1]! >= p.bbox[1]! - 1 &&
      block.bbox[2]! <= p.bbox[2]! + 1 && block.bbox[3]! <= p.bbox[3]! + 1) ?? false;
  });
}

export function tableStructureStatus(document: Document, table: Table) {
  const checked = checkedSourceGrid(document, table);
  if (checked) return { status: 'geometry_checked' as const, issue_codes: ['native_grid_superseded_by_checked_source_grid'],
    support_semantics: 'geometry_checked_source_cells_unapproved_semantics' as const };
  const cells = document.schema_version === '3' ? document.structure.units.filter(u => table.cells.some(c => c.unit_id === u.unit_id)) : [];
  const sourceConflict = cells.some(u => ['partial', 'unmapped'].includes(u.mapping.status));
  if (sourceConflict && table.source_layout) return { ...table.source_layout, status: 'source_conflict' as const,
    issue_codes: [...new Set([...table.source_layout.issue_codes, 'native_cell_text_source_conflict'])],
    support_semantics: 'blocked_due_to_structure_conflict' as const };
  return table.source_layout ?? {
    status: sourceConflict ? 'source_conflict' as const : cells.some(u => !reliable(u) && u.mapping.status !== 'not_text') ? 'requires_review' as const : 'native_unverified' as const,
    issue_codes: sourceConflict ? ['native_cell_text_source_conflict'] : [],
    support_semantics: sourceConflict ? 'blocked_due_to_structure_conflict' as const : 'unverified' as const,
  };
}

export function checkedSourceGrid(document: Document, table: Table) {
  const grid = table.source_grid;
  return grid?.status === 'geometry_checked' && grid.source_pdf_sha256 === document.file_sha256 && grid.text_version === document.text_version &&
    !grid.issue_codes.length && grid.verification.all_cells_independently_checked && grid.verification.grid_slots_covered_once &&
    grid.verification.raw_nonspace_codepoints === grid.verification.covered_nonspace_codepoints &&
    grid.cells.every(c => ['geometry_checked', 'blank_geometry_checked'].includes(c.status)) ? grid : undefined;
}

export function checkedTableCaptionContains(document: Document, source: Span): boolean {
  return document.schema_version === '3' && document.structure.tables.some(t => {
    const grid = checkedSourceGrid(document, t);
    return grid?.caption_status === 'geometry_checked_numbered_title' && grid.caption_segments.some(s => s.block_id === source.block_id && s.text_version === source.text_version && s.start <= source.start && s.end >= source.end);
  });
}

export function checkedTableFootnoteContains(document: Document, source: Span): boolean {
  return document.schema_version === '3' && document.structure.tables.some(t => checkedSourceGrid(document, t)?.footnote_segments.some(s =>
    s.block_id === source.block_id && s.text_version === source.text_version && s.start <= source.start && s.end >= source.end));
}

/** Whole raw lines may contain several checked cells and delimiter spaces. */
export function checkedTableSourceContains(document: Document, table: Table, source: Span): boolean {
  const grid = checkedSourceGrid(document, table);
  if (!grid) return false;
  const block = document.blocks.find(b => b.block_id === source.block_id);
  if (!block || source.text_version !== document.text_version) return false;
  const spans = grid.cells.flatMap(c => c.source_segments).filter(s => s.block_id === source.block_id && s.text_version === source.text_version);
  return Array.from(block.text).slice(source.start, source.end).every((char, offset) => /\s/u.test(char) ||
    spans.some(s => s.start <= source.start + offset && s.end > source.start + offset));
}

/** A bounded structural projection over the current source window, never a second source-text copy.
 * lineIndexIds is the immutable batch/document index table. authorizedIds limits
 * reread references; it never grants access or marks a referenced line read.
 */
export function buildDocumentStructureContext(document: Document, windowIds: readonly string[],
  lineIndexIds: readonly string[] = document.blocks.map(b => b.block_id), authorizedIds: readonly string[] = lineIndexIds) {
  const visible = new Set(windowIds), authorized = new Set(authorizedIds);
  const index = new Map(lineIndexIds.map((id, i) => [id, i]));
  const spans = (values: readonly Span[]) => values.filter(s => visible.has(s.block_id)).map(s => [index.get(s.block_id)!, s.start, s.end]);
  const required = (values: readonly Span[]) => [...new Set(values.filter(s => !visible.has(s.block_id) && authorized.has(s.block_id))
    .map(s => index.get(s.block_id)).filter((n): n is number => n !== undefined))];
  const empty = { schema_version: 'document-structure-context-1' as const,
    source_binding: { file_sha256: document.file_sha256, text_version: document.text_version },
    native_relations_verified: false, order_basis: 'native_order_unverified_no_source_reordering',
    source_span_format: '[line_index, start, end] in Unicode code points; [start,end)',
  };
  if (document.schema_version !== '3') return { ...empty, available: false as const, reason: 'source_has_no_native_structure' };
  const units = new Map(document.structure.units.map(u => [u.unit_id, u]));
  const glyphUnsafe = (u?: StructureUnit) => u?.source_segments.some(s => document.blocks.find(b => b.block_id === s.block_id)?.source_glyph_issues?.length);
  const readingIndex = new Map(document.structure.reading_order.map((id, i) => [id, i]));
  const touched = document.structure.units.filter(u => u.source_segments.some(s => visible.has(s.block_id)));
  const paragraphs = touched.filter(u => ['text', 'list_item', 'caption', 'footnote', 'section_header', 'other'].includes(u.kind));
  const touchedOrder = paragraphs.map(u => readingIndex.get(u.unit_id)).filter((n): n is number => n !== undefined);
  // Frozen native artifacts omitted heading levels in the old adapter. Keep the
  // absence explicit; printed numbering may suggest paths but is never approved.
  const headingPaths = document.structure.organization?.heading_paths ?? document.structure.units.filter(u => u.kind === 'section_header').map(u => {
    const number = u.native_text.replace(/[\u0000-\u001f]/gu, '').trim().match(/^(\d{1,2}(?:\.\d{1,2}){0,4})\s+\S/u)?.[1] ?? null;
    return { unit_id: u.unit_id, native_level: u.native_heading_level ?? null, printed_number: number,
      inferred_level: number?.split('.').length ?? null, parent_unit_id: null, status: number ? 'numbering_inferred' as const : 'native_unverified' as const,
      role: /^【(?:文章编号|中图分类号|文献标识码)】/u.test(u.native_text) ? 'metadata' as const : number ? 'numbered_section' as const : 'native_heading' as const };
  });
  const headingIds = new Set(touched.filter(u => u.kind === 'section_header').map(u => u.unit_id));
  for (const order of touchedOrder) {
    const nearest = headingPaths.filter(h => h.role !== 'metadata' && (readingIndex.get(h.unit_id) ?? Infinity) <= order)
      .sort((a, b) => (readingIndex.get(b.unit_id) ?? 0) - (readingIndex.get(a.unit_id) ?? 0))[0];
    for (let h = nearest; h && !headingIds.has(h.unit_id); h = headingPaths.find(p => p.unit_id === h!.parent_unit_id)) headingIds.add(h.unit_id);
  }
  const describe = (u: StructureUnit) => ({ unit_id: u.unit_id, kind: u.kind,
    ...(u.native_label !== u.kind ? { native_label: u.native_label } : {}),
    ...(u.content_layer !== 'body' ? { content_layer: u.content_layer } : {}),
    native_reading_index: readingIndex.get(u.unit_id) ?? null, mapping_status: u.mapping.status, line_spans: spans(u.source_segments),
    complete_unit_in_window: u.source_segments.length > 0 && u.source_segments.every(s => visible.has(s.block_id)),
    ...(required(u.source_segments).length ? { required_line_indices: required(u.source_segments) } : {}),
    ...(u.source_segments.some(s => !authorized.has(s.block_id)) ? { source_spans_outside_authorized_scope: u.source_segments.filter(s => !authorized.has(s.block_id)).length } : {}),
    ...(u.source_regions ? { native_regions: u.source_regions.map(r => ({ provenance_index: r.provenance_index,
      physical_page: u.provenance[r.provenance_index]?.physical_page, mapping_status: r.mapping_status, line_spans: spans(r.source_segments) })) } : {}),
  });
  const cap = 24, headingCap = 16;
  const tables = document.structure.tables.filter(t => {
    const grid = checkedSourceGrid(document, t);
    if (grid) return [...grid.cells.flatMap(c => c.source_segments), ...grid.caption_segments, ...grid.footnote_segments].some(s => visible.has(s.block_id));
    if (t.source_layout?.source_rows.some(r => r.source_segments.some(s => visible.has(s.block_id)))) return true;
    const ids = new Set([t.table_id, ...t.caption_unit_ids, ...t.footnote_unit_ids, ...t.cells.map(c => c.unit_id)]);
    if (touched.some(u => ids.has(u.unit_id))) return true;
    const parent = units.get(t.table_id);
    return document.blocks.some(b => visible.has(b.block_id) && parent?.provenance.some(p => p.physical_page === b.page && p.bbox &&
      b.bbox[0]! >= p.bbox[0]! - 1 && b.bbox[1]! >= p.bbox[1]! - 1 && b.bbox[2]! <= p.bbox[2]! + 1 && b.bbox[3]! <= p.bbox[3]! + 1));
  }).map(t => {
    const quality = tableStructureStatus(document, t);
    const grid = checkedSourceGrid(document, t);
    if (grid) {
      const selected = grid.cells.filter(c => c.role === 'column_header' || c.source_segments.some(s => visible.has(s.block_id)));
      return { table_id: t.table_id, association_status: grid.caption_status === 'geometry_checked_numbered_title' ? 'source_geometry_checked' : t.association_status ?? 'native_unverified', role: 'explicitly_cited_numeric_support_only',
        layout_status: quality.status, issue_codes: quality.issue_codes, support_semantics: quality.support_semantics,
        active_grid: { grid_id: grid.grid_id, basis: 'printed_rules_exact_raw_spans_and_independent_character_geometry', n_rows: grid.n_rows, n_cols: grid.n_cols,
          header_rows: grid.header_rows, logical_header_rows: grid.logical_header_rows, geometry_checked: true, human_approved: false },
        native_grid: { n_rows: t.n_rows, n_cols: t.n_cols, verified: false, superseded: true },
        caption_units: grid.caption_status === 'geometry_checked_numbered_title' ? [{ unit_id: grid.grid_id + '-title', kind: 'caption',
          mapping_status: grid.caption_status, line_spans: spans(grid.caption_segments), required_line_indices: required(grid.caption_segments),
          complete_unit_in_window: grid.caption_segments.every(s => visible.has(s.block_id)) }] :
          t.caption_unit_ids.map(id => units.get(id)).filter((u): u is StructureUnit => !!u).map(describe),
        active_caption_status: grid.caption_status, active_caption_number: grid.caption_number,
        native_caption_status: t.association_status ?? 'native_unverified', native_caption_relationships: t.caption_relationships ?? [],
        source_row_basis: 'checked_source_grid_baselines', source_row_fields: ['physical_page', 'visible_line_indices'],
        source_rows: grid.row_bounds.slice(0, -1).map((top, r) => [grid.physical_page, [...new Set(grid.cells.flatMap(c => c.source_segments)
          .filter(s => visible.has(s.block_id) && document.blocks.some(b => b.block_id === s.block_id &&
            (b.bbox[1]! + b.bbox[3]!) / 2 >= top && (b.bbox[1]! + b.bbox[3]!) / 2 < grid.row_bounds[r + 1]!))
          .map(s => index.get(s.block_id)!))]]).filter(row => (row[1] as number[]).length),
        cell_fields: ['cell_id', 'row_start_end', 'col_start_end', 'role', 'geometry_status', 'visible_line_spans', 'required_line_indices', 'column_header_ids', 'row_group_cell_id'],
        header_relationship_status: 'source_geometry_checked_semantics_unapproved',
        cells: selected.slice(0, cap).map(c => [c.cell_id, [c.row_start, c.row_end], [c.col_start, c.col_end], c.role, c.status,
          spans(c.source_segments), required(c.source_segments), c.column_header_ids, c.row_group_cell_id]),
        footnote_line_spans: spans(grid.footnote_segments), withheld_conflicted_cell_hints: t.cells.length,
        omitted_cell_hints: Math.max(0, selected.length - cap), medical_approved: false };
    }
    const selected = t.cells.filter(c => c.column_header || units.get(c.unit_id)?.source_segments.some(s => visible.has(s.block_id)));
    const blocked = quality.support_semantics === 'blocked_due_to_structure_conflict';
    return { table_id: t.table_id, association_status: t.association_status ?? 'native_unverified', role: 'explicitly_cited_numeric_support_only',
      layout_status: quality.status, issue_codes: quality.issue_codes, support_semantics: quality.support_semantics,
      values_may_be_literal_while_cell_and_header_relationships_conflict: quality.status === 'source_conflict',
      native_grid: { n_rows: t.n_rows, n_cols: t.n_cols, verified: false },
      caption_units: t.caption_unit_ids.map(id => units.get(id)).filter((u): u is StructureUnit => !!u).map(describe),
      source_row_basis: 'decoded_baseline_not_semantic_row',
      source_row_fields: ['physical_page', 'visible_line_indices'],
      source_rows: t.source_layout?.source_rows.filter(r => r.source_segments.some(s => visible.has(s.block_id))).map(r => [r.physical_page,
        r.source_segments.filter(s => visible.has(s.block_id)).map(s => index.get(s.block_id)!)]) ?? [],
      cell_fields: ['unit_id', 'row_start_end', 'col_start_end', 'column_header', 'row_header', 'row_section', 'source_mapping', 'visible_line_spans', 'required_line_indices', 'native_header_parent_ids'],
      header_relationship_status: blocked ? 'withheld_due_to_structure_conflict' : 'native_grid_unverified',
      cells: (blocked ? [] : selected.slice(0, cap)).map(c => [c.unit_id, [c.row_start, c.row_end], [c.col_start, c.col_end], c.column_header, c.row_header, c.row_section,
        units.get(c.unit_id)?.mapping.status ?? 'unmapped', spans(units.get(c.unit_id)?.source_segments ?? []), required(units.get(c.unit_id)?.source_segments ?? []),
        t.source_layout?.header_paths.find(p => p.cell_unit_id === c.unit_id)?.parent_cell_unit_ids ?? []]),
      withheld_conflicted_cell_hints: blocked ? selected.length : 0,
      omitted_cell_hints: blocked ? 0 : Math.max(0, selected.length - cap), medical_approved: false,
    };
  });
  const pictures = document.structure.pictures.filter(p => [...p.caption_unit_ids, ...p.footnote_unit_ids].some(id => touched.some(u => u.unit_id === id))).map(p => ({
    picture_id: p.picture_id, association_status: p.association_status ?? 'native_unverified',
    caption_relationships: p.caption_relationships ?? [], caption_unit_ids: p.caption_unit_ids, footnote_unit_ids: p.footnote_unit_ids,
    whole_figure_identity_verified: false,
  }));
  return { ...empty, available: true as const, paragraphs: paragraphs.slice(0, cap).map(describe), omitted_paragraph_hints: Math.max(0, paragraphs.length - cap),
    headings: headingPaths.filter(h => headingIds.has(h.unit_id)).slice(-headingCap).map(h => ({ ...h, line_spans: spans(units.get(h.unit_id)?.source_segments ?? []),
      native_title_display: glyphUnsafe(units.get(h.unit_id)) ? '' : Array.from(units.get(h.unit_id)?.native_text ?? '').slice(0, 320).join(''),
      ...(glyphUnsafe(units.get(h.unit_id)) ? { native_title_withheld_source_glyph_unverified: true } : {}),
      native_title_display_truncated: Array.from(units.get(h.unit_id)?.native_text ?? '').length > 320,
      title_display_role: 'processed_native_context_not_literal_quote_or_read_source',
      required_line_indices: required(units.get(h.unit_id)?.source_segments ?? []), source_text_in_window: units.get(h.unit_id)?.source_segments.every(s => visible.has(s.block_id)) ?? false })),
    omitted_heading_hints: Math.max(0, headingPaths.filter(h => headingIds.has(h.unit_id)).length - headingCap),
    tables, pictures, paragraph_continuations: (document.structure.organization?.paragraph_continuations ?? [])
      .filter(c => touched.some(u => [c.from_unit_id, c.to_unit_id].includes(u.unit_id)))
      .map(c => ({ ...c, from_line_spans: spans(units.get(c.from_unit_id)?.source_segments ?? []), to_line_spans: spans(units.get(c.to_unit_id)?.source_segments ?? []),
        required_line_indices: required([...(units.get(c.from_unit_id)?.source_segments ?? []), ...(units.get(c.to_unit_id)?.source_segments ?? [])]),
        source_spans_outside_authorized_scope: [...(units.get(c.from_unit_id)?.source_segments ?? []), ...(units.get(c.to_unit_id)?.source_segments ?? [])].filter(s => !authorized.has(s.block_id)).length,
        source_text_joined: false })),
    checked_continuations: (document.structure.organization?.continuation_recovery?.relations ?? []).filter(c =>
      c.ordered_segments.some(s => visible.has(s.block_id))).slice(0, cap).map(c => ({ relation_id: c.relation_id, status: c.status, source_type: c.source_type,
        proof_method: c.proof_method, proof_codes: c.proof_codes, ordered_line_spans: spans(c.ordered_segments),
        complete_relation_in_window: c.ordered_segments.every(s => visible.has(s.block_id)), required_line_indices: required(c.ordered_segments),
        source_spans_outside_authorized_scope: c.ordered_segments.filter(s => !authorized.has(s.block_id)).length,
        boundary: c.boundary, human_approved: false, literal_characters_rewritten: false })),
    body_source_text_copied: false, referenced_unread_lines_are_not_read: true,
  };
}
