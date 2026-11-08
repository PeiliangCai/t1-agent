/** Recheck freshly prepared real PDFs through current Pi tools on loopback only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FigureAssetCatalog, RunInput, EvidenceCatalog } from '@t1/contracts';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { buildSourceEvidenceUnits } from '../packages/agent/src/source-evidence-units.js';
import { planPaperMethods } from '../packages/agent/src/method-comparison.js';
import { runExtractionDocument } from '../packages/agent/src/extraction-run.js';
import { ExtractionStore } from '../packages/agent/src/extraction-store.js';
import { ExtractionBudget } from '../packages/agent/src/extraction-budget.js';
import { developmentProfile } from '../packages/agent/src/extraction-pi.js';
import { exportEvidenceDelivery, assertFigureCatalog } from '../packages/agent/src/evidence-delivery.js';
import { comparisonCompletion } from './audit-method-comparison.js';
import { createRuntimeResponsesFixture, type ResponsesStep } from '../tests/extraction/fixtures/runtime-responses.js';

const root = 'docs/acceptance/s0-s4-recheck-2026-11-08';
const frozen = 'docs/acceptance/pdf-structure-review-2026-11-07';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
type Document = Awaited<ReturnType<typeof json>>;
function differences(a: any, b: any, path = ''): Array<{ path: string; before: unknown; after: unknown }> {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return [{ path, before: a, after: b }];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => differences(a[k], b[k], path + '/' + k));
}
function canonical(document: Document, value: unknown): any {
  const ids = new Map<string, string>(document.structure.units.map((u: any) => [u.unit_id, u.native_ref]));
  for (const t of document.structure.tables) {
    const g = t.source_grid; if (!g) continue;
    ids.set(g.grid_id, t.native_ref + '/source_grid');
    for (const c of g.cells ?? []) ids.set(c.cell_id, t.native_ref + `/source_cell/${c.row_start}/${c.col_start}`);
  }
  const walk = (v: any): any => {
    if (v === document.text_version) return '<bound_text_version>';
    if (typeof v === 'string') return ids.get(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}
function packets(value: any): any[] {
  if (typeof value === 'string') { try { return packets(JSON.parse(value)); } catch { return []; } }
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(packets)];
}
const catalog: EvidenceCatalog = { catalog_version: 'medical-unavailable-1', status: 'unavailable', fixture: false,
  cancers: [], image_types: [], features: [], bindings: [] };
const results: any[] = [];
for (const sourceId of ['L01', 'L05', 'L07']) {
  const folder = join(root, 'production', sourceId), parsed = await json(join(folder, 'parser-result.json'));
  const document = parsed.document; assertParsedDocument(document); assert.equal(document.fixture, false);
  const old = (await json(join(frozen, 'derived', sourceId, 'parser-result.json'))).document;
  const sourceBytes = await readFile(document.source.file_reference); assert.equal(sha(sourceBytes), document.file_sha256);
  const stripVersion = (d: Document) => d.blocks.map(({ text_version: _version, ...b }: any) => b);
  assert.deepEqual(stripVersion(document), stripVersion(old), sourceId + ': every original raw anchor except the new version');
  const configDiff = differences(old.parser.config, document.parser.config);
  assert.ok(configDiff.every(d => ['/auxiliary_module_sha256/source_tables.py', '/auxiliary_module_sha256/source_geometry.py',
    '/source_geometry/rule_geometry'].includes(d.path)), sourceId + ': only recorded literal-span/rule-geometry helpers change');
  assert.deepEqual(document.parser.config.native_config, old.parser.config.native_config);
  const nativeDiff = differences(await json(old.native_artifact.path), await json(document.native_artifact.path));
  assert.ok(nativeDiff.every(d => /\/pictures\/\d+\/prov\/\d+\/bbox\/[lr]$/.test(d.path) &&
    typeof d.before === 'number' && typeof d.after === 'number' && Math.abs(d.before - d.after) < 0.001));
  const gridChecks = document.structure.tables.map((t: any) => {
    const prior = old.structure.tables.find((v: any) => v.native_ref === t.native_ref);
    if (sourceId === 'L01' && t.native_ref === '#/tables/0') {
      assert.equal(prior.source_grid.status, 'source_conflict'); assert.equal(t.source_grid.status, 'geometry_checked');
      const data = (d: Document, g: any) => g.cells.filter((c: any) => c.row_start >= g.header_rows).map((c: any) =>
        canonical(d, { row: [c.row_start, c.row_end], column: [c.col_start, c.col_end], source_segments: c.source_segments, status: c.status, bbox: c.bbox }));
      const outsideRecoveredSpans = (v: any) => !(v.row[0] >= 5 && (v.column[0] >= 2 && v.column[1] <= 4 || v.column[0] >= 5 && v.column[1] <= 8));
      assert.deepEqual(data(document, t.source_grid).filter(outsideRecoveredSpans), data(old, prior.source_grid).filter(outsideRecoveredSpans),
        'ordinary separate data values retain their literal slots');
      const literal = (c: any) => c.source_segments.map((s: any) => document.blocks.find((b: any) => b.block_id === s.block_id).text.slice(s.start, s.end)).join('');
      for (const [row, col, end, value] of [[5, 2, 4, '0.266'], [5, 5, 8, '5.256'], [6, 2, 4, '0.606'], [6, 5, 8, '0.072']]) {
        const c = t.source_grid.cells.find((c: any) => c.row_start === row && c.col_start === col);
        assert.equal(literal(c), value); assert.equal(c.col_end, end); assert.equal(c.column_header_ids.length, 1);
        const parent = t.source_grid.cells.find((h: any) => h.cell_id === c.column_header_ids[0]);
        assert.deepEqual([parent.col_start, parent.col_end], [col, end]);
      }
    } else {
      const { method: _currentMethod, ...currentGrid } = canonical(document, t.source_grid);
      const { method: _priorMethod, ...priorGrid } = canonical(old, prior.source_grid);
      assert.deepEqual(currentGrid, priorGrid, sourceId + ': all other source grid content remains equivalent');
    }
    return { native_ref: t.native_ref, physical_page: t.source_grid.physical_page, status: t.source_grid.status,
      rows: t.source_grid.n_rows, columns: t.source_grid.n_cols, issue_codes: t.source_grid.issue_codes,
      raw_characters: t.source_grid.verification?.raw_nonspace_codepoints,
      covered_characters: t.source_grid.verification?.covered_nonspace_codepoints,
      helper_method: t.source_grid.method, prior_status: prior.source_grid.status };
  });
  const edges = document.structure.organization.continuation_recovery.relations;
  const edgeContent = (d: Document) => d.structure.organization.continuation_recovery.relations.map((e: any) => ({
    from: d.structure.units.find((u: any) => u.unit_id === e.from_unit_id).native_ref,
    to: d.structure.units.find((u: any) => u.unit_id === e.to_unit_id).native_ref,
    source_type: e.source_type, status: e.status, ordered_segments: canonical(d, e.ordered_segments) }));
  assert.deepEqual(edgeContent(document), edgeContent(old), sourceId + ': checked literal continuation relationships');
  const figures = await json(join(folder, 'figure-assets/catalog.json')) as FigureAssetCatalog;
  assertFigureCatalog(document, figures);
  const oldFigures = await json(join(frozen, 'figures', sourceId, 'figure-assets/catalog.json')) as FigureAssetCatalog;
  const figureChecks = figures.figures.filter(f => f.figure_number !== null).map(f => {
    const previous = oldFigures.figures.find(p => p.figure_number === f.figure_number)!;
    assert.ok(previous); assert.deepEqual(canonical(document, f.caption_segments), canonical(old, previous.caption_segments));
    assert.deepEqual(f.regions.map(r => r.sha256), previous.regions.map(r => r.sha256));
    return { figure_number: f.figure_number, original_PNG_SHA256: f.regions.map(r => r.sha256),
      caption_literal_spans_equal_except_bound_version: true, regions: f.regions.length, verification: f.verification.status,
      source_versions_equal: document.text_version === old.text_version, prior_user_feedback_inherited: false };
  });
  const checkedTableCells = new Set(document.structure.tables.filter((t: any) => t.source_grid?.status === 'geometry_checked').flatMap((t: any) => t.cells.map((c: any) => c.unit_id)));
  const mappingLimits = document.structure.units.filter((u: any) => ['partial', 'unmapped', 'ambiguous'].includes(u.mapping.status)).map((u: any) => ({
    native_ref: u.native_ref, kind: u.kind, status: u.mapping.status, text_preview: u.native_text.slice(0, 120),
    pages: [...new Set(u.provenance.map((p: any) => p.physical_page))],
    superseded_by_independently_checked_source_grid: checkedTableCells.has(u.unit_id) }));
  const preparation = await json(join(folder, 'prepared.json'));
  const methods = planPaperMethods(document, { source: preparation.current_source_preparation ?? 'fresh default CLI, no source substitution' }, { maxCodePoints: 8500, maxBlocks: 128, contextBlocks: 6 });
  const runs: any[] = [];
  let sharedFigures: FigureAssetCatalog | undefined;
  for (const job of methods.jobs) {
    const runDirectory = join(folder, 'loopback-' + job.condition); await mkdir(runDirectory);
    const allowed = new Set(job.selection.entries.filter(e => e.article_eligible && e.state !== 'excluded').map(e => e.block_id));
    const summaryIds = [...new Set([...edges.flatMap((e: any) => e.ordered_segments.map((s: any) => s.block_id)),
      ...document.structure.tables.flatMap((t: any) => t.source_grid?.caption_segments?.map((s: any) => s.block_id) ?? []),
      ...document.structure.tables.flatMap((t: any) => t.source_grid?.cells.filter((c: any) =>
        c.span_basis === 'literal_value_centered_under_printed_parent_group_no_vertical_divider').flatMap((c: any) => c.source_segments.map((s: any) => s.block_id)) ?? []),
      job.selection.kept_block_ids[0]!])].filter((id): id is string => typeof id === 'string' && allowed.has(id)).slice(0, 128);
    const steps: ResponsesStep[] = job.batches.flatMap(() => [
      { calls: [{ name: 'read_document_blocks', arguments: {} }] },
      { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] },
    ]);
    steps.push({ calls: [{ name: 'get_document_context', arguments: {} }, { name: 'read_document_blocks',
      arguments: { line_indices: summaryIds.map(id => document.blocks.findIndex((b: any) => b.block_id === id)) } }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { summary: 'Loopback protocol transport only; no model extraction or medical judgment.',
      reviews: [], links: [], updates: [], summary_complete: true } }] });
    const server = await createRuntimeResponsesFixture(steps), store = new ExtractionStore(':memory:');
    const input: RunInput = { schema_version: '1', run_id: `fresh-${sourceId}-${job.condition}`, document_id: sourceId, file_sha256: document.file_sha256,
      fixture: false, scope: { scope_version: '1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] },
        features: { mode: 'all', binding_ids: [] }, catalog_version: catalog.catalog_version, matching_policy_version: 'exact-explicit-synonyms-1' },
      rule_version: 'engineering-loopback-current-production-1', runtime_profile: { provider: server.config.provider, model_id: server.config.modelId,
        endpoint: server.endpoint, pi_version: '1.4.0', version: 'local-synthetic-transport' } };
    try {
      const result = await runExtractionDocument({ input, document, catalog, metadata: { task_id: input.run_id,
        article_family_id: 'file-sha256-' + document.file_sha256, created_at: new Date().toISOString(),
        source_version: { file_sha256: document.file_sha256, source_kind: 'real_development_PDF_local_transport_only', version: document.file_sha256,
          obtained_at: new Date().toISOString() } }, profile: developmentProfile(server.config.modelId), config: server.config,
        budget: new ExtractionBudget(join(runDirectory, 'local-synthetic-ledger.json'), server.endpoint), store, directory: join(runDirectory, 'extraction'),
        strategy: 'baseline', ...(job.condition === 'F' ? { sourceSelectionCondition: 'F' as const, figureCatalog: sharedFigures } : {}) });
      assert.equal(result.error, undefined); assert.equal(result.task_processing_complete, true);
      assert.equal(result.coverage.whole_document_summary_complete, true); assert.equal(result.coverage.source_text_layer_decode_complete, true);
      assert.equal(result.coverage.task_scope_source_blocks, methods.article.included_block_ids.length - job.selection.excluded_block_ids.length);
      assert.ok(result.coverage.unprocessed_source_block_ids.every(id => !job.selection.excluded_block_ids.includes(id)));
      assert.deepEqual(result.coverage.f_unselected_source_block_ids, job.condition === 'F' ? job.selection.deferred_block_ids : []);
      const visibleIds = new Set<string>(), visibleUnits = new Set<string>(), visibleGrids = new Set<string>();
      for (const [index, batch] of job.batches.entries()) {
        const ids = [...new Set([...batch.assigned_block_ids, ...batch.context_block_ids])];
        const p = server.requests[index * 2 + 1]!.tool_results.flatMap(r => packets(r.output)).find(p => Array.isArray(p.source_lines));
        assert.ok(p, 'actual next Pi request contains the exact source tool result');
        for (const line of p.source_lines) { const id = ids[line.line_index]!; assert.ok(allowed.has(id));
          assert.equal(line.text, document.blocks.find((b: any) => b.block_id === id)!.text); visibleIds.add(id); }
        for (const u of p.source_units ?? []) visibleUnits.add(u.unit_id);
        for (const t of p.document_structure?.tables ?? []) if (t.active_grid) visibleGrids.add(t.active_grid.grid_id);
      }
      assert.ok(job.selection.kept_block_ids.every(id => visibleIds.has(id)));
      const allToolPackets = server.requests.flatMap(r => r.tool_results.flatMap(t => packets(t.output)));
      const spanChecks = document.structure.tables.flatMap((t: any) => t.source_grid.cells.filter((c: any) =>
        c.span_basis === 'literal_value_centered_under_printed_parent_group_no_vertical_divider').map((c: any) => {
        const actual = allToolPackets.flatMap(p => p.document_structure?.tables ?? []).flatMap((p: any) => p.cells ?? []).find((cell: any) => cell[0] === c.cell_id);
        assert.ok(actual, 'corrected complete literal cell reaches actual Pi tool text, including legal summary reread');
        assert.deepEqual(actual[2], [c.col_start, c.col_end]); assert.deepEqual(actual[7], c.column_header_ids);
        return { cell_id: c.cell_id, columns: actual[2], parent_header_ids: actual[7], actual_Pi_tool_text_verified: true };
      }));
      const sourceUnits = buildSourceEvidenceUnits(document);
      const bridgeChecks = edges.map((edge: any) => {
        const from = document.structure.units.find((u: any) => u.unit_id === edge.from_unit_id).source_segments.at(-1);
        const to = document.structure.units.find((u: any) => u.unit_id === edge.to_unit_id).source_segments[0];
        const bridges = sourceUnits.filter(u => u.segments.some(s => s.block_id === from.block_id && s.end === from.end) &&
          u.segments.some(s => s.block_id === to.block_id && s.start === to.start));
        assert.ok(bridges.length > 0 && bridges.every(u => visibleUnits.has(u.unit_id)), 'checked continuation reaches the actual source payload');
        return { from_native_ref: document.structure.units.find((u: any) => u.unit_id === edge.from_unit_id).native_ref,
          to_native_ref: document.structure.units.find((u: any) => u.unit_id === edge.to_unit_id).native_ref,
          literal_bridge_units: bridges.map(u => u.unit_id), available_in_actual_batch_payload: bridges.every(u => visibleUnits.has(u.unit_id)) };
      });
      const discovered = job.condition === 'B0' ? await json(join(runDirectory, 'extraction/figure-assets/catalog.json')) : sharedFigures!;
      if (job.condition === 'B0') sharedFigures = discovered;
      assertFigureCatalog(document, discovered);
      assert.deepEqual(discovered.figures.map((f: any) => f.regions.map((r: any) => r.sha256)), figures.figures.map(f => f.regions.map(r => r.sha256)));
      const exported = join(runDirectory, 'candidate-export');
      await exportEvidenceDelivery(document, [], { codeRoot: process.cwd(), directory: exported, mode: 'candidates', catalog: discovered, coverage: result.coverage });
      const exportedCoverage = await json(join(exported, 'coverage.json')); assert.equal(exportedCoverage.task_processing_complete, true);
      const completion = comparisonCompletion(result); assert.equal(completion.task_processing_complete, true);
      runs.push({ condition: job.condition, source_selection_digest: job.selection.digest, source_rule_version: job.selection.rule_version,
        counts: job.selection.counts, code_points: job.selection.code_points, actual_selected_blocks: visibleIds.size,
        excluded_blocks_never_returned: true, bridge_checks: bridgeChecks, visible_source_grids: [...visibleGrids],
        complete_literal_span_checks: spanChecks,
        local_synthetic_requests_counted_in_budget: server.requests.length, real_model_requests: 0, paid_requests: 0,
        actual_serialized_request_UTF8_bytes: server.requests.map(r => Buffer.byteLength(JSON.stringify(r.body))),
        synthetic_usage_is_not_real_token_estimate: true, completion, legacy_state: result.state,
        selected_processing_complete: result.coverage.selected_source_block_processing_complete,
        summary_complete: result.coverage.whole_document_summary_complete, coverage: result.coverage,
        figure_discovery: result.figure_discovery, default_figure_assets_checked: true,
        result: join(runDirectory, 'extraction/result.json'), export_coverage: join(exported, 'coverage.json') });
    } finally { store.close(); await server.close(); }
  }
  results.push({ source_id: sourceId, fresh_preparation: join(folder, 'prepared.json'), current_source_preparation: preparation.current_source_preparation ?? 'fresh_default_adapter_CPU_parse_and_default_Figure_discovery', new_text_version: document.text_version,
    source_IR_sha256: sha(await readFile(join(folder, 'parser-result.json'))),
    frozen_text_version: old.text_version, source_versions_equal: document.text_version === old.text_version,
    source_PDF_SHA256: document.file_sha256, raw_anchors_except_version_equal: true, formal_native_configuration_equal: true,
    recorded_helper_configuration_differences: configDiff,
    native_differences: nativeDiff, grid_checks: gridChecks, checked_continuations: edgeContent(document), figure_checks: figureChecks,
    native_mapping_limitations: mappingLimits, unresolved_continuations: document.structure.organization.continuation_recovery.unresolved,
    prior_43_feedback_rebound_or_inherited: false, methods_equal_by_complete_model_input_fingerprint: methods.all_method_inputs_identical, runs });
  process.stdout.write(JSON.stringify({ source_id: sourceId, new_text_version: document.text_version, native_differences: nativeDiff.length,
    runs: runs.map(r => ({ condition: r.condition, task_complete: r.completion.task_processing_complete, summary_complete: r.summary_complete,
      selected: r.counts.kept, deferred: r.counts.deferred, synthetic_requests: r.local_synthetic_requests_counted_in_budget })) }) + '\n');
}
const reportPath = join(root, 'report.json');
let report: any = {}; try { report = await json(reportPath); } catch { /* first audited section */ }
report.schema_version = 's0-s4-current-recheck-1'; report.status = 'current_production_chain_verified_final_stage_checks_pending';
report.production_chain = { real_PDFs: 3, current_source_preparation: 'L01 fresh default adapter CPU parse; L05/L07 current helper rebuild from this rounds real CPU native and exact raw anchors, source/PDF SHA rechecked', reused_frozen_IR_instead_of_parsing: false,
  model_substitute: 'Installed Pi SDK with scripted Responses SSE on 127.0.0.1 only; empty candidate output is a transport fixture, not an extraction result.',
  real_model_calls: 0, paid_calls: 0, papers: results };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
