#!/usr/bin/env python3
"""Render selected engineering location previews locally; no quality approval."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import pypdfium2
from PIL import ImageDraw

CODE = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--summary', required=True)
    args = parser.parse_args()
    summary_path = CODE / args.summary
    summary = json.loads(summary_path.read_text())
    out = summary_path.parent / 'localization-previews'
    out.mkdir(exist_ok=False)
    index = []
    for record in summary['results']:
        if record['source_id'] not in ['MED03', 'L01']:
            continue
        document = json.loads((CODE / record['output']).read_text())['document']
        location = json.loads((summary_path.parent / (record['source_id'] + '.location.json')).read_text())
        source = CODE / record['file_reference']
        assert sha256(source.read_bytes()).hexdigest() == record['sha256']
        with pypdfium2.PdfDocument(source) as pdf:
            for segment in location['segments']:
                physical_page = segment['physical_page']
                geometry = document['pages'][physical_page - 1]
                page = pdf[physical_page - 1]
                bitmap = page.render(scale=1.5)
                image = bitmap.to_pil().copy()
                sx, sy = image.width / geometry['width'], image.height / geometry['height']
                x0, y0, x1, y1 = segment['bbox']
                pixel_box = [x0 * sx, y0 * sy, x1 * sx, y1 * sy]
                ImageDraw.Draw(image).rectangle(pixel_box, outline=(240, 0, 0), width=2)
                name = f'{record["source_id"]}-physical-page-{physical_page}.png'
                image.save(out / name)
                bitmap.close(); page.close()
                index.append({'source_id': record['source_id'], 'physical_page': physical_page,
                              'image': str((out / name).relative_to(CODE)), 'bbox_pt': segment['bbox'],
                              'coordinate_system': geometry['geometry']['coordinate_system'],
                              'block_id': segment['block_id'], 'text_version': document['text_version'],
                              'precision': 'whole_textline_not_exact_glyph', 'human_fidelity_verified': False,
                              'source_original_unchanged': sha256(source.read_bytes()).hexdigest() == record['sha256']})
    (out / 'index.json').write_text(json.dumps({'purpose': 'manual_source_page_review_material', 'items': index, 'quality_passed': False}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'previews': len(index), 'index': str((out / 'index.json').relative_to(CODE)), 'quality_passed': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
