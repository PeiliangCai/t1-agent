"""Candidate-neutral structural IR, anchored to separately decoded PDF text.

Native paragraphs/cells may rewrite whitespace, hyphens or glyphs. They remain
display data. Authoritative quotes are exact code-point segments in `blocks`.
Geometry/normalization alignment is provenance evidence, never medical gold.
"""
from copy import deepcopy
from dataclasses import dataclass
from difflib import SequenceMatcher
from hashlib import sha256
from pathlib import Path
import json
import os
import re
import resource
import subprocess
import time
import unicodedata

from adapter import CODE, DoclingParseTextAdapter, ParseInput, ParserError, resolve_segments, normalize_text

CANDIDATES = ('docling-standard-cpu', 'mineru-basic-onnx-cpu')
METHOD = 'geometry_and_nfkd_whitespace_hyphen_alignment_2'
LOADED_ADAPTER_SHA256 = sha256(Path(__file__).read_bytes()).hexdigest()
LOADED_NATIVE_WORKER_SHA256 = sha256((Path(__file__).parent / 'native_worker.py').read_bytes()).hexdigest()


def worker_environment():
    root = CODE / '.tools/pdf-parser'
    env = {**os.environ, 'OMP_NUM_THREADS': '4', 'OPENBLAS_NUM_THREADS': '4', 'MKL_NUM_THREADS': '4',
           'MINERU_CPU_NUM_THREADS': '4', 'MINERU_INTRA_OP_NUM_THREADS': '4', 'MINERU_INTER_OP_NUM_THREADS': '1',
           'MINERU_PDF_RENDER_THREADS': '1', 'MINERU_HOME': str(root / 'mineru-home'),
           'MINERU_MODEL_BASE_DIR': str(root / 'mineru-models'), 'MINERU_MODEL_SOURCE': 'local',
           'MINERU_MODEL_SMALL_BACKEND': 'onnx', 'MINERU_MODEL_ONNX_DEVICE': 'cpu',
           'MINERU_TELEMETRY_DISABLED': '1', 'HF_HOME': str(root / 'hf'), 'HF_HUB_OFFLINE': '1',
           'TRANSFORMERS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1', 'XDG_CACHE_HOME': str(root / 'cache'),
           'PYTHONUNBUFFERED': '1'}
    for name in ['MINERU_MODEL_VLM_SERVER_URL', 'MINERU_VL_SERVER_URL', 'MINERU_API_URL']:
        env.pop(name, None)
    return env


class NativeWorker:
    def __init__(self, candidate_id, log_directory):
        if candidate_id not in CANDIDATES:
            raise ParserError('candidate_not_allowed', 'An explicit allowed candidate is required')
        self.candidate_id = candidate_id
        log_directory.mkdir(parents=True, exist_ok=True)
        self.log_path = log_directory / (candidate_id + f'-{os.getpid()}-{time.time_ns()}.stderr.log')
        self.log = self.log_path.open('w')
        python = CODE / ('.venv/bin/python' if candidate_id == 'docling-standard-cpu' else '.tools/mineru-venv/bin/python')
        self.process = subprocess.Popen([str(python), str(CODE / 'services/pdf-parser/native_worker.py'), '--candidate-id', candidate_id],
                                        cwd=CODE, env=worker_environment(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.log, text=True, encoding='utf-8')

    def parse(self, path):
        self.process.stdin.write(json.dumps({'path': str(path)}) + '\n'); self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise ParserError('native_worker_exited', 'Native candidate worker exited; inspect its local stderr log')
        response = json.loads(line)
        if not response.get('ok'):
            raise ParserError(response.get('error', {}).get('code', 'native_candidate_failed'),
                              response.get('error', {}).get('message', 'Native candidate failed'))
        return response

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=5)
        self.log.close()


class StructuredParserAdapter:
    def __init__(self, candidate_id, *, log_directory=None):
        self.candidate_id = candidate_id
        self.worker = NativeWorker(candidate_id, log_directory or CODE / 'runtime-data/s3-native-logs')

    def parse(self, value):
        source_adapter = DoclingParseTextAdapter()
        path, raw = source_adapter._read(value)
        # The identical source anchor pipeline is applied to both candidates.
        source = source_adapter.parse(value)
        response = self.worker.parse(path)
        encoded = (json.dumps(response['native'], ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
        native_hash = sha256(encoded).hexdigest()
        folder = CODE / 'runtime-data/s3-native-artifacts' / value.run_id
        folder.mkdir(parents=True, exist_ok=True)
        artifact = folder / (self.candidate_id + '-' + native_hash + '.json')
        if artifact.exists():
            if artifact.read_bytes() != encoded:
                raise ParserError('native_artifact_conflict', 'Immutable native artifact differs')
        else:
            with artifact.open('xb') as stream:
                stream.write(encoded)
        document = build_ir(source, response['native'], self.candidate_id, response['metrics'], response['errors'],
                            {'path': str(artifact.relative_to(CODE)), 'sha256': native_hash, 'format': 'candidate_native_json'})
        return document

    def close(self):
        self.worker.close()


def flatten(text):
    chars, positions = [], []
    for index, char in enumerate(text):
        for transformed in unicodedata.normalize('NFKD', char):
            if not transformed.isspace() and transformed not in '-\u00ad\u2010\u2011':
                chars.append(transformed); positions.append(index)
    return ''.join(chars), positions


def intersect(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))


def native_box(box, native_size, page):
    if not box:
        return None
    l, t, r, b = [float(box[k]) for k in ['l', 't', 'r', 'b']]
    width, height = native_size
    if str(box.get('coord_origin', 'TOPLEFT')).upper() == 'BOTTOMLEFT':
        t, b = height - t, height - b
    sx, sy = page['width'] / width, page['height'] / height
    return [min(l, r) * sx, min(t, b) * sy, max(l, r) * sx, max(t, b) * sy]


def provenance(page_no, box, size, source, ref, precision='native_element_bbox', charspan=None):
    if not 1 <= page_no <= len(source['pages']) or source['pages'][page_no - 1]['geometry'] is None:
        return None
    return {'physical_page': page_no, 'bbox': native_box(box, size, source['pages'][page_no - 1]),
            'coordinate_system': 'crop_rotated_top_left_pt', 'native_ref': ref, 'native_bbox': box or {},
            'native_page_size': list(size), 'precision': precision, 'native_charspan': charspan}


def align_sources(native_text, locations, source):
    target, target_positions = flatten(native_text)
    base = {'status': 'not_text' if not target else 'unmapped', 'method': METHOD,
            'matched_native_code_points': 0, 'alignable_native_code_points': len(set(target_positions)),
            'transformations': ['NFKD/whitespace/hyphens ignored for matching only; source text is retained verbatim'], 'warnings': []}
    if not target:
        return [], base
    spans = sorted([p for p in locations if p.get('native_charspan') and
                    0 <= p['native_charspan'][0] < p['native_charspan'][1] <= len(native_text)],
                   key=lambda p: p['native_charspan'][0])
    if len(spans) > 1 and len(spans) == len(locations) and all(a['native_charspan'][1] <= b['native_charspan'][0] for a, b in zip(spans, spans[1:])):
        segments, mappings = [], []
        for p in spans:
            start, end = p['native_charspan']
            local, mapping = align_sources(native_text[start:end], [{**p, 'native_charspan': None}], source)
            segments.extend(local); mappings.append(mapping)
        block_order = {b['block_id']: b['reading_order'] for b in source['blocks']}
        unique = {(s['block_id'], s['start'], s['end']): s for s in segments}
        segments = sorted(unique.values(), key=lambda s: (block_order[s['block_id']], s['start']))
        base['matched_native_code_points'] = sum(m['matched_native_code_points'] for m in mappings)
        base['native_provenance_partitioned'] = True
        base['transformations'].append('Native charspan/provenance regions aligned separately, preserving cross-column/page source boundaries')
        base['warnings'] = list(dict.fromkeys(w for m in mappings for w in m['warnings']))
        if any(m['status'] == 'ambiguous' for m in mappings):
            base['warnings'].append('At least one native provenance region has ambiguous source matches')
        base['status'] = 'normalized_alignment' if all(m['status'] in ['exact', 'normalized_alignment', 'not_text'] for m in mappings) else 'partial' if segments else 'ambiguous' if any(m['status'] == 'ambiguous' for m in mappings) else 'unmapped'
        return segments, base
    candidates = {}
    for location in locations:
        if location['bbox'] is None:
            continue
        region = location['bbox']
        for block in source['blocks']:
            if block['page'] != location['physical_page'] or not block['text'].strip():
                continue
            area = max(1e-6, (block['bbox'][2] - block['bbox'][0]) * (block['bbox'][3] - block['bbox'][1]))
            if intersect(block['bbox'], region) / area >= 0.20:
                candidates[block['block_id']] = block
    ordered = sorted(candidates.values(), key=lambda b: (b['page'], round((b['bbox'][1] + b['bbox'][3]) / 4), b['bbox'][0]))
    stream, positions = [], []
    for block in ordered:
        text, offsets = flatten(block['text'])
        stream.append(text); positions.extend((block, offset) for offset in offsets)
    stream = ''.join(stream)
    starts, start = [], 0
    while target and (start := stream.find(target, start)) >= 0:
        starts.append(start); start += 1
    ranges, matched_target_positions = [], set()
    if len(starts) == 1:
        ranges = [(starts[0], starts[0] + len(target))]
        matched_target_positions.update(target_positions)
    elif len(starts) > 1:
        base['status'] = 'ambiguous'; base['warnings'].append('Multiple literal source matches inside native region; no first-match shortcut')
        return [], base
    elif len(target) >= 8 and stream:
        # Only retain demonstrably equal source substrings; never manufacture
        # an exact whole-native quotation from a fuzzy match.
        for match in SequenceMatcher(None, target, stream, autojunk=False).get_matching_blocks():
            if match.size >= 5:
                ranges.append((match.b, match.b + match.size))
                matched_target_positions.update(target_positions[match.a:match.a + match.size])
    grouped = {}
    for begin, end in ranges:
        for block, offset in positions[begin:end]:
            grouped.setdefault(block['block_id'], {'block': block, 'start': offset, 'end': offset + 1})
            grouped[block['block_id']]['start'] = min(grouped[block['block_id']]['start'], offset)
            grouped[block['block_id']]['end'] = max(grouped[block['block_id']]['end'], offset + 1)
    segments = []
    for group in sorted(grouped.values(), key=lambda x: x['block']['reading_order']):
        block, begin, end = group['block'], group['start'], group['end']
        # Retain source line-end hyphens/whitespace instead of making the
        # native dehyphenated spelling appear literal in a source quotation.
        if not flatten(block['text'][end:])[0]:
            end = len(block['text'])
        if not flatten(block['text'][:begin])[0]:
            begin = 0
        segments.append({'block_id': block['block_id'], 'text_version': source['text_version'], 'start': begin, 'end': end})
    base['matched_native_code_points'] = len(matched_target_positions)
    if segments:
        raw = ''.join(next(b for b in ordered if b['block_id'] == s['block_id'])['text'][s['start']:s['end']] for s in segments)
        base['status'] = 'exact' if raw == native_text else 'normalized_alignment' if len(starts) == 1 else 'partial'
        if raw != native_text:
            base['warnings'].append('Native processed text differs from literal segments; preserve segment boundaries and source spelling')
    return segments, base


class Builder:
    def __init__(self, source, identity):
        self.source, self.identity = source, identity
        self.units, self.tables, self.pictures, self.hierarchy = [], [], [], []
        self.reading_order, self.furniture = [], []
        self.refs = {}

    def unit_id(self, ref):
        return self.identity + '-u-' + sha256(ref.encode()).hexdigest()[:16]

    def add(self, ref, kind, text, label, locations, layer='body', original=None):
        identifier = self.unit_id(ref)
        segments, mapping = align_sources(text, locations, self.source)
        unit = {'unit_id': identifier, 'native_ref': ref, 'kind': kind, 'native_label': label,
                'native_text': text, 'native_original_text': original, 'native_text_role': 'processed_native_not_literal_quote',
                'content_layer': layer, 'source_segments': segments, 'provenance': locations, 'mapping': mapping}
        self.units.append(unit); self.refs[ref] = identifier
        return identifier


def docling_structure(native, source, identity):
    builder = Builder(source, identity)
    objects = {}
    for group in ['texts', 'tables', 'pictures', 'groups']:
        objects.update({x['self_ref']: x for x in native.get(group, [])})

    def locations(item, precision='native_element_bbox'):
        result = []
        for p in item.get('prov', []):
            page = native['pages'].get(str(p['page_no']))
            if page:
                point = provenance(p['page_no'], p['bbox'], [page['size']['width'], page['size']['height']], source,
                                   item['self_ref'], precision, p.get('charspan'))
                if point:
                    result.append(point)
        return result

    for item in native.get('texts', []):
        label = item.get('label', 'text')
        kind = label if label in ['text', 'section_header', 'caption', 'footnote', 'list_item'] else 'other'
        builder.add(item['self_ref'], kind, item.get('text', ''), label, locations(item), item.get('content_layer', 'body'), item.get('orig'))
    for item in native.get('tables', []):
        ref = item['self_ref']; locs = locations(item)
        table_id = builder.add(ref, 'table', '', 'table', locs, item.get('content_layer', 'body'))
        cells = []
        for i, cell in enumerate(item['data']['table_cells']):
            cellref = ref + f'/data/table_cells/{i}'
            cell_locs = []
            if locs:
                page = locs[0]['physical_page']; size = locs[0]['native_page_size']
                p = provenance(page, cell.get('bbox'), size, source, cellref,
                               'native_table_cell_bbox' if cell.get('bbox') else 'native_table_region_only')
                if not cell.get('bbox'):
                    p = {**locs[0], 'native_ref': cellref, 'precision': 'native_table_region_only'}
                if p:
                    cell_locs.append(p)
            unit_id = builder.add(cellref, 'table_cell', cell.get('text', ''), 'table_cell', cell_locs)
            cells.append({'unit_id': unit_id, 'row_start': cell['start_row_offset_idx'], 'row_end': cell['end_row_offset_idx'],
                          'col_start': cell['start_col_offset_idx'], 'col_end': cell['end_col_offset_idx'],
                          'row_span': cell['row_span'], 'col_span': cell['col_span'], 'column_header': cell['column_header'],
                          'row_header': cell['row_header'], 'row_section': cell['row_section']})
        builder.tables.append({'table_id': table_id, 'native_ref': ref, 'physical_pages': list(dict.fromkeys(p['physical_page'] for p in locs)),
                               'caption_unit_ids': [builder.refs[x['$ref']] for x in item.get('captions', []) if x['$ref'] in builder.refs],
                               'footnote_unit_ids': [builder.refs[x['$ref']] for x in item.get('footnotes', []) if x['$ref'] in builder.refs],
                               'association_basis': 'native_explicit' if item.get('captions') or item.get('footnotes') else 'none',
                               'n_rows': item['data']['num_rows'], 'n_cols': item['data']['num_cols'], 'cells': cells,
                               'native_html': None, 'cross_page_continuation': 'not_assumed'})
    for item in native.get('pictures', []):
        ref = item['self_ref']; locs = locations(item)
        picture_id = builder.add(ref, 'picture', '', 'picture', locs, item.get('content_layer', 'body'))
        builder.pictures.append({'picture_id': picture_id, 'native_ref': ref,
                                 'physical_pages': list(dict.fromkeys(p['physical_page'] for p in locs)),
                                 'caption_unit_ids': [builder.refs[x['$ref']] for x in item.get('captions', []) if x['$ref'] in builder.refs],
                                 'footnote_unit_ids': [builder.refs[x['$ref']] for x in item.get('footnotes', []) if x['$ref'] in builder.refs],
                                 'association_basis': 'native_explicit' if item.get('captions') or item.get('footnotes') else 'none'})
    def walk(item, destination):
        ref = item['self_ref']
        if ref in builder.refs and builder.refs[ref] not in destination:
            destination.append(builder.refs[ref])
        children = [x['$ref'] for x in item.get('children', [])]
        builder.hierarchy.append({'parent_ref': ref, 'child_refs': children})
        for child in children:
            if child in objects:
                walk(objects[child], destination)
    walk(native['body'], builder.reading_order)
    if 'furniture' in native:
        walk(native['furniture'], builder.furniture)
    return builder, sorted(int(p) for p in native.get('pages', {}))


def mineru_structure(native, source, identity):
    from html.parser import HTMLParser

    class TableReader(HTMLParser):
        def __init__(self, text):
            super().__init__(convert_charrefs=True)
            self.rows, self.row, self.cell = [], None, None
            self.feed(text)

        def handle_starttag(self, tag, attrs):
            if tag == 'tr':
                self.row = []
            elif tag in ['td', 'th']:
                self.cell = {'tag': tag, 'attrs': dict(attrs), 'text': ''}
            elif tag == 'br' and self.cell is not None:
                self.cell['text'] += '\n'

        def handle_data(self, text):
            if self.cell is not None:
                self.cell['text'] += text

        def handle_endtag(self, tag):
            if tag in ['td', 'th'] and self.cell is not None:
                if self.row is None:
                    self.row = []
                self.row.append(self.cell); self.cell = None
            elif tag == 'tr' and self.row is not None:
                self.rows.append(self.row); self.row = None

    builder = Builder(source, identity)
    pages = []

    def text_of(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return ''.join(text_of(c.get('content', '')) for c in content if isinstance(c, dict))
        return ''

    def location(block, page, ref, precision='native_element_bbox'):
        bbox = block.get('bbox')
        if bbox is None:
            return []
        physical = page['page_idx'] + 1
        if physical > len(source['pages']) or source['pages'][physical - 1]['geometry'] is None:
            return []
        info = source['pages'][physical - 1]
        size = [info['width'], info['height']]
        raw = {'l': bbox[0] * size[0], 't': bbox[1] * size[1], 'r': bbox[2] * size[0], 'b': bbox[3] * size[1],
               'coord_origin': 'TOPLEFT', 'native_normalized_bbox': bbox, 'native_unit': 'fraction_of_rotated_crop_page'}
        p = provenance(physical, raw, size, source, ref, precision)
        return [p] if p else []

    def visit(block, page, ref, top=False):
        label = block['type']
        children = block.get('content')
        visual = label in ['table', 'image', 'chart']
        label_kind = {'text': 'text', 'ref_text': 'text', 'doc_title': 'section_header', 'paragraph_title': 'section_header',
                      'image_caption': 'caption', 'table_caption': 'caption', 'chart_caption': 'caption',
                      'image_footnote': 'footnote', 'table_footnote': 'footnote', 'page_footnote': 'footnote',
                      'table': 'table', 'image': 'picture', 'chart': 'picture'}
        kind = label_kind.get(label, 'other')
        layer = 'furniture' if label in ['header', 'footer', 'page_number', 'aside_text'] else 'body'
        content = '' if visual else text_of(children)
        locs = location(block, page, ref)
        unit_id = builder.add(ref, kind, content, label, locs, layer)
        if isinstance(children, list) and children and isinstance(children[0], dict) and children[0].get('type') in ['text', 'equation_inline', 'code_inline', 'hyperlink']:
            builder.units[-1]['native_inline_spans'] = children
        if top:
            (builder.furniture if layer == 'furniture' else builder.reading_order).append(unit_id)
        if visual:
            child_ids = []
            for index, child in enumerate(children or []):
                child_ids.append(visit(child, page, ref + f'/content/{index}'))
            builder.hierarchy.append({'parent_ref': ref, 'child_refs': [ref + f'/content/{i}' for i in range(len(child_ids))]})
            caption_ids = [identifier for identifier in child_ids if next(u for u in builder.units if u['unit_id'] == identifier)['kind'] == 'caption']
            footnote_ids = [identifier for identifier in child_ids if next(u for u in builder.units if u['unit_id'] == identifier)['kind'] == 'footnote']
            if label == 'table':
                body = next((b for b in children or [] if b['type'] == 'table_body'), {})
                html = text_of(body.get('content', ''))
                parsed = TableReader(html); occupied = set(); cells = []; nrows = ncols = 0
                for row_index, row in enumerate(parsed.rows):
                    col = 0
                    for col_index, cell in enumerate(row):
                        while (row_index, col) in occupied:
                            col += 1
                        try:
                            rs, cs = max(1, int(cell['attrs'].get('rowspan', '1'))), max(1, int(cell['attrs'].get('colspan', '1')))
                        except ValueError:
                            rs = cs = 1
                        cellref = ref + f'/html/tr/{row_index}/cell/{col_index}'
                        cell_locs = [{**p, 'native_ref': cellref, 'precision': 'native_table_region_only'} for p in locs]
                        identifier = builder.add(cellref, 'table_cell', cell['text'], 'html_table_cell', cell_locs)
                        cells.append({'unit_id': identifier, 'row_start': row_index, 'row_end': row_index + rs,
                                      'col_start': col, 'col_end': col + cs, 'row_span': rs, 'col_span': cs,
                                      'column_header': cell['tag'] == 'th' and cell['attrs'].get('scope') != 'row',
                                      'row_header': cell['tag'] == 'th' and cell['attrs'].get('scope') == 'row', 'row_section': False})
                        occupied.update((r, c) for r in range(row_index, row_index + rs) for c in range(col, col + cs))
                        nrows, ncols = max(nrows, row_index + rs), max(ncols, col + cs); col += cs
                builder.tables.append({'table_id': unit_id, 'native_ref': ref, 'physical_pages': [page['page_idx'] + 1],
                    'caption_unit_ids': caption_ids, 'footnote_unit_ids': footnote_ids, 'association_basis': 'native_explicit' if caption_ids or footnote_ids else 'none',
                    'n_rows': nrows, 'n_cols': ncols, 'cells': cells, 'native_html': html,
                    'cross_page_continuation': 'native_flag_unverified' if block.get('continues_prev') is not None else 'not_assumed',
                    'native_continues_previous': block.get('continues_prev')})
            else:
                builder.pictures.append({'picture_id': unit_id, 'native_ref': ref, 'physical_pages': [page['page_idx'] + 1],
                    'caption_unit_ids': caption_ids, 'footnote_unit_ids': footnote_ids, 'association_basis': 'native_explicit' if caption_ids or footnote_ids else 'none'})
        elif isinstance(children, list) and children and isinstance(children[0], dict) and 'bbox' in children[0]:
            child_refs = []
            for index, child in enumerate(children):
                childref = ref + f'/content/{index}'; child_refs.append(childref); visit(child, page, childref)
            builder.hierarchy.append({'parent_ref': ref, 'child_refs': child_refs})
        return unit_id

    for page_index, page in enumerate(native.get('pages', [])):
        pages.append(page['page_idx'] + 1)
        for index, block in enumerate(page.get('blocks', [])):
            visit(block, page, f'#/pages/{page_index}/blocks/{index}', True)
    return builder, pages


def validate_structured(document):
    import jsonschema
    jsonschema.validate(document, json.loads((CODE / 'packages/contracts/schema/DocumentIRV3.json').read_text()))
    ids = [b['block_id'] for b in document['blocks']]
    if ids != document['coverage']['expected_block_ids'] or len(set(ids)) != len(ids):
        raise ParserError('invalid_document_ir', 'Source block coverage identity mismatch')
    for i, block in enumerate(document['blocks']):
        if block['document_id'] != document['document_id'] or block['text_version'] != document['text_version'] or block['reading_order'] != i:
            raise ParserError('invalid_document_ir', 'Source block version or order mismatch')
        if normalize_text(block['raw_text']) != (block['text'], block['normalization_map']):
            raise ParserError('invalid_document_ir', 'Source text mapping mismatch')
    units = {u['unit_id']: u for u in document['structure']['units']}
    if len(units) != len(document['structure']['units']) or not set(document['structure']['reading_order']) <= set(units):
        raise ParserError('invalid_document_ir', 'Native unit identity/order mismatch')
    for unit in units.values():
        if unit['source_segments']:
            resolve_segments(document, document_id=document['document_id'], text_version=document['text_version'], segments=unit['source_segments'])
    for table in document['structure']['tables']:
        if not {table['table_id'], *table['caption_unit_ids'], *table['footnote_unit_ids'], *(c['unit_id'] for c in table['cells'])} <= set(units):
            raise ParserError('invalid_document_ir', 'Native table reference mismatch')


def guard_caption_associations(builder):
    units = {u['unit_id']: u for u in builder.units}
    for expected, entries in [('table', builder.tables), ('picture', builder.pictures)]:
        for entry in entries:
            relationships, issues = [], []
            for identifier in entry['caption_unit_ids']:
                caption = units[identifier]['native_text'].lstrip()
                is_figure = bool(re.match(r'(?i)(?:fig(?:ure)?\.?\s*\d|图\s*\d)', caption))
                is_table = bool(re.match(r'(?i)(?:table\s*\d|表\s*\d)', caption))
                is_keywords = bool(re.match(r'(?i)(?:key\s*words?\b|关键词)', caption))
                conflict = expected == 'table' and is_figure or expected == 'picture' and is_table or is_keywords
                reason = 'caption_type_conflicts_with_native_parent' if conflict else 'native_link_retained_not_human_verified'
                relationships.append({'unit_id': identifier, 'native_retained': True,
                                      'project_status': 'rejected_conflict' if conflict else 'unverified', 'reason': reason})
                if conflict:
                    issues.append(reason + ':' + identifier)
            entry.update({'association_status': 'conflict' if issues else 'native_unverified' if relationships else 'none',
                          'association_issues': issues, 'caption_relationships': relationships,
                          'usable_for_semantic_interpretation': False})


def build_ir(source, native, candidate_id, native_metrics, native_errors, native_artifact):
    if candidate_id not in CANDIDATES:
        raise ParserError('candidate_not_allowed', 'Select an explicit allowed local CPU candidate')
    started = time.monotonic()
    config = {'adapter_version': 's3-structured-1', 'adapter_sha256': LOADED_ADAPTER_SHA256,
              'native_worker_sha256': LOADED_NATIVE_WORKER_SHA256,
              'candidate_id': candidate_id, 'device': 'cpu', 'cpu_threads': 4, 'ocr_mode': 'pdf_text_layer',
              'paid_llm_enabled': False, 'source_parser': source['parser'], 'source_alignment_method': METHOD,
              'native_processed_text_authoritative': False, 'native_config': native_metrics.get('configuration', {})}
    config_digest = sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    version = 's3v3-' + sha256((source['file_sha256'] + source['document_id'] + candidate_id + config_digest + native_artifact['sha256']).encode()).hexdigest()[:32]
    result = deepcopy(source); result['schema_version'] = '3'; result['text_version'] = version; result['raw_text_version'] = version + '-raw'
    for block in result['blocks']:
        block['text_version'] = version
    identity = sha256((version + candidate_id).encode()).hexdigest()[:16]
    if candidate_id == 'docling-standard-cpu':
        builder, native_pages = docling_structure(native, result, identity)
    else:
        builder, native_pages = mineru_structure(native, result, identity)
    guard_caption_associations(builder)
    result['source_extraction'] = {'parser_id': source['parser']['id'], 'parser_version': source['parser']['version'],
                                   'config_digest': source['parser']['config_digest'], 'text_version': source['text_version'],
                                   'raw_text_definition': 'decoded_PDF_text_layer_no_native_structure_rewrite'}
    result['native_artifact'] = native_artifact
    result['structure'] = {'units': builder.units, 'reading_order': builder.reading_order, 'furniture_unit_ids': builder.furniture,
                           'hierarchy': builder.hierarchy, 'tables': builder.tables, 'pictures': builder.pictures,
                           'native_processed_text_is_authoritative_quote': False, 'human_fidelity_verified': False}
    unmapped = [u['unit_id'] for u in builder.units if u['mapping']['status'] in ['unmapped', 'partial']]
    ambiguous = [u['unit_id'] for u in builder.units if u['mapping']['status'] == 'ambiguous']
    result['coverage'].update({'scope': 'raw_pdf_text_layer_with_candidate_structure', 'native_pages': native_pages,
                              'native_errors': native_errors, 'unmapped_unit_ids': unmapped, 'ambiguous_unit_ids': ambiguous,
                              'structure_verified_by_human': False, 'table_structure': 'native_candidate_output_unverified',
                              'reading_order': 'native_candidate_order_unverified'})
    result['coverage']['limitations'].extend(['Native structure/text is a candidate output, not literal source quotation',
                                               'Table/page continuations are not inferred; image/OCR coverage remains explicitly unverified'])
    state = 'unsupported' if not result['blocks'] else 'partial' if source['parser']['status'] != 'parsed' or native_errors or unmapped or ambiguous or native_pages != source['coverage']['physical_pages_expected'] else 'parsed'
    result['parser'] = {'id': candidate_id, 'version': native_metrics['parser_version'], 'status': state, 'config': config, 'config_digest': config_digest}
    result['metrics'] = {'source_anchor_seconds': source['metrics']['total_seconds'], 'native_seconds': native_metrics.get('total_seconds', 0),
                         'mapping_seconds': time.monotonic() - started, 'total_seconds': source['metrics']['total_seconds'] + native_metrics.get('total_seconds', 0) + time.monotonic() - started,
                         'native_metrics': native_metrics, 'host_metrics': source['metrics'], 'remote_document_uploads': 0, 'llm_calls': 0}
    validate_structured(result)
    return result
