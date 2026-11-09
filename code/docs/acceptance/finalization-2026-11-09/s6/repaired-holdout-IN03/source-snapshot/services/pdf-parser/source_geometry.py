"""Auxiliary PDF glyph/rule geometry; decoded raw source remains authoritative."""
from hashlib import sha256
from pathlib import Path
from importlib.metadata import version
import unicodedata

from adapter import CODE, DoclingParseTextAdapter, ParseInput, geometry_for_cell, native_stdout_to_stderr

CONFIG = {'backend': 'docling-parse', 'char_cells': 'COMPUTE_AND_MATERIALIZE', 'shapes': 'COMPUTE_AND_MATERIALIZE',
          'backend_version': version('docling-parse'), 'independent_verifier_version': version('pypdfium2'),
          'sanitization': False, 'keep_glyphs': False, 'ocr': False, 'independent_verifier': 'pdfium_char_geometry',
          'matching': 'NFKD_nonwhitespace_only_no_hyphen_or_value_changes',
          'rule_geometry': 'horizontal_rules_and_vertical_polyline_segments_1'}


def compact(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value) if not c.isspace())


class SourceGeometry:
    def __init__(self, source):
        self.source, self.backend, self.pdf, self.pages = source, None, None, {}
        path, _ = DoclingParseTextAdapter()._read(ParseInput('source-geometry', source['document_id'], source['source']['file_reference'], source['file_sha256'], source['fixture']))
        self.path = path

    def close(self):
        if self.backend:
            with native_stdout_to_stderr(): self.backend.unload()
        if self.pdf: self.pdf.close()

    def page(self, number):
        if number in self.pages: return self.pages[number]
        if self.backend is None:
            from docling_parse.pdf_parser import DoclingPdfParser, DecodeConfig, ContentConfig, ContentLevel
            import pypdfium2 as pdfium
            with native_stdout_to_stderr():
                self.backend = DoclingPdfParser(loglevel='fatal').load(path_or_stream=self.path, lazy=True,
                    decode_config=DecodeConfig(do_sanitization=False, keep_glyphs=False),
                    content_config=ContentConfig(char_cells_content_level=ContentLevel.COMPUTE_AND_MATERIALIZE,
                        word_cells_content_level=ContentLevel.SKIP, line_cells_content_level=ContentLevel.SKIP,
                        shapes_content_level=ContentLevel.COMPUTE_AND_MATERIALIZE, bitmaps_content_level=ContentLevel.SKIP))
            self.pdf = pdfium.PdfDocument(self.path)
        with native_stdout_to_stderr(): page = self.backend.get_page(number)
        info = self.source['pages'][number - 1]; geometry = info['geometry']
        glyphs = []
        for cell in page.char_cells:
            box, _ = geometry_for_cell(cell, geometry)
            glyphs.append({'index': cell.index, 'text': cell.orig if isinstance(cell.orig, str) else cell.text,
                           'bbox': box, 'font': cell.font_name})
        rules, vertical_rules = [], []
        for shape in page.shapes:
            points = [[float(x) * geometry['pdf_user_unit'], geometry['height'] - float(y) * geometry['pdf_user_unit']] for x, y in shape.points]
            for a, b in zip(points, points[1:]):
                if abs(a[0] - b[0]) <= .2 and abs(a[1] - b[1]) >= 1:
                    vertical_rules.append({'x': (a[0] + b[0]) / 2, 'y0': min(a[1], b[1]), 'y1': max(a[1], b[1]), 'shape_index': shape.index})
            if len(points) != 2: continue
            if abs(points[0][1] - points[1][1]) <= .2 and abs(points[0][0] - points[1][0]) >= 8:
                rules.append({'x0': min(p[0] for p in points), 'x1': max(p[0] for p in points), 'y': sum(p[1] for p in points) / 2, 'shape_index': shape.index})
        independent = []
        pdf_page = self.pdf[number - 1]; text_page = pdf_page.get_textpage()
        try:
            # PDFium boxes are PDF coordinates. Use its page-to-device transform,
            # including CropBox/rotation, rather than assuming an unrotated page.
            from ctypes import byref, c_int
            import pypdfium2 as pdfium
            scale = 16; width, height = round(info['width'] * scale), round(info['height'] * scale)
            for index in range(text_page.count_chars()):
                text = text_page.get_text_range(index, 1)
                if not compact(text): continue
                l, b, r, t = text_page.get_charbox(index)
                points = []
                for x, y in [(l, b), (r, t)]:
                    dx, dy = c_int(), c_int()
                    if not pdfium.raw.FPDF_PageToDevice(pdf_page, 0, 0, width, height, 0, x, y, byref(dx), byref(dy)):
                        raise ValueError('pdfium_coordinate_conversion_failed')
                    points.append((dx.value / scale, dy.value / scale))
                independent.append({'text': text, 'bbox': [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]})
        finally: text_page.close(); pdf_page.close()
        result = {'glyphs': glyphs, 'rules': rules, 'vertical_rules': vertical_rules, 'independent': independent}
        self.pages[number] = result
        return result

    def map_block(self, block):
        """Unique geometry-delimited whole-line identity, never first text occurrence."""
        x0, y0, x1, y1 = block['bbox']
        glyphs = [g for g in self.page(block['page'])['glyphs'] if x0 - .6 <= (g['bbox'][0] + g['bbox'][2]) / 2 <= x1 + .6
                  and y0 - .6 <= (g['bbox'][1] + g['bbox'][3]) / 2 <= y1 + .6 and compact(g['text'])]
        glyphs.sort(key=lambda g: (g['bbox'][0], g['index']))
        chars = [(c, i) for i, char in enumerate(block['text']) for c in compact(char)]
        decoded = [(c, g) for g in glyphs for c in compact(g['text'])]
        if ''.join(c for c, _ in chars) != ''.join(c for c, _ in decoded):
            return None
        return [{'offset': i, 'glyph': g} for (_, i), (_, g) in zip(chars, decoded)]


def inside(glyph, bbox):
    x = (glyph['bbox'][0] + glyph['bbox'][2]) / 2; y = (glyph['bbox'][1] + glyph['bbox'][3]) / 2
    return bbox[0] <= x < bbox[2] and bbox[1] <= y < bbox[3]
