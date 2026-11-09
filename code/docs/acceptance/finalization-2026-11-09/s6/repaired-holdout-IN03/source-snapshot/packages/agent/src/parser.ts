import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertSchema, ContractError, DocumentIRSchema, ParserRequestSchema, ParserResultSchema, DocumentIRV2Schema, documentIRV2Issues,
  ParserCandidateSchema, StructuredParserRequestSchema, StructuredParserResultSchema, resolveDocumentSegments,
  type DocumentIR, type DocumentIRV2, type ParserAdapter, type ParserRequest, type ParserResult,
  type ParserCandidateId, type StructuredDocumentIR, type StructuredParserResult } from '@t1/contracts';

const CODE = fileURLToPath(new URL('../../../', import.meta.url));

export class LocalParserError extends ContractError {
  constructor(code: string, public readonly retryable = false) { super(code); }
}

export function assertParsedDocument(document: Exclude<DocumentIR, { schema_version: '1' }>): void {
  assertSchema(DocumentIRSchema, document);
  if (!['2', '3'].includes(document.schema_version)) throw new LocalParserError('unsupported_document_ir_version');
  if (document.schema_version === '2') {
    if (documentIRV2Issues(document).length) throw new LocalParserError('invalid_document_ir');
    return;
  }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const blocks = document.blocks, ids = blocks.map(b => b.block_id), pages = document.pages.map(p => p.physical_page);
  if (!same(pages, pages.map((_, i) => i + 1)) || !same(pages, document.coverage.physical_pages_expected) ||
    new Set(ids).size !== ids.length || !same(ids, document.coverage.expected_block_ids) || !same(ids, document.coverage.processed_block_ids) ||
    document.fixture !== (document.evidence_kind === 'engineering_fixture')) throw new LocalParserError('invalid_document_ir');
  const validPages = new Set(document.pages.filter(p => p.status !== 'failed').map(p => p.physical_page));
  for (const [index, block] of blocks.entries()) {
    if (block.document_id !== document.document_id || block.text_version !== document.text_version || block.reading_order !== index ||
      !validPages.has(block.page)) throw new LocalParserError('invalid_document_ir');
    const raw = Array.from(block.raw_text), normalized = Array.from(block.text);
    if (block.source_glyph_issues?.some(g => g.start >= g.end || g.end > normalized.length)) throw new LocalParserError('invalid_source_glyph_issue');
    let rawEnd = 0, normalizedEnd = 0;
    for (const run of block.normalization_map) {
      const a = raw.slice(run.raw_start, run.raw_end).join(''), b = normalized.slice(run.normalized_start, run.normalized_end).join('');
      if (run.raw_start !== rawEnd || run.normalized_start !== normalizedEnd || run.raw_end <= run.raw_start || run.normalized_end <= run.normalized_start ||
        (run.kind === 'identity' ? a !== b || a.includes('\r') : !['\r', '\r\n'].includes(a) || b !== '\n')) throw new LocalParserError('invalid_document_ir');
      rawEnd = run.raw_end; normalizedEnd = run.normalized_end;
    }
    if (rawEnd !== raw.length || normalizedEnd !== normalized.length || block.raw_text.replace(/\r\n?/g, '\n') !== block.text) throw new LocalParserError('invalid_document_ir');
  }
  const units = new Map(document.structure.units.map(u => [u.unit_id, u]));
  if (units.size !== document.structure.units.length || document.structure.reading_order.some(id => !units.has(id)) ||
    document.structure.furniture_unit_ids.some(id => !units.has(id))) throw new LocalParserError('invalid_structure_reference');
  for (const unit of units.values()) {
    // Validate each explicit source segment independently. Native order is not raw PDF content-stream order.
    for (const segment of unit.source_segments) {
      try { resolveDocumentSegments(document, { document_id: document.document_id, text_version: document.text_version, segments: [segment], joiner: '' }); }
      catch { throw new LocalParserError('invalid_structure_source_segment'); }
    }
    for (const region of unit.source_regions ?? []) {
      if (region.provenance_index >= unit.provenance.length) throw new LocalParserError('invalid_structure_source_region');
      for (const segment of region.source_segments) {
        try { resolveDocumentSegments(document, { document_id: document.document_id, text_version: document.text_version, segments: [segment], joiner: '' }); }
        catch { throw new LocalParserError('invalid_structure_source_region'); }
      }
    }
  }
  for (const item of [...document.structure.tables, ...document.structure.pictures]) {
    if ([...item.caption_unit_ids, ...item.footnote_unit_ids].some(id => !units.has(id))) throw new LocalParserError('invalid_structure_reference');
  }
  if (document.structure.tables.some(table => table.cells.some(cell => !units.has(cell.unit_id)))) throw new LocalParserError('invalid_structure_reference');
  for (const table of document.structure.tables) {
    const cellIds = new Set(table.cells.map(c => c.unit_id));
    for (const header of table.source_layout?.header_paths ?? []) if ([header.cell_unit_id, ...header.parent_cell_unit_ids].some(id => !cellIds.has(id))) throw new LocalParserError('invalid_structure_table_header');
    for (const row of table.source_layout?.source_rows ?? []) for (const segment of row.source_segments) {
      try { resolveDocumentSegments(document, { document_id: document.document_id, text_version: document.text_version, segments: [segment], joiner: '' }); }
      catch { throw new LocalParserError('invalid_structure_table_row'); }
      if (document.blocks.find(b => b.block_id === segment.block_id)?.page !== row.physical_page) throw new LocalParserError('invalid_structure_table_row');
    }
    const grid = table.source_grid;
    if (grid && (grid.source_pdf_sha256 !== document.file_sha256 || grid.text_version !== document.text_version)) throw new LocalParserError('invalid_source_grid_version');
    if (grid && grid.status !== 'unresolved') {
      const cellIds = new Set(grid.cells.map(c => c.cell_id)), slots: string[] = [];
      if (cellIds.size !== grid.cells.length || grid.column_bounds.length !== grid.n_cols + 1 || grid.row_bounds.length !== grid.n_rows + 1) throw new LocalParserError('invalid_source_grid_dimensions');
      for (const cell of grid.cells) {
        if (!(0 <= cell.row_start && cell.row_start < cell.row_end && cell.row_end <= grid.n_rows && 0 <= cell.col_start && cell.col_start < cell.col_end && cell.col_end <= grid.n_cols) ||
          cell.row_span !== cell.row_end - cell.row_start || cell.col_span !== cell.col_end - cell.col_start ||
          cell.column_header_ids.some(id => !cellIds.has(id)) || cell.row_group_cell_id !== null && !cellIds.has(cell.row_group_cell_id)) throw new LocalParserError('invalid_source_grid_cell');
        for (let r = cell.row_start; r < cell.row_end; r++) for (let c = cell.col_start; c < cell.col_end; c++) slots.push(`${r},${c}`);
        for (const segment of cell.source_segments) {
          try { resolveDocumentSegments(document, { document_id: document.document_id, text_version: document.text_version, segments: [segment], joiner: '' }); }
          catch { throw new LocalParserError('invalid_source_grid_source'); }
          if (document.blocks.find(b => b.block_id === segment.block_id)?.page !== cell.physical_page) throw new LocalParserError('invalid_source_grid_source');
        }
      }
      if (slots.length !== new Set(slots).size || slots.length !== grid.n_rows * grid.n_cols) throw new LocalParserError('invalid_source_grid_coverage');
      if (grid.status === 'geometry_checked' && (grid.issue_codes.length || !grid.verification.all_cells_independently_checked || !grid.verification.grid_slots_covered_once ||
        grid.verification.raw_nonspace_codepoints !== grid.verification.covered_nonspace_codepoints || grid.cells.some(c => c.status === 'source_conflict'))) throw new LocalParserError('invalid_source_grid_verification');
      for (const segment of [...grid.caption_segments, ...grid.footnote_segments]) {
        try { resolveDocumentSegments(document, { document_id: document.document_id, text_version: document.text_version, segments: [segment], joiner: '' }); }
        catch { throw new LocalParserError('invalid_source_grid_source'); }
      }
      if (grid.caption_status === 'geometry_checked_numbered_title' && (!grid.caption_number || !grid.caption_segments.length)) throw new LocalParserError('invalid_source_table_title');
    }
  }
  for (const heading of document.structure.organization?.heading_paths ?? []) if (units.get(heading.unit_id)?.kind !== 'section_header' ||
    heading.parent_unit_id !== null && units.get(heading.parent_unit_id)?.kind !== 'section_header') throw new LocalParserError('invalid_structure_heading_path');
  for (const edge of document.structure.organization?.paragraph_continuations ?? []) if ([edge.from_unit_id, edge.to_unit_id].some(id => units.get(id)?.kind !== 'text')) throw new LocalParserError('invalid_structure_continuation');
  for (const edge of document.structure.organization?.continuation_recovery?.relations ?? []) if (!units.has(edge.from_unit_id) || !units.has(edge.to_unit_id) ||
    !same(edge.ordered_segments, [...units.get(edge.from_unit_id)!.source_segments, ...units.get(edge.to_unit_id)!.source_segments])) throw new LocalParserError('invalid_checked_continuation_source');
  const textPages = document.pages.filter(p => p.text_layer_present).map(p => p.physical_page);
  const noText = document.pages.filter(p => p.status !== 'failed' && !p.text_layer_present).map(p => p.physical_page);
  const images = document.pages.filter(p => p.bitmap_count).map(p => p.physical_page);
  const failed = document.pages.filter(p => p.status === 'failed').map(p => ({ physical_page: p.physical_page, code: p.error?.code }));
  const unmapped = document.structure.units.filter(u => ['unmapped', 'partial'].includes(u.mapping.status)).map(u => u.unit_id);
  const ambiguous = document.structure.units.filter(u => u.mapping.status === 'ambiguous').map(u => u.unit_id);
  const expectedStatus = !ids.length ? 'unsupported' : failed.length || noText.length || images.length ||
    document.coverage.native_errors.length || unmapped.length || ambiguous.length || blocks.some(b => b.source_glyph_issues?.length) || !same(document.coverage.native_pages, pages) ? 'partial' : 'parsed';
  if (!same(textPages, document.coverage.text_layer_pages) || !same(failed, document.coverage.failed_pages) ||
    !same(noText, document.coverage.pages_without_text) || !same(images, document.coverage.image_text_unverified_pages) ||
    !same([...validPages], document.coverage.decoded_pages) || !same(unmapped, document.coverage.unmapped_unit_ids) ||
    !same(ambiguous, document.coverage.ambiguous_unit_ids) || document.parser.status !== expectedStatus ||
    document.coverage.text_layer_decode_complete !== (textPages.length === pages.length)) throw new LocalParserError('invalid_document_coverage');
}

interface ProcessOptions { timeoutMs?: number; maxOutputBytes?: number; pythonExecutable?: string }
async function runLocalParser<T extends ParserResult | StructuredParserResult>(input: ParserRequest, script: string, args: string[],
  options: ProcessOptions, validate: (payload: unknown) => T, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new LocalParserError('parser_aborted');
  const expectedPath = await realpath(resolve(CODE, input.file_reference)).catch(() => undefined);
  if (signal?.aborted) throw new LocalParserError('parser_aborted');
  return new Promise((accept, reject) => {
    const child = spawn(options.pythonExecutable ?? join(CODE, '.venv/bin/python'), [script, ...args], {
      cwd: CODE, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...process.env, OMP_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '4', MKL_NUM_THREADS: '4', PYTHONUNBUFFERED: '1' },
    });
    let ended = false, bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: T) => {
      if (ended) return;
      ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* Child may have exited before the timeout/abort callback. */ }
        reject(error);
      } else accept(value!);
    };
    const abort = () => finish(new LocalParserError('parser_aborted'));
    const timer = setTimeout(() => finish(new LocalParserError('parser_timeout', true)), options.timeoutMs ?? 180_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 64 * 1024 * 1024)) finish(new LocalParserError('parser_output_limit'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {}); // Drain diagnostics without exposing PDF strings or host paths as API errors.
    child.on('error', () => finish(new LocalParserError('parser_process_unavailable')));
    child.on('close', (code) => {
      if (ended) return;
      try {
        const payload = validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (payload.run_id !== input.run_id) throw new LocalParserError('parser_run_mismatch');
        if (payload.document) {
          assertParsedDocument(payload.document);
          if (payload.document.document_id !== input.document_id || payload.document.file_sha256 !== input.file_sha256 ||
            payload.document.fixture !== Boolean(input.fixture)) throw new LocalParserError('parser_identity_mismatch');
          if (!expectedPath || resolve(CODE, payload.document.source.file_reference) !== expectedPath) throw new LocalParserError('parser_source_reference_mismatch');
          const expectedStatus = payload.document.parser.status === 'parsed' ? 'ok' : payload.document.parser.status;
          if (payload.status !== expectedStatus || payload.error) throw new LocalParserError('parser_status_mismatch');
        } else if (payload.status !== 'error' || !payload.error) throw new LocalParserError('parser_status_mismatch');
        const expectedCode = payload.status === 'ok' ? 0 : payload.status === 'error' ? 1 : 2;
        if (code !== expectedCode) throw new LocalParserError('parser_exit_status_mismatch');
        finish(undefined, payload);
      } catch (error) { finish(error instanceof LocalParserError ? error : new LocalParserError('invalid_parser_result')); }
    });
  });
}

/** Explicit local text-line baseline. No model-controlled CLI or filesystem tool is exposed. */
export class LocalPythonParserAdapter implements ParserAdapter {
  constructor(readonly options: ProcessOptions & { configRevision?: string } = {}) {}

  async parse(input: ParserRequest, signal?: AbortSignal): Promise<DocumentIRV2> {
    const result = await this.parseResult(input, signal);
    if (result.error || !result.document) throw new LocalParserError(result.error?.code ?? 'missing_parser_document', result.error?.retryable);
    return result.document;
  }

  async parseResult(input: ParserRequest, signal?: AbortSignal): Promise<ParserResult> {
    assertSchema(ParserRequestSchema, input);
    input = structuredClone(input);
    const args = ['parse', '--run-id', input.run_id, '--document-id', input.document_id,
      '--file-reference', input.file_reference, '--file-sha256', input.file_sha256,
      '--config-revision', this.options.configRevision ?? '1'];
    if (input.fixture) args.push('--fixture');
    return runLocalParser(input, 'services/pdf-parser/cli.py', args, this.options, payload => {
      assertSchema(ParserResultSchema, payload);
      if (payload.document) assertSchema(DocumentIRV2Schema, payload.document);
      return payload;
    }, signal);
  }
}

/** Model-free check of a historical IR against the identical PDF. Old IR bytes,
 * text versions and approvals are never rewritten. A changed decoder/line layout
 * requires re-parsing instead of guessing a new alignment for existing quotes. */
export async function auditLegacySourceGlyphs(document: Exclude<DocumentIR, { schema_version: '1' }>) {
  if (document.fixture) throw new LocalParserError('source_glyph_audit_requires_real_pdf');
  const checked = await new LocalPythonParserAdapter({ timeoutMs: 30_000 }).parse({
    run_id: 'local-source-glyph-audit', document_id: document.document_id,
    file_reference: document.source.file_reference, file_sha256: document.file_sha256, fixture: false,
  });
  if (checked.parser.config.font_glyph_guard_version !== 'sparse-embedded-font-no-unicode-1' ||
    checked.blocks.length !== document.blocks.length || checked.pages.length !== document.pages.length || checked.coverage.failed_pages.length)
    throw new LocalParserError('source_glyph_audit_alignment_failed');
  const source = new Map(checked.blocks.map(b => [b.page + ':' + b.backend_cell_index, b]));
  const copy = structuredClone(document);
  for (const block of copy.blocks) {
    const fresh = source.get(block.page + ':' + block.backend_cell_index);
    if (!fresh || fresh.raw_text !== block.raw_text || fresh.text !== block.text ||
      fresh.bbox.some((v, i) => Math.abs(v - block.bbox[i]!) > 1e-6)) throw new LocalParserError('source_glyph_audit_alignment_failed');
    if (fresh.source_glyph_issues?.length) block.source_glyph_issues = structuredClone(fresh.source_glyph_issues);
  }
  copy.parser.config = { ...copy.parser.config, font_glyph_guard_version: checked.parser.config.font_glyph_guard_version,
    font_glyph_guard_sha256: checked.parser.config.font_glyph_guard_sha256 };
  const audit = { schema_version: 'source-font-glyph-audit-1', document_id: document.document_id,
    file_sha256: document.file_sha256, historical_text_version: document.text_version,
    guard_version: checked.parser.config.font_glyph_guard_version, guard_sha256: checked.parser.config.font_glyph_guard_sha256,
    compared_source_blocks: copy.blocks.length, original_ir_rewritten: false, model_calls: 0,
    all_font_encoding_errors_detected: false, source_page_review_still_required: true,
    uncertain_source_spans: copy.blocks.flatMap(b => (b.source_glyph_issues ?? []).map(issue => ({ block_id: b.block_id, ...issue }))) };
  return { document: copy, audit };
}

/** Explicit backend primitive; createConfiguredPdfParserAdapter applies the trusted formal selection. */
export class LocalStructuredPythonParserAdapter implements ParserAdapter {
  constructor(readonly options: ProcessOptions & { candidateId: ParserCandidateId; logDirectory?: string }) {
    assertSchema(ParserCandidateSchema, options.candidateId);
  }
  async parse(input: ParserRequest, signal?: AbortSignal): Promise<StructuredDocumentIR> {
    const result = await this.parseResult(input, signal);
    if (result.error || !result.document) throw new LocalParserError(result.error?.code ?? 'missing_parser_document', result.error?.retryable);
    return result.document;
  }
  async parseResult(input: ParserRequest, signal?: AbortSignal): Promise<StructuredParserResult> {
    assertSchema(ParserRequestSchema, input); input = structuredClone(input);
    const request = { ...input, candidate_id: this.options.candidateId };
    assertSchema(StructuredParserRequestSchema, request);
    const args = ['parse', '--candidate-id', request.candidate_id, '--run-id', request.run_id, '--document-id', request.document_id,
      '--file-reference', request.file_reference, '--file-sha256', request.file_sha256];
    if (request.fixture) args.push('--fixture');
    if (this.options.logDirectory) args.push('--log-directory', this.options.logDirectory);
    return runLocalParser(input, 'services/pdf-parser/structured-cli.py', args, { timeoutMs: 600_000, ...this.options }, payload => {
      assertSchema(StructuredParserResultSchema, payload);
      if (payload.document?.parser.id !== undefined && payload.document.parser.id !== request.candidate_id) throw new LocalParserError('parser_candidate_mismatch');
      return payload;
    }, signal);
  }
}
