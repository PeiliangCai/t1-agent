#!/usr/bin/env python3
"""Readable native table grid snapshots; neither quotes nor accepted clinical data."""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFont

CODE = Path(__file__).resolve().parents[1]
ROOT = CODE / 'docs/acceptance/s3/comparison-2026-11-02'
OUT = ROOT / 'page-review/v1'
FONT = ImageFont.truetype(str(CODE / '.tools/pdf-parser/fonts/NotoSansCJKsc-Regular.otf'), 17)
SMALL = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 14)
CASES = [('L01', 2), ('L01', 3), ('MED03', 4), ('L05', 5), ('L05', 6), ('L02', 2)]


def wrap(text, width, draw):
    lines, line = [], ''
    for char in text:
        if char == '\n' or draw.textlength(line + char, font=FONT) > width:
            lines.append(line); line = '' if char == '\n' else char
        else:
            line += char
    lines.append(line)
    return lines


def main():
    records = []
    for candidate in ['docling-standard-cpu', 'mineru-basic-onnx-cpu']:
        for source_id, page in CASES:
            path = ROOT / 'runs/guarded-v3/reuse' / candidate / (source_id + '.json')
            document = json.loads(path.read_text())['document']; units = {u['unit_id']: u for u in document['structure']['units']}
            for index, table in enumerate(document['structure']['tables']):
                if page not in table['physical_pages'] or not table['n_cols'] or not table['n_rows']:
                    continue
                cols, rows = table['n_cols'], table['n_rows']
                cw = max(90, min(220, 1600 // cols)); heights = [42] * rows
                measure = ImageDraw.Draw(Image.new('RGB', (10, 10)))
                for cell in table['cells']:
                    lines = wrap(units[cell['unit_id']]['native_text'], cell['col_span'] * cw - 12, measure)
                    required = (len(lines) * 24 + 10 + cell['row_span'] - 1) // cell['row_span']
                    for r in range(cell['row_start'], min(rows, cell['row_end'])):
                        heights[r] = max(heights[r], required)
                boundaries = [100]
                for h in heights:
                    boundaries.append(boundaries[-1] + h)
                image = Image.new('RGB', (cols * cw + 60, boundaries[-1] + 70), 'white'); draw = ImageDraw.Draw(image)
                draw.text((12, 8), f'{source_id} physical page {page} | {candidate}', font=SMALL, fill='black')
                draw.text((12, 30), f'Native grid: {table["native_ref"]}  ({rows} rows x {cols} columns)', font=SMALL, fill='black')
                draw.text((12, 53), 'AI engineering comparison. Native grid/text can be WRONG. Not literal quotations or medical approval.', font=SMALL, fill='#a00000')
                for cell in table['cells']:
                    r0, r1, c0, c1 = cell['row_start'], cell['row_end'], cell['col_start'], cell['col_end']
                    if r1 > rows or c1 > cols:
                        continue
                    x0, x1, y0, y1 = 45 + c0 * cw, 45 + c1 * cw, boundaries[r0], boundaries[r1]
                    draw.rectangle((x0, y0, x1, y1), outline='#333333', fill='#f2f4f5' if r0 == 0 else 'white', width=1)
                    for line_number, line in enumerate(wrap(units[cell['unit_id']]['native_text'], x1 - x0 - 12, draw)):
                        draw.text((x0 + 6, y0 + 4 + line_number * 24), line, font=FONT, fill='black')
                for row in range(rows):
                    draw.text((5, boundaries[row] + 5), str(row), font=SMALL, fill='#555555')
                for col in range(cols):
                    draw.text((45 + col * cw + 3, 80), str(col), font=SMALL, fill='#555555')
                target = OUT / f'{source_id}-p{page:02d}-{candidate}-table{index}-grid.png'
                if target.exists():
                    raise RuntimeError('Native table snapshot exists; preserve prior evidence')
                image.save(target)
                records.append({'source_id': source_id, 'physical_page': page, 'candidate_id': candidate,
                                'native_ref': table['native_ref'], 'table_id': table['table_id'],
                                'grid_image': str(target.relative_to(CODE)), 'IR': str(path.relative_to(CODE)),
                                'association_status': table['association_status'], 'semantically_usable': False})
    (OUT / 'native-grid-index.json').write_text(json.dumps({'purpose': 'Native candidate output, not accepted table truth', 'items': records}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'table_snapshots': len(records)}))


if __name__ == '__main__':
    main()
