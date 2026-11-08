"""Recover source paragraph relations from explicit print-flow witnesses.

Relations retain every original span and physical boundary. An engineering
check is distinct from user approval and from medical/case interpretation.
"""
from hashlib import sha256
import json
import re
import statistics

VERSION = 'source-print-flow-1'


def restore_continuations(builder, source, geometry):
    blocks = {b['block_id']: b for b in source['blocks']}
    units = {u['unit_id']: u for u in builder.units}
    ordered = [units[i] for i in builder.reading_order if units[i]['content_layer'] == 'body'
               and units[i]['native_label'] not in ['page_header', 'page_footer']]
    indent_witnesses = []
    for unit in ordered:
        spans = unit['source_segments']
        if unit['kind'] != 'text' or len(spans) < 3 or len({blocks[s['block_id']]['page'] for s in spans}) != 1: continue
        lines = [blocks[s['block_id']] for s in spans]
        if max(b['bbox'][0] for b in lines[1:]) - min(b['bbox'][0] for b in lines[1:]) > 5: continue
        height = statistics.median(b['bbox'][3] - b['bbox'][1] for b in lines)
        indent = lines[0]['bbox'][0] - min(b['bbox'][0] for b in lines[1:])
        if 1.5 * height <= indent <= 3.5 * height:
            indent_witnesses.append(unit['unit_id'])
    relations, unresolved = [], []
    for left, right in zip(ordered, ordered[1:]):
        if left['kind'] not in ['text', 'caption', 'list_item'] or right['kind'] not in ['text', 'caption', 'list_item']: continue
        if any(u['mapping']['status'] not in ['exact', 'normalized_alignment'] or not u['source_segments'] for u in [left, right]): continue
        lspans, rspans = left['source_segments'], right['source_segments']
        last, first = blocks[lspans[-1]['block_id']], blocks[rspans[0]['block_id']]
        a, b = last['bbox'], first['bbox']
        page_break = first['page'] == last['page'] + 1
        column_break = first['page'] == last['page'] and b[0] >= a[2] - 8 and b[1] < a[1]
        same_band = first['page'] == last['page'] and right['provenance'][0]['bbox'] and left['provenance'][0]['bbox'] and abs(right['provenance'][0]['bbox'][1] - left['provenance'][0]['bbox'][1]) <= 3
        if not (page_break or column_break): continue
        raw_left = '\n'.join(blocks[s['block_id']]['text'][s['start']:s['end']] for s in lspans)
        raw_right = '\n'.join(blocks[s['block_id']]['text'][s['start']:s['end']] for s in rspans)
        if re.search(r'[。！？.!?][”’"\')\]]*\s*$', raw_left) or re.search(r'上接\s*第?\s*\d+\s*页', raw_left + raw_right): continue
        figure = bool(re.match(r'(?i)^\s*(?:fig(?:ure)?\.?\s*\d|图\s*\d)', raw_left))
        if re.match(r'(?i)^\s*(?:fig(?:ure)?\.?\s*\d|图\s*\d|table\s*\d|表\s*\d)', raw_right): continue
        if not figure and left['kind'] != right['kind']: continue
        identities = lambda text: {m[0].lower().replace(' ', '') for m in re.finditer(r'\b(?:case|patient|lesion)\s*(?:no\.?\s*)?\d+|(?:病例|患者|病灶)\s*\d+', text, re.I)}
        li, ri = identities(raw_left), identities(raw_right)
        if li and ri and not li.intersection(ri): continue
        mapped_left, mapped_right = geometry.map_block(last), geometry.map_block(first)
        if not mapped_left or not mapped_right: continue
        fonts_l = {x['glyph']['font'] for x in mapped_left}; fonts_r = {x['glyph']['font'] for x in mapped_right}
        if not fonts_l.intersection(fonts_r): continue
        height = statistics.median(x['glyph']['bbox'][3] - x['glyph']['bbox'][1] for x in mapped_left + mapped_right)
        lboxes = [blocks[s['block_id']]['bbox'] for s in lspans]; rboxes = [blocks[s['block_id']]['bbox'] for s in rspans]
        line_full = abs(a[2] - max(box[2] for box in lboxes)) <= height * 1.2
        unindented = abs(b[0] - min(box[0] for box in rboxes)) <= height * .35
        if not line_full or not unindented: continue
        proofs = ['exact_raw_character_geometry', 'same_pdf_font', 'previous_line_fills_column', 'next_region_has_no_paragraph_indent', 'native_adjacent_units_without_heading_table_or_case_boundary']
        strength = None
        left_enum = list(re.finditer(r'[（(](\d+)[）)]', raw_left)); right_enum = list(re.finditer(r'[（(](\d+)[）)]', raw_right))
        if not figure and left_enum and right_enum and int(right_enum[0][1]) == int(left_enum[-1][1]) + 1 and right_enum[0].start() > 0:
            strength = 'numbered_item_continues_through_page_or_column'; proofs.append('printed_enumeration_next_item_is_consecutive')
        hyphen = bool(re.search(r'[A-Za-z]{2,}[-‐]\s*$', raw_left) and re.match(r'^\s*[a-z]+', raw_right))
        bracket = raw_left.count('(') > raw_left.count(')') and ')' in raw_right[:40] and '(' not in raw_right[:raw_right.find(')')]
        if figure:
            owners = [p for p in builder.pictures if left['unit_id'] in p['caption_unit_ids'] and p.get('association_status') != 'conflict']
            if not same_band or len(owners) != 1: continue
            picture = units[owners[0]['picture_id']]
            spanning = any(p['physical_page'] == first['page'] and p['bbox'] and p['bbox'][0] <= a[0] + 48 and p['bbox'][2] >= b[2] - 48
                           and 0 <= min(box[1] for box in lboxes + rboxes) - p['bbox'][3] <= 48 for p in picture['provenance'])
            if not spanning: continue
            if hyphen: strength = 'explicit_line_end_hyphen_with_shared_figure_band'; proofs.append('printed_hyphenated_word_continues')
            elif bracket: strength = 'explicit_unclosed_parenthesis_with_shared_figure_band'; proofs.append('printed_open_parenthesis_closed_in_next_caption_column')
            proofs.append('same_explicit_native_figure_parent_spans_both_caption_columns')
        elif hyphen:
            strength = 'explicit_line_end_hyphen_in_body_flow'; proofs.append('printed_hyphenated_word_continues')
        elif left['kind'] == right['kind'] == 'list_item' and re.match(r'^\s*[•·●▪◦‣–—]\s*', blocks[lspans[0]['block_id']]['text']) and not re.match(r'^\s*[•·●▪◦‣–—]', blocks[rspans[0]['block_id']]['text']):
            def column_edge(page, right_edge):
                # A nested list may occupy an entire local column. Resolve the
                # page's column rail from repeated same-sized source pages, not
                # from the nested item's own (indented) left edge.
                width = source['pages'][page - 1]['width']
                possible = [item['bbox'][0] for item in source['blocks'] if abs(source['pages'][item['page'] - 1]['width'] - width) < 1
                            and abs(item['bbox'][2] - right_edge) <= height * 2
                            and height * 12 < item['bbox'][2] - item['bbox'][0] <= 1.5 * max(a[2] - a[0], b[2] - b[0])]
                return min(possible) if possible else None
            left_edge, right_edge = column_edge(last['page'], a[2]), column_edge(first['page'], b[2])
            hanging = statistics.median(box[0] for box in lboxes[1:]) - left_edge if left_edge is not None and len(lboxes) > 1 else None
            incoming = b[0] - right_edge if right_edge is not None else None
            if hanging is not None and incoming is not None and hanging >= height and abs(hanging - incoming) <= height * .4:
                strength = 'printed_bullet_item_with_matching_hanging_indent'
                proofs.extend(['explicit_source_bullet_starts_previous_item', 'no_new_source_bullet_in_continuation', 'matching_hanging_indent_relative_to_column_rails'])
        elif strength is None and left['kind'] == right['kind'] == 'text' and len(indent_witnesses) >= 3:
            strength = 'document_paragraph_indent_convention'; proofs.append('source_repeated_indent_convention:' + str(len(indent_witnesses)))
        entry = {'from_unit_id': left['unit_id'], 'to_unit_id': right['unit_id'],
                 'boundary': 'physical_page' if page_break else 'column',
                 'source_type': 'figure_caption' if figure else 'body', 'ordered_segments': lspans + rspans,
                 'proof_codes': proofs, 'human_approved': False}
        if not strength:
            unresolved.append({**entry, 'status': 'needs_user_review', 'reason': 'no_explicit_split_word_enumeration_or_supported_indent_proof'})
            continue
        entry.update(status='engineering_checked', proof_method=strength)
        entry['relation_id'] = 'pc-' + sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()[:24]
        relations.append(entry)
    return {'method': VERSION, 'relations': relations, 'unresolved': unresolved, 'paragraph_indent_witness_unit_ids': indent_witnesses}
