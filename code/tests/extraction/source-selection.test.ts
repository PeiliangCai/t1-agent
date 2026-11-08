import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StructureUnit } from '../../packages/contracts/src/document-ir-v3.js';
import { buildArticleScope } from '../../packages/agent/src/article-scope.js';
import { selectSourceBlocks, proposeExplicitSourceLinks, type SourceSelectionCondition } from '../../packages/agent/src/source-selection.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { reconcileEvidence } from '../../packages/agent/src/reconciliation.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';

function unit(fixture: ReturnType<typeof makeEvidenceFixture>, indices: number[], options: Partial<StructureUnit> = {}): StructureUnit {
  return { unit_id: 'synthetic-unit', native_ref: '#/texts/0', kind: 'text', native_label: 'synthetic', native_text: 'not-authoritative', native_original_text: null,
    native_text_role: 'processed_native_not_literal_quote', content_layer: 'body',
    source_segments: indices.map(i => ({ block_id: fixture.document.blocks[i]!.block_id, text_version: fixture.document.text_version, start: 0, end: fixture.document.blocks[i]!.text.length })),
    provenance: [{ physical_page: 1, bbox: null, coordinate_system: 'crop_rotated_top_left_pt', native_ref: '#/texts/0', native_bbox: {}, native_page_size: [600, 800], precision: 'native_element_bbox', native_charspan: null }],
    mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_2', matched_native_code_points: 1, alignable_native_code_points: 1, transformations: [], warnings: [] }, ...options };
}
const select = (fixture: ReturnType<typeof makeEvidenceFixture>, condition: SourceSelectionCondition) => selectSourceBlocks(fixture.document, buildArticleScope(fixture.document), condition);

test('B0/F share task bibliography exclusion without rewriting article membership or original text', () => {
  const f = makeEvidenceFixture(['CT shows spiculation.', 'References', '1. Smith A. CT. J Med. 2024;2:1-8.', 'Unclassified tail.']);
  const original = JSON.stringify(f.document), b0 = select(f, 'B0'), positive = select(f, 'F');
  assert.equal(b0.kept_block_ids.length, 3);
  assert.equal(b0.entries.length, 4);
  assert.deepEqual(b0.excluded_block_ids, positive.excluded_block_ids);
  assert.equal(positive.excluded_block_ids.length, 1);
  assert.equal(positive.entries[2]!.state, 'excluded');
  assert.equal(positive.entries[2]!.article_eligible, true);
  assert.ok(positive.entries[2]!.rule_ids.includes('TASK_BIBLIOGRAPHY_EXCLUDED'));
  assert.equal(positive.entries[3]!.state, 'kept');
  assert.equal(JSON.stringify(f.document), original);
  assert.equal(select(f, 'F').digest, positive.digest);
});

test('F deferral is separate from common bibliography scope and unknowns remain kept', () => {
  const f = makeEvidenceFixture(['Novel unlisted phenotype.', '© 2024 Publisher.', 'References', '1. Smith A. Study title.', 'J Med. 2024;2:1-8.', '2. Incomplete entry without endpoint']);
  f.document.structure.units.push(unit(f, [3, 4], { kind: 'list_item' }));
  assert.deepEqual(select(f, 'F').deferred_block_ids, [f.document.blocks[1]!.block_id]);
  const s = select(f, 'F'); assert.equal(s.entries[0]!.state, 'kept'); assert.equal(s.entries[5]!.state, 'kept');
  assert.equal(s.full_document_coverage_implied, false); assert.deepEqual(s.excluded_block_ids, [f.document.blocks[3]!.block_id, f.document.blocks[4]!.block_id]);
});

test('negation, uncertainty, numeric measurements, morphology and cell/nucleus/tissue descriptions survive', () => {
  const f = makeEvidenceFixture(['未见明显强化；边界可能不清。', 'The thickness was 3.2 mm, without definite invasion.',
    'Irregular nuclei and glandular tissue architecture were observed.', '细胞核深染、组织排列紊乱。', 'Unknown unclassified phrase']);
  assert.equal(select(f, 'F').kept_block_ids.length, 5);
});

test('a reference-looking body sentence without a source References heading is never removed', () => {
  const f = makeEvidenceFixture(['1. This group had spiculation in 2024;2:1-8.', 'References are discussed in the body, not a heading.']);
  assert.equal(select(f, 'F').kept_block_ids.length, 2);
});

test('unmapped table pages, captions and uncertain mappings default to retained source context', () => {
  const f = makeEvidenceFixture(['References', '1. Smith A. J Med. 2024;2:1-8.', '© 2024 Publisher.']);
  f.document.structure.units.push(unit(f, [], { kind: 'table', mapping: { ...unit(f, []).mapping, status: 'unmapped' } }));
  assert.equal(select(f, 'F').kept_block_ids.length, 3);
  const caption = makeEvidenceFixture(['References', '1. Smith A. J Med. 2024;2:1-8.']);
  caption.document.structure.units.push(unit(caption, [1], { kind: 'caption' }));
  assert.equal(select(caption, 'F').entries[1]!.state, 'kept');
});

test('article quarantine cannot be restored by retrieval cues or context expansion', () => {
  const f = makeEvidenceFixture(['CT shows a mass.', '上接第38页', 'MRI signal 3 mm.']);
  const article = buildArticleScope(f.document), s = selectSourceBlocks(f.document, article, 'F');
  for (const id of article.quarantined_block_ids) {
    assert.equal(s.kept_block_ids.includes(id), false); assert.equal(s.entries.find(e => e.block_id === id)!.state, 'deferred');
  }
  assert.throws(() => selectSourceBlocks(f.document, { ...article, text_version: 'different' }, 'F'), /source_selection_binding_mismatch/);
});

test('explicit source links require a shared figure/table ID and block incompatible case/modality/phase/panel', () => {
  const f = makeEvidenceFixture(['Figure 1A. Case 1 lesion 1 CT arterial phase, margin is smooth.',
    'Figure 1A. Case 1 lesion 1 CT arterial phase, density is low.',
    'Figure 1B. Case 2 lesion 1 MRI venous phase, signal is high.', 'Figure 2A. Case 1 CT.', 'Same article has a smooth mass without an exact figure ID.']);
  const proposal = proposeExplicitSourceLinks(f.document, buildArticleScope(f.document));
  assert.equal(proposal.links.length, 3);
  assert.equal(proposal.links[0]!.status, 'compatible_explicit_markers_pending_review');
  assert.equal(proposal.links[1]!.status, 'blocked_incompatible_conditions');
  assert.deepEqual(proposal.links[1]!.conflicts, ['case', 'modality', 'condition', 'panel']);
  assert.ok(proposal.links.every(l => !l.assertion_merge_allowed));
  const unknown = makeEvidenceFixture(['Fig. 1. CT.', 'Fig. 1. A smooth edge.']);
  assert.equal(proposeExplicitSourceLinks(unknown.document, buildArticleScope(unknown.document)).links[0]!.status, 'pending_identity_or_conditions');
});

test('summary can re-read F-deferred task-scope lines but cannot cite them before actual read', async () => {
  const f = makeEvidenceFixture(['Unlisted phenotype.', '© 2024 Publisher. All rights reserved.']);
  const selection = select(f, 'F'), store = new ExtractionStore(':memory:');
  store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting'); store.transition(f.input.run_id, 'reconciling');
  const summary = new ExtractionSummaryTools(f.context, buildArticleScope(f.document), store, 'baseline', [], selection);
  const ref = { block_id: f.document.blocks[1]!.block_id, exact_quote: f.document.blocks[1]!.text };
  // This checks mechanical read permission only, not medical eligibility.
  const submission = { ...f.submission, feature_name_raw: null, source_fragments: [ref], assertion: { ...f.submission.assertion, original_wording: ref.exact_quote, evidence: [ref] },
    disease_or_lesion: { value: null, status: 'unknown', evidence: [] }, modality: { value: null, status: 'unknown', evidence: [] }, provenance: { ...f.submission.provenance, evidence: [ref] } };
  assert.equal(selection.entries[1]!.state, 'deferred');
  const context = () => ({ ...f.context, readBlockIds: [...summary.readBlocks] });
  assert.equal(validateEvidenceSubmission(submission, context()).accepted, false);
  try {
    const read = summary.definitions().find(d => d.name === 'read_document_blocks')!;
    const toolContext = {} as Parameters<typeof read.execute>[4];
    const result = await read.execute('synthetic-read', { line_indices: [1] }, undefined, undefined, toolContext);
    assert.match(JSON.stringify(result), /All rights reserved/);
    assert.deepEqual([...summary.readBlocks], [ref.block_id]);
    assert.equal(validateEvidenceSubmission(submission, context()).accepted, true);
    await assert.rejects(read.execute('synthetic-double', { line_indices: [1], block_ids: [ref.block_id] }, undefined, undefined, toolContext), /choose_one_read_selection/);
  } finally { store.close(); }
});

test('ordinary default B0 Pi extraction and reconciliation cannot reintroduce task-excluded bibliography', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't1-selection-'));
  const f = makeEvidenceFixture(['CT shows spiculation.', 'References', '1. Smith A. J Med. 2024;2:1-8.']);
  const server = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }, { name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'read_document_blocks', arguments: { line_indices: [0, 2] } }] },
    { calls: [{ name: 'read_document_blocks', arguments: { line_indices: [0] } }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { summary: 'Known bibliography skipped; authorized source read.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ]);
  const store = new ExtractionStore(':memory:');
  f.input.runtime_profile = { ...f.input.runtime_profile, provider: server.config.provider, model_id: server.config.modelId, endpoint: server.endpoint };
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
      profile: developmentProfile(server.config.modelId), config: server.config, budget: new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint),
      store, directory: join(directory, 'run'), strategy: 'baseline' });
    assert.equal(result.error, undefined);
    assert.equal(result.coverage.whole_document_summary_complete, true);
    assert.equal(result.state, 'partial');
    assert.equal(result.coverage.explicitly_completed_source_blocks, 2);
    assert.equal(result.coverage.selected_source_block_processing_complete, true);
    assert.equal(result.coverage.source_block_processing_complete, false);
    assert.equal(result.coverage.full_document_extraction_completed, false);
    assert.deepEqual(result.coverage.unprocessed_source_block_ids, []);
    assert.deepEqual(result.coverage.original_article_unprocessed_source_block_ids, [f.document.blocks[2]!.block_id]);
    assert.equal(result.task_processing_complete, true); assert.deepEqual(result.coverage.task_processing_blockers, []);
    assert.deepEqual(result.coverage.unselected_reread_source_block_ids, []);
    assert.equal(result.coverage.source_blocks_read, 2);
    assert.equal(result.coverage.task_scope_source_block_processing_complete, true);
    assert.equal(JSON.stringify(server.requests).includes('Smith'), false);
    const corrections = result.events.filter(e => e.type === 'protocol_correction');
    assert.equal(corrections.length, 1); assert.equal(corrections[0]!.detail.error_code, 'bibliography_read_outside_task_scope');
    assert.equal(corrections[0]!.detail.parameters_rewritten, false);
    assert.equal(result.events.filter(e => e.type === 'protocol_diagnostic_pause' || e.type === 'retry').length, 0);
    assert.equal(server.requests.length, 4); assert.equal(result.ledger_totals.requests, 4);
    assert.match(JSON.stringify(server.requests[2]!.tool_results), /bibliography_read_outside_task_scope/);
    const rejectedRead = server.requests[2]!.tool_results.find(t => t.output.includes('bibliography_read_outside_task_scope'))!;
    assert.equal(rejectedRead.output.includes('CT shows spiculation'), false);
    assert.match(JSON.stringify(server.requests[3]!.tool_results), /CT shows spiculation/);
    const manifest = JSON.parse(await readFile(join(directory, 'run/source-selection.json'), 'utf8'));
    assert.equal(manifest.entries.length, 3);
    assert.equal(manifest.entries[2].state, 'excluded');
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('mapped complete bibliography with visual keywords is excluded in both methods while adjacent body/caption/table remain', () => {
  const f = makeEvidenceFixture(['References', '1. Smith A. CT spiculation and histological nuclei.', 'J Med. 2024;2:1-8.',
    'CT shows low attenuation [1].', 'Fig. 2. A smooth nodule.', 'Tumour diameter 3 mm.']);
  f.document.structure.units.push(unit(f, [1, 2], { unit_id: 'citation', kind: 'list_item' }),
    unit(f, [3], { unit_id: 'body' }), unit(f, [4], { unit_id: 'caption', kind: 'caption' }), unit(f, [5], { unit_id: 'table', kind: 'table_cell' }));
  for (const method of ['B0', 'F'] as const) {
    const s = select(f, method);
    assert.deepEqual(s.excluded_block_ids, [f.document.blocks[1]!.block_id, f.document.blocks[2]!.block_id]);
    assert.ok([3, 4, 5].every(i => s.kept_block_ids.includes(f.document.blocks[i]!.block_id)));
  }
});

test('no heading, inline citation, incomplete DOI/type marker, mixed raw blocks and unmapped multi-line entries stay available', () => {
  for (const lines of [
    ['1. Smith A. CT. J Med. 2024;2:1-8.', 'Body references are discussed here.'],
    ['References', '[1] CT shows spiculation.'],
    ['References', '1. Smith A. CT [J].'],
    ['References', '1. Smith A. CT. doi: https://doi.org/'],
    ['References', '1. Smith A. CT. J Med. 2024;2:1-8. CT shows a smooth rim.'],
    ['References', '1. Smith A. CT.', 'J Med. 2024;2:1-8.'],
  ]) assert.deepEqual(select(makeEvidenceFixture(lines), 'B0').excluded_block_ids, []);
  const mixed = makeEvidenceFixture(['References', '1. Smith A. CT. J Med. 2024;2:1-8. CT shows a smooth rim.']);
  const mapped = unit(mixed, [1], { kind: 'list_item' }); mapped.source_segments[0]!.end = mixed.document.blocks[1]!.text.indexOf(' CT shows');
  mixed.document.structure.units.push(mapped);
  assert.deepEqual(select(mixed, 'B0').excluded_block_ids, []);
});

test('appendix/supplementary or an unfamiliar mapped section boundary ends bibliography scope', () => {
  for (const title of ['Appendix A', 'Supplementary information', '附录', 'Additional details']) {
    const f = makeEvidenceFixture(['References', '1. Smith A. CT. J Med. 2024;2:1-8.', title, '2. Jones B. CT. J Med. 2023;2:3-8.']);
    f.document.structure.units.push(unit(f, [2], { kind: 'section_header' }));
    assert.deepEqual(select(f, 'B0').excluded_block_ids, [f.document.blocks[1]!.block_id]);
    assert.equal(select(f, 'F').entries[3]!.state, 'kept');
  }
});

test('a locator wrapped as a numbered-looking tail is not another entry or a section heading', () => {
  const f = makeEvidenceFixture(['References', '1. Smith A. CT.', 'J Med. 2024;2:1-', '8. doi: https://doi.org/10.1000/example.',
    '1 3', '2. Jones B. CT. J Med. 2023;2:3-8.']);
  f.document.structure.units.push(unit(f, [1, 2, 3], { unit_id: 'ref-1', kind: 'list_item' }),
    unit(f, [4], { unit_id: 'footer', kind: 'other', content_layer: 'furniture' }),
    unit(f, [5], { unit_id: 'ref-2', kind: 'list_item' }));
  assert.deepEqual(select(f, 'B0').excluded_block_ids, [1, 2, 3, 5].map(i => f.document.blocks[i]!.block_id));
});

test('batch/summary access and candidate updates reject confirmed bibliography through all model selectors', async () => {
  const f = makeEvidenceFixture(['We observed spiculation on CT in lung cancer.', 'References',
    '1. Smith A. spiculation on CT in lung cancer. J Med. 2024;2:1-8.']);
  const article = buildArticleScope(f.document), selection = select(f, 'B0'), ref = f.document.blocks[2]!;
  const store = new ExtractionStore(':memory:'); store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
  const batch = { batch_id: 'scope-guard', assigned_block_ids: [f.document.blocks[0]!.block_id], context_block_ids: [ref.block_id],
    physical_pages: [1], source_code_points: 100, order_basis: 'native_mapped_then_source_fallback' as const, warnings: [] };
  const tools = new ExtractionTools(f.context, batch, article, store);
  const located = { block_id: ref.block_id, exact_quote: ref.text }, submission = { ...f.submission, source_fragments: [located],
    assertion: { ...f.submission.assertion, original_wording: ref.text, evidence: [located] } };
  try {
    const read = await tools.invoke('read_document_blocks', { ...tools.ids }, 'batch-read');
    assert.equal(JSON.stringify(read).includes('Smith'), false);
    await assert.rejects(tools.invoke('read_document_blocks', { ...tools.ids, block_ids: [ref.block_id] }, 'batch-denied'), /bibliography_read_outside_task_scope/);
    const saved = await tools.invoke('submit_candidate_records', { ...tools.ids, records: [submission], batch_complete: false }, 'batch-cite-denied');
    assert.equal(store.current(f.input.run_id).length, 0); assert.match(JSON.stringify(saved), /source_block_not_provided/);
    store.transition(f.input.run_id, 'reconciling');
    const summary = new ExtractionSummaryTools(f.context, article, store, 'baseline', [], selection), defs = summary.definitions();
    const defaultSummary = new ExtractionSummaryTools(f.context, article, store, 'baseline');
    await assert.rejects(defaultSummary.invoke('read_document_blocks', { run_id: f.input.run_id, document_id: f.document.document_id,
      block_ids: [ref.block_id] }, 'summary-without-selection-denied'), /bibliography_read_outside_task_scope/);
    const readTool = defs.find(t => t.name === 'read_document_blocks')!, toolContext = {} as Parameters<typeof readTool.execute>[4];
    for (const selector of [{ line_indices: [2] }, { block_ids: [ref.block_id] }])
      await assert.rejects(readTool.execute('summary-denied', selector, undefined, undefined, toolContext), /bibliography_read_outside_task_scope/);
    assert.equal(summary.readBlocks.has(ref.block_id), false);
    const context = await summary.invoke('get_document_context', { run_id: f.input.run_id, document_id: f.document.document_id }, 'summary-context');
    assert.deepEqual((context as { input_selection: { source_pages: Array<{ authorized_document_line_indices: number[] }> } }).input_selection.source_pages[0]!.authorized_document_line_indices, [0, 1]);
    await assert.rejects(summary.invoke('submit_candidate_records', { run_id: f.input.run_id, document_id: f.document.document_id,
      summary: '', reviews: [], links: [], updates: [submission], summary_complete: false }, 'summary-cite-denied'), /summary_update_validation_failed/);
    // An old externally restored candidate must not leak its bibliography through
    // get_document_context even when it predates the shared task-scope rule.
    const old = validateEvidenceSubmission(submission, f.context);
    assert.ok(old.accepted && old.record);
    store.apply(f.input.run_id, reconcileEvidence(old.record, []));
    await assert.rejects(summary.invoke('get_document_context', { run_id: f.input.run_id, document_id: f.document.document_id }, 'old-context-denied'), /source_outside_bibliography_task_scope/);
  } finally { store.close(); }
});
