import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { StructureUnit } from '../../packages/contracts/src/document-ir-v3.js';
import { buildArticleScope, type ExtractionDocument } from '../../packages/agent/src/article-scope.js';
import { selectSourceBlocks } from '../../packages/agent/src/source-selection.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

type Fixture = ReturnType<typeof makeEvidenceFixture>;
function mapped(f: Fixture, indices: number[], id: string, options: Partial<StructureUnit> = {}): StructureUnit {
  return { unit_id: id, native_ref: '#/texts/' + id, kind: 'text', native_label: 'synthetic',
    native_text: 'PROCESSED NATIVE TEXT IS NOT A RETRIEVAL SOURCE', native_original_text: null,
    native_text_role: 'processed_native_not_literal_quote', content_layer: 'body',
    source_segments: indices.map(i => ({ block_id: f.document.blocks[i]!.block_id, text_version: f.document.text_version,
      start: 0, end: Array.from(f.document.blocks[i]!.text).length })),
    provenance: indices.map(i => ({ physical_page: f.document.blocks[i]!.page, bbox: null,
      coordinate_system: 'crop_rotated_top_left_pt', native_ref: '#/texts/' + id, native_bbox: {}, native_page_size: [600, 800],
      precision: 'native_element_bbox', native_charspan: null })),
    mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_4',
      matched_native_code_points: 1, alignable_native_code_points: 1, transformations: [], warnings: [] }, ...options };
}
function select(f: Fixture) { return selectSourceBlocks(f.document, buildArticleScope(f.document), 'F'); }
function install(f: Fixture, ...units: StructureUnit[]) {
  f.document.structure.units.push(...units); f.document.structure.reading_order.push(...units.map(u => u.unit_id)); return f;
}

test('F genuinely defers complete cue-negative prose as unprioritized, preserving B0 and source bytes', () => {
  const f = makeEvidenceFixture(['Our study has certain limitations.',
    'The conclusions require prospective validation in other centers.', 'CT showed a rim.']);
  install(f, mapped(f, [0, 1], 'limitations'), mapped(f, [2], 'observation'));
  const before = JSON.stringify(f.document), s = select(f), b = selectSourceBlocks(f.document, buildArticleScope(f.document), 'B0');
  assert.deepEqual(s.deferred_block_ids, f.document.blocks.slice(0, 2).map(b => b.block_id));
  assert.ok(s.entries.slice(0, 2).every(e => e.rule_ids.includes('F_NOT_PRIORITIZED_UNIT_DEFERRED')));
  assert.match(s.entries[0]!.reasons[0]!, /not judged medically irrelevant.*reread/);
  assert.equal(b.kept_block_ids.length, 3); assert.equal(JSON.stringify(f.document), before);
  assert.equal(s.unknown_default, 'kept'); assert.equal(s.full_document_coverage_implied, false);
});

test('a late broad seed retains the whole paragraph, subject, negation, units and unfamiliar appearance', () => {
  const f = makeEvidenceFixture(['Patient 7 underwent the same preparation.', 'There was no definite change before injection.',
    'The observed phenotype was pebble-like, measuring 3.2 mm.']);
  install(f, mapped(f, [0, 1, 2], 'paragraph'));
  const s = select(f);
  assert.equal(s.kept_block_ids.length, 3); assert.ok(s.entries.every(e => e.rule_ids.includes('F_POSITIVE_UNIT')));
});

test('isolated numerals and negation cannot select a complete cue-negative paragraph by themselves', () => {
  const f = makeEvidenceFixture(['The grant supported 25 researchers.', 'No external financial support was provided.']);
  install(f, mapped(f, [0, 1], 'funding'));
  assert.equal(select(f).deferred_block_ids.length, 2);
  const unknown = makeEvidenceFixture(['Only 25.', 'No matching term.']);
  assert.equal(select(unknown).kept_block_ids.length, 2);
});

test('missing mapping, an incomplete sentence, explicit novelty and ambiguous ownership remain visible', () => {
  const f = makeEvidenceFixture(['Novel unlisted phenotype.', 'An unfamiliar expression is zorb-like.',
    'A fragment whose boundary', 'Our study has limitations. CT showed a rim.', 'A completely unmapped expression.']);
  const mixed = mapped(f, [3], 'mixed'); mixed.source_segments[0]!.end = 'Our study has limitations.'.length;
  install(f, mapped(f, [0], 'novel'), mapped(f, [1], 'unfamiliar'), mapped(f, [2], 'fragment'), mixed);
  assert.equal(select(f).kept_block_ids.length, 5);
});

test('a misleading processed native hint cannot select a reliable cue-negative literal unit', () => {
  const f = makeEvidenceFixture(['Our study has certain limitations.']);
  install(f, mapped(f, [0], 'literal', { native_text: 'CT showed a spiculated mass.' }));
  assert.equal(select(f).entries[0]!.state, 'deferred');
});

test('explicit backward reference restores the whole preceding unit without arbitrary two-line restoration', () => {
  const f = makeEvidenceFixture(['The enrolled subgroup followed the second protocol.', 'The remaining subjects followed the first protocol.',
    'These showed a thin rim on MRI.', 'Our study has certain limitations.']);
  install(f, mapped(f, [0, 1], 'subject'), mapped(f, [2], 'reference'), mapped(f, [3], 'limitations'));
  const s = select(f);
  assert.deepEqual(s.kept_block_ids, f.document.blocks.slice(0, 3).map(b => b.block_id));
  assert.ok(s.entries[0]!.rule_ids.includes('KEEP_CONTEXT_NEIGHBOR'));
  assert.deepEqual(s.entries[0]!.context_of_block_ids, [f.document.blocks[2]!.block_id]);
  assert.equal(s.entries[3]!.state, 'deferred');
});

test('mixed copyright and visual source is retained; a prefix is not a deletion boundary', () => {
  const f = makeEvidenceFixture(['© 2024 Publisher. CT shows a smooth rim.', 'Copyright 2024 Publisher. All rights reserved.']);
  install(f, mapped(f, [0], 'mixed'), mapped(f, [1], 'copyright'));
  assert.equal(select(f).entries[0]!.state, 'kept'); assert.equal(select(f).entries[1]!.state, 'deferred');
  assert.equal(select(makeEvidenceFixture(['© 2024 Publisher. CT shows a smooth rim.'])).entries[0]!.state, 'kept');
});

test('cross-page and uncertain continuation units stay intact, including a seedless endpoint', () => {
  const f = makeEvidenceFixture([{ text: 'The enrolled subgroup followed the second protocol.', page: 1 },
    { text: 'The remaining subjects followed the first protocol.', page: 2 }, { text: 'MRI showed no definite invasion.', page: 2 }]);
  install(f, mapped(f, [0], 'left'), mapped(f, [1], 'right'), mapped(f, [2], 'seed'));
  f.document.structure.organization = { version: 'pdf-organization-1', native_order_preserved: true, heading_paths: [],
    paragraph_continuations: [{ from_unit_id: 'left', to_unit_id: 'right', boundary: 'physical_page',
      status: 'candidate_unverified', reason_codes: ['synthetic_uncertain_continuation'] }] };
  assert.equal(select(f).kept_block_ids.length, 3);
  const cross = makeEvidenceFixture([{ text: 'For the same patient the observation', page: 1 },
    { text: 'was a honeycomb pattern on CT without enhancement.', page: 2 }]);
  install(cross, mapped(cross, [0, 1], 'cross-page'));
  assert.equal(select(cross).kept_block_ids.length, 2);
});

test('an incomplete bibliography tail is retained and common bibliography masks stay identical', () => {
  const f = makeEvidenceFixture(['References', '1. Smith A. CT. J Med. 2024;2:1-8.',
    'Committees: Protocol for the Examination of Resection Specimens.', 'Our study has certain limitations.']);
  install(f, mapped(f, [1], 'complete', { kind: 'list_item' }), mapped(f, [2], 'incomplete', { kind: 'list_item' }));
  const a = buildArticleScope(f.document), s = selectSourceBlocks(f.document, a, 'F'), b = selectSourceBlocks(f.document, a, 'B0');
  assert.deepEqual(s.excluded_block_ids, b.excluded_block_ids);
  assert.equal(s.entries[2]!.state, 'kept');
});

test('real unit4 inputs keep all mapped figure/table/footnote and recovered continuation source, without forcing a reduction', async () => {
  for (const id of ['L01', 'L05', 'L07']) {
    const d = JSON.parse(await readFile(`docs/acceptance/pdf-structure-review-2026-11-07/derived/${id}/parser-result.json`, 'utf8')).document as ExtractionDocument;
    assert.equal(d.schema_version, '3'); if (d.schema_version !== '3') continue;
    const before = JSON.stringify(d), article = buildArticleScope(d), s = selectSourceBlocks(d, article, 'F'), b = selectSourceBlocks(d, article, 'B0');
    const kept = new Set(s.kept_block_ids), units = new Map(d.structure.units.map(u => [u.unit_id, u]));
    assert.deepEqual(s.excluded_block_ids, b.excluded_block_ids);
    for (const u of d.structure.units.filter(u => ['caption', 'table', 'table_cell', 'footnote'].includes(u.kind)))
      assert.ok(u.source_segments.every(span => kept.has(span.block_id)), `${id}:${u.native_ref}`);
    for (const edge of d.structure.organization?.continuation_recovery?.relations ?? [])
      for (const unitId of [edge.from_unit_id, edge.to_unit_id])
        assert.ok(units.get(unitId)!.source_segments.every(span => kept.has(span.block_id)), `${id}:${unitId}`);
    if (id === 'L01') assert.deepEqual(s.kept_block_ids, b.kept_block_ids);
    if (id === 'L05') {
      const limitations = d.structure.units.find(u => u.native_ref === '#/texts/104')!;
      assert.ok(limitations.source_segments.every(span => s.deferred_block_ids.includes(span.block_id)));
    }
    assert.equal(JSON.stringify(d), before);
  }
});
