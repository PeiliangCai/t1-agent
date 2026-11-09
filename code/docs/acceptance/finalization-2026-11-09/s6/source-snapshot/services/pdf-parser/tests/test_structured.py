"""Engineering regressions using real retained native artifacts, no mock parsing."""
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
import unittest

PARSER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PARSER))
from adapter import CODE, DoclingParseTextAdapter, ParseInput, ParserError, resolve_segments
from structured import (Builder, align_sources, build_ir, guard_caption_associations,
                        mineru_structure, validate_structured)
from pypdf import PdfWriter

ROOT = CODE / 'docs/acceptance/s3/comparison-2026-11-02'
CANDIDATES = ['docling-standard-cpu', 'mineru-basic-onnx-cpu']
IDS = ['MED03', 'L07', 'L05', 'L01', 'L02']


def load(candidate, source, revision='guarded-v4'):
    return json.loads((ROOT / 'runs' / revision / 'reuse' / candidate / (source + '.json')).read_text())['document']


class StructuredTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
        cls.out = ROOT / 'validation' / ('constructed-' + stamp)
        cls.out.mkdir(parents=True)
        cls.documents = {(c, s): load(c, s) for c in CANDIDATES for s in IDS}

    def test_actual_both_candidates_keep_source_native_and_quality_boundaries(self):
        for source_id in IDS:
            first, second = [self.documents[c, source_id] for c in CANDIDATES]
            self.assertEqual([(b['raw_text'], b['text'], b['bbox']) for b in first['blocks']],
                             [(b['raw_text'], b['text'], b['bbox']) for b in second['blocks']])
            self.assertNotEqual(first['text_version'], second['text_version'])
            for doc in [first, second]:
                validate_structured(doc)
                self.assertFalse(doc['fixture'])
                self.assertFalse(doc['coverage']['full_content_coverage_verified'])
                self.assertFalse(doc['structure']['human_fidelity_verified'])
                self.assertEqual(doc['coverage']['native_pages'], list(range(1, len(doc['pages']) + 1)))
                self.assertFalse(doc['structure']['native_processed_text_is_authoritative_quote'])
                self.assertEqual(doc['metrics']['llm_calls'], 0)
                artifact = CODE / doc['native_artifact']['path']
                self.assertEqual(sha256(artifact.read_bytes()).hexdigest(), doc['native_artifact']['sha256'])
                self.assertTrue(all(not t['usable_for_semantic_interpretation'] for t in
                                    doc['structure']['tables'] + doc['structure']['pictures']))

    def test_actual_cross_column_charspans_map_separately_and_quote_preserves_segments(self):
        doc = self.documents['docling-standard-cpu', 'MED03']
        unit = next(u for u in doc['structure']['units'] if u['native_ref'] == '#/texts/20')
        self.assertEqual(len(unit['provenance']), 2)
        self.assertTrue(unit['mapping']['native_provenance_partitioned'])
        self.assertEqual(unit['mapping']['status'], 'normalized_alignment')
        self.assertEqual(unit['mapping']['matched_native_code_points'], unit['mapping']['alignable_native_code_points'])
        self.assertGreaterEqual(len(unit['source_segments']), 20)
        located = resolve_segments(doc, document_id=doc['document_id'], text_version=doc['text_version'],
                                   segments=unit['source_segments'], joiner='\n')
        self.assertEqual(len(located['segments']), len(unit['source_segments']))
        blocks = {b['block_id']: b for b in doc['blocks']}
        self.assertEqual(located['quote'], '\n'.join(blocks[s['block_id']]['text'][s['start']:s['end']] for s in unit['source_segments']))
        self.assertIn('neoadjuvant', located['quote'])
        self.assertIn('chemotherapy and colectomy', located['quote'])
        (self.out / 'real-cross-column-locator.json').write_text(json.dumps(located, ensure_ascii=False, indent=2) + '\n')

    def test_actual_caption_conflicts_keep_original_link_and_reject_its_use(self):
        for source_id, collection, ref, reason in [
            ('L05', 'tables', '#/tables/2', 'caption_type_conflicts_with_native_parent'),
            ('L07', 'pictures', '#/pictures/11', 'tiny_picture_and_remote_numbered_caption_geometry_conflict')]:
            doc = self.documents['docling-standard-cpu', source_id]
            entry = next(t for t in doc['structure'][collection] if t['native_ref'] == ref)
            self.assertTrue(entry['caption_unit_ids'])
            self.assertEqual(entry['association_status'], 'conflict')
            self.assertFalse(entry['usable_for_semantic_interpretation'])
            self.assertTrue(any(r['reason'] == reason and r['native_retained'] and r['project_status'] == 'rejected_conflict'
                                for r in entry['caption_relationships']))
        # Validly sized figures are not relinked or rejected by the tiny-icon rule.
        doc = self.documents['docling-standard-cpu', 'L07']
        true_image = next(p for p in doc['structure']['pictures'] if p['native_ref'] == '#/pictures/12')
        self.assertEqual(true_image['caption_unit_ids'], [])

    def test_actual_ambiguous_repeated_table_cells_are_not_given_first_match(self):
        doc = self.documents['mineru-basic-onnx-cpu', 'MED03']
        cells = [u for u in doc['structure']['units'] if u['mapping']['status'] == 'ambiguous']
        self.assertGreater(len(cells), 500)
        self.assertTrue(all(u['kind'] == 'table_cell' for u in cells))
        self.assertTrue(all(u['source_segments'] == [] for u in cells))
        self.assertTrue(all(p['precision'] == 'native_table_region_only' for u in cells for p in u['provenance']))

    def test_actual_small_table_cells_inside_long_source_rows_keep_unique_exact_offsets(self):
        doc = self.documents['docling-standard-cpu', 'L05']
        original = deepcopy(doc['blocks'])
        for label in ['AAH', 'AIS', 'MIA']:
            unit = next(u for u in doc['structure']['units'] if u['native_ref'].startswith('#/tables/0/data/table_cells/') and u['native_text'] == label)
            segments, mapping = align_sources(label, unit['provenance'], doc)
            self.assertIn(mapping['status'], ['exact', 'normalized_alignment'], label)
            blocks = {b['block_id']: b for b in doc['blocks']}
            self.assertEqual(''.join(blocks[s['block_id']]['text'][s['start']:s['end']] for s in segments), label)
        # IAC occurs more than once in its decoded row; geometry is not exact glyph geometry.
        unit = next(u for u in doc['structure']['units'] if u['native_ref'] == '#/tables/0/data/table_cells/4')
        segments, mapping = align_sources(unit['native_text'], unit['provenance'], doc)
        self.assertEqual(segments, []); self.assertEqual(mapping['status'], 'ambiguous')
        self.assertEqual(doc['blocks'], original)

    def test_small_cell_geometry_does_not_choose_a_repeated_value_or_a_different_row(self):
        source = {'text_version': 'v', 'blocks': [
            {'block_id': 'other-row', 'page': 1, 'bbox': [0, 0, 1000, 10], 'text': 'AAH', 'text_version': 'v', 'reading_order': 0},
            {'block_id': 'row', 'page': 1, 'bbox': [0, 20, 1000, 30], 'text': '0.001 0.001', 'text_version': 'v', 'reading_order': 1}]}
        locations = [{'physical_page': 1, 'bbox': [300, 20, 330, 30]}]
        segments, mapping = align_sources('0.001', locations, source)
        self.assertEqual(segments, []); self.assertEqual(mapping['status'], 'ambiguous')
        segments, mapping = align_sources('AAH', locations, source)
        self.assertEqual(segments, []); self.assertEqual(mapping['status'], 'unmapped')

    def test_native_table_html_spans_are_retained_without_inventing_cell_geometry(self):
        source = self.documents['mineru-basic-onnx-cpu', 'L01']
        html = '<table><tr><th rowspan="2">A</th><th colspan="2">B</th></tr><tr><td>1</td><td>1</td></tr></table>'
        native = {'pages': [{'page_idx': 0, 'blocks': [{'type': 'table', 'bbox': [0.1, 0.1, 0.9, 0.8],
                   'content': [{'type': 'table_body', 'content': html}]}]}]}
        builder, pages = mineru_structure(native, source, 'constructed-html')
        table = builder.tables[0]
        self.assertEqual(pages, [1])
        self.assertEqual((table['n_rows'], table['n_cols']), (2, 3))
        self.assertEqual(table['native_html'], html)
        self.assertEqual((table['cells'][0]['row_span'], table['cells'][1]['col_span']), (2, 2))
        self.assertEqual([c['col_start'] for c in table['cells'][2:]], [1, 2])
        self.assertTrue(all(p['precision'] == 'native_table_region_only' for u in builder.units if u['kind'] == 'table_cell' for p in u['provenance']))

    def test_unicode_dehyphenation_matches_do_not_replace_raw_source(self):
        source = {'text_version': 'v', 'blocks': [{'block_id': 'a', 'page': 1, 'bbox': [0, 0, 100, 10], 'text': '😀 micro-', 'text_version': 'v', 'reading_order': 0},
                             {'block_id': 'b', 'page': 1, 'bbox': [0, 10, 100, 20], 'text': 'scopic β e\u0301', 'text_version': 'v', 'reading_order': 1}]}
        locations = [{'physical_page': 1, 'bbox': [0, 0, 100, 20]}]
        segments, mapping = align_sources('😀 microscopic β é', locations, source)
        self.assertEqual(mapping['status'], 'normalized_alignment')
        self.assertEqual(segments[0]['start'], 0)
        self.assertEqual(segments[0]['end'], len('😀 micro-'))
        self.assertEqual(segments[1]['end'], len('scopic β e\u0301'))
        self.assertEqual(source['blocks'][0]['text'], '😀 micro-')
        self.assertEqual(source['blocks'][1]['text'], 'scopic β e\u0301')

    def test_actual_ir_versions_and_partial_source_coverage_are_rejected_if_corrupted(self):
        doc = self.documents['docling-standard-cpu', 'L01']
        for change in ['version', 'coverage', 'normalization']:
            broken = deepcopy(doc)
            if change == 'version':
                broken['blocks'][0]['text_version'] = 'old-version'
            elif change == 'coverage':
                broken['coverage']['expected_block_ids'] = broken['coverage']['expected_block_ids'][1:]
            else:
                broken['blocks'][0]['raw_text'] += 'corruption'
            with self.assertRaises(ParserError):
                validate_structured(broken)
        unit = next(u for u in doc['structure']['units'] if u['source_segments'])
        other = self.documents['mineru-basic-onnx-cpu', 'L01']
        with self.assertRaises(ParserError):
            resolve_segments(other, document_id=doc['document_id'], text_version=doc['text_version'], segments=unit['source_segments'])

    def test_structured_cli_returns_real_preparse_errors_without_model_inference(self):
        encrypted = self.out / 'encrypted.pdf'
        writer = PdfWriter(); writer.add_blank_page(width=300, height=200); writer.encrypt('test-password', algorithm='RC4-40'); writer.write(encrypted)
        damaged = self.out / 'damaged.pdf'; damaged.write_bytes(b'%PDF-1.7\ninvalid-page-tree')
        real = CODE / 'evaluation/corpus/development-candidates/L01.pdf'
        cases = [('docling-standard-cpu', encrypted, sha256(encrypted.read_bytes()).hexdigest(), 'encrypted_pdf_unsupported'),
                 ('mineru-basic-onnx-cpu', damaged, sha256(damaged.read_bytes()).hexdigest(), 'invalid_or_damaged_pdf'),
                 ('mineru-basic-onnx-cpu', real, '0' * 64, 'file_sha256_mismatch'),
                 ('not-a-candidate', real, sha256(real.read_bytes()).hexdigest(), 'candidate_not_allowed')]
        results = []
        for candidate, path, digest, expected in cases:
            command = [sys.executable, str(PARSER / 'structured-cli.py'), 'parse', '--candidate-id', candidate,
                       '--run-id', 'constructed-errors', '--document-id', 'constructed-errors', '--file-reference', str(path), '--file-sha256', digest,
                       '--log-directory', str(self.out.relative_to(CODE))]
            result = subprocess.run(command, cwd=CODE, capture_output=True, text=True, timeout=30)
            payload = json.loads(result.stdout)
            results.append({'candidate': candidate, 'expected': expected, 'actual': payload, 'exit_code': result.returncode, 'stderr': result.stderr})
            self.assertEqual(result.returncode, 1)
            self.assertIsNone(payload['document'])
            self.assertEqual(payload['error']['code'], expected)
        (self.out / 'structured-cli-errors.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    unittest.main()
