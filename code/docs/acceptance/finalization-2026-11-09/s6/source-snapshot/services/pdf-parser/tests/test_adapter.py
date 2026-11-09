from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import unittest

PARSER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PARSER))
from adapter import (CODE, DoclingParseTextAdapter, ParseInput, ParserError, apply_matrix,
                     normalize_text, normalized_to_raw, resolve_segments)
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, NumberObject, DecodedStreamObject
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from PIL import Image


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
        cls.out = CODE / 'docs/acceptance/s3/constructed' / stamp
        cls.out.mkdir(parents=True, exist_ok=False)
        cls.adapter = DoclingParseTextAdapter()
        raw = BytesIO()
        canvas = Canvas(raw, pagesize=(300, 200))
        for rotation in [0, 90, 180, 270]:
            canvas.drawString(30, 170, f'TOP WORD {rotation}')
            canvas.drawString(30, 30, 'Repeated marker')
            canvas.showPage()
        canvas.save()
        reader, writer = PdfReader(BytesIO(raw.getvalue())), PdfWriter()
        for rotation, page in zip([0, 90, 180, 270], reader.pages):
            page.cropbox.lower_left = (20, 10)
            page.cropbox.upper_right = (280, 190)
            page.rotate(rotation)
            page[NameObject('/UserUnit')] = NumberObject(2)
            writer.add_page(page)
        cls.rotated = cls.out / 'cropped-rotated-userunit.pdf'
        writer.write(cls.rotated)
        cls.document = cls.parse(cls.rotated)
        (cls.out / 'cropped-rotated-ir.json').write_text(json.dumps(cls.document, ensure_ascii=False, indent=2) + '\n')
        (cls.out / 'known-geometry.json').write_text(json.dumps({
            'source': 'ReportLab canvas then explicit PDF CropBox/Rotate/UserUnit', 'media_box': [0, 0, 300, 200],
            'crop_box': [20, 10, 280, 190], 'rotations': [0, 90, 180, 270], 'user_unit': 2,
            'text_draw_positions_pdf_user_space': [[30, 170], [30, 30]],
            'expected_display_dimensions_pt': [[520, 360], [360, 520], [520, 360], [360, 520]],
            'quality_scope': 'constructed geometry, not real-paper fidelity acceptance'}, indent=2) + '\n')

    @classmethod
    def parse(cls, path, **options):
        return cls.adapter.parse(ParseInput('constructed-test', 'constructed-pdf', str(path), sha256(path.read_bytes()).hexdigest(), True), **options)

    def test_normalization_retains_unicode_and_exact_raw_mapping(self):
        raw = '中😀βe\u0301 ² 7 mm\r\n下一段\r末尾'
        text, mapping = normalize_text(raw)
        self.assertEqual(text, '中😀βe\u0301 ² 7 mm\n下一段\n末尾')
        block = {'raw_text': raw, 'text': text, 'normalization_map': mapping}
        start = text.index('😀')
        a, b = normalized_to_raw(block, start, start + 2)
        self.assertEqual(raw[a:b], '😀β')
        a, b = normalized_to_raw(block, text.index('\n'), text.index('\n') + 1)
        self.assertEqual(raw[a:b], '\r\n')
        for interval in [(0, 0), (-1, 2), (0, 999), (True, 2)]:
            with self.assertRaisesRegex(ParserError, 'nonempty'):
                normalized_to_raw(block, *interval)

    def test_actual_pdf_geometry_crop_rotation_userunit_and_physical_pages(self):
        document = self.document
        self.assertEqual([p['physical_page'] for p in document['pages']], [1, 2, 3, 4])
        self.assertTrue(document['fixture'])
        for page, rotation, dims in zip(document['pages'], [0, 90, 180, 270], [(520, 360), (360, 520), (520, 360), (360, 520)]):
            self.assertEqual(page['rotation'], rotation)
            self.assertEqual((page['width'], page['height']), dims)
            geometry = page['geometry']
            self.assertEqual(geometry['coordinate_system'], 'crop_rotated_top_left')
            top = next(b for b in document['blocks'] if b['page'] == page['physical_page'] and b['text'].startswith('TOP WORD'))
            # Known canvas position: the raw PDF textline begins at x=30 and
            # its glyph box straddles the y=170 baseline, for every /Rotate.
            pdf_box = top['source_geometry']['pdf_bbox']
            self.assertAlmostEqual(pdf_box[0], 30, places=3)
            self.assertLess(pdf_box[1], 170)
            self.assertGreater(pdf_box[3], 170)
            x0, y0, x1, y1 = top['bbox']
            corners = [apply_matrix(geometry['canonical_to_pdf'], x, y) for x, y in [(x0, y0), (x1, y1)]]
            actual = [min(p[0] for p in corners), min(p[1] for p in corners), max(p[0] for p in corners), max(p[1] for p in corners)]
            for a, b in zip(actual, pdf_box):
                self.assertAlmostEqual(a, b, places=4)

    def test_exact_segments_disambiguate_repetition_cross_pages_and_reject_versions(self):
        document = self.document
        blocks = [b for b in document['blocks'] if b['text'] == 'Repeated marker'][:2]
        segments = [{'block_id': b['block_id'], 'text_version': document['text_version'], 'start': 0, 'end': len(b['text'])} for b in blocks]
        reference = {'document_id': document['document_id'], 'text_version': document['text_version'], 'segments': segments, 'joiner': '\n'}
        located = resolve_segments(document, **reference)
        self.assertEqual(located['quote'], 'Repeated marker\nRepeated marker')
        self.assertEqual([s['physical_page'] for s in located['segments']], [1, 2])
        with self.assertRaisesRegex(ParserError, 'another document'):
            resolve_segments(document, **{**reference, 'document_id': 'other'})
        with self.assertRaisesRegex(ParserError, 'another text version'):
            resolve_segments(document, **{**reference, 'text_version': 'obsolete'})
        with self.assertRaisesRegex(ParserError, 'same text version'):
            resolve_segments(document, **{**reference, 'segments': [{**segments[0], 'text_version': 'obsolete'}]})
        with self.assertRaisesRegex(ParserError, 'reverse'):
            resolve_segments(document, **{**reference, 'segments': list(reversed(segments))})
        (self.out / 'cross-page-reference.json').write_text(json.dumps(reference, indent=2) + '\n')
        (self.out / 'cross-page-location.json').write_text(json.dumps(located, indent=2) + '\n')

    def test_stable_versions_and_config_changes_do_not_reuse_references(self):
        repeated = self.parse(self.rotated)
        self.assertEqual(repeated['text_version'], self.document['text_version'])
        changed = DoclingParseTextAdapter(config_revision='different').parse(ParseInput('new-run', 'constructed-pdf', str(self.rotated), sha256(self.rotated.read_bytes()).hexdigest(), True))
        self.assertNotEqual(changed['text_version'], repeated['text_version'])
        self.assertTrue(set(b['block_id'] for b in changed['blocks']).isdisjoint(b['block_id'] for b in repeated['blocks']))

    def test_unicode_code_point_offsets_in_an_actual_constructed_pdf(self):
        path = self.out / 'unicode-text.pdf'
        generated = self.out / 'unicode-generated-reportlab-original.pdf'
        pdfmetrics.registerFont(TTFont('S3Unicode', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
        canvas = Canvas(str(generated), pagesize=(400, 200)); canvas.setFont('S3Unicode', 14)
        expected = '😀 β e\u0301 7 mm²'
        canvas.drawString(30, 170, expected); canvas.showPage(); canvas.save()
        # ReportLab 5.1.0 emits <1F600> for the astral destination. Keep that
        # original generated PDF as failure evidence; create a separate valid
        # test PDF whose ToUnicode uses the required UTF-16BE surrogate pair.
        # Production PDFs are never changed or repaired by this test helper.
        reader, writer = PdfReader(generated), PdfWriter()
        repaired = 0
        for font_reference in reader.pages[0]['/Resources']['/Font'].values():
            font = font_reference.get_object()
            if '/ToUnicode' in font:
                original = font['/ToUnicode'].get_object().get_data()
                if b'<1F600>' in original:
                    stream = DecodedStreamObject()
                    stream.set_data(original.replace(b'<1F600>', b'<D83DDE00>'))
                    font[NameObject('/ToUnicode')] = stream
                    repaired += 1
        self.assertEqual(repaired, 1)
        writer.add_page(reader.pages[0]); writer.write(path)
        (self.out / 'unicode-generator-repair.json').write_text(json.dumps({
            'generator': 'reportlab-5.1.0', 'generated_original': generated.name, 'valid_test_pdf': path.name,
            'before_destination': '<1F600>', 'after_destination': '<D83DDE00>', 'expected_code_point': 'U+1F600',
            'basis': 'Adobe PDF Reference 1.7 section 5.9.2: ToUnicode destinations use UTF-16BE',
            'source': 'https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.7old.pdf',
            'only_constructed_fixture_changed': True, 'production_repair_enabled': False}, indent=2) + '\n')
        document = self.parse(path)
        self.assertEqual(' '.join(b['raw_text'] for b in document['blocks']), expected)
        emoji_block = next(b for b in document['blocks'] if '😀' in b['text'])
        beta_start = emoji_block['text'].index('β')
        beta = resolve_segments(document, document_id=document['document_id'], text_version=document['text_version'],
                                segments=[{'block_id': emoji_block['block_id'], 'text_version': document['text_version'], 'start': beta_start, 'end': beta_start + 1}])
        self.assertEqual(beta['quote'], 'β')
        self.assertEqual(beta_start, 2)  # UTF-16 would count the leading emoji twice.
        block = next(b for b in document['blocks'] if '7 mm' in b['text'])
        start = block['text'].index('7 mm²')
        located = resolve_segments(document, document_id=document['document_id'], text_version=document['text_version'],
                                   segments=[{'block_id': block['block_id'], 'text_version': document['text_version'], 'start': start, 'end': start + 5}])
        self.assertEqual(located['quote'], '7 mm²')
        self.assertEqual(located['raw_quote'], '7 mm²')
        cross_block = resolve_segments(document, document_id=document['document_id'], text_version=document['text_version'], joiner=' ',
                                       segments=[{'block_id': b['block_id'], 'text_version': document['text_version'], 'start': 0, 'end': len(b['text'])} for b in document['blocks']])
        self.assertEqual(cross_block['quote'], expected)
        self.assertEqual(cross_block['raw_quote'], expected)
        (self.out / 'unicode-cross-block-location.json').write_text(json.dumps(cross_block, ensure_ascii=False, indent=2) + '\n')
        (self.out / 'unicode-text-ir.json').write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n')

    def test_scanned_mixed_and_blank_pages_remain_partial_or_unsupported(self):
        path = self.out / 'text-scan-mixed-blank.pdf'
        canvas = Canvas(str(path), pagesize=(300, 200))
        raster = ImageReader(Image.new('RGB', (100, 60), 'white'))
        canvas.drawString(30, 170, 'Text layer only'); canvas.showPage()
        canvas.drawImage(raster, 20, 20, width=200, height=120); canvas.showPage()
        canvas.drawString(30, 170, 'Partial text and unexamined image')
        canvas.drawImage(raster, 20, 20, width=200, height=100); canvas.showPage()
        canvas.showPage(); canvas.save()
        document = self.parse(path)
        self.assertEqual(document['parser']['status'], 'partial')
        self.assertEqual(document['coverage']['pages_without_text'], [2, 4])
        self.assertEqual(document['pages'][1]['ocr_requirement'], 'required')
        self.assertEqual(document['pages'][2]['ocr_requirement'], 'possible_image_text_unverified')
        self.assertFalse(document['coverage']['full_content_coverage_verified'])
        self.assertFalse(document['coverage']['fidelity_human_verified'])
        (self.out / 'text-scan-mixed-blank-ir.json').write_text(json.dumps(document, indent=2) + '\n')
        reader, writer = PdfReader(path), PdfWriter()
        writer.add_page(reader.pages[1]); scan = self.out / 'scan-only.pdf'; writer.write(scan)
        unsupported = self.parse(scan)
        self.assertEqual(unsupported['parser']['status'], 'unsupported')
        self.assertEqual(unsupported['blocks'], [])

    def test_failed_geometry_page_is_listed_without_discarding_other_pages(self):
        reader, writer = PdfReader(self.rotated), PdfWriter()
        reader.pages[1].cropbox.upper_right = (999, 999)
        for page in reader.pages:
            writer.add_page(page)
        path = self.out / 'unsupported-crop-one-page.pdf'; writer.write(path)
        document = self.parse(path)
        self.assertEqual(document['parser']['status'], 'partial')
        self.assertEqual(document['coverage']['failed_pages'], [{'physical_page': 2, 'code': 'unsupported_page_geometry'}])
        self.assertEqual([p['physical_page'] for p in document['pages']], [1, 2, 3, 4])
        self.assertEqual({b['page'] for b in document['blocks']}, {1, 3, 4})

    def test_encrypted_damaged_changed_sha_and_outside_root_return_structured_errors(self):
        writer = PdfWriter(); writer.add_blank_page(width=300, height=200); writer.encrypt('test-password', algorithm='RC4-40')
        encrypted = self.out / 'encrypted.pdf'; writer.write(encrypted)
        with self.assertRaisesRegex(ParserError, 'Encrypted'):
            self.parse(encrypted)
        damaged = self.out / 'damaged.pdf'; damaged.write_bytes(b'%PDF-1.7\ninvalid-page-tree')
        with self.assertRaisesRegex(ParserError, 'page tree'):
            self.parse(damaged)
        with self.assertRaisesRegex(ParserError, 'expected SHA256'):
            self.adapter.parse(ParseInput('run', 'doc', str(self.rotated), '0' * 64))
        with self.assertRaisesRegex(ParserError, 'outside'):
            self.adapter.parse(ParseInput('run', 'doc', '../AGENTS.md', '0' * 64))

    def test_cli_json_contract_exit_status_and_output_immutability(self):
        output = self.out / 'cli-result.json'
        args = [str(CODE / '.venv/bin/python'), str(PARSER / 'cli.py'), 'parse', '--run-id', 'cli-test',
                '--document-id', 'cli-constructed', '--file-reference', str(self.rotated),
                '--file-sha256', sha256(self.rotated.read_bytes()).hexdigest(), '--fixture', '--output', str(output)]
        first = subprocess.run(args, capture_output=True, text=True, cwd=CODE)
        self.assertEqual(first.returncode, 0, first.stderr)
        content = output.read_bytes()
        second = subprocess.run(args, capture_output=True, text=True, cwd=CODE)
        self.assertEqual(second.returncode, 1)
        self.assertEqual(json.loads(second.stdout)['error']['code'], 'output_already_exists')
        self.assertEqual(output.read_bytes(), content)


if __name__ == '__main__':
    unittest.main(verbosity=2)
