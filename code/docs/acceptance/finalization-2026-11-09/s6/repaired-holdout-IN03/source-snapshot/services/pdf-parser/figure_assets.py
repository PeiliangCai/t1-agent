"""CPU-only, source-bound Figure sidecars; no OCR/VLM, image synthesis or PDF mutation.

Numbered source-anchored captions determine Figure identity. Explicit native
Note links only supplement tight, unambiguous source-page geometry; they never
establish identity or verification. Geometry and barriers produce *candidates*.
Even a clean native rectangle is not proof that every panel belongs to a Figure.
"""
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from ctypes import byref, c_int
from datetime import datetime, timezone
import argparse
import json
import math
import re

from adapter import CODE, DoclingParseTextAdapter, ParseInput, ParserError

FIGURE_START = re.compile(r'^\s*(?:fig(?:ure)?\.?\s*|图\s*)([1-9][0-9]*)(?![0-9])', re.I)
NOTE_START = re.compile(r'^\s*(?:注(?:释)?\s*[:：]|(?:figure\s+)?notes?\s*[:：.])', re.I)


def locate_caption(document, unit):
    if unit['mapping']['status'] not in ['exact', 'normalized_alignment']:
        return []
    blocks = {b['block_id']: b for b in document['blocks']}
    result = []
    for s in unit['source_segments']:
        b = blocks.get(s['block_id'])
        if not b or s['text_version'] != document['text_version'] or not 0 <= s['start'] < s['end'] <= len(b['text']):
            raise ParserError('figure_caption_source_mismatch', 'Caption segments must bind the original source text')
        quote = b['text'][s['start']:s['end']]
        occurrences = [i for i in range(len(b['text']) - len(quote) + 1) if b['text'].startswith(quote, i)]
        result.append({**s, 'exact_quote': quote, 'occurrence': occurrences.index(s['start']),
                       'physical_page': b['page'], 'bbox': list(b['bbox']), 'location_precision': 'whole_textline_not_exact_glyph'})
    return sorted(result, key=lambda s: (blocks[s['block_id']]['reading_order'], s['start']))


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def overlap(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))


def distance(a, b):
    return math.hypot(max(0, a[0] - b[2], b[0] - a[2]), max(0, a[1] - b[3], b[1] - a[3]))


def panel_labels(text):
    # Preserve the printed label/range; never guess a lesion or select a panel crop.
    return list(dict.fromkeys(m[0] for m in re.finditer(r'(?<![A-Za-z])(?:[A-Ia-i]\s*[-–—]\s*[A-Ia-i]|[（(][A-Ia-i][）)])', text)))


def supplemental_notes(document, captions, components):
    """Retain a separately parsed Note without swallowing neighboring prose.

    A vendor link alone is insufficient. A body caption/footnote must literally
    start with an explicit Note marker, link to one picture component, sit below
    that component, and adjoin exactly one numbered caption in the same column.
    No missing line, continuation paragraph, panel or cross-page link is inferred.
    """
    result = {id(caption): [] for caption in captions}
    table_notes = {identifier for table in document['structure']['tables']
                   for identifier in table['caption_unit_ids'] + table['footnote_unit_ids']}
    blocks = {b['block_id']: b for b in document['blocks']}
    for unit in document['structure']['units']:
        if (unit['kind'] not in ['caption', 'footnote'] or unit.get('content_layer') != 'body'
                or unit['unit_id'] in table_notes or not NOTE_START.match(unit['native_text'])):
            continue
        segments = locate_caption(document, unit)
        if not segments or not NOTE_START.match(segments[0]['exact_quote']):
            continue
        if any(s['start'] != 0 or s['end'] != len(blocks[s['block_id']]['text']) for s in segments):
            continue
        pages = {s['physical_page'] for s in segments}
        if len(pages) != 1:
            continue
        # Reject a native Note that joins columns, skips a paragraph or reverses
        # visual line order, even if the processed text looks like one caption.
        if any(not 0 <= b['bbox'][1] - a['bbox'][3] <= 16 or abs(b['bbox'][0] - a['bbox'][0]) > 24
               for a, b in zip(segments, segments[1:])):
            continue
        page = segments[0]['physical_page']; box = union([s['bbox'] for s in segments])
        adjacent = []
        for caption in captions:
            if {s['physical_page'] for s in caption['segments']} != pages:
                continue
            capbox = union([s['bbox'] for s in caption['segments']])
            horizontal = max(0, min(box[2], capbox[2]) - max(box[0], capbox[0]))
            if (horizontal >= min(box[2] - box[0], capbox[2] - capbox[0]) * 0.5
                    and (0 <= capbox[1] - box[3] <= 16 or 0 <= box[1] - capbox[3] <= 16)):
                adjacent.append((caption, capbox))
        if len(adjacent) != 1:
            continue
        caption, capbox = adjacent[0]
        owners = [p for p in document['structure']['pictures']
                  if unit['unit_id'] in p['caption_unit_ids'] + p['footnote_unit_ids']
                  and p.get('association_status') != 'conflict']
        linked = [c for c in components if c['page'] == page and any(p['picture_id'] in c['ids'] for p in owners)]
        if len(owners) != 1 or len(linked) != 1:
            continue
        picture = linked[0]['bbox']
        # Both strings must be below the same Figure, with enough common width
        # to avoid attaching an adjacent column's note or a caption beside a plot.
        if not (0 <= min(box[1], capbox[1]) - picture[3] <= 72
                and max(box[3], capbox[3]) - picture[3] <= 96
                and box[0] >= picture[0] - 64 and box[2] <= picture[2] + 64):
            continue
        if any(max(0, min(picture[2], b[2]) - max(picture[0], b[0])) < min(picture[2] - picture[0], b[2] - b[0]) * 0.5
               for b in [box, capbox]):
            continue
        bridge = union([box, capbox])
        owned = {s['block_id'] for s in segments + caption['segments']}
        if any(b['page'] == page and b['block_id'] not in owned and b['text'].strip()
               and overlap(b['bbox'], bridge) > 0.5 * (b['bbox'][2] - b['bbox'][0]) * (b['bbox'][3] - b['bbox'][1])
               for b in blocks.values()):
            continue
        result[id(caption)].extend(segments)
    return result


def supplemental_caption_columns(document, captions, components):
    """Keep demonstrable two-column caption continuation as unverified context.

    The vendor relationship is never rewritten. Both source-mapped columns must
    occupy the same narrow band directly under one explicitly linked picture,
    with no intervening source paragraph and a lower-case continuation. Ambiguous
    layouts retain separate text; this does not certify a complete caption.
    """
    units = {u['unit_id']: u for u in document['structure']['units']}
    blocks = {b['block_id']: b for b in document['blocks']}
    proposals = []
    for caption in captions:
        left = units.get(caption['unit_id'])
        if not left:
            continue
        if len({s['physical_page'] for s in caption['segments']}) != 1:
            continue
        page = caption['segments'][0]['physical_page']
        a = union([s['bbox'] for s in caption['segments']])
        if re.search(r'[.!?。！？][”’"\')\]]*$', left['native_text'].rstrip()):
            continue
        owners = [p for p in document['structure']['pictures'] if left['unit_id'] in p['caption_unit_ids']
                  and p.get('association_status') != 'conflict']
        linked = [c for c in components if c['page'] == page and any(p['picture_id'] in c['ids'] for p in owners)]
        if len(owners) != 1 or len(linked) != 1:
            continue
        picture = linked[0]['bbox']
        for right in units.values():
            text = right['native_text'].lstrip()
            if (right['unit_id'] == left['unit_id'] or right['kind'] not in ['caption', 'text'] or right['content_layer'] != 'body'
                    or not text or not text[0].islower() or FIGURE_START.match(text) or NOTE_START.match(text)):
                continue
            segments = locate_caption(document, right)
            if not segments or {s['physical_page'] for s in segments} != {page}:
                continue
            b = union([s['bbox'] for s in segments])
            if not (8 <= b[0] - a[2] <= 64 and abs(a[1] - b[1]) <= 3 and abs(a[3] - b[3]) <= 12
                    and 0.65 <= (b[2] - b[0]) / max(1, a[2] - a[0]) <= 1.55
                    and 0 <= min(a[1], b[1]) - picture[3] <= 48
                    and a[0] >= picture[0] - 48 and b[2] <= picture[2] + 48):
                continue
            owned = {s['block_id'] for s in caption['segments'] + segments}
            band = union([a, b])
            if any(block['page'] == page and block['block_id'] not in owned and block['text'].strip()
                   and overlap(block['bbox'], band) > 0.5 * max(1e-6, (block['bbox'][2] - block['bbox'][0]) * (block['bbox'][3] - block['bbox'][1]))
                   for block in blocks.values()):
                continue
            proposals.append((caption, right['unit_id'], segments))
    result = {id(c): [] for c in captions}
    for caption, identifier, segments in proposals:
        if sum(c is caption for c, _, _ in proposals) == 1 and sum(i == identifier for _, i, _ in proposals) == 1:
            result[id(caption)] = segments
    return result


def raw_caption_segments(document, label):
    """Retain a standalone printed Figure label and tight same-style lines.

    This is source geometry, never a semantic repair of the vendor structure.
    A new paragraph, column, competing line, label or font-size change stops it.
    Newly grouped captions always require review, even when one bitmap exists.
    """
    def located(block):
        return {'block_id': block['block_id'], 'text_version': document['text_version'], 'start': 0,
                'end': len(block['text']), 'exact_quote': block['text'], 'occurrence': 0,
                'physical_page': block['page'], 'bbox': list(block['bbox']), 'location_precision': 'whole_textline_not_exact_glyph'}
    result, previous, line_height = [located(label)], label, None
    for _ in range(24):
        candidates = [b for b in document['blocks'] if b['page'] == label['page'] and b['text'].strip()
                      and b['bbox'][1] >= previous['bbox'][3] - 0.25
                      and 0 <= b['bbox'][1] - previous['bbox'][3] <= 6
                      and abs(b['bbox'][0] - label['bbox'][0]) <= 3]
        if not candidates:
            break
        candidates.sort(key=lambda b: b['bbox'][1])
        following = candidates[0]
        if sum(abs(b['bbox'][1] - following['bbox'][1]) <= 1 for b in candidates) != 1:
            break
        height = following['bbox'][3] - following['bbox'][1]
        if (re.match(r'^\s*(?:fig(?:ure)?\.?\s*\d|table\s*\d|[图表]\s*\d)', following['text'], re.I)
                or height <= 0 or height > (line_height or (label['bbox'][3]-label['bbox'][1])) * 1.4
                or line_height and abs(height-line_height) > max(.8, line_height*.15)):
            break
        line_height = line_height or height
        result.append(located(following)); previous = following
    return result


def discover_figures(document, image_inventory=None):
    if document['schema_version'] != '3':
        return []
    units = {u['unit_id']: u for u in document['structure']['units']}
    pictures = []
    for picture in document['structure']['pictures']:
        for p in units[picture['picture_id']]['provenance']:
            box = p['bbox']
            if box and box[2] - box[0] >= 48 and box[3] - box[1] >= 36 and (box[2]-box[0])*(box[3]-box[1]) >= 2400:
                pictures.append({'id': picture['picture_id'], 'page': p['physical_page'], 'bbox': box})
    # A complete original bitmap is a better review region than a detector's
    # partial panel. It remains unverified; this never infers medical identity.
    if image_inventory is not None:
        source_pictures = []
        for page, objects in image_inventory.items():
            for index, obj in enumerate(objects):
                box = obj['bbox']
                if not obj['top_level'] or (box[2]-box[0])*(box[3]-box[1]) < 2400 or box[2]-box[0] < 48 or box[3]-box[1] < 36:
                    continue
                owned = [p for p in pictures if p['page'] == page and overlap(p['bbox'], box) >=
                         (p['bbox'][2]-p['bbox'][0])*(p['bbox'][3]-p['bbox'][1])*.95]
                owners = [p['id'] for p in owned]
                region = list(box)
                if owned:
                    detected = union([p['bbox'] for p in owned])
                    if (overlap(detected, box) >= (box[2]-box[0])*(box[3]-box[1])*.98
                            and max(0, detected[0]-box[0], detected[1]-box[1], box[2]-detected[2], box[3]-detected[3]) <= 8):
                        region = union([box, detected])
                source_pictures.append({'id': owners[0] if owners else f'original-bitmap-p{page}-{index}',
                                        'ids': owners, 'page': page, 'bbox': region})
        pictures = source_pictures + [p for p in pictures if not any(q['page'] == p['page'] and overlap(q['bbox'], p['bbox']) >=
                     (p['bbox'][2]-p['bbox'][0])*(p['bbox'][3]-p['bbox'][1])*.95 for q in source_pictures)]
    # Geometry components keep a multi-panel group intact instead of cropping a guessed panel.
    components = []
    unseen = list(pictures)
    while unseen:
        group = [unseen.pop(0)]
        changed = True
        while changed:
            changed = False
            for p in list(unseen):
                if any(q['page'] == p['page'] and distance(q['bbox'], p['bbox']) <= 24 for q in group):
                    group.append(p); unseen.remove(p); changed = True
        components.append({'page': group[0]['page'], 'bbox': union([p['bbox'] for p in group]),
                           'ids': list(dict.fromkeys(identifier for p in group for identifier in p.get('ids', [p['id']])) )})
    captions = []
    seen_segments = set()
    for unit in document['structure']['units']:
        if not FIGURE_START.match(unit['native_text']):
            continue
        segments = locate_caption(document, unit)
        if not segments:
            continue
        original = '\n'.join(s['exact_quote'] for s in segments)
        marker = FIGURE_START.match(original)
        if not marker:
            continue
        key = tuple((s['block_id'], s['start'], s['end']) for s in segments)
        if key in seen_segments:
            continue
        seen_segments.add(key)
        captions.append({'number': marker[1], 'segments': segments, 'text': original, 'unit_id': unit['unit_id']})
    # A native paragraph can incorrectly absorb a distant Figure label. A raw
    # standalone label supplies the literal identity without rewriting that IR.
    for block in document['blocks']:
        marker = FIGURE_START.fullmatch(block['text'].strip())
        if not marker:
            continue
        segments = raw_caption_segments(document, block)
        existing = [c for c in captions if any(s['block_id'] == block['block_id'] for s in c['segments'])]
        if existing:
            if len(existing) == 1 and len(existing[0]['segments']) == 1 and len(segments) > 1:
                existing[0].update(segments=segments, text='\n'.join(s['exact_quote'] for s in segments), raw_geometry_caption=True)
            continue
        captions.append({'number': marker[1], 'segments': segments, 'text': '\n'.join(s['exact_quote'] for s in segments),
                         'unit_id': None, 'raw_geometry_caption': True})
    continued = supplemental_caption_columns(document, captions, components)
    for caption in captions:
        extra = continued[id(caption)]
        caption['numbered_identity_segments'] = list(caption['segments'])
        if extra:
            # Native/source column boundaries remain separate literal segments.
            caption['segments'] = caption['segments'] + extra
            caption['text'] = '\n'.join(s['exact_quote'] for s in caption['segments'])
    notes = supplemental_notes(document, captions, components)
    figures, used_components = [], set()
    for caption in captions:
        # Keep the identity of the numbered caption stable when separately
        # parsed notes add literal context to a new derived catalog.
        identity_segments = caption['numbered_identity_segments']
        extra = notes[id(caption)]
        if extra:
            blocks = {b['block_id']: b for b in document['blocks']}
            by_span = {(s['block_id'], s['start'], s['end']): s for s in identity_segments + extra}
            caption['segments'] = sorted(by_span.values(), key=lambda s: (blocks[s['block_id']]['reading_order'], s['start']))
            caption['text'] = '\n'.join(s['exact_quote'] for s in caption['segments'])
        pages = {s['physical_page'] for s in caption['segments']}
        candidates = []
        for index, component in enumerate(components):
            if component['page'] not in pages:
                continue
            capbox = union([s['bbox'] for s in caption['segments'] if s['physical_page'] == component['page']])
            box = component['bbox']
            horizontal = max(0, min(box[2], capbox[2])-max(box[0], capbox[0]))
            vertical = max(0, min(box[3], capbox[3])-max(box[1], capbox[1]))
            below = 0 <= capbox[1] - box[3] <= 72 and horizontal >= min(box[2]-box[0], capbox[2]-capbox[0]) * 0.5
            side = distance(box, capbox) <= 60 and vertical >= min(box[3]-box[1], capbox[3]-capbox[1]) * 0.5
            if not (below or side):
                continue
            bridge = union([box, capbox]); caption_ids = {s['block_id'] for s in caption['segments']}
            barriers = [b for b in document['blocks'] if b['page'] == component['page'] and b['block_id'] not in caption_ids
                        and len(b['text'].strip()) > 16 and overlap(b['bbox'], bridge) > 0.5 * (b['bbox'][2]-b['bbox'][0])*(b['bbox'][3]-b['bbox'][1])
                        and overlap(b['bbox'], box) == 0]
            if not barriers:
                candidates.append((index, component))
        identity = sha256(json.dumps([document['file_sha256'], document['text_version'], identity_segments], sort_keys=True).encode()).hexdigest()[:24]
        unique = len(candidates) == 1
        selected = [candidates[0][1]] if unique else []
        if unique:
            used_components.add(candidates[0][0])
        figures.append({'figure_id': 'figure-' + identity, 'figure_number': caption['number'], 'caption_segments': caption['segments'],
                        'panel_labels': panel_labels(caption['text']), 'native_picture_ids': [i for c in selected for i in c['ids']],
                        'region_specs': [{'physical_page': c['page'], 'bbox': c['bbox']} for c in selected],
                        'caption_continuation_unverified': bool(continued[id(caption)]) or caption.get('raw_geometry_caption', False),
                        'verification': {'status': 'needs_review', 'method': 'native_candidate_only', 'actor': None, 'checked_at': None,
                         'notes': ('Standalone original label and adjoining same-style caption lines retained by source geometry; relation and completeness require original-page review. ' if caption.get('raw_geometry_caption') else '') +
                                  ('Same-band cross-column caption continuation retained as separate source segments; relation and caption completeness remain unverified. ' if continued[id(caption)] else '') +
                                  ('Separately parsed explicit Note retained as source segments after unique native-link and same-page geometry checks; Note/caption relation remains unverified. ' if extra else '') +
                                  ('Independent numbered source caption + unique connected picture region + adjacency + no paragraph barrier; whole-Figure/panel completeness still needs source-page check.' if unique else
                                   'No unique compatible whole-Figure region; caption retained and no rectangle guessed.'),
                         'all_panels_included': False, 'caption_figure_identity_checked': False, 'human_approved': False}})
    # Preserve unassigned regions as candidates. Absence of a numbered caption never means "no figure".
    for index, component in enumerate(components):
        if index in used_components:
            continue
        identity = sha256(json.dumps([document['file_sha256'], component], sort_keys=True).encode()).hexdigest()[:24]
        figures.append({'figure_id': 'region-' + identity, 'figure_number': None, 'caption_segments': [], 'panel_labels': [],
                        'native_picture_ids': component['ids'], 'region_specs': [{'physical_page': component['page'], 'bbox': component['bbox']}],
                        'verification': {'status': 'needs_review', 'method': 'native_candidate_only', 'actor': None, 'checked_at': None,
                         'notes': 'Unassigned picture geometry; no Figure/caption identity inferred.', 'all_panels_included': False,
                         'caption_figure_identity_checked': False, 'human_approved': False}})
    return figures


def original_image_objects(page, info):
    """PDFium maps original PDF page coordinates to the same rotated CropBox as the render.

    Nested Form image transforms are not guessed. Such objects remain unverified.
    """
    import pypdfium2 as pdfium
    size_x, size_y = math.ceil(info['width']*16), math.ceil(info['height']*16)
    objects = []
    for image in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE]):
        left, bottom, right, top = image.get_bounds()
        points = []
        for x, y in [(left, bottom), (left, top), (right, bottom), (right, top)]:
            dx, dy = c_int(), c_int()
            if not pdfium.raw.FPDF_PageToDevice(page, 0, 0, size_x, size_y, 0, x, y, byref(dx), byref(dy)):
                raise ParserError('figure_object_coordinate_failed', 'Original image object coordinate conversion failed')
            points.append((dx.value*info['width']/size_x, dy.value*info['height']/size_y))
        objects.append({'bbox': [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)],
                        'top_level': image.level == 0})
    return objects


def complete_bitmap_render_bounds(figure, image_objects, page_info, document=None):
    """Do not clip an almost-contained original bitmap, even when its caption needs review.

    This repairs only render geometry. It does not establish caption, panel,
    case or medical identity and never changes verification/approval fields.
    """
    if len(figure['region_specs']) != 1:
        return 'not_one_region'
    spec = figure['region_specs'][0]; box = spec['bbox']
    intersecting = [o for o in image_objects if overlap(o['bbox'], box) > 0]
    if len(intersecting) != 1 or not intersecting[0]['top_level']:
        return 'ambiguous_or_nested_bitmap'
    original = intersecting[0]['bbox']
    area = (original[2]-original[0])*(original[3]-original[1])
    missing_margin = max(0, box[0]-original[0], box[1]-original[1], original[2]-box[2], original[3]-box[3])
    if area <= 0 or overlap(original, box)/area < 0.98 or missing_margin > 8:
        return 'bitmap_outside_small_rounding_margin'
    if any(o is not intersecting[0] and distance(o['bbox'], box) <= 24 for o in image_objects):
        return 'nearby_uncontained_bitmap'
    full = union([box, original])
    if not (0 <= full[0] < full[2] <= page_info['width'] and 0 <= full[1] < full[3] <= page_info['height']):
        return 'bitmap_outside_bound_page'
    if full == box:
        return 'already_contains_complete_bitmap'
    caption_ids = {s['block_id'] for s in figure['caption_segments']}
    if document and any(b['page'] == spec['physical_page'] and b['block_id'] not in caption_ids
                        and len(b['text'].strip()) > 16
                        and overlap(b['bbox'], full) > overlap(b['bbox'], box) + 0.01
                        for b in document['blocks']):
        return 'unrelated_source_text_in_added_margin'
    spec['bbox'] = full
    return 'completed_original_bitmap_render_bounds'


def mechanically_check(figure, candidate, all_candidates, image_objects, page_info, document=None, external_paths=()):
    if document:
        blocks = {b['block_id']: b for b in document['blocks']}
        if any(g['start'] < s['end'] and s['start'] < g['end']
               for s in candidate['caption_segments'] for g in blocks[s['block_id']].get('source_glyph_issues', [])):
            figure['verification']['notes'] += ' Source caption has an undecidable embedded-font glyph; original-page review required.'
            return
    # A newly grouped native Note is review context, never automatic proof of
    # caption identity, complete panels or suitability as a medical image.
    if candidate.get('caption_continuation_unverified') or any(NOTE_START.match(s['exact_quote']) for s in candidate['caption_segments']):
        return
    if not figure['figure_number'] or len(candidate['region_specs']) != 1:
        return
    if sum(c['figure_number'] == figure['figure_number'] for c in all_candidates) != 1:
        return
    box = figure['region_specs'][0]['bbox']
    intersecting = [o for o in image_objects if overlap(o['bbox'], box) > 0]
    if len(intersecting) != 1 or not intersecting[0]['top_level']:
        return
    original = intersecting[0]['bbox']
    if max(abs(a-b) for a, b in zip(original, box)) > 8:
        return
    if any(o is not intersecting[0] and distance(o['bbox'], box) <= 24 for o in image_objects):
        return
    # Extra drawn parts or printed panel labels outside the candidate would be lost by a bitmap-only crop.
    for path_box in external_paths:
        if distance(path_box, box) <= 16 and overlap(path_box, box) < max(1, (path_box[2]-path_box[0])*(path_box[3]-path_box[1]))*0.95:
            return
    if document:
        for block in document['blocks']:
            if block['page'] != candidate['region_specs'][0]['physical_page'] or not re.fullmatch(r'\s*\(?[A-Za-z]\)?\s*', block['text']):
                continue
            if distance(block['bbox'], box) <= 24 and not (box[0] <= block['bbox'][0] and box[1] <= block['bbox'][1] and box[2] >= block['bbox'][2] and box[3] >= block['bbox'][3]):
                return
    if any(c is not candidate and c['figure_number'] and any(s['physical_page'] == candidate['region_specs'][0]['physical_page'] and
           distance(s['bbox'], box) <= 72 for s in c['caption_segments']) for c in all_candidates):
        return
    # Pure geometry completion runs separately, including for caption/Note review
    # cases. A refused completion must not be bypassed by an approval path.
    full = union([box, original])
    if full != box or not (0 <= full[0] < full[2] <= page_info['width'] and 0 <= full[1] < full[3] <= page_info['height']):
        return
    figure['verification'] = {'status': 'mechanically_checked', 'method': 'single_pdf_bitmap_caption_guard_1',
       'actor': 'local-deterministic-figure-guard-1', 'checked_at': datetime.now(timezone.utc).isoformat(),
       'notes': 'Unique source-numbered caption, no paragraph barrier, one complete top-level original PDF bitmap matching the whole detector region; no nearby uncontained bitmap. Engineering structural check, not human/medical approval.',
       'all_panels_included': True, 'caption_figure_identity_checked': True, 'human_approved': False,
       'mechanical_evidence': {'pdf_image_object_count': 1, 'original_image_bbox': original,
          'caption_number_unique': True, 'no_nearby_uncontained_visual_objects': True, 'no_intervening_paragraph': True,
          'native_region_matches_complete_pdf_bitmap': True}}


def extract_catalog(document, output_directory, *, scale=2):
    import pypdfium2 as pdfium
    if not 0.25 <= scale <= 4:
        raise ParserError('figure_render_scale_invalid', 'Render scale must be between 0.25 and 4')
    output = Path(output_directory).resolve()
    if not output.is_relative_to(CODE):
        raise ParserError('figure_output_outside_code', 'Figure assets must remain inside code/')
    value = ParseInput('figure-assets', document['document_id'], document['source']['file_reference'], document['file_sha256'], document['fixture'])
    pdf_path, _ = DoclingParseTextAdapter()._read(value)
    output.mkdir(parents=True, exist_ok=False)
    catalog = {'schema_version': 'figure-asset-catalog-1', 'document_id': document['document_id'], 'file_sha256': document['file_sha256'],
               'text_version': document['text_version'], 'figures': [], 'inventory_complete': False,
               'original_pdf_modified': False, 'generated_images_used': False}
    from structured import validate_structured
    if document['schema_version'] == '3':
        validate_structured(document)
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        image_inventory = {}
        for info in document['pages']:
            if info['status'] == 'failed':
                continue
            page = pdf[info['physical_page']-1]
            try:
                image_inventory[info['physical_page']] = original_image_objects(page, info)
            finally:
                page.close()
        candidates = discover_figures(document, image_inventory)
        for candidate in candidates:
            figure = deepcopy(candidate)
            figure.pop('caption_continuation_unverified', None)
            if len(figure['region_specs']) == 1:
                page_number = figure['region_specs'][0]['physical_page']; page = pdf[page_number-1]
                try:
                    # Top-level path rectangles outside the bitmap are a mixed/vector-Figure warning.
                    info = document['pages'][page_number-1]
                    paths = []
                    for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_PATH]):
                        if obj.level != 0:
                            continue
                        l, b, r, t = obj.get_bounds(); points = []
                        for x, y in [(l, b), (r, t)]:
                            dx, dy = c_int(), c_int(); sx, sy = math.ceil(info['width']*16), math.ceil(info['height']*16)
                            if pdfium.raw.FPDF_PageToDevice(page, 0, 0, sx, sy, 0, x, y, byref(dx), byref(dy)):
                                points.append((dx.value*info['width']/sx, dy.value*info['height']/sy))
                        if len(points) == 2:
                            paths.append([min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)])
                    image_objects = original_image_objects(page, info)
                    complete_bitmap_render_bounds(figure, image_objects, info, document)
                    mechanically_check(figure, candidate, candidates, image_objects, info, document, paths)
                finally:
                    page.close()
            specs = figure.pop('region_specs'); figure['regions'] = []
            for region_index, spec in enumerate(specs):
                page_number, box = spec['physical_page'], spec['bbox']
                info = document['pages'][page_number-1]
                if not all(math.isfinite(n) for n in box) or not (0 <= box[0] < box[2] <= info['width'] and 0 <= box[1] < box[3] <= info['height']):
                    raise ParserError('figure_region_invalid', 'Figure bbox must be inside the bound rotated CropBox')
                page = pdf[page_number-1]
                try:
                    width, height = page.get_size()
                    render_scale = scale * info['width'] / width
                    if width*height*render_scale**2 > 50_000_000:
                        raise ParserError('figure_render_pixel_limit', 'Page render exceeds the local pixel bound')
                    bitmap = page.render(scale=render_scale)
                    try:
                        image = bitmap.to_pil()
                        sx, sy = image.width/info['width'], image.height/info['height']
                        pixels = [math.floor(box[0]*sx), math.floor(box[1]*sy), math.ceil(box[2]*sx), math.ceil(box[3]*sy)]
                        crop = image.crop(pixels)
                        filename = figure['figure_id'] + f'-p{page_number}-{region_index}.png'
                        path = output / filename
                        with path.open('xb') as stream:
                            crop.save(stream, format='PNG')
                        figure['regions'].append({'asset_id': figure['figure_id']+f'-{region_index}', 'path': str(path.relative_to(CODE)),
                           'sha256': sha256(path.read_bytes()).hexdigest(), 'mime_type': 'image/png', 'physical_page': page_number,
                           'bbox': box, 'coordinate_system': 'crop_rotated_top_left_pt', 'width_px': crop.width, 'height_px': crop.height,
                           'render_scale': scale, 'extraction_method': 'original_pdf_region_render', 'source_pdf_sha256': document['file_sha256'],
                           'visual_modification': 'none'})
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            catalog['figures'].append(figure)
    finally:
        pdf.close()
    schema = json.loads((CODE/'packages/contracts/schema/FigureAssetCatalog.json').read_text())
    import jsonschema
    jsonschema.validate(catalog, schema)
    (output/'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2)+'\n')
    return catalog


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--document', required=True)
    cli.add_argument('--output', required=True)
    cli.add_argument('--scale', type=float, default=2)
    args = cli.parse_args()
    payload = json.loads(Path(args.document).read_text())
    catalog = extract_catalog(payload.get('document', payload), args.output, scale=args.scale)
    print(json.dumps({'figures': len(catalog['figures']), 'regions': sum(len(f['regions']) for f in catalog['figures']),
                      'mechanically_checked': sum(f['verification']['status'] == 'mechanically_checked' for f in catalog['figures']),
                      'whole_figure_checked': 0, 'remote_calls': 0, 'catalog': str(Path(args.output)/'catalog.json')}))


if __name__ == '__main__':
    main()
