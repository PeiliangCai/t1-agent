"""Conservative source-font uncertainty, never semantic unit replacement.

A one-code embedded custom font without ToUnicode does not establish that its
Latin-looking extraction matches the displayed glyph. Preserve its decoded text
and quarantine the exact source offsets, or the whole line if alignment fails.
"""
from hashlib import sha256
import unicodedata

VERSION = 'sparse-embedded-font-no-unicode-1'


def font_key(value):
    return str(value).lstrip('/').split('+', 1)[-1]


def sparse_unmapped_fonts(pdf_page):
    fonts = {}
    resources = pdf_page.get('/Resources')
    if not resources:
        return fonts
    font_resources = resources.get_object().get('/Font', {})
    if hasattr(font_resources, 'get_object'):
        font_resources = font_resources.get_object()
    for resource, ref in font_resources.items():
        font = ref.get_object()
        if font.get('/ToUnicode') is not None or font.get('/FirstChar') != font.get('/LastChar') or not isinstance(font.get('/FirstChar'), int):
            continue
        descriptor = font.get('/FontDescriptor')
        if not descriptor:
            continue
        descriptor = descriptor.get_object()
        program = next((descriptor.get(key) for key in ['/FontFile3', '/FontFile2', '/FontFile'] if descriptor.get(key) is not None), None)
        if program is None:
            continue
        raw = program.get_object().get_data()
        if not raw:
            continue
        name = str(font.get('/BaseFont') or descriptor.get('/FontName') or resource)
        fonts[font_key(name)] = {'font_name': name, 'font_program_sha256': sha256(raw).hexdigest(),
                                'pdf_character_code': int(font['/FirstChar']),
                                'code': 'sparse_embedded_font_without_unicode_mapping'}
    return fonts


def compact(text):
    return ''.join(c for c in unicodedata.normalize('NFKD', text) if not c.isspace())


def mark_line_glyph_issues(block, glyphs, suspicious_fonts):
    if not suspicious_fonts:
        return []
    x0, y0, x1, y1 = block['bbox']
    line = [g for g in glyphs if x0 - .6 <= (g['bbox'][0] + g['bbox'][2]) / 2 <= x1 + .6
            and y0 - .6 <= (g['bbox'][1] + g['bbox'][3]) / 2 <= y1 + .6 and compact(g['text'])]
    line.sort(key=lambda g: (g['bbox'][0], g['index']))
    risky = [g for g in line if font_key(g['font']) in suspicious_fonts]
    if not risky:
        return []
    chars = [(c, i) for i, character in enumerate(block['text']) for c in compact(character)]
    decoded = [(c, g) for g in line for c in compact(g['text'])]
    exact = ''.join(c for c, _ in chars) == ''.join(c for c, _ in decoded)
    issues = []
    if exact:
        for (_, offset), (_, glyph) in zip(chars, decoded):
            if font_key(glyph['font']) in suspicious_fonts:
                issues.append({**suspicious_fonts[font_key(glyph['font'])], 'start': offset, 'end': offset + 1, 'precision': 'glyph_offset'})
    else:
        for glyph in risky:
            issues.append({**suspicious_fonts[font_key(glyph['font'])], 'start': 0, 'end': len(block['text']), 'precision': 'whole_textline_fallback'})
    return list({(i['start'], i['end'], i['font_program_sha256']): i for i in issues}.values())
