"""Focused source/layout regressions; no native inference, provider or network."""
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
import importlib.util
import json
import sys
import unittest

PARSER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PARSER))
from adapter import CODE, ParserError
from structured import align_sources, build_ir, validate_structured
from figure_assets import discover_figures

spec = importlib.util.spec_from_file_location('pdf_quality_diagnostic', CODE / 'scripts/diagnose-pdf-input-quality.py')
diagnostic = importlib.util.module_from_spec(spec); spec.loader.exec_module(diagnostic)


class InputQualityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old, cls.new = {}, {}
        for source_id in ['L01', 'L05', 'L07', 'L02']:
            path = diagnostic.FEEDBACK / source_id / 'parser-result.json' if source_id in ['L01', 'L05'] else diagnostic.BASE / 'runs/guarded-v4/reuse/docling-standard-cpu' / (source_id + '.json')
            old = json.loads(path.read_text())['document']; cls.old[source_id] = old
            artifact = CODE / old['native_artifact']['path']
            assert sha256(artifact.read_bytes()).hexdigest() == old['native_artifact']['sha256']
            cls.new[source_id] = build_ir(diagnostic.retained_source(old), json.loads(artifact.read_text()), old['parser']['id'],
                                         old['metrics']['native_metrics'], old['coverage']['native_errors'], old['native_artifact'])

    def test_real_anchors_and_native_order_do_not_change_and_repeated_values_stay_ambiguous(self):
        for source_id in self.old:
            old, new = self.old[source_id], self.new[source_id]
            self.assertEqual(diagnostic.anchor_digest(old), diagnostic.anchor_digest(new))
            refs = lambda d: [next(u['native_ref'] for u in d['structure']['units'] if u['unit_id'] == i) for i in d['structure']['reading_order']]
            self.assertEqual(refs(old), refs(new))
            self.assertFalse(new['structure']['human_fidelity_verified'])
            if source_id in ['L01', 'L05']:
                self.assertEqual(len(old['coverage']['ambiguous_unit_ids']), len(new['coverage']['ambiguous_unit_ids']))
                self.assertEqual(len(old['coverage']['unmapped_unit_ids']), len(new['coverage']['unmapped_unit_ids']))
        cell = next(u for u in self.new['L05']['structure']['units'] if u['native_ref'] == '#/tables/0/data/table_cells/4')
        self.assertEqual(cell['mapping']['status'], 'ambiguous'); self.assertEqual(cell['source_segments'], [])

    def test_l01_numbered_heading_path_and_continuation_context_are_inferred_without_joining(self):
        doc = self.new['L01']; units = {u['unit_id']: u for u in doc['structure']['units']}
        by_number = {h['printed_number']: h for h in doc['structure']['organization']['heading_paths']}
        child = by_number['1.4']; self.assertEqual(child['native_level'], 1); self.assertEqual(child['inferred_level'], 2)
        self.assertEqual(child['status'], 'numbering_inferred'); self.assertEqual(child['parent_unit_id'], by_number['1']['unit_id'])
        meta = next(h for h in doc['structure']['organization']['heading_paths'] if units[h['unit_id']]['native_ref'] == '#/texts/8')
        self.assertEqual(meta['role'], 'metadata'); self.assertIsNone(meta['printed_number'])
        edges = doc['structure']['organization']['paragraph_continuations']
        self.assertTrue(any(e['boundary'] == 'physical_page' for e in edges))
        self.assertTrue(all(e['status'] == 'candidate_unverified' for e in edges))

    def test_l05_table4_preserves_native_grid_and_baselines_but_blocks_conflicted_support(self):
        doc = self.new['L05']; table = next(t for t in doc['structure']['tables'] if t['native_ref'] == '#/tables/3')
        self.assertEqual((table['n_rows'], table['n_cols']), (15, 7))
        layout = table['source_layout']; self.assertEqual(len(layout['source_rows']), 25)
        self.assertEqual(layout['row_basis'], 'decoded_baselines_not_semantic_rows')
        self.assertEqual(layout['status'], 'source_conflict'); self.assertEqual(layout['support_semantics'], 'blocked_due_to_structure_conflict')
        units = {u['unit_id']: u for u in doc['structure']['units']}
        logistic = next(c for c in table['cells'] if units[c['unit_id']]['native_text'] == 'Logistic')
        header_p = next(c for c in table['cells'] if c['row_start'] == 1 and c['col_start'] == 5)
        path = next(p for p in layout['header_paths'] if p['cell_unit_id'] == header_p['unit_id'])
        self.assertEqual(path['parent_cell_unit_ids'], [logistic['unit_id']]); self.assertEqual(path['status'], 'native_grid_unverified')
        self.assertNotEqual(doc['structure']['tables'][1]['source_layout']['support_semantics'], 'blocked_due_to_structure_conflict')

    def test_l07_two_column_captions_recover_both_halves_and_region_without_changing_native_links(self):
        old = self.old['L07']; before = deepcopy(old)
        figures = discover_figures(old)
        for number, expected in [('2', 18), ('3', 8)]:
            fig = next(f for f in figures if f['figure_number'] == number)
            self.assertEqual(len(fig['caption_segments']), expected); self.assertEqual(len(fig['region_specs']), 1)
            self.assertTrue(fig['caption_continuation_unverified']); self.assertEqual(fig['verification']['status'], 'needs_review')
            self.assertFalse(fig['verification']['caption_figure_identity_checked'])
        fig3 = next(f for f in figures if f['figure_number'] == '3')
        quotes = [s['exact_quote'] for s in fig3['caption_segments']]
        self.assertTrue(any(q.rstrip().endswith('pos-') for q in quotes)); self.assertTrue(any(q.startswith('teriorly') for q in quotes))
        self.assertEqual(old, before)
        # p7/8/9 were already repaired by independent geometry, not this round.
        for number in ['4', '5', '6']:
            fig = next(f for f in figures if f['figure_number'] == number)
            self.assertEqual(len(fig['region_specs']), 1); self.assertFalse(fig['caption_continuation_unverified'])

    def test_caption_continuation_with_an_intervening_paragraph_or_second_candidate_is_not_guessed(self):
        for mode in ['barrier', 'duplicate']:
            doc = deepcopy(self.old['L07']); continuation = next(u for u in doc['structure']['units'] if u['native_ref'] == '#/texts/99')
            if mode == 'barrier':
                block = deepcopy(next(b for b in doc['blocks'] if b['block_id'] == continuation['source_segments'][0]['block_id']))
                block.update(block_id='synthetic-barrier', text='Independent intervening paragraph', bbox=[295, 340, 305, 350]); doc['blocks'].append(block)
            else:
                duplicate = deepcopy(continuation); duplicate['unit_id'] = 'synthetic-duplicate'; doc['structure']['units'].append(duplicate)
            fig = next(f for f in discover_figures(doc) if f['figure_number'] == '3')
            self.assertFalse(fig['caption_continuation_unverified']); self.assertEqual(len(fig['caption_segments']), 4)

    def test_partial_fuzzy_source_ranges_never_swallow_skipped_other_column_text(self):
        source = {'text_version': 'v', 'blocks': [{'block_id': 'line', 'text': 'alpha EXTRA 12345 OTHER omega', 'page': 1,
                    'bbox': [0, 0, 100, 10], 'reading_order': 0}]}
        segments, mapping = align_sources('alpha12345omega', [{'physical_page': 1, 'bbox': [0, 0, 100, 10]}], source)
        quotes = [source['blocks'][0]['text'][s['start']:s['end']] for s in segments]
        self.assertEqual(mapping['status'], 'partial'); self.assertEqual(quotes, ['alpha', '12345', 'omega'])

    def test_new_organization_and_table_source_references_are_validated(self):
        for mode in ['heading', 'row', 'header']:
            doc = deepcopy(self.new['L05'])
            if mode == 'heading': doc['structure']['organization']['heading_paths'][0]['parent_unit_id'] = 'unknown'
            elif mode == 'row': doc['structure']['tables'][3]['source_layout']['source_rows'][0]['physical_page'] = 1
            else: doc['structure']['tables'][3]['source_layout']['header_paths'][0]['parent_cell_unit_ids'] = ['unknown']
            with self.assertRaises(ParserError): validate_structured(doc)


if __name__ == '__main__': unittest.main()
