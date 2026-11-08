"""Local PDF text/geometry adapter; no LLM, OCR, or remote parsing.

Raw text means backend-decoded text, not PDF stream bytes. Original file bytes
remain identified by SHA256. This model-free path does not reconstruct tables,
assign semantic captions, or validate reading order.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from importlib.metadata import version
from pathlib import Path
from typing import Protocol
import json
import math
import os
import re
import resource
import time

CODE = Path(__file__).resolve().parents[2]
ADAPTER_VERSION = 's3-text-adapter-1'
NORMALIZATION_VERSION = 'line-endings-only-1'


@dataclass(frozen=True)
class ParseInput:
    run_id: str
    document_id: str
    file_reference: str
    file_sha256: str
    fixture: bool = False


class ParserError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable

    def as_dict(self):
        return {'code': self.code, 'message': self.message, 'retryable': self.retryable}


class ParserAdapter(Protocol):
    """Return DocumentIR v2 (including partial coverage), or raise ParserError."""
    def parse(self, value: ParseInput) -> dict: ...


class UnimplementedParser:
    """S1 placeholder preserved for callers explicitly selecting that stub."""
    def parse(self, value: ParseInput) -> dict:
        raise ParserError('real_pdf_parser_not_implemented_until_S3', 'Historical S1 placeholder')


def normalize_text(raw: str):
    """Normalize CRLF/CR only, with half-open Unicode-code-point map runs."""
    output, mapping = [], []
    i = n = 0
    while i < len(raw):
        start_i, start_n = i, n
        if raw[i] == '\r':
            i += 2 if raw[i:i + 2] == '\r\n' else 1
            output.append('\n'); n += 1
            kind = 'newline'
        else:
            while i < len(raw) and raw[i] != '\r':
                i += 1
            output.append(raw[start_i:i]); n += i - start_i
            kind = 'identity'
        mapping.append({'raw_start': start_i, 'raw_end': i, 'normalized_start': start_n, 'normalized_end': n, 'kind': kind})
    return ''.join(output), mapping


def normalized_to_raw(block: dict, start: int, end: int):
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(block['text']):
        raise ParserError('invalid_span', 'Span must be a nonempty Unicode code point interval')
    covered = [m for m in block['normalization_map'] if m['normalized_end'] > start and m['normalized_start'] < end]
    if not covered:
        raise ParserError('invalid_normalization_map', 'Span is absent from the normalization mapping')
    first, last = covered[0], covered[-1]
    raw_start = first['raw_start'] + start - first['normalized_start'] if first['kind'] == 'identity' else first['raw_start']
    raw_end = last['raw_start'] + end - last['normalized_start'] if last['kind'] == 'identity' else last['raw_end']
    return raw_start, raw_end


def apply_matrix(matrix, x, y):
    a, b, c, d, e, f = matrix
    return a * x + c * y + e, b * x + d * y + f


def box_of(points):
    xs, ys = zip(*points)
    return [min(xs), min(ys), max(xs), max(ys)]


def page_geometry(pdf_page):
    """Docling cells are CropBox-relative AND already /Rotate-transformed.

    Canonical geometry is displayed crop top-left in typographic points. Raw
    PDF boxes and inverse matrices are retained for PDF.js viewport conversion.
    """
    crop, media = [float(x) for x in pdf_page.cropbox], [float(x) for x in pdf_page.mediabox]
    rotation, unit = int(pdf_page.rotation) % 360, float(pdf_page.user_unit)
    l, b, r, t = crop
    w, h = r - l, t - b
    if not all(math.isfinite(x) for x in [*crop, *media, unit]) or w <= 0 or h <= 0 or unit <= 0 or rotation not in [0, 90, 180, 270]:
        raise ParserError('unsupported_page_geometry', 'Invalid dimensions, UserUnit, or page rotation')
    if l < media[0] - 1e-6 or b < media[1] - 1e-6 or r > media[2] + 1e-6 or t > media[3] + 1e-6:
        raise ParserError('unsupported_page_geometry', 'CropBox outside MediaBox requires separate validation')
    dw, dh = (h, w) if rotation in [90, 270] else (w, h)
    matrix = {0: [1, 0, 0, 1, l, b], 90: [0, 1, -1, 0, l + w, b],
              180: [-1, 0, 0, -1, l + w, b + h], 270: [0, -1, 1, 0, l, b + h]}[rotation]
    origin = apply_matrix(matrix, 0, dh)
    px, py = apply_matrix(matrix, 1 / unit, dh), apply_matrix(matrix, 0, dh - 1 / unit)
    canonical_to_pdf = [px[0] - origin[0], px[1] - origin[1], py[0] - origin[0], py[1] - origin[1], *origin]
    return {'width': dw * unit, 'height': dh * unit, 'rotation': rotation, 'coordinate_unit': 'pt',
            'coordinate_system': 'crop_rotated_top_left', 'pdf_user_unit': unit,
            'pdf_crop_box': crop, 'pdf_media_box': media, 'backend_to_pdf': matrix, 'canonical_to_pdf': canonical_to_pdf,
            'backend_coordinate_system': 'docling_crop_rotated_bottom_left_pdf_user_units',
            'conversion_version': 'docling-crop-rotation-userunit-1'}


def geometry_for_cell(cell, geometry):
    rect = cell.rect
    if str(rect.coord_origin.value) != 'BOTTOMLEFT':
        raise ParserError('unsupported_coordinate_origin', 'Backend coordinate origin changed')
    polygon = [(float(getattr(rect, f'r_x{i}')), float(getattr(rect, f'r_y{i}'))) for i in range(4)]
    if not all(math.isfinite(v) for p in polygon for v in p):
        raise ParserError('invalid_cell_geometry', 'Non-finite backend coordinates')
    unit = geometry['pdf_user_unit']
    canonical = [(x * unit, geometry['height'] - y * unit) for x, y in polygon]
    pdf = [apply_matrix(geometry['backend_to_pdf'], x, y) for x, y in polygon]
    return box_of(canonical), {'coordinate_system': geometry['backend_coordinate_system'], 'bbox': box_of(polygon),
                               'polygon': [v for p in polygon for v in p], 'pdf_bbox': box_of(pdf),
                               'precision': 'whole_textline_not_exact_glyph'}


def resolve_segments(document: dict, *, document_id: str, text_version: str, segments: list, joiner: str = ''):
    """Resolve block/version/code-point references without a full-text search."""
    if document_id != document['document_id']:
        raise ParserError('document_id_mismatch', 'Reference belongs to another document')
    if text_version != document['text_version']:
        raise ParserError('text_version_mismatch', 'Reference belongs to another text version')
    if not segments or not isinstance(joiner, str):
        raise ParserError('invalid_segments', 'At least one exact segment and a string joiner are required')
    blocks = {b['block_id']: b for b in document['blocks']}
    located, quotes, raw_quotes = [], [], []
    previous = (-1, -1)
    for segment in segments:
        if segment.get('text_version') != text_version:
            raise ParserError('text_version_mismatch', 'Each segment must bind the same text version')
        block = blocks.get(segment.get('block_id'))
        if block is None:
            raise ParserError('unknown_block', 'Referenced block does not exist in this document version')
        start, end = segment.get('start'), segment.get('end')
        raw_start, raw_end = normalized_to_raw(block, start, end)
        if (block['reading_order'], start) < previous:
            raise ParserError('segments_out_of_order', 'Segments must not overlap or reverse source order')
        previous = (block['reading_order'], end)
        quotes.append(block['text'][start:end]); raw_quotes.append(block['raw_text'][raw_start:raw_end])
        located.append({**segment, 'physical_page': block['page'], 'bbox': block['bbox'],
                        'source_geometry': block['source_geometry'], 'raw_start': raw_start, 'raw_end': raw_end})
    return {'document_id': document_id, 'text_version': text_version, 'unit': 'unicode_code_point',
            'interval': '[start,end)', 'joiner': joiner, 'quote': joiner.join(quotes),
            'raw_quote': joiner.join(raw_quotes), 'segments': located, 'medical_semantics_verified': False}


def validate_ir_semantics(document):
    if document.get('schema_version') != '2':
        raise ParserError('unsupported_ir_version', 'This CLI locator requires DocumentIR v2; v1 fixtures use the existing S1 locator')
    pages, blocks, coverage = document['pages'], document['blocks'], document['coverage']
    page_ids = [p['physical_page'] for p in pages]
    ids = [b['block_id'] for b in blocks]
    valid_pages = {p['physical_page'] for p in pages if p['status'] != 'failed'}
    if page_ids != list(range(1, len(pages) + 1)) or coverage['physical_pages_expected'] != page_ids:
        raise ParserError('invalid_document_ir', 'Physical page enumeration is inconsistent')
    if len(set(ids)) != len(ids) or ids != coverage['expected_block_ids'] or ids != coverage['processed_block_ids']:
        raise ParserError('invalid_document_ir', 'Block identities and coverage are inconsistent')
    if document['fixture'] != (document['evidence_kind'] == 'engineering_fixture'):
        raise ParserError('invalid_document_ir', 'Fixture and source evidence labels conflict')
    for index, block in enumerate(blocks):
        if block['document_id'] != document['document_id'] or block['text_version'] != document['text_version'] or block['page'] not in valid_pages or block['reading_order'] != index:
            raise ParserError('invalid_document_ir', 'Block document/version/page/order binding is inconsistent')
        text, mapping = normalize_text(block['raw_text'])
        if block['text'] != text or block['normalization_map'] != mapping:
            raise ParserError('invalid_document_ir', 'Raw and normalized text mapping is inconsistent')
    text_pages = [p['physical_page'] for p in pages if p['text_layer_present']]
    failures = [{'physical_page': p['physical_page'], 'code': p['error']['code']} for p in pages if p['status'] == 'failed']
    no_text = [p['physical_page'] for p in pages if p['status'] != 'failed' and not p['text_layer_present']]
    image_pages = [p['physical_page'] for p in pages if p['bitmap_count']]
    state = 'unsupported' if not blocks else 'partial' if failures or no_text or image_pages else 'parsed'
    if coverage['text_layer_pages'] != text_pages or coverage['text_layer_decode_complete'] != (len(text_pages) == len(pages)) or coverage['failed_pages'] != failures or coverage['pages_without_text'] != no_text or coverage['image_text_unverified_pages'] != image_pages or document['parser']['status'] != state:
        raise ParserError('invalid_document_ir', 'Page coverage/status is inconsistent')


@contextmanager
def native_stdout_to_stderr():
    """Keep native messages away from the CLI's JSON stdout."""
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        yield
    finally:
        os.dup2(saved, 1)
        os.close(saved)


class DoclingParseTextAdapter:
    parser_id = 'docling-parse-text'

    def __init__(self, *, allowed_root: Path = CODE, config_revision: str = '1'):
        self.allowed_root, self.config_revision = allowed_root.resolve(), config_revision

    def _read(self, value):
        for identifier in [value.run_id, value.document_id]:
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}', identifier):
                raise ParserError('invalid_identity', 'Run/document identifiers must be bounded safe identifiers')
        if not re.fullmatch(r'[a-f0-9]{64}', value.file_sha256):
            raise ParserError('invalid_sha256', 'Expected lowercase SHA256 is required')
        path = Path(value.file_reference)
        path = (CODE / path).resolve() if not path.is_absolute() else path.resolve()
        if not path.is_relative_to(self.allowed_root):
            raise ParserError('file_outside_allowed_root', 'PDF reference is outside the configured local root')
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise ParserError('file_unreadable', 'Local PDF cannot be read') from exc
        if sha256(raw).hexdigest() != value.file_sha256:
            raise ParserError('file_sha256_mismatch', 'Original bytes differ from the expected SHA256')
        if not raw.startswith(b'%PDF-'):
            raise ParserError('invalid_pdf_header', 'Input is not a PDF file')
        return path, raw

    def parse(self, value: ParseInput) -> dict:
        started = time.monotonic()
        usage_before = resource.getrusage(resource.RUSAGE_SELF)
        path, raw = self._read(value)
        file_check_seconds = time.monotonic() - started
        try:
            from pypdf import PdfReader
            from io import BytesIO
            reader = PdfReader(BytesIO(raw), strict=False)
            if reader.is_encrypted:
                raise ParserError('encrypted_pdf_unsupported', 'Encrypted PDF requires a separately supported password workflow')
            page_count = len(reader.pages)
            if not page_count:
                raise ParserError('empty_pdf', 'PDF has no physical pages')
        except ParserError:
            raise
        except Exception as exc:
            raise ParserError('invalid_or_damaged_pdf', 'PDF metadata/page tree cannot be decoded') from exc
        try:
            from docling_parse.pdf_parser import DoclingPdfParser, DecodeConfig, ContentConfig, ContentLevel
        except ImportError as exc:
            raise ParserError('parser_dependency_missing', 'Install the isolated pinned parser requirements') from exc
        config = {'adapter_version': ADAPTER_VERSION, 'adapter_sha256': sha256(Path(__file__).read_bytes()).hexdigest(),
                  'config_revision': self.config_revision, 'normalization_version': NORMALIZATION_VERSION,
                  'do_sanitization': False, 'keep_glyphs': False, 'ocr_enabled': False, 'table_reconstruction': False,
                  'reading_order': 'backend_textline_order_unverified', 'metadata_backend': 'pypdf-' + version('pypdf')}
        backend_version = version('docling-parse')
        config_digest = sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        backend_started = time.monotonic()
        try:
            with native_stdout_to_stderr():
                parser = DoclingPdfParser(loglevel='fatal')
                backend = parser.load(path_or_stream=BytesIO(raw), lazy=True,
                                      decode_config=DecodeConfig(do_sanitization=False, keep_glyphs=False),
                                      content_config=ContentConfig(char_cells_content_level=ContentLevel.SKIP,
                                                                  word_cells_content_level=ContentLevel.SKIP,
                                                                  line_cells_content_level=ContentLevel.COMPUTE_AND_MATERIALIZE,
                                                                  shapes_content_level=ContentLevel.SKIP,
                                                                  bitmaps_content_level=ContentLevel.COMPUTE_AND_MATERIALIZE,
                                                                  include_bitmap_bytes=False))
            if backend is None or not backend.is_loaded() or backend.number_of_pages() != page_count:
                raise ParserError('backend_page_count_mismatch', 'Backend and PDF page tree disagree')
        except ParserError:
            raise
        except Exception as exc:
            raise ParserError('backend_open_failed', 'Native backend could not open this PDF') from exc
        backend_init_seconds = time.monotonic() - backend_started
        pages, blocks, failures = [], [], []
        first_text_seconds = None
        identity = sha256((value.document_id + value.file_sha256 + backend_version + config_digest).encode()).hexdigest()[:20]
        try:
            for physical_page in range(1, page_count + 1):
                page_started = time.monotonic()
                base = {'physical_page': physical_page, 'printed_label': None, 'ocr': False,
                        'width': None, 'height': None, 'rotation': 0, 'coordinate_unit': 'pt', 'geometry': None,
                        'status': 'failed', 'text_layer_present': False, 'bitmap_count': None,
                        'ocr_requirement': 'unknown', 'error': None, 'duration_seconds': 0.0}
                page_blocks = []
                try:
                    geometry = page_geometry(reader.pages[physical_page - 1])
                    with native_stdout_to_stderr():
                        page = backend.get_page(physical_page)
                    for index, cell in enumerate(page.textline_cells):
                        raw_text = cell.orig if isinstance(cell.orig, str) else cell.text
                        if raw_text == '':
                            continue
                        text, mapping = normalize_text(raw_text)
                        bbox, source_geometry = geometry_for_cell(cell, geometry)
                        page_blocks.append({'block_id': f'{identity}-p{physical_page:04d}-l{index:06d}',
                                            'document_id': value.document_id, 'text_version': '', 'text': text,
                                            'raw_text': raw_text, 'backend_text': cell.text, 'raw_text_source': 'backend_cell_orig',
                                            'normalization_map': mapping, 'page': physical_page, 'type': 'text',
                                            'semantic_type_status': 'unclassified_textline',
                                            'reading_order': len(blocks) + len(page_blocks), 'bbox': bbox,
                                            'source_geometry': source_geometry, 'backend_cell_index': index})
                    bitmaps, has_text = len(page.bitmap_resources), any(b['text'].strip() for b in page_blocks)
                    if has_text and first_text_seconds is None:
                        first_text_seconds = time.monotonic() - started
                    status = 'text_layer_extracted_images_unverified' if has_text and bitmaps else 'text_layer_extracted_fidelity_unverified' if has_text else 'ocr_required_no_text_layer' if bitmaps else 'blank_or_vector_page_unverified'
                    base.update({'width': geometry['width'], 'height': geometry['height'], 'rotation': geometry['rotation'],
                                 'geometry': geometry, 'backend_dimension': page.dimension.model_dump(mode='json'),
                                 'status': status, 'text_layer_present': has_text, 'bitmap_count': bitmaps,
                                 'ocr_requirement': 'possible_image_text_unverified' if has_text and bitmaps else 'required' if bitmaps else 'not_detected' if has_text else 'unknown'})
                    blocks.extend(page_blocks)
                except Exception as exc:
                    code = exc.code if isinstance(exc, ParserError) else 'page_decode_failed'
                    base['error'] = {'code': code, 'exception_type': type(exc).__name__}
                    failures.append({'physical_page': physical_page, 'code': code})
                base['duration_seconds'] = round(time.monotonic() - page_started, 6)
                pages.append(base)
        finally:
            with native_stdout_to_stderr():
                backend.unload()
        raw_digest = sha256(json.dumps([(b['block_id'], b['raw_text'], b['bbox']) for b in blocks], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        text_version = 's3-' + sha256((identity + raw_digest).encode()).hexdigest()[:32]
        for block in blocks:
            block['text_version'] = text_version
        decoded = [p['physical_page'] for p in pages if p['status'] != 'failed']
        text_pages = [p['physical_page'] for p in pages if p['text_layer_present']]
        no_text = [p['physical_page'] for p in pages if p['status'] != 'failed' and not p['text_layer_present']]
        image_unverified = [p['physical_page'] for p in pages if p['bitmap_count']]
        state = 'unsupported' if not blocks else 'partial' if failures or no_text or image_unverified else 'parsed'
        usage_after = resource.getrusage(resource.RUSAGE_SELF)
        ids = [b['block_id'] for b in blocks]
        return {
            'schema_version': '2', 'document_id': value.document_id, 'file_sha256': value.file_sha256,
            'fixture': value.fixture, 'evidence_kind': 'engineering_fixture' if value.fixture else 'real_paper', 'title': None,
            'source': {'file_reference': str(path.relative_to(self.allowed_root)), 'bytes': len(raw), 'original_modified': False},
            'parser': {'id': self.parser_id, 'version': backend_version, 'status': state, 'config': config, 'config_digest': config_digest},
            'text_version': text_version, 'raw_text_version': text_version + '-raw', 'offset_unit': 'unicode_code_point',
            'offset_interval': '[start,end)', 'normalization_version': NORMALIZATION_VERSION, 'pages': pages, 'blocks': blocks,
            'coverage': {'expected_block_ids': ids, 'processed_block_ids': ids, 'failed_block_ids': [], 'excluded': [],
                         'scope': 'emitted_text_layer_blocks_only', 'physical_pages_expected': list(range(1, page_count + 1)),
                         'decoded_pages': decoded, 'text_layer_pages': text_pages, 'failed_pages': failures,
                         'pages_without_text': no_text, 'image_text_unverified_pages': image_unverified,
                         'page_enumeration_complete': len(pages) == page_count, 'text_layer_decode_complete': len(text_pages) == page_count,
                         'full_content_coverage_verified': False, 'fidelity_human_verified': False,
                         'table_structure': 'not_reconstructed', 'reading_order': 'backend_textline_order_unverified',
                         'limitations': ['No OCR or text burned into images', 'No table/header/footnote or caption association',
                                         'Backend line order preserved; multi-column reading order unverified',
                                         'Whole textline coordinates; exact glyph highlighting not implemented',
                                         'Decoded text, Unicode, units, superscripts and omissions require human PDF comparison']},
            'metrics': {'file_check_seconds': round(file_check_seconds, 6), 'backend_init_seconds': round(backend_init_seconds, 6),
                        'first_text_seconds': round(first_text_seconds, 6) if first_text_seconds is not None else None,
                        'total_seconds': round(time.monotonic() - started, 6),
                        'cpu_user_seconds': round(usage_after.ru_utime - usage_before.ru_utime, 6),
                        'cpu_system_seconds': round(usage_after.ru_stime - usage_before.ru_stime, 6),
                        'peak_rss_bytes': usage_after.ru_maxrss * 1024, 'peak_rss_scope': 'current_process_lifetime_linux_ru_maxrss',
                        'gpu_peak_memory_bytes': None, 'network_document_uploads': 0, 'llm_calls': 0},
        }
