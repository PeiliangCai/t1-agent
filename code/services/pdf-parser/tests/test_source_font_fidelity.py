"""Mechanical font uncertainty tests. No semantic spelling/unit correction."""
from pathlib import Path
import sys
import unittest
from pypdf.generic import DictionaryObject, NameObject, NumberObject, DecodedStreamObject

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from source_font_fidelity import sparse_unmapped_fonts, mark_line_glyph_issues


def font_page(first=109, last=109, unicode_map=False):
    program = DecodedStreamObject(); program.set_data(b'synthetic-font-program')
    font = DictionaryObject({NameObject('/FirstChar'): NumberObject(first), NameObject('/LastChar'): NumberObject(last),
        NameObject('/BaseFont'): NameObject('/ABCDEF+Custom'), NameObject('/FontDescriptor'):
        DictionaryObject({NameObject('/FontFile3'): program})})
    if unicode_map:
        mapping = DecodedStreamObject(); mapping.set_data(b'synthetic-unicode-map')
        font[NameObject('/ToUnicode')] = mapping
    return DictionaryObject({NameObject('/Resources'): DictionaryObject({NameObject('/Font'):
        DictionaryObject({NameObject('/F1'): font})})})


class SourceFontFidelityTests(unittest.TestCase):
    def test_one_code_unmapped_embedded_font_is_uncertain_without_guessing_unicode(self):
        fonts = sparse_unmapped_fonts(font_page())
        self.assertEqual(fonts['Custom']['pdf_character_code'], 109)
        block = {'text': '50 mm', 'bbox': [0, 0, 50, 10]}
        glyphs = [{'index': i, 'text': c, 'font': 'ABCDEF+Custom' if i == 3 else 'Helvetica',
                   'bbox': [i*5, 0, i*5+4, 10]} for i, c in enumerate('50 mm')]
        issues = mark_line_glyph_issues(block, glyphs, fonts)
        self.assertEqual([(g['start'], g['end'], g['precision']) for g in issues], [(3, 4, 'glyph_offset')])
        self.assertEqual(block['text'], '50 mm')

    def test_latin_mm_and_regular_embedded_font_are_not_flagged(self):
        self.assertEqual(sparse_unmapped_fonts(font_page(32, 255)), {})
        self.assertEqual(sparse_unmapped_fonts(font_page(unicode_map=True)), {})
        block = {'text': '50 mm', 'bbox': [0, 0, 50, 10]}
        glyphs = [{'index': i, 'text': c, 'font': 'Helvetica', 'bbox': [i*5, 0, i*5+4, 10]} for i, c in enumerate('50 mm')]
        self.assertEqual(mark_line_glyph_issues(block, glyphs, sparse_unmapped_fonts(font_page())), [])

    def test_alignment_failure_quarantines_only_the_source_line(self):
        block = {'text': '50 mm', 'bbox': [0, 0, 50, 10]}
        glyphs = [{'index': 1, 'text': 'm', 'font': 'Custom', 'bbox': [15, 0, 19, 10]},
                  {'index': 2, 'text': 'm', 'font': 'Custom', 'bbox': [15, 20, 19, 30]}]
        issues = mark_line_glyph_issues(block, glyphs, sparse_unmapped_fonts(font_page()))
        self.assertEqual([(g['start'], g['end'], g['precision']) for g in issues], [(0, 5, 'whole_textline_fallback')])


if __name__ == '__main__':
    unittest.main()
