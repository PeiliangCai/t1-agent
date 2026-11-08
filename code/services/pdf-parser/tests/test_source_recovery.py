"""True PDF cell/flow recovery, independent glyph checks, no provider calls."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import importlib.util
import json
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapter import CODE, ParserError
from source_geometry import SourceGeometry, inside
from source_tables import restore_table
from source_continuations import restore_continuations
from structured import build_ir, validate_structured

spec = importlib.util.spec_from_file_location('rebuild_source', CODE / 'scripts/diagnose-pdf-input-quality.py')
rebuild = importlib.util.module_from_spec(spec); spec.loader.exec_module(rebuild)


class SourceRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.docs = {}; cls.before = {}
        for source_id in ['L01', 'L05', 'L07']:
            path = CODE / 'docs/acceptance/pdf-input-quality-2026-11-07/derived' / source_id / 'parser-result.json'
            old = json.loads(path.read_text())['document']; cls.before[source_id] = old
            cls.docs[source_id] = build_ir(rebuild.retained_source(old), json.loads((CODE / old['native_artifact']['path']).read_text()), old['parser']['id'],
                                          old['metrics']['native_metrics'], old['coverage']['native_errors'], old['native_artifact'])

    def test_table4_recovers_every_original_cell_slot_blank_and_duplicate_value(self):
        doc = self.docs['L05']; table = doc['structure']['tables'][3]; grid = table['source_grid']
        self.assertEqual((table['n_rows'], table['n_cols']), (15, 7))
        self.assertEqual((grid['n_rows'], grid['n_cols'], grid['header_rows']), (25, 7, 2))
        self.assertEqual(grid['status'], 'geometry_checked'); self.assertEqual(grid['issue_codes'], [])
        self.assertEqual(len(grid['cells']), 158); self.assertEqual(grid['verification']['raw_nonspace_codepoints'], 771)
        self.assertTrue(grid['verification']['all_cells_independently_checked']); self.assertTrue(grid['verification']['grid_slots_covered_once'])
        self.assertEqual(sum(c['row_span'] * c['col_span'] for c in grid['cells']), 175)
        bs = {b['block_id']: b for b in doc['blocks']}
        text = lambda c: '\n'.join(bs[s['block_id']]['text'][s['start']:s['end']] for s in c['source_segments'])
        logistic = next(c for c in grid['cells'] if text(c) == 'Logistic')
        self.assertEqual((logistic['row_span'], logistic['col_span']), (1, 2))
        gender = next(c for c in grid['cells'] if text(c) == 'Gender'); self.assertEqual(gender['row_span'], 2)
        p_first = next(c for c in grid['cells'] if c['row_start'] == 2 and c['col_start'] == 4)
        p_blank = next(c for c in grid['cells'] if c['row_start'] == 3 and c['col_start'] == 4)
        self.assertEqual(text(p_first), '0.504'); self.assertEqual(p_blank['status'], 'blank_geometry_checked'); self.assertEqual(p_blank['source_segments'], [])
        self.assertTrue(any(text(c) == '/' for c in grid['cells']))
        repeated = [c for c in grid['cells'] if text(c) == '< 0.001*']; self.assertGreaterEqual(len(repeated), 4)
        self.assertEqual(len({json.dumps(c['source_segments'], sort_keys=True) for c in repeated}), len(repeated))
        notes = ''.join(bs[s['block_id']]['text'][s['start']:s['end']] for s in grid['footnote_segments'])
        self.assertEqual(notes, 'Marked with * indicate statistical significance')

    def test_another_real_multilevel_table_is_recovered_by_the_same_rules(self):
        doc = self.docs['L05']; grid = doc['structure']['tables'][1]['source_grid']; bs = {b['block_id']: b for b in doc['blocks']}
        self.assertEqual((grid['n_rows'], grid['n_cols'], grid['header_rows']), (10, 8, 2)); self.assertEqual(grid['status'], 'geometry_checked')
        self.assertEqual(len(grid['cells']), 70)
        for title in ['Before', 'After']:
            cell = next(c for c in grid['cells'] if ''.join(bs[s['block_id']]['text'][s['start']:s['end']] for s in c['source_segments']) == title)
            self.assertEqual(cell['col_span'], 3)
        self.assertEqual(doc['structure']['tables'][0]['source_grid']['status'], 'geometry_checked')

    def test_connected_header_strokes_survive_a_vertically_centered_neighbor_baseline(self):
        doc = self.docs['L01']; grid = doc['structure']['tables'][0]['source_grid']; bs = {b['block_id']: b for b in doc['blocks']}
        text = lambda c: ''.join(bs[s['block_id']]['text'][s['start']:s['end']] for s in c['source_segments']).replace(' ', '')
        self.assertEqual(grid['status'], 'geometry_checked'); self.assertEqual(grid['issue_codes'], [])
        self.assertEqual((grid['n_rows'], grid['n_cols'], grid['header_rows'], grid['logical_header_rows']), (7, 8, 3, 2))
        self.assertEqual(grid['verification']['raw_nonspace_codepoints'], 115)
        self.assertEqual(grid['verification']['covered_nonspace_codepoints'], 115)
        self.assertTrue(grid['verification']['all_cells_independently_checked']); self.assertTrue(grid['verification']['grid_slots_covered_once'])
        for label, first, last in [('性别/例', 2, 4), ('病理类型/例', 5, 8)]:
            parent = next(c for c in grid['cells'] if text(c) == label)
            self.assertEqual((parent['row_start'], parent['row_end'], parent['col_start'], parent['col_end']), (0, 2, first, last))
            for child in [c for c in grid['cells'] if c['row_start'] == 2 and first <= c['col_start'] < last]:
                self.assertIn(parent['cell_id'], child['column_header_ids'])
        self.assertEqual(doc['structure']['tables'][0]['n_rows'], 6, 'native candidate grid is preserved separately')

    def test_a_gap_in_the_parent_underline_does_not_invent_a_multicolumn_header(self):
        doc = self.before['L01']; geometry = SourceGeometry(doc)
        try:
            page = geometry.page(2)
            page['rules'] = [r for r in page['rules'] if not (388 < r['x0'] < 389 and 356 < r['y'] < 358)]
            grid = restore_table(doc['structure']['tables'][0], {u['unit_id']: u for u in doc['structure']['units']}, doc, geometry)
            self.assertNotEqual(grid['status'], 'geometry_checked')
            self.assertIn('unseparated_header_relationship_ambiguous', grid['issue_codes'])
        finally: geometry.close()

    def test_complete_numeric_literals_cross_virtual_child_rails_without_being_cut_into_values(self):
        doc = self.docs['L01']; grid = doc['structure']['tables'][0]['source_grid']; bs = {b['block_id']: b for b in doc['blocks']}
        text = lambda c: ''.join(bs[s['block_id']]['text'][s['start']:s['end']] for s in c['source_segments'])
        for row, first, last, literal in [(5, 2, 4, '0.266'), (5, 5, 8, '5.256'), (6, 2, 4, '0.606'), (6, 5, 8, '0.072')]:
            with self.subTest(row=row, literal=literal):
                cell = next(c for c in grid['cells'] if c['row_start'] == row and c['col_start'] == first)
                self.assertEqual((cell['col_end'], cell['col_span'], text(cell)), (last, last - first, literal))
                self.assertEqual(cell['span_basis'], 'literal_value_centered_under_printed_parent_group_no_vertical_divider')
                self.assertEqual(len(cell['source_segments']), 1)
                self.assertEqual(len(cell['column_header_ids']), 1, 'whole value belongs to the parent, not any child category')
        # Same raw line contains two real adjacent values. Their whitespace and
        # independent positions must not be read as one integer such as 292.
        for row, expected in [(3, ['29', '2', '11', '15', '5']), (4, ['17', '2', '13', '5', '1'])]:
            cells = [c for c in grid['cells'] if c['row_start'] == row and c['col_start'] in [2, 3, 5, 6, 7]]
            self.assertEqual([text(c) for c in cells], expected)
            self.assertTrue(all(c['col_span'] == 1 for c in cells))

    def test_numeric_span_requires_centering_contiguity_and_no_actual_vertical_divider(self):
        for mode in ['divider', 'off_center', 'gap', 'missing_vertical_geometry']:
            with self.subTest(mode=mode):
                doc = deepcopy(self.before['L01']); geometry = SourceGeometry(doc)
                try:
                    grid = self.docs['L01']['structure']['tables'][0]['source_grid']
                    value = next(c for c in grid['cells'] if c['row_start'] == 5 and c['col_start'] == 2)
                    block = next(b for b in doc['blocks'] if b['block_id'] == value['source_segments'][0]['block_id'])
                    page = geometry.page(2); mapped = geometry.map_block(block)
                    if mode == 'divider':
                        page['vertical_rules'].append({'x': grid['column_bounds'][3], 'y0': block['bbox'][1] - 1, 'y1': block['bbox'][3] + 1, 'shape_index': -1})
                    elif mode == 'missing_vertical_geometry': del page['vertical_rules']
                    else:
                        for item in mapped:
                            delta = 4 if mode == 'off_center' else -3 if item['offset'] < 2 else 3
                            item['glyph']['bbox'][0] += delta; item['glyph']['bbox'][2] += delta
                        block['bbox'][0] -= 4; block['bbox'][2] += 4
                    restored = restore_table(doc['structure']['tables'][0], {u['unit_id']: u for u in doc['structure']['units']}, doc, geometry)
                    self.assertNotEqual(restored['status'], 'geometry_checked')
                    self.assertIn('complete_value_crosses_child_columns_without_unique_span', restored['issue_codes'])
                    self.assertFalse(any(c['row_start'] == 5 and c['col_start'] == 2 and c['col_end'] == 4 for c in restored['cells']))
                finally: geometry.close()

    def test_numeric_span_preserves_raw_internal_whitespace_instead_of_reformatting_source(self):
        doc = deepcopy(self.before['L01']); grid = self.docs['L01']['structure']['tables'][0]['source_grid']
        value = next(c for c in grid['cells'] if c['row_start'] == 5 and c['col_start'] == 2)
        block = next(b for b in doc['blocks'] if b['block_id'] == value['source_segments'][0]['block_id'])
        block['text'] = '0.2 66'  # Local fixture only: the real PDF/raw source is never edited.
        geometry = SourceGeometry(doc)
        try:
            restored = restore_table(doc['structure']['tables'][0], {u['unit_id']: u for u in doc['structure']['units']}, doc, geometry)
            cell = next(c for c in restored['cells'] if c['row_start'] == 5 and c['col_start'] == 2)
            segment = cell['source_segments'][0]
            self.assertEqual((cell['col_span'], segment['start'], segment['end']), (2, 0, 6))
            self.assertEqual(block['text'][segment['start']:segment['end']], '0.2 66')
            self.assertEqual(restored['status'], 'geometry_checked')
        finally: geometry.close()

    def test_table3_refines_bad_native_region_and_restores_wrapped_header_title_value_and_footnote(self):
        doc = self.docs['L05']; table = doc['structure']['tables'][2]; grid = table['source_grid']; bs = {b['block_id']: b for b in doc['blocks']}
        text = lambda c: '\n'.join(bs[s['block_id']]['text'][s['start']:s['end']] for s in c['source_segments'])
        self.assertEqual((table['n_rows'], table['n_cols']), (17, 8)); self.assertEqual(table['association_status'], 'conflict')
        self.assertEqual(grid['status'], 'geometry_checked'); self.assertEqual((grid['n_rows'], grid['n_cols']), (17, 6)); self.assertEqual(len(grid['cells']), 89)
        self.assertEqual((grid['header_rows'], grid['logical_header_rows']), (2, 1))
        header = next(c for c in grid['cells'] if text(c) == 'LASSO\nCoefficient')
        self.assertEqual((header['row_span'], header['col_span']), (2, 1)); self.assertEqual(header['column_header_ids'], [])
        value = next(c for c in grid['cells'] if text(c) == '12.78(± 4.71)')
        self.assertEqual((value['col_start'], value['col_end']), (3, 4))
        self.assertGreater(grid['region_bbox'][0], grid['native_region_bbox'][0] + 100)
        self.assertLess(grid['region_bbox'][3], grid['native_region_bbox'][3] - 100)
        self.assertEqual(grid['caption_status'], 'geometry_checked_numbered_title'); self.assertEqual(grid['caption_number'], '3')
        self.assertEqual([bs[s['block_id']]['text'] for s in grid['caption_segments']], ['Table 3 Univariate and', 'multivariate analysis between', 'group 1 and group 2'])
        self.assertEqual(''.join(bs[s['block_id']]['text'] for s in grid['footnote_segments']), 'Marked with * indicate statistical significance')

    def test_two_plausible_regions_ambiguous_title_and_header_font_conflict_do_not_certify_missing_structure(self):
        for mode in ['two_regions', 'title', 'header']:
            doc = deepcopy(self.before['L05']); geometry = SourceGeometry(doc)
            try:
                page = geometry.page(6)
                if mode == 'two_regions':
                    for y in [110., 130., 150.]:
                        for x0, x1 in [(180., 280.), (280., 380.)]: page['rules'].append({'x0': x0, 'x1': x1, 'y': y, 'shape_index': 999})
                elif mode == 'title':
                    title = deepcopy(next(b for b in doc['blocks'] if b['page'] == 6 and b['text'].startswith('Table 3 ')))
                    title['block_id'] = 'synthetic-second-title'; title['text'] = title['text'].replace('Table 3', 'Table 9'); doc['blocks'].append(title)
                else:
                    for glyph in page['glyphs']:
                        if 505 <= glyph['bbox'][0] < 544 and 70 < glyph['bbox'][1] < 80: glyph['font'] = 'synthetic-different-font'
                grid = restore_table(doc['structure']['tables'][2], {u['unit_id']: u for u in doc['structure']['units']}, doc, geometry)
                if mode == 'title': self.assertEqual(grid['caption_status'], 'unresolved'); self.assertEqual(grid['caption_segments'], [])
                else: self.assertNotEqual(grid['status'], 'geometry_checked')
            finally: geometry.close()

    def test_duplicate_source_glyph_or_independent_wrong_value_never_chooses_first_match(self):
        doc = self.before['L05']; units = {u['unit_id']: u for u in doc['structure']['units']}
        for mode in ['duplicate', 'independent_value']:
            geometry = SourceGeometry(doc)
            try:
                page = geometry.page(7)
                if mode == 'duplicate':
                    glyph = next(g for g in page['glyphs'] if 446 < g['bbox'][0] < 450 and 97 < g['bbox'][1] < 100)
                    page['glyphs'].append(deepcopy(glyph))
                else:
                    glyph = next(g for g in page['independent'] if g['text'] == '0' and 446 < g['bbox'][0] < 450 and 97 < g['bbox'][1] < 102)
                    glyph['text'] = '9'
                grid = restore_table(doc['structure']['tables'][3], units, doc, geometry)
                self.assertNotEqual(grid['status'], 'geometry_checked')
            finally: geometry.close()

    def test_missing_column_rule_witness_prevents_unsupported_grid_certification(self):
        doc = self.before['L05']; geometry = SourceGeometry(doc)
        try:
            page = geometry.page(7); page['rules'] = [r for r in page['rules'] if r['x0'] < 300]
            grid = restore_table(doc['structure']['tables'][3], {u['unit_id']: u for u in doc['structure']['units']}, doc, geometry)
            self.assertEqual(grid['status'], 'unresolved')
        finally: geometry.close()

    def test_real_cross_page_and_caption_relations_are_checked_without_rewriting_original_spans(self):
        for source_id, refs, method in [('L01', ('#/texts/15', '#/texts/19'), 'numbered_item'), ('L01', ('#/texts/10', '#/texts/11'), 'document_paragraph_indent'),
                                        ('L07', ('#/texts/98', '#/texts/99'), 'explicit_line_end_hyphen'), ('L07', ('#/texts/74', '#/texts/75'), 'explicit_unclosed_parenthesis'),
                                        ('L07', ('#/texts/137', '#/texts/141'), 'explicit_line_end_hyphen'),
                                        ('L07', ('#/texts/113', '#/texts/115'), 'printed_bullet_item'),
                                        ('L07', ('#/texts/148', '#/texts/149'), 'printed_bullet_item'),
                                        ('L07', ('#/texts/168', '#/texts/169'), 'printed_bullet_item')]:
            doc = self.docs[source_id]; units = {u['unit_id']: u for u in doc['structure']['units']}
            edge = next(r for r in doc['structure']['organization']['continuation_recovery']['relations'] if
                        (units[r['from_unit_id']]['native_ref'], units[r['to_unit_id']]['native_ref']) == refs)
            self.assertEqual(edge['status'], 'engineering_checked'); self.assertIn(method, edge['proof_method']); self.assertFalse(edge['human_approved'])
            self.assertEqual(edge['ordered_segments'], units[edge['from_unit_id']]['source_segments'] + units[edge['to_unit_id']]['source_segments'])
        for source_id in self.docs:
            self.assertEqual(rebuild.anchor_digest(self.before[source_id]), rebuild.anchor_digest(self.docs[source_id]))

    def test_different_explicit_cases_and_intervening_heading_are_hard_boundaries(self):
        for mode in ['case', 'heading']:
            source = {'blocks': [{'block_id': 'a', 'text': 'Case 1 shows a hypoin-', 'page': 1, 'bbox': [0, 90, 100, 100]},
                                 {'block_id': 'b', 'text': 'Case 2 tense nodule.', 'page': 2, 'bbox': [0, 10, 100, 20]}]}
            unit = lambda identifier, block: {'unit_id': identifier, 'native_label': 'text', 'kind': 'text', 'content_layer': 'body',
                  'mapping': {'status': 'exact'}, 'source_segments': [{'block_id': block['block_id'], 'start': 0, 'end': len(block['text'])}],
                  'provenance': [{'bbox': block['bbox']}]}
            units = [unit('u1', source['blocks'][0]), unit('u2', source['blocks'][1])]; order = ['u1', 'u2']
            if mode == 'heading':
                units.insert(1, {'unit_id': 'h', 'native_label': 'section_header', 'kind': 'section_header', 'content_layer': 'body', 'source_segments': []}); order.insert(1, 'h')
            class NoGeometry:
                def map_block(self, _): raise AssertionError('Hard boundary must precede geometry matching')
            result = restore_continuations(SimpleNamespace(units=units, reading_order=order, pictures=[]), source, NoGeometry())
            self.assertEqual(result['relations'], [])

    def test_grid_version_and_source_span_corruption_are_rejected(self):
        for mode in ['version', 'source', 'slot']:
            doc = deepcopy(self.docs['L05']); grid = doc['structure']['tables'][3]['source_grid']
            if mode == 'version': grid['text_version'] = 'stale'
            elif mode == 'source': next(c for c in grid['cells'] if c['source_segments'])['source_segments'][0]['block_id'] = 'missing'
            else: grid['cells'][0]['col_end'] = 4
            with self.assertRaises(ParserError): validate_structured(doc)


if __name__ == '__main__': unittest.main()
