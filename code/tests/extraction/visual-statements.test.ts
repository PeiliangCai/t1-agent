import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import type { EvidenceSubmission, LocatedEvidenceFragment, StructureUnit, EvidenceValidationContext } from '@t1/contracts';
import { buildSourceEvidenceUnits, groupEvidenceFragments, addSourceStatementContext, SOURCE_EVIDENCE_UNIT_VERSION } from '../../packages/agent/src/source-evidence-units.js';
import { expandBatchLineEvidence, type StatementEvidence } from '../../packages/agent/src/extraction-protocol.js';
import { validateEvidenceSubmission, locateEvidenceFragment } from '../../packages/agent/src/evidence-validation.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../../packages/agent/src/visual-evidence-policy.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { buildArticleScope, planExtractionBatches } from '../../packages/agent/src/article-scope.js';
import { buildEvidenceDelivery, exportEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

function mapped(f: ReturnType<typeof makeEvidenceFixture>, indices: number[], kind: StructureUnit['kind'] = 'text', id = 'mapped-text'): StructureUnit {
  const u: StructureUnit = { unit_id: id, native_ref: '#/test/' + id, kind, native_label: kind,
    native_text: 'Processed native text is deliberately unrelated; never quoted.', native_original_text: null,
    native_text_role: 'processed_native_not_literal_quote', content_layer: 'body',
    source_segments: indices.map(i => ({ block_id: f.document.blocks[i]!.block_id, text_version: f.document.text_version,
      start: 0, end: Array.from(f.document.blocks[i]!.text).length })), provenance: [],
    mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_3', matched_native_code_points: 1,
      alignable_native_code_points: 1, transformations: [], warnings: [] } };
  f.document.structure.units.push(u); f.document.structure.reading_order.push(id); return u;
}
function binding(f: ReturnType<typeof makeEvidenceFixture>) { return f.submission.binding; }
const candidate = (extra: Partial<StatementEvidence> = {}): StatementEvidence => ({ feature_name_raw: null, feature_category: 'synthetic-visual-description',
  evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors', ...extra });
function current(f: ReturnType<typeof makeEvidenceFixture>): EvidenceValidationContext { return { ...f.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION }; }
function tableFixture() {
  const f = makeEvidenceFixture(['CT shows a round 5 mm nodule (Table 2).', 'Table 2 Nodule measurements', '4.2 ± 1.1 mm']);
  mapped(f, [0]); mapped(f, [1], 'caption', 'table-caption'); mapped(f, [2], 'table_cell', 'table-cell');
  f.document.structure.tables.push({ table_id: 'table-2', native_ref: '#/tables/0', physical_pages: [1], caption_unit_ids: ['table-caption'],
    footnote_unit_ids: [], association_basis: 'native_explicit', n_rows: 1, n_cols: 1, cells: [{ unit_id: 'table-cell', row_start: 0, row_end: 1,
      col_start: 0, col_end: 1, row_span: 1, col_span: 1, column_header: false, row_header: false, row_section: false }],
    native_html: null, cross_page_continuation: 'not_assumed', association_status: 'native_unverified' });
  return f;
}
function plainSubmission(f: ReturnType<typeof makeEvidenceFixture>, source: EvidenceSubmission['source_fragments']): EvidenceSubmission {
  return { ...f.submission, source_fragments: source, display_joiner: '\n', feature_name_raw: null, context_fragments: [],
    disease_or_lesion: { value: null, status: 'unknown', evidence: [] }, modality: { value: null, status: 'unknown', evidence: [] },
    assertion: { value: 'unknown', evidence: source, original_wording: source.map(s => s.exact_quote).join('\n') },
    provenance: { origin: 'study_authors', cited_references: [], evidence: source } };
}

test('new sentence selection keeps exact Unicode, numbers and units without unrelated next-sentence qualifiers', () => {
  const f = makeEvidenceFixture(['CT shows a 5 mm nodule 😀. No enhancement was seen at 7 s.']); mapped(f, [0]);
  const units = buildSourceEvidenceUnits(f.document); assert.equal(units.length, 2);
  const submission = expandBatchLineEvidence(candidate({ source_unit_ids: [units[0]!.unit_id],
    numeric_expressions: [{ original_text: '5 mm', unit_original: 'mm', line_indices: [0] }] }), f.document.blocks, binding(f), units);
  const r = validateEvidenceSubmission(submission, current(f));
  assert.equal(r.accepted, true, JSON.stringify(r.issues));
  assert.equal(r.record!.original_quote, 'CT shows a 5 mm nodule 😀.');
  assert.equal(r.record!.quote_span.segments[0]!.end, Array.from('CT shows a 5 mm nodule 😀.').length);
  assert.equal(r.record!.numeric_expressions[0]!.unit_original, 'mm');
  assert.ok(!r.issues.some(i => i.code === 'source_qualifier_or_number_omitted'));
  assert.ok(!r.record!.context.fragments.some(f => f.exact_quote.includes('7 s')));
  assert.equal(r.record!.context.before, ''); assert.equal(r.record!.context.after, '');
  assert.equal(r.record!.extraction_trace.evidence_policy_version, VISUAL_STATEMENT_POLICY_VERSION);
  assert.equal(r.record!.extraction_trace.source_evidence_unit_version, SOURCE_EVIDENCE_UNIT_VERSION);
  const delivered = buildEvidenceDelivery(f.document, [{ record: r.record!, version: 1, actor: 'automatic' }]);
  assert.equal(delivered.records[0]!.original_fragments[0]!.exact_quote, 'CT shows a 5 mm nodule 😀.');
  // Historical validation keeps its historical whole-line omission behavior.
  assert.equal(validateEvidenceSubmission(submission, f.context).accepted, false);
});

test('necessary patient context uses its complete sentence unit and preserves the disease/source evidence', () => {
  const f = makeEvidenceFixture(['The patient had lung', 'cancer. CT shows a round nodule.']); mapped(f, [0, 1]);
  const units = buildSourceEvidenceUnits(f.document);
  const good = expandBatchLineEvidence(candidate({ source_unit_ids: [units[1]!.unit_id], context_unit_ids: [units[0]!.unit_id],
    disease_or_lesion: { value: 'cancer', line_indices: [1] } }), f.document.blocks, binding(f), units);
  const r = validateEvidenceSubmission(good, current(f));
  assert.equal(r.accepted, true, JSON.stringify(r.issues));
  assert.equal(r.record!.disease_or_lesion.value, 'cancer');
  assert.match(r.record!.context.fragments.map(f => f.exact_quote).join('\n'), /The patient had lung\ncancer\./u);
  const bad = expandBatchLineEvidence(candidate({ source_unit_ids: [units[1]!.unit_id], context_line_indices: [0] }), f.document.blocks, binding(f), units);
  assert.ok(validateEvidenceSubmission(bad, current(f)).issues.some(i => i.code === 'incomplete_context_statement' && i.severity === 'reject'));
});

test('cross-line missing negation is rejected; complete source unit preserves its literal qualifier', () => {
  const f = makeEvidenceFixture(['No', 'spiculation is visible on CT.']); mapped(f, [0, 1]);
  const units = buildSourceEvidenceUnits(f.document); assert.equal(units.length, 1);
  const partial = expandBatchLineEvidence(candidate({ source_line_indices: [1] }), f.document.blocks, binding(f));
  const bad = validateEvidenceSubmission(partial, current(f));
  assert.equal(bad.accepted, false); assert.ok(bad.issues.some(i => i.code === 'incomplete_source_statement'));
  const full = expandBatchLineEvidence(candidate({ source_unit_ids: [units[0]!.unit_id], assertion: 'negated' }), f.document.blocks, binding(f), units);
  const good = validateEvidenceSubmission(full, current(f));
  assert.equal(good.accepted, true, JSON.stringify(good.issues));
  assert.equal(good.record!.original_quote, 'No\nspiculation is visible on CT.');
});

test('uncertain native mapping retains the historical numeric/negation omission guard', () => {
  const f = makeEvidenceFixture(['No spiculation was seen in the 9 mm nodule.']);
  const clipped = plainSubmission(f, [{ block_id: f.document.blocks[0]!.block_id, exact_quote: 'spiculation was seen' }]);
  const r = validateEvidenceSubmission(clipped, current(f));
  assert.equal(r.accepted, false); assert.ok(r.issues.some(i => i.code === 'source_qualifier_or_number_omitted'));
});

test('geometry, pages, different native units and explicit case identities never become one sentence', () => {
  for (const mode of ['column', 'page', 'case', 'native-unit'] as const) {
    const f = makeEvidenceFixture(mode === 'case' ? ['Case 1 has a round', 'Case 2 has a spiculated nodule.'] : ['CT shows a round', 'nodule.']);
    if (mode === 'native-unit') { mapped(f, [0]); mapped(f, [1], 'text', 'second-unit'); }
    else mapped(f, [0, 1]);
    if (mode === 'column') f.document.blocks[1]!.bbox = [350, 10, 580, 25];
    if (mode === 'page') f.document.blocks[1]!.page = 2;
    const units = buildSourceEvidenceUnits(f.document);
    assert.ok(units.every(u => u.segments.length === 1), mode);
    const fragments = f.document.blocks.map(b => locateEvidenceFragment(f.document, { block_id: b.block_id, exact_quote: b.text }));
    assert.ok(groupEvidenceFragments(f.document, fragments, units).every(g => g.segments.length === 1), mode);
  }
});

test('new complete-sentence context adds missing source blocks without changing B0/F/R assignment inventory', () => {
  const f = makeEvidenceFixture(['CT shows no', 'spiculation.']); mapped(f, [0, 1]);
  const article = buildArticleScope(f.document), before = planExtractionBatches(f.document, article, { maxBlocks: 1, contextBlocks: 0 });
  const after = addSourceStatementContext(f.document, before, article.included_block_ids);
  assert.deepEqual(after.map(b => b.assigned_block_ids), before.map(b => b.assigned_block_ids));
  assert.deepEqual(after[0]!.context_block_ids, [f.document.blocks[1]!.block_id]);
  assert.equal(before[0]!.context_block_ids.length, 0);
});

test('new primary table role check cannot be bypassed by imaging_observation label; old records remain readable', () => {
  const f = tableFixture();
  const submission = expandBatchLineEvidence(candidate({ source_line_indices: [2] }), f.document.blocks, binding(f));
  assert.equal(validateEvidenceSubmission(submission, f.context).accepted, true);
  const r = validateEvidenceSubmission(submission, current(f));
  assert.equal(r.accepted, false); assert.ok(r.issues.some(i => i.code === 'table_evidence_cannot_be_primary'));
});

test('explicitly cited table values stay verbatim in separate supporting evidence, never the primary quotation', async () => {
  const f = tableFixture(), units = buildSourceEvidenceUnits(f.document);
  const submission = expandBatchLineEvidence(candidate({ source_unit_ids: [units[0]!.unit_id], supporting_table_evidence: [{ table_id: 'table-2', reference_line_indices: [0], line_indices: [2] }],
    numeric_expressions: [{ original_text: '4.2 ± 1.1 mm', unit_original: 'mm', line_indices: [2] }] }), f.document.blocks, binding(f), units);
  const r = validateEvidenceSubmission(submission, current(f));
  assert.equal(r.accepted, true, JSON.stringify(r.issues));
  assert.equal(r.record!.original_quote, f.document.blocks[0]!.text);
  assert.equal(r.record!.context.supporting_table_evidence![0]!.fragments[0]!.exact_quote, '4.2 ± 1.1 mm');
  assert.equal(r.record!.context.supporting_table_evidence![0]!.relationship_status, 'explicit_reference_value_relationship_unverified');
  assert.equal(r.record!.evidence_validation.medical_semantics_verified, false);
  assert.ok(r.issues.some(i => i.code === 'supporting_table_value_relationship_requires_review'));
  const delivered = buildEvidenceDelivery(f.document, [{ record: r.record!, version: 1, actor: 'automatic' }]);
  assert.equal(delivered.records[0]!.supporting_table_evidence![0]!.fragments[0]!.exact_quote, '4.2 ± 1.1 mm');
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/visual-statements-export-'));
  try {
    // The fixture identity is the hash of this exact synthetic JSON, never a real PDF.
    const sourceBytes = Buffer.from(JSON.stringify(f.document.blocks.map(b => ({ text: b.text, page: b.page }))));
    assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), f.document.file_sha256);
    const sourcePath = resolve(directory, 'synthetic-source.json'); await writeFile(sourcePath, sourceBytes);
    f.document.source.file_reference = relative(process.cwd(), sourcePath);
    await exportEvidenceDelivery(f.document, [{ record: r.record!, version: 1, actor: 'automatic' }], {
      codeRoot: process.cwd(), directory: resolve(directory, 'export'), mode: 'candidates', coverage: {} });
    const saved = JSON.parse(await readFile(resolve(directory, 'export/records.jsonl'), 'utf8'));
    assert.equal(saved.supporting_table_evidence[0].relationship_status, 'explicit_reference_value_relationship_unverified');
    assert.equal(saved.supporting_table_evidence[0].fragments[0].exact_quote, '4.2 ± 1.1 mm');
    assert.equal(saved.evidence_policy_version, VISUAL_STATEMENT_POLICY_VERSION);
    assert.equal(saved.original_fragments[0].exact_quote, f.document.blocks[0]!.text);
    assert.ok(!(await readFile(resolve(directory, 'export/records.csv'), 'utf8')).includes('4.2 ± 1.1'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing/wrong explicit table reference and context-only table laundering reject', () => {
  for (const mode of ['wrong-number', 'no-reference', 'wrong-table-values', 'context-only'] as const) {
    const f = tableFixture();
    if (mode === 'wrong-number') f.document.blocks[0]!.text = 'CT shows a round nodule (Table 3).';
    if (mode === 'no-reference') f.document.blocks[0]!.text = 'CT shows a round nodule.';
    const submission = expandBatchLineEvidence(candidate({ source_line_indices: [0], ...(mode === 'context-only' ? { context_line_indices: [2] } : {
      supporting_table_evidence: [{ table_id: 'table-2', reference_line_indices: [0], line_indices: [mode === 'wrong-table-values' ? 0 : 2] }] }) }), f.document.blocks, binding(f));
    const r = validateEvidenceSubmission(submission, current(f));
    assert.equal(r.accepted, false, mode); assert.ok(r.issues.some(i => i.severity === 'reject' && /table/u.test(i.code)), mode);
  }
});

test('feature-list/statistical label remains a visible semantic review flag, never a classifier guarantee', () => {
  const f = makeEvidenceFixture(['We evaluated CT feature names and regression associations.']); mapped(f, [0]);
  for (const evidence_type of ['feature_mention', 'association_conclusion'] as const) {
    const s = expandBatchLineEvidence(candidate({ source_line_indices: [0], evidence_type }), f.document.blocks, binding(f));
    const r = validateEvidenceSubmission(s, current(f));
    assert.equal(r.accepted, true); assert.equal(r.record!.review_status, 'needs_context');
    assert.ok(r.issues.some(i => i.code === 'visual_statement_purpose_requires_review'));
    assert.equal(r.record!.evidence_validation.medical_semantics_verified, false);
  }
});

test('batch submit and summary update both use the new mechanical policy and source-unit protocol', async () => {
  const f = tableFixture(), context = current(f), article = buildArticleScope(f.document), store = new ExtractionStore(':memory:');
  store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
  try {
    const batch = planExtractionBatches(f.document, article)[0]!, tools = new ExtractionTools(context, batch, article, store, 'batch_lines');
    const defs = tools.definitions(), read = defs.find(d => d.name === 'read_document_blocks')!, submit = defs.find(d => d.name === 'submit_candidate_records')!;
    const toolContext = {} as Parameters<typeof read.execute>[4];
    const readResult = await read.execute('read', {}, undefined, undefined, toolContext);
    const body = JSON.parse((readResult.content[0] as { text: string }).text);
    assert.equal(body.evidence_policy_version, VISUAL_STATEMENT_POLICY_VERSION);
    assert.ok(body.source_units.length >= 3);
    const bad = await submit.execute('table-submit', { records: [candidate({ source_line_indices: [2] })], batch_complete: false }, undefined, undefined, toolContext);
    assert.match(JSON.stringify(bad), /table_evidence_cannot_be_primary/); assert.equal(store.current(f.input.run_id).length, 0);
    const unitId = body.source_units.find((u: any) => u.source_type === 'body').unit_id;
    await submit.execute('statement-submit', { records: [candidate({ source_unit_ids: [unitId] })], batch_complete: true }, undefined, undefined, toolContext);
    assert.equal(tools.completed, true); assert.equal(store.current(f.input.run_id).length, 1);
    store.transition(f.input.run_id, 'reconciling');
    const summary = new ExtractionSummaryTools(context, article, store, 'baseline'), summaryDefs = summary.definitions();
    const summaryRead = summaryDefs.find(d => d.name === 'read_document_blocks')!, summarySubmit = summaryDefs.find(d => d.name === 'submit_candidate_records')!;
    await summaryRead.execute('summary-read', { line_indices: [0, 1, 2] }, undefined, undefined, toolContext);
    await assert.rejects(summarySubmit.execute('summary-table-patch', { summary: 'Unapproved', reviews: [], links: [], updates: [candidate({ source_line_indices: [2] })], summary_complete: false }, undefined, undefined, toolContext), /summary_update_validation_failed/);
    assert.equal(store.current(f.input.run_id).length, 1);
  } finally { store.close(); }
});

test('production new-run entry binds current rules through extraction and reconciliation without a paid provider', async () => {
  const f = makeEvidenceFixture(['CT shows a round nodule.']); mapped(f, [0]);
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/visual-statements-local-'));
  const scripted = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }, { name: 'submit_candidate_records', arguments: {
      records: [candidate({ source_unit_ids: ['su-000001'] })], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: {
      summary: 'Local synthetic engineering fixture only.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ]);
  const store = new ExtractionStore(':memory:');
  try {
    f.input.runtime_profile = { ...f.input.runtime_profile, provider: scripted.config.provider, model_id: scripted.config.modelId, endpoint: scripted.endpoint };
    const r = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
      profile: developmentProfile(scripted.config.modelId), config: scripted.config, budget: new ExtractionBudget(resolve(directory, 'ledger.json'), scripted.endpoint),
      store, directory: resolve(directory, 'run'), strategy: 'baseline' });
    assert.equal(r.candidate_count, 1); assert.equal(r.evidence_policy_version, VISUAL_STATEMENT_POLICY_VERSION);
    assert.equal(r.source_evidence_unit_version, SOURCE_EVIDENCE_UNIT_VERSION);
    assert.equal(r.versions[0]!.record.extraction_trace.evidence_policy_version, VISUAL_STATEMENT_POLICY_VERSION);
    assert.equal(r.medical_quality_approved, false);
    const bodies = scripted.requests.map(r => JSON.stringify(r.body));
    assert.ok(bodies[0]!.includes('source_unit_ids')); assert.ok(bodies.at(-1)!.includes('visual-statements-2'));
    assert.ok(scripted.endpoint.startsWith('http://127.0.0.1:'));
  } finally { store.close(); await scripted.close(); await rm(directory, { recursive: true, force: true }); }
});

const readJSON = async (path: string) => JSON.parse(await readFile(new URL('../../' + path, import.meta.url), 'utf8'));
const getPack = () => readJSON('apps/pi-web/public/output-review/pack-manifest.json');
const chars = (fragments: LocatedEvidenceFragment[]) => fragments.flatMap(f => Array.from(f.exact_quote).map((char, i) => [f.block_id, f.text_version, f.start + i, char]));

test('real frozen S03 groups into complete general-definition sentences; every old-view character and offset survives', async () => {
  const p = await getPack(), documents = new Map<string, any>(), catalogs = new Map<string, any>();
  for (const paper of p.papers) { documents.set(paper.document_id, (await readJSON(paper.ir_path)).document); catalogs.set(paper.document_id, await readJSON(paper.figure_catalog_path)); }
  const s03 = p.random_samples.find((s: any) => s.id === 'S03'), document = documents.get('L01');
  const g = groupEvidenceFragments(document, s03.view.original_fragments);
  assert.equal(g.length, 2); assert.ok(g.every(g => g.completeness === 'complete'));
  assert.match(g[0]!.segments.map(s => s.exact_quote).join('\n'), /CT 血管征定义/u);
  const views = [...p.random_samples.map((s: any) => s.view), ...p.risks.flatMap((s: any) => [s.before, s.after])];
  const results = new Map<string, any>();
  for (const view of views) {
    if (!results.has(view.result_path)) results.set(view.result_path, await readJSON(view.result_path));
    const version = results.get(view.result_path).versions.find((v: any) => v.record.record_id === view.record_id && v.version === view.record_version);
    const delivered = buildEvidenceDelivery(documents.get(view.document_id), [version], catalogs.get(view.document_id));
    assert.equal(delivered.records[0]!.text_fingerprint, view.text_fingerprint, view.record_id + '/legacy_text_fingerprint');
    assert.equal(delivered.records[0]!.delivery_fingerprint, view.delivery_fingerprint, view.record_id + '/legacy_delivery_fingerprint');
  }
  for (const view of views) for (const field of ['original_fragments', 'context_fragments']) {
    const original = view[field] as LocatedEvidenceFragment[], grouped = groupEvidenceFragments(documents.get(view.document_id), original);
    assert.deepEqual(chars(grouped.flatMap(g => g.segments)), chars(original), view.record_id + '/' + field);
    for (const s of grouped.flatMap(g => g.segments)) assert.deepEqual(s, locateEvidenceFragment(documents.get(view.document_id), { block_id: s.block_id, exact_quote: s.exact_quote, occurrence: s.occurrence }));
  }
});

test('real S18 identifies its missing leading span; the complete classification-plus-dimension source sentence remains allowed', async () => {
  const p = await getPack(), doc = (await readJSON(p.papers.find((p: any) => p.document_id === 'L05').ir_path)).document;
  const s18 = p.random_samples.find((s: any) => s.id === 'S18'), units = buildSourceEvidenceUnits(doc);
  const groups = groupEvidenceFragments(doc, s18.view.original_fragments, units);
  assert.ok(groups.some(g => g.missing_source_spans.some(s => s.block_id.endsWith('l000006') && s.start === 96 && s.end === 119)));
  const f = makeEvidenceFixture();
  f.document = doc;
  f.input = { ...f.input, document_id: doc.document_id, file_sha256: doc.file_sha256, fixture: false };
  f.context = { ...f.context, input: f.input, document: doc, allowedBlockIds: doc.blocks.map((b: any) => b.block_id),
    readBlockIds: doc.blocks.map((b: any) => b.block_id), metadata: { ...f.context.metadata,
      source_version: { ...f.context.metadata.source_version, file_sha256: doc.file_sha256 } } };
  const bound = { ...binding(f), document_id: doc.document_id, file_sha256: doc.file_sha256, text_version: doc.text_version };
  const sourceUnit = units.find(u => u.segments.some(s => s.block_id.endsWith('p0002-l000007')))!;
  const submission = expandBatchLineEvidence(candidate({ source_unit_ids: [sourceUnit.unit_id], evidence_type: 'definition' }), doc.blocks, bound, units);
  const r = validateEvidenceSubmission(submission, current(f));
  assert.equal(r.accepted, true, JSON.stringify(r.issues));
  assert.match(r.record!.original_quote, /According to the clas-/u);
  assert.match(r.record!.original_quote, /less than 5 mm/u);
  assert.ok(!r.record!.original_quote.includes('Some studies suggest'));
});

test('all seventeen real frozen independent table samples are mechanically rejected only under the new policy', async () => {
  const p = await getPack(), documents = new Map<string, any>();
  for (const paper of p.papers) documents.set(paper.document_id, (await readJSON(paper.ir_path)).document);
  let count = 0;
  for (const sample of p.random_samples) {
    const document = documents.get(sample.view.document_id), groups = groupEvidenceFragments(document, sample.view.original_fragments);
    if (!groups.some(g => ['table', 'table_caption'].includes(g.source_type))) continue;
    const f = makeEvidenceFixture(), record = (await readJSON(sample.view.result_path)).versions.find((v: any) => v.record.record_id === sample.view.record_id && v.version === sample.view.record_version).record;
    const trace = record.extraction_trace;
    const source = sample.view.original_fragments.map((s: any) => ({ block_id: s.block_id, exact_quote: s.exact_quote, occurrence: s.occurrence }));
    const context: EvidenceValidationContext = { ...f.context, document, catalog: { ...f.catalog, catalog_version: trace.scope.catalog_version }, input: { ...f.input, run_id: trace.run_id, document_id: document.document_id,
      file_sha256: document.file_sha256, fixture: false, scope: trace.scope }, allowedBlockIds: document.blocks.map((b: any) => b.block_id),
      readBlockIds: document.blocks.map((b: any) => b.block_id), metadata: { ...f.context.metadata, task_id: trace.task_id, source_version: record.source_version } };
    const submission = { ...plainSubmission(f, source), binding: trace.source_binding };
    const legacy = validateEvidenceSubmission(submission, context), now = validateEvidenceSubmission(submission, { ...context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION });
    assert.equal(legacy.accepted, true, sample.id + JSON.stringify(legacy.issues));
    assert.equal(now.accepted, false, sample.id); assert.ok(now.issues.some(i => i.code === 'table_evidence_cannot_be_primary'), sample.id); count++;
  }
  assert.equal(count, 17);
});

test('the immutable feedback JSON remains byte-identical and is never made a medical gold label', async () => {
  const raw = await readFile(new URL('../../apps/pi-web/public/output-review/普通用户初筛-cc939653-2026-11-05T06-08-53.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), 'e53f669c7086761f9d0ef209448979aae488068c7b1e2a80d1f5590e422b6a28');
  const f = JSON.parse(raw.toString('utf8'));
  assert.equal(f.items.length, 35); assert.equal(f.items.filter((i: any) => i.note).length, 11);
  assert.equal(f.medical_quality_approved, false);
  const s03 = f.items.find((i: any) => i.id === 'S03'); assert.equal(s03.answers.image_description, 'not_like'); assert.match(s03.note, /可以提取/u);
});
