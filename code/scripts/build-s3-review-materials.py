#!/usr/bin/env python3
"""Build source-page, native-order/caption overlays and table grids for AI review."""
from hashlib import sha256
from html import escape
from pathlib import Path
import argparse
import json
import pypdfium2
from PIL import ImageDraw, ImageFont

CODE = Path(__file__).resolve().parents[1]
ROOT = CODE / 'docs/acceptance/s3/comparison-2026-11-02'
PAGES = [('L01', 1), ('L01', 2), ('L01', 3), ('MED03', 2), ('MED03', 4),
         ('L05', 5), ('L05', 6), ('L07', 2), ('L07', 3), ('L02', 2)]


def grid(table, units):
    starts = {(c['row_start'], c['col_start']): c for c in table['cells']}
    covered = {(r, col) for c in table['cells'] for r in range(c['row_start'], c['row_end'])
               for col in range(c['col_start'], c['col_end']) if (r, col) != (c['row_start'], c['col_start'])}
    rows = []
    for row in range(table['n_rows']):
        cells = []
        for col in range(table['n_cols']):
            if (row, col) in covered:
                continue
            cell = starts.get((row, col))
            if cell:
                u = units[cell['unit_id']]
                cells.append(f'<td rowspan="{cell["row_span"]}" colspan="{cell["col_span"]}" title="{escape(u["unit_id"])}">{escape(u["native_text"])}</td>')
            else:
                cells.append('<td></td>')
        rows.append('<tr>' + ''.join(cells) + '</tr>')
    return '<table>' + ''.join(rows) + '</table>'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--originals-only', action='store_true')
    parser.add_argument('--revision', default='v1')
    args = parser.parse_args()
    out = ROOT / 'page-review' / args.revision
    out.mkdir(parents=True, exist_ok=True)
    register = json.loads((CODE / 'evaluation/manifests/source-register.json').read_text())
    evidence, sections = [], []
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 14)
    for source_id, physical_page in PAGES:
        source = next(s for s in register['sources'] if s['source_id'] == source_id)
        pdf_path = CODE / source['access']['local_path']
        assert sha256(pdf_path.read_bytes()).hexdigest() == source['access']['sha256']
        prefix = f'{source_id}-p{physical_page:02d}'
        original = out / (prefix + '-original.png')
        with pypdfium2.PdfDocument(pdf_path) as pdf:
            page = pdf[physical_page - 1]; bitmap = page.render(scale=1.6); image = bitmap.to_pil().copy()
            if not original.exists():
                image.save(original)
            bitmap.close(); page.close()
        item = {'source_id': source_id, 'physical_page': physical_page, 'original_pdf_sha256': source['access']['sha256'],
                'original_image': str(original.relative_to(CODE)), 'candidates': {}, 'reviewer_kind': 'AI_engineering_review',
                'human_or_medical_approval': False}
        section = [f'<section id="{prefix}"><h2>{source_id} physical page {physical_page}</h2><a href="{original.name}">Original page</a>']
        if not args.originals_only:
            for candidate in ['docling-standard-cpu', 'mineru-basic-onnx-cpu']:
                path = ROOT / 'runs/guarded-v3/reuse' / candidate / (source_id + '.json')
                if not path.exists():
                    path = ROOT / 'runs/guarded-v3/cold' / candidate / (source_id + '.json')
                if not path.exists():
                    continue
                payload = json.loads(path.read_text())
                if not payload.get('document'):
                    continue
                document = payload['document']; units = {u['unit_id']: u for u in document['structure']['units']}
                rank = {unit_id: i + 1 for i, unit_id in enumerate(document['structure']['reading_order'])}
                overlay = image.copy(); draw = ImageDraw.Draw(overlay)
                geometry = document['pages'][physical_page - 1]
                sx, sy = image.width / geometry['width'], image.height / geometry['height']
                texts = []
                for unit in document['structure']['units']:
                    if unit['kind'] in ['table_cell', 'other']:
                        continue
                    for p in unit['provenance']:
                        if p['physical_page'] != physical_page or p['bbox'] is None:
                            continue
                        box = [p['bbox'][0] * sx, p['bbox'][1] * sy, p['bbox'][2] * sx, p['bbox'][3] * sy]
                        color = '#b000b0' if unit['kind'] == 'caption' else '#d02020' if unit['kind'] in ['table', 'picture'] else '#0060d0'
                        draw.rectangle(box, outline=color, width=2)
                        label = str(rank.get(unit['unit_id'], 'C' if unit['kind'] == 'caption' else '-'))
                        draw.text((box[0], max(0, box[1] - 16)), label, font=font, fill=color, stroke_width=1, stroke_fill='white')
                        texts.append({'unit_id': unit['unit_id'], 'native_order': rank.get(unit['unit_id']), 'kind': unit['kind'],
                                      'native_ref': unit['native_ref'], 'bbox': p['bbox'], 'native_text': unit['native_text'],
                                      'mapping': unit['mapping'], 'source_segments': unit['source_segments']})
                overlay_path = out / f'{prefix}-{candidate}-order.png'
                if overlay_path.exists():
                    raise RuntimeError('Overlay exists; choose a new review revision')
                overlay.save(overlay_path)
                tables = [t for t in document['structure']['tables'] if physical_page in t['physical_pages']]
                pictures = [p for p in document['structure']['pictures'] if physical_page in p['physical_pages']]
                item['candidates'][candidate] = {'IR': str(path.relative_to(CODE)), 'IR_sha256': sha256(path.read_bytes()).hexdigest(),
                    'overlay': str(overlay_path.relative_to(CODE)), 'units': texts, 'tables': tables, 'pictures': pictures}
                section.append(f'<h3>{candidate}</h3><p><a href="{overlay_path.name}">Native order/region overlay</a></p>')
                for t in tables:
                    section.append('<h4>Native table (unverified): ' + escape(t['native_ref']) + '</h4>' + grid(t, units))
                    section.append('<p>Caption links: ' + escape(' | '.join(units[x]['native_text'] for x in t['caption_unit_ids'])) + '</p>')
                for p in pictures:
                    section.append('<p>Picture caption links: ' + escape(' | '.join(units[x]['native_text'] for x in p['caption_unit_ids'])) + '</p>')
                section.append('<details><summary>Native text/order and exact source references</summary><pre>' + escape(json.dumps(texts, ensure_ascii=False, indent=2)) + '</pre></details>')
        section.append('</section>'); sections.extend(section); evidence.append(item)
    index = {'purpose': 'AI engineering review materials; not human gold/medical approval', 'pages': evidence}
    name = 'originals-index.json' if args.originals_only else 'index.json'
    (out / name).write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n')
    if not args.originals_only:
        (out / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>S3 CPU source-page comparison</title><style>body{font:15px system-ui;max-width:1200px;margin:auto;padding:24px}table{border-collapse:collapse;margin:16px 0}td{border:1px solid #777;padding:4px;font-size:12px}pre{white-space:pre-wrap}section{border-top:2px solid #aaa;margin-top:28px}</style><h1>S3 AI engineering source-page comparison</h1><p>Native text/grid outputs are unverified candidate results. Exact quotations use individual source segments. No human or medical approval.</p>' + ''.join(sections))
    print(json.dumps({'index': str((out / name).relative_to(CODE)), 'source_pages': len(evidence), 'human_approval': False}), flush=True)


if __name__ == '__main__':
    main()
