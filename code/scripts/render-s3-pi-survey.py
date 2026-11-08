#!/usr/bin/env python3
"""Render the 31 assigned original pages beside native candidate element boxes.

Reads existing native exports through their preserved IR fields. Source mapping
and common PDF text-line blocks are deliberately excluded from native coverage.
Rendering is preparation for an AI engineering survey, never a quality pass.
"""
import argparse
from hashlib import sha256
import json
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont

CODE = Path(__file__).resolve().parents[1]
ASSIGNED = {'MED03': [1, 3, 5, 6, 7, 8, 9], 'L07': [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            'L05': [1, 2, 3, 4, 7, 8, 9, 10], 'L01': [4], 'L02': [1, 3]}
CANDIDATES = ['docling-standard-cpu', 'mineru-basic-onnx-cpu']
COLORS = {'text': '#176dc2', 'section_header': '#7a20b3', 'caption': '#ca1c88', 'table': '#d27600',
          'table_cell': '#d8a340', 'picture': '#00864b', 'footnote': '#777777', 'list_item': '#176dc2', 'other': '#59656f'}


def font(size):
    path = Path('/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf')
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default(size=size)


def local(path):
    value = (CODE / path).resolve()
    if not value.is_relative_to(CODE):
        raise ValueError('all survey inputs and outputs must be in code/')
    return value


def page_summary(document, number):
    positions = {unit_id: index + 1 for index, unit_id in enumerate(document['structure']['reading_order'])}
    units = []
    for unit in document['structure']['units']:
        provenance = [p for p in unit['provenance'] if p['physical_page'] == number]
        if not provenance:
            continue
        units.append({key: unit.get(key) for key in ['unit_id', 'native_ref', 'kind', 'native_label', 'native_text',
                                                   'native_original_text', 'native_text_role', 'content_layer']} |
                     {'provenance': provenance, 'reading_order_number': positions.get(unit['unit_id'])})
    lookup = {unit['unit_id']: unit for unit in document['structure']['units']}
    relationships = []
    for kind in ['tables', 'pictures']:
        for item in document['structure'][kind]:
            if number not in item['physical_pages']:
                continue
            relationships.append({'kind': kind, 'native_ref': item['native_ref'],
                                  'native_caption_texts': [lookup[unit_id]['native_text'] for unit_id in item['caption_unit_ids']],
                                  'native_footnote_texts': [lookup[unit_id]['native_text'] for unit_id in item['footnote_unit_ids']],
                                  **{key: item.get(key) for key in ['n_rows', 'n_cols', 'association_basis', 'association_status',
                                                                 'association_issues', 'caption_relationships', 'usable_for_semantic_interpretation']}})
    ordered = sorted([unit for unit in units if unit['reading_order_number'] is not None], key=lambda u: u['reading_order_number'])
    return {'native_units': units, 'unit_counts': {kind: sum(unit['kind'] == kind for unit in units) for kind in COLORS},
            'native_text_code_points': sum(len(unit['native_text'] or '') for unit in units),
            'native_relationships': relationships, 'native_reading_order': [{'order': unit['reading_order_number'], 'kind': unit['kind'],
                'native_ref': unit['native_ref'], 'text_start': unit['native_text'][:220]} for unit in ordered],
            'common_source_blocks_used_for_native_completeness': False, 'source_segments_used': False}


def overlay(original, document, number, summary):
    image = original.copy().convert('RGB')
    draw = ImageDraw.Draw(image)
    dimensions = document['pages'][number - 1]
    scale_x, scale_y = image.width / dimensions['width'], image.height / dimensions['height']
    for unit in summary['native_units']:
        color = COLORS[unit['kind']]
        for prov in unit['provenance']:
            if prov['bbox'] is None:
                continue
            x0, y0, x1, y1 = prov['bbox']
            box = [x0 * scale_x, y0 * scale_y, x1 * scale_x, y1 * scale_y]
            if box[2] <= box[0] or box[3] <= box[1]:
                continue
            draw.rectangle(box, outline=color, width=3 if unit['kind'] in ['table', 'picture', 'caption'] else 1)
            if unit['kind'] != 'table_cell':
                label = (str(unit['reading_order_number']) if unit['reading_order_number'] else '-') + ':' + unit['kind'][:3]
                x, y = max(0, box[0]), max(0, box[1] - 12)
                draw.rectangle([x, y, x + len(label) * 7 + 2, y + 12], fill='white')
                draw.text((x + 1, y), label, fill=color, font=font(11))
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ir-root', required=True)
    parser.add_argument('--output', default='docs/acceptance/s3/comparison-2026-11-02/page-review/pi-executor-survey/renders-v1')
    args = parser.parse_args()
    root, output = local(args.ir_root), local(args.output)
    output.mkdir(parents=True, exist_ok=False)
    records = []
    for document_id, page_numbers in ASSIGNED.items():
        source = local(f'evaluation/corpus/development-candidates/{document_id}.pdf')
        digest = sha256(source.read_bytes()).hexdigest()
        documents = {}
        for candidate in CANDIDATES:
            result_path = root / candidate / f'{document_id}.json'
            document = json.loads(result_path.read_text())['document']
            assert document['document_id'] == document_id and document['file_sha256'] == digest
            artifact = local(document['native_artifact']['path'])
            assert sha256(artifact.read_bytes()).hexdigest() == document['native_artifact']['sha256']
            documents[candidate] = document
        pdf = pdfium.PdfDocument(str(source))
        try:
            for number in page_numbers:
                page = pdf[number - 1]
                bitmap = page.render(scale=1.25)
                original = bitmap.to_pil().copy().convert('RGB')
                bitmap.close(); page.close()
                name = f'{document_id}-p{number:02d}'
                original_path = output / f'{name}-original.png'
                original.save(original_path)
                summaries = {candidate: page_summary(document, number) for candidate, document in documents.items()}
                panels = [original]
                for candidate in CANDIDATES:
                    marked = overlay(original, documents[candidate], number, summaries[candidate])
                    marked.save(output / f'{name}-{candidate}.png'); panels.append(marked)
                gap, margin = 12, 58
                comparison = Image.new('RGB', (original.width * 3 + gap * 4, original.height + margin + 18), 'white')
                draw = ImageDraw.Draw(comparison)
                for index, panel in enumerate(panels):
                    x = gap + index * (original.width + gap)
                    comparison.paste(panel, (x, margin))
                    draw.text((x, 5), f'{document_id} physical page {number} | ' + ['ORIGINAL', 'DOCLING native', 'MINERU native'][index], fill='black', font=font(17))
                    draw.text((x, 29), 'blue=text purple=heading pink=caption orange=table green=picture', fill='#444444', font=font(11))
                comparison_path = output / f'{name}-comparison.png'; comparison.save(comparison_path)
                record = {'document_id': document_id, 'physical_page': number, 'original_file_sha256': digest,
                          'original_image': str(original_path.relative_to(CODE)), 'comparison_image': str(comparison_path.relative_to(CODE)),
                          'actual_image_view_completed': False, 'native_candidates': {candidate: {
                              'parser_result_file': str((root / candidate / f'{document_id}.json').relative_to(CODE)),
                              'native_artifact': documents[candidate]['native_artifact'], **summaries[candidate]} for candidate in CANDIDATES}}
                (output / f'{name}-native-summary.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
                records.append(record)
                print(json.dumps({'page': name, 'comparison': str(comparison_path.relative_to(CODE)),
                                  'native_units': {candidate: len(summaries[candidate]['native_units']) for candidate in CANDIDATES}}), flush=True)
        finally:
            pdf.close()
        assert sha256(source.read_bytes()).hexdigest() == digest
    payload = {'scope': 'render_preparation_only_no_AI_view_claim', 'pages': records, 'page_count': len(records),
               'native_models_rerun': False, 'paid_llm_calls': 0, 'original_PDF_bytes_unchanged': True,
               'common_source_blocks_used_for_native_completeness': False, 'source_segments_used': False,
               'legend': COLORS, 'limitations': ['Native element boxes are not glyph boxes.', 'Rendering is not a fidelity pass or medical review.',
                                                'Native text is processed output and is not a verbatim source quote.']}
    (output / 'index.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
