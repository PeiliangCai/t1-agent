import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { StructuredDocumentIR, EvidenceValidationContext } from '@t1/contracts';
import { assertParsedDocument } from '../../packages/agent/src/parser.js';
import { buildArticleScope } from '../../packages/agent/src/article-scope.js';
import { buildSourceEvidenceUnits, addSourceStatementContext, groupEvidenceFragments, classifySourceSpan } from '../../packages/agent/src/source-evidence-units.js';
import { buildDocumentStructureContext, checkedTableSourceContains } from '../../packages/agent/src/document-structure-context.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { VISUAL_STATEMENT_POLICY_VERSION, visualStatementIssues } from '../../packages/agent/src/visual-evidence-policy.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

const documents = new Map<string, StructuredDocumentIR>();
function recovered(id: string): StructuredDocumentIR {
  if (documents.has(id)) return documents.get(id)!;
  const script = `import sys,json,importlib.util\nfrom pathlib import Path\nsys.path.insert(0,'services/pdf-parser')\nfrom structured import build_ir\nspec=importlib.util.spec_from_file_location('r','scripts/diagnose-pdf-input-quality.py')\nr=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)\nd=json.loads(Path('docs/acceptance/pdf-input-quality-2026-11-07/derived/${id}/parser-result.json').read_text())['document']\nprint(json.dumps(build_ir(r.retained_source(d),json.loads((Path(d['native_artifact']['path'])).read_text()),d['parser']['id'],d['metrics']['native_metrics'],d['coverage']['native_errors'],d['native_artifact']),ensure_ascii=False))`;
  const doc = JSON.parse(execFileSync('.venv/bin/python', ['-c', script], { maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })) as StructuredDocumentIR;
  assertParsedDocument(doc); documents.set(id, doc); return doc;
}
function context(document: StructuredDocumentIR) {
  const f = makeEvidenceFixture();
  const input = { ...f.input, document_id: document.document_id, file_sha256: document.file_sha256, fixture: false };
  const metadata = { ...f.context.metadata, source_version: { ...f.context.metadata.source_version, file_sha256: document.file_sha256,
    version: 'sha256:' + document.file_sha256 } };
  const context: EvidenceValidationContext = { ...f.context, document, input, metadata, allowedBlockIds: document.blocks.map(b => b.block_id),
    readBlockIds: [], evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
  const store = new ExtractionStore(':memory:'); store.create(input, metadata); store.transition(input.run_id, 'extracting');
  return { context, store, article: buildArticleScope(document) };
}

test('actual statement read/submit accepts exact whole-line Table4 support across checked cells, with semantics still pending', async () => {
  const doc = recovered('L05'), primary = doc.structure.units.find(u => u.native_ref === '#/texts/84')!, table = doc.structure.tables[3]!;
  assert.equal(table.source_grid?.status, 'geometry_checked');
  const support = doc.blocks.find(b => b.block_id.endsWith('p0007-l000136'))!; // The original last row contains five different value cells.
  const paragraph = [...new Set(primary.source_segments.map(s => s.block_id))];
  const ids = [...paragraph, ...new Set(table.caption_unit_ids.flatMap(id => doc.structure.units.find(u => u.unit_id === id)!.source_segments.map(s => s.block_id))), support.block_id];
  const c = context(doc);
  try {
    const tools = new ExtractionTools(c.context, { batch_id: 'source-grid-support', assigned_block_ids: ids, context_block_ids: [], physical_pages: [6, 7],
      source_code_points: 5000, order_basis: 'native_mapped_then_source_fallback', warnings: [] }, c.article, c.store, 'batch_lines');
    const definitions = tools.definitions(), read = definitions.find(t => t.name === 'read_document_blocks')!, submit = definitions.find(t => t.name === 'submit_candidate_records')!;
    const readResult = await read.execute('source-grid-read', {}, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
    const body = JSON.parse((readResult.content[0] as { text: string }).text);
    assert.equal(body.document_structure.tables.find((t: any) => t.table_id === table.table_id).active_grid.n_rows, 25);
    assert.ok(body.document_structure.tables.find((t: any) => t.table_id === table.table_id).cells.length > 0);
    const referenceIndices = paragraph.map(id => ids.indexOf(id)).filter(i => doc.blocks.find(b => b.block_id === ids[i])!.text.includes('Table 4'));
    assert.ok(referenceIndices.length);
    const record = { source_line_indices: paragraph.map(id => ids.indexOf(id)), feature_name_raw: null, feature_category: 'local mechanical citation test',
      evidence_type: 'association_conclusion', assertion: 'affirmed', origin: 'study_authors', supporting_table_evidence: [{ table_id: table.table_id,
        reference_line_indices: referenceIndices, line_indices: [ids.indexOf(support.block_id)] }] };
    const result = await submit.execute('checked-table-support', { records: [record], batch_complete: false }, undefined, undefined, {} as Parameters<typeof submit.execute>[4]);
    const submitted = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(submitted.rejected.length, 0, JSON.stringify(submitted)); assert.equal(c.store.current(c.context.input.run_id).length, 1);
    const saved = c.store.current(c.context.input.run_id)[0]!.record;
    assert.equal(saved.context.supporting_table_evidence![0]!.fragments[0]!.exact_quote, support.text);
    assert.equal(saved.review_status, 'needs_context'); // Citation mechanics do not approve this statistical statement as visual evidence.
    assert.ok(saved.evidence_validation.issues.some(i => i.code === 'visual_statement_purpose_requires_review'));
    assert.equal(saved.evidence_validation.medical_semantics_verified, false);
    for (const mode of ['wrong_table', 'body_row']) {
      const changed = structuredClone(record);
      if (mode === 'wrong_table') changed.supporting_table_evidence[0]!.table_id = doc.structure.tables[1]!.table_id;
      else changed.supporting_table_evidence[0]!.line_indices = [0];
      const bad = await submit.execute('bad-' + mode, { records: [changed], batch_complete: false }, undefined, undefined, {} as Parameters<typeof submit.execute>[4]);
      assert.match(JSON.stringify(bad), /supporting_table_(?:value_source_mismatch|explicit_reference_required)/);
    }
  } finally { c.store.close(); }
});

test('whole-line support membership covers only original checked-cell characters, never neighboring prose', () => {
  const doc = recovered('L05'), table = doc.structure.tables[3]!;
  const value = doc.blocks.find(b => b.block_id.endsWith('p0007-l000078'))!;
  assert.ok(value.text.includes('101 (27.2%) < 0.001* 0.180'));
  assert.equal(checkedTableSourceContains(doc, table, { block_id: value.block_id, text_version: doc.text_version, start: 0, end: Array.from(value.text).length }), true);
  const body = doc.blocks.find(b => b.page === 7 && b.text.startsWith('We focused'))!;
  assert.equal(checkedTableSourceContains(doc, table, { block_id: body.block_id, text_version: doc.text_version, start: 0, end: Array.from(body.text).length }), false);
});

test('Table3 actual read/submit uses its recovered numbered title and six columns while rejecting the old neighboring Figure title', async () => {
  const doc = recovered('L05'), table = doc.structure.tables[2]!, grid = table.source_grid!;
  assert.equal(grid.status, 'geometry_checked'); if (grid.status !== 'geometry_checked') throw new Error('expected_checked_grid');
  assert.equal(grid.n_cols, 6); assert.equal(grid.logical_header_rows, 1); assert.equal(table.association_status, 'conflict');
  const primary = doc.structure.units.find(u => u.native_ref === '#/texts/75')!, figure = doc.structure.units.find(u => u.unit_id === table.caption_unit_ids[0])!;
  const support = doc.blocks.find(b => b.page === 6 && b.text.includes('12.78') && b.text.includes('4.71'))!;
  const paragraph = [...new Set(primary.source_segments.map(s => s.block_id))], figureId = figure.source_segments[0]!.block_id;
  assert.ok(primary.native_text.includes('Table 3'));
  const ids = [...new Set([...paragraph, ...grid.caption_segments.map(s => s.block_id), support.block_id, figureId])];
  const c = context(doc);
  try {
    const tools = new ExtractionTools(c.context, { batch_id: 'table3-source-title', assigned_block_ids: ids, context_block_ids: [], physical_pages: [5, 6],
      source_code_points: 6000, order_basis: 'native_mapped_then_source_fallback', warnings: [] }, c.article, c.store, 'batch_lines');
    const read = tools.definitions().find(t => t.name === 'read_document_blocks')!, submit = tools.definitions().find(t => t.name === 'submit_candidate_records')!;
    const output = await read.execute('read-table3-title', {}, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
    const body = JSON.parse((output.content[0] as { text: string }).text), current = body.document_structure.tables.find((t: any) => t.table_id === table.table_id);
    assert.equal(body.source_unit_version, 'literal-source-sentences-4'); assert.equal(current.active_grid.n_cols, 6); assert.equal(current.active_grid.logical_header_rows, 1);
    assert.equal(current.active_caption_number, '3'); assert.equal(current.association_status, 'source_geometry_checked'); assert.equal(current.native_caption_status, 'conflict');
    assert.ok(current.caption_units.every((u: any) => u.line_spans.every((s: number[]) => body.source_lines[s[0]!].text.startsWith('Table 3') ||
      body.source_lines[s[0]!].text.startsWith('multivariate') || body.source_lines[s[0]!].text.startsWith('group 1'))));
    const summary = body.supporting_tables.find((t: any) => t.table_id === table.table_id);
    assert.deepEqual(summary.caption_unit_ids, []); assert.equal(summary.source_caption_number, '3'); assert.equal(summary.native_caption_status, 'conflict');
    assert.equal(classifySourceSpan(doc, figure.source_segments[0]!), 'figure_caption');
    assert.equal(classifySourceSpan(doc, grid.caption_segments[0]!), 'table_caption');
    const record = { source_line_indices: paragraph.map(id => ids.indexOf(id)), feature_name_raw: null, feature_category: 'mechanical Table3 citation test',
      evidence_type: 'association_conclusion', assertion: 'affirmed', origin: 'study_authors', supporting_table_evidence: [{ table_id: table.table_id,
        reference_line_indices: paragraph.map(id => ids.indexOf(id)).filter(i => doc.blocks.find(b => b.block_id === ids[i])!.text.includes('Table 3')),
        line_indices: [ids.indexOf(support.block_id)] }] };
    assert.ok(record.supporting_table_evidence[0]!.reference_line_indices.length);
    const valid = await submit.execute('submit-table3-checked-title', { records: [record], batch_complete: false }, undefined, undefined, {} as Parameters<typeof submit.execute>[4]);
    assert.equal(JSON.parse((valid.content[0] as { text: string }).text).rejected.length, 0, JSON.stringify(valid));
    assert.equal(c.store.current(c.context.input.run_id)[0]!.record.context.supporting_table_evidence![0]!.fragments[0]!.exact_quote, support.text);
    for (const mode of ['wrong_figure_reference', 'wrong_figure_value']) {
      const badRecord = structuredClone(record);
      if (mode === 'wrong_figure_reference') { badRecord.source_line_indices = [ids.indexOf(figureId)]; badRecord.supporting_table_evidence[0]!.reference_line_indices = [ids.indexOf(figureId)]; }
      else badRecord.supporting_table_evidence[0]!.line_indices = [ids.indexOf(figureId)];
      const bad = await submit.execute(mode, { records: [badRecord], batch_complete: false }, undefined, undefined, {} as Parameters<typeof submit.execute>[4]);
      assert.match(JSON.stringify(bad), mode === 'wrong_figure_reference' ? /supporting_table_explicit_reference_required/ : /supporting_table_value_source_mismatch/);
    }
    const unresolved = structuredClone(doc), unresolvedGrid = unresolved.structure.tables[2]!.source_grid!;
    if (unresolvedGrid.status === 'unresolved') throw new Error('expected_grid');
    unresolvedGrid.caption_status = 'unresolved'; unresolvedGrid.caption_number = null; unresolvedGrid.caption_segments = [];
    assert.ok(visualStatementIssues(unresolved, { evidence_type: 'association_conclusion' }, [], [], [], [{ table_id: table.table_id, reference_evidence: [], fragments: [] }])
      .some(i => i.code === 'supporting_table_caption_conflict'));
  } finally { c.store.close(); }
});

test('checked L01 source continuation yields the full original cross-page sentence and context reread requirements', () => {
  const doc = recovered('L01'), units = buildSourceEvidenceUnits(doc);
  const statement = units.find(u => u.segments.some(s => s.exact_quote.endsWith('药物过')) && u.segments.some(s => s.exact_quote.startsWith('敏')))!;
  assert.ok(statement); assert.equal(statement.completeness, 'complete'); assert.equal(statement.kind, 'sentence');
  assert.deepEqual([...new Set(statement.segments.map(s => s.physical_page))], [1, 2]);
  assert.ok(statement.segments.some(s => s.exact_quote.includes('（11）其他原发性恶性肿瘤')));
  assert.ok(statement.segments.some(s => s.exact_quote.endsWith('药物过'))); assert.ok(statement.segments.some(s => s.exact_quote.startsWith('敏')));
  const groups = groupEvidenceFragments(doc, statement.segments, units); assert.equal(groups.length, 1); assert.equal(groups[0]!.completeness, 'complete');
  const first = statement.segments[0]!.block_id;
  const batch = addSourceStatementContext(doc, [{ assigned_block_ids: [first], context_block_ids: [] as string[], warnings: [] as string[] }], doc.blocks.map(b => b.block_id))[0]!;
  assert.deepEqual(batch.assigned_block_ids, [first]); assert.ok(statement.segments.every(s => s.block_id === first || batch.context_block_ids.includes(s.block_id)));
  const packet = buildDocumentStructureContext(doc, [first]);
  if (!packet.available) throw new Error('missing_structure');
  assert.ok(packet.checked_continuations.some(c => !c.complete_relation_in_window && c.required_line_indices.length > 0));
});

test('checked L07 captions/body keep hyphens and separate physical provenance while complete source units span the boundary', () => {
  const doc = recovered('L07'), units = buildSourceEvidenceUnits(doc);
  for (const [left, right, type] of [['pos-', 'teriorly', 'figure_caption'], ['moni-', 'tored', 'body']] as const) {
    const statement = units.find(u => u.segments.some(s => s.exact_quote.endsWith(left)) && u.segments.some(s => s.exact_quote.startsWith(right)))!;
    assert.ok(statement, left); assert.equal(statement.completeness, 'complete'); assert.equal(statement.source_type, type);
    assert.ok(statement.segments.length >= 2); assert.ok(statement.structure_unit_ids.length >= 2);
  }
});
