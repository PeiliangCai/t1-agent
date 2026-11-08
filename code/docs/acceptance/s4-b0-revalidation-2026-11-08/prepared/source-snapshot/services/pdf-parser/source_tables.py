"""Source grids rebuilt from printed rule segments and exact raw/glyph anchors.

The native grid is retained verbatim. No paper ID, page number, medical value or
expected answer is used. Unsupported rule layouts fail closed with a reason.
"""
from hashlib import sha256
import json
import statistics
import re

from source_geometry import compact, inside

VERSION = 'printed-rule-raw-glyph-grid-4'


def clusters(values, tolerance=.6):
    result = []
    for value in sorted(values):
        if result and abs(value - statistics.mean(result[-1])) <= tolerance: result[-1].append(value)
        else: result.append([value])
    return [statistics.mean(g) for g in result]


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def restore_table(table, units, source, geometry):
    locations = units[table['table_id']]['provenance']
    base = {'method': VERSION, 'status': 'unresolved', 'issue_codes': [], 'source_pdf_sha256': source['file_sha256'],
            'text_version': source['text_version'], 'human_approved': False}
    if len(locations) != 1 or not locations[0]['bbox']:
        return {**base, 'issue_codes': ['single_source_table_region_required']}
    number, region = locations[0]['physical_page'], locations[0]['bbox']
    page = geometry.page(number)
    rules = [r for r in page['rules'] if region[1] - 3 <= r['y'] <= region[3] + 3
             and region[0] - 3 <= r['x0'] < r['x1'] <= region[2] + 3]
    groups = []
    for y in clusters([r['y'] for r in rules]):
        segments = sorted([r for r in rules if abs(r['y'] - y) <= .6], key=lambda r: r['x0'])
        extent = [segments[0]['x0'], max(r['x1'] for r in segments)]
        connected = all(a['x1'] >= b['x0'] - .8 for a, b in zip(segments, segments[1:]))
        groups.append({'y': y, 'segments': segments, 'extent': extent, 'connected': connected,
                       'edges': clusters([x for r in segments for x in [r['x0'], r['x1']]])})
    # Native regions can absorb a side title or a following Figure. Identify a
    # unique contained family of repeated segmented rails before selecting text.
    # Never choose the widest/first family when two tables/plots remain possible.
    families = []
    for group in groups:
        if not group['connected'] or group['extent'][1] - group['extent'][0] < max(80, (region[2] - region[0]) * .35): continue
        family = next((f for f in families if all(abs(a - b) < .8 for a, b in zip(f[0]['extent'], group['extent']))), None)
        if family is None: families.append([group])
        else: family.append(group)
    candidates = []
    for family in families:
        if len(family) < 3: continue
        most = max(family, key=lambda g: len(g['edges']))
        agree = [g for g in family if len(g['edges']) == len(most['edges']) and all(abs(a - b) < .8 for a, b in zip(g['edges'], most['edges']))]
        if 3 <= len(most['edges']) <= 33 and len(agree) >= 2: candidates.append(family)
    if not candidates:
        return {**base, 'issue_codes': ['printed_top_header_bottom_rules_not_resolved']}
    if len(candidates) != 1:
        return {**base, 'issue_codes': ['multiple_rule_bounded_table_regions']}
    full = sorted(candidates[0], key=lambda g: g['y'])
    for group in groups: group['full'] = group in full
    # Segmented horizontal strokes independently expose column rails. Require
    # the same rails in at least two full-width rules, not the native col count.
    best = max(full, key=lambda g: len(g['edges']))
    columns = best['edges']
    agreeing = [g for g in full if len(g['edges']) == len(columns) and all(abs(a - b) < .8 for a, b in zip(g['edges'], columns))]
    if not 3 <= len(columns) <= 33 or len(agreeing) < 2:
        return {**base, 'issue_codes': ['independent_printed_column_rails_ambiguous']}
    if any(compact(g['text']) and region[0] <= (g['bbox'][0] + g['bbox'][2]) / 2 <= region[2]
           and full[1]['y'] + 1 < (g['bbox'][1] + g['bbox'][3]) / 2 < full[-1]['y']
           and not columns[0] <= (g['bbox'][0] + g['bbox'][2]) / 2 <= columns[-1] for g in page['glyphs']):
        return {**base, 'issue_codes': ['source_body_glyphs_outside_rule_family']}
    blocks = [b for b in source['blocks'] if b['page'] == number and b['text'].strip()
              and b['bbox'][0] >= columns[0] - .8 and b['bbox'][2] <= columns[-1] + .8
              and b['bbox'][1] >= full[0]['y'] - .5 and b['bbox'][3] <= full[-1]['y'] + .5]
    blocks.sort(key=lambda b: (b['bbox'][1], b['bbox'][0]))
    rows = []
    for block in blocks:
        if rows and abs(rows[-1]['bbox'][1] - block['bbox'][1]) <= 2:
            rows[-1]['blocks'].append(block); rows[-1]['bbox'] = union([rows[-1]['bbox'], block['bbox']])
        else: rows.append({'blocks': [block], 'bbox': list(block['bbox'])})
    if len(rows) < 2: return {**base, 'issue_codes': ['source_baselines_unresolved']}
    inner = [g for g in full[1:-1] if rows[0]['bbox'][3] < g['y'] < rows[-1]['bbox'][1]]
    if not inner: return {**base, 'issue_codes': ['header_body_rule_unresolved']}
    header_bottom = inner[0]['y']; header_rows = sum(row['bbox'][3] < header_bottom for row in rows)
    row_edges = [full[0]['y']]
    for a, b in zip(rows, rows[1:]):
        separators = [g['y'] for g in groups if a['bbox'][3] < g['y'] < b['bbox'][1]]
        row_edges.append(min(separators, key=lambda y: abs(y - (a['bbox'][3] + b['bbox'][1]) / 2)) if separators else (a['bbox'][3] + b['bbox'][1]) / 2)
    row_edges.append(full[-1]['y'])
    slots, expected, glyph_offsets = {}, set(), {}
    for r, row in enumerate(rows):
        for block in row['blocks']:
            mapped = geometry.map_block(block)
            if mapped is None:
                return {**base, 'issue_codes': ['raw_line_character_geometry_not_unique:' + block['block_id']]}
            for item in mapped:
                glyph, offset = item['glyph'], item['offset']; x = (glyph['bbox'][0] + glyph['bbox'][2]) / 2
                cols = [c for c in range(len(columns) - 1) if columns[c] - .05 <= x < columns[c + 1] - .05]
                if len(cols) != 1: return {**base, 'issue_codes': ['glyph_column_assignment_ambiguous']}
                key = (r, cols[0]); slots.setdefault(key, []).append((block, offset, glyph))
                expected.add((block['block_id'], offset)); glyph_offsets[(block['block_id'], offset)] = glyph
    cells, structure_issues = [], []
    for r in range(len(rows)):
        for c in range(len(columns) - 1):
            cells.append({'row_start': r, 'row_end': r + 1, 'col_start': c, 'col_end': c + 1,
                          'items': slots.get((r, c), []), 'role': 'column_header' if r < header_rows else 'data',
                          'span_basis': 'printed_column_rails_and_source_baseline'})

    def merge(selected, basis, role=None):
        entry = {'row_start': min(c['row_start'] for c in selected), 'row_end': max(c['row_end'] for c in selected),
                 'col_start': min(c['col_start'] for c in selected), 'col_end': max(c['col_end'] for c in selected),
                 'items': [i for c in selected for i in c['items']], 'role': role or selected[0]['role'], 'span_basis': basis}
        for cell in selected: cells.remove(cell)
        cells.append(entry); return entry

    # A vertically centered neighboring header can add an unrelated baseline
    # between a parent label and its children. Match connected printed strokes
    # to their own glyph bands instead of moving the rule to a global midpoint.
    for group in groups:
        if group['full'] or not full[0]['y'] < group['y'] < header_bottom: continue
        if any(abs(group['y'] - edge) < .8 for edge in row_edges): continue
        components = []
        for line in group['segments']:
            if components and line['x0'] <= components[-1][1] + .8:
                components[-1][1] = max(components[-1][1], line['x1'])
            else: components.append([line['x0'], line['x1']])
        for x0, x1 in components:
            lo, hi = [min(range(len(columns)), key=lambda i: abs(columns[i] - x)) for x in [x0, x1]]
            if hi - lo < 2 or abs(columns[lo] - x0) > 1 or abs(columns[hi] - x1) > 1: continue
            lane = [c for c in cells if c['role'] == 'column_header' and lo <= c['col_start'] < c['col_end'] <= hi]
            above = [c for c in lane if c['items'] and max(g['bbox'][3] for _, _, g in c['items']) < group['y'] - .1]
            below = [c for c in lane if c['items'] and min(g['bbox'][1] for _, _, g in c['items']) > group['y'] + .1]
            if not above or not below or len({c['row_start'] for c in above}) != 1: continue
            top, child = above[0]['row_start'], min(c['row_start'] for c in below)
            children = [c for c in below if c['row_start'] == child]
            if child <= top or sorted((c['col_start'], c['col_end']) for c in children) != [(i, i + 1) for i in range(lo, hi)]: continue
            selected = [c for c in lane if top <= c['row_start'] < c['row_end'] <= child]
            if any(c['items'] for c in selected if c['row_start'] != top): continue
            items = [item for c in selected for item in c['items']]
            if not items or len({b['block_id'] for b, _, _ in items}) != 1: continue
            glyphs = sorted({g['index']: g for _, _, g in items}.values(), key=lambda g: g['bbox'][0])
            height = statistics.median(g['bbox'][3] - g['bbox'][1] for g in glyphs)
            if any(b['bbox'][0] - a['bbox'][2] > height * 1.5 for a, b in zip(glyphs, glyphs[1:])): continue
            merge(selected, 'connected_printed_header_rule_between_parent_and_child_glyph_bands')

    # A partial underline with one contiguous printed header phrase provides a
    # colspan witness (e.g. Logistic / Before / After); no header text is guessed.
    for r in range(header_rows - 1):
        partial = [g for g in groups if not g['full'] and abs(g['y'] - row_edges[r + 1]) < .8]
        for group in partial:
            for line in group['segments']:
                ends = [min(range(len(columns)), key=lambda i: abs(columns[i] - x)) for x in [line['x0'], line['x1']]]
                if abs(columns[ends[0]] - line['x0']) > 1: continue
                # Some publishers stop a group underline after the last child
                # label rather than at the column rail. Its covered child text
                # still identifies the right edge without importing native spans.
                children = [c for c in cells if c['row_start'] == r + 1 and c['items']
                            and all(line['x0'] - 1 <= g['bbox'][0] and g['bbox'][2] <= line['x1'] + 1 for _, _, g in c['items'])]
                if children: ends[1] = max(c['col_end'] for c in children)
                if ends[1] - ends[0] < 2: continue
                selected = [c for c in cells if c['row_start'] == r and c['row_end'] == r + 1 and ends[0] <= c['col_start'] < c['col_end'] <= ends[1]]
                items = [i for c in selected for i in c['items']]
                glyphs = sorted({g['index']: g for _, _, g in items}.values(), key=lambda g: g['bbox'][0])
                if not items or len({b['block_id'] for b, _, _ in items}) != 1: continue
                height = statistics.median(g['bbox'][3] - g['bbox'][1] for g in glyphs)
                if any(b['bbox'][0] - a['bbox'][2] > height * 1.5 for a, b in zip(glyphs, glyphs[1:])): continue
                merge(selected, 'partial_printed_header_underline')
    # A header column with no inner rule continues through the empty line below.
    for r in range(header_rows - 1):
        for upper in list(cells):
            if upper not in cells or upper['row_end'] != r + 1 or upper['role'] != 'column_header': continue
            x0, x1 = columns[upper['col_start']], columns[upper['col_end']]
            ruled = any(abs(line['y'] - row_edges[r + 1]) < .8 and min(line['x1'], x1) - max(line['x0'], x0) > .5 for line in rules)
            lower = [c for c in cells if c['row_start'] == r + 1 and c['row_end'] == r + 2 and x0 <= columns[c['col_start']] and columns[c['col_end']] <= x1]
            if not ruled and lower and all(not c['items'] for c in lower): merge([upper] + lower, 'unbroken_header_region_and_blank_lower_slots')
            elif not ruled and len(lower) == 1 and upper['col_end'] - upper['col_start'] == 1 and upper['items'] and lower[0]['items']:
                top_glyphs = [g for _, _, g in upper['items']]; low_glyphs = [g for _, _, g in lower[0]['items']]
                same_font = {g['font'] for g in top_glyphs} == {g['font'] for g in low_glyphs}
                aligned = abs(min(g['bbox'][0] for g in top_glyphs) - min(g['bbox'][0] for g in low_glyphs)) <= 1
                same_size = abs(statistics.median(g['bbox'][3] - g['bbox'][1] for g in top_glyphs) - statistics.median(g['bbox'][3] - g['bbox'][1] for g in low_glyphs)) <= .5
                if same_font and aligned and same_size:
                    merge([upper] + lower, 'wrapped_header_same_font_alignment_unbroken_rule_band')
                else: structure_issues.append('unseparated_header_relationship_ambiguous')
    # Preserve shared row labels without copying values into the printed blanks.
    labels = sorted([c for c in cells if c['row_start'] >= header_rows and c['col_start'] == 0 and c['items']], key=lambda c: c['row_start'])
    for i, label in enumerate(labels):
        end = labels[i + 1]['row_start'] if i + 1 < len(labels) else len(rows)
        below = [c for c in cells if c['col_start'] == 0 and label['row_end'] <= c['row_start'] < end]
        subcategories = [c for c in cells if c['col_start'] == 1 and label['row_start'] <= c['row_start'] < end]
        if end - label['row_start'] > 1 and below and all(not c['items'] for c in below) and len(subcategories) == end - label['row_start'] and all(c['items'] for c in subcategories):
            merge([label] + below, 'printed_group_label_and_contiguous_subcategory_lane', 'row_group_label')

    # Child-column rails are virtual positions, not printed cell dividers. A
    # single literal value centered under an explicit parent group may span
    # them. Character conservation alone must not certify a cut-up value.
    parents = sorted([c for c in cells if c['role'] == 'column_header' and c['col_end'] - c['col_start'] > 1],
                     key=lambda c: c['col_end'] - c['col_start'])
    numeric_literal = re.compile(r'[<>≤≥]?[+−-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+−-]?\d+)?[%‰]?[*†‡]?')
    for parent in parents:
        for row in range(header_rows, len(rows)):
            selected = [c for c in cells if c['row_start'] == row and c['row_end'] == row + 1 and
                        parent['col_start'] <= c['col_start'] < c['col_end'] <= parent['col_end']]
            populated = [c for c in selected if c['items']]
            if len(populated) < 2 or any(c['col_end'] - c['col_start'] != 1 for c in selected): continue
            items = [item for c in selected for item in c['items']]
            if len({b['block_id'] for b, _, _ in items}) != 1: continue
            block = items[0][0]; offsets = {offset for _, offset, _ in items}; start, end = min(offsets), max(offsets) + 1
            raw = block['text'][start:end]
            # Recognition may ignore whitespace; the eventual source span never
            # does. Separate integer values such as "29 2" are not one token.
            if any(not block['text'][i].isspace() and i not in offsets for i in range(start, end)): continue
            if not numeric_literal.fullmatch(compact(raw)): continue
            if any(c.isspace() for c in raw) and not re.search(r'[.,eE<>≤≥]', raw): continue
            glyphs = sorted({g['index']: g for _, _, g in items}.values(), key=lambda g: g['bbox'][0])
            height = statistics.median(g['bbox'][3] - g['bbox'][1] for g in glyphs)
            box = union([g['bbox'] for g in glyphs]); midpoint = (box[1] + box[3]) / 2
            centered = abs((box[0] + box[2]) / 2 - (columns[parent['col_start']] + columns[parent['col_end']]) / 2) <= max(1, height * .4)
            contiguous = all(b['bbox'][0] - a['bbox'][2] <= height * .6 for a, b in zip(glyphs, glyphs[1:]))
            divided = any(abs(line['x'] - x) <= .6 and line['y0'] <= midpoint <= line['y1']
                          for line in page.get('vertical_rules', []) for x in columns[parent['col_start'] + 1:parent['col_end']])
            if not centered or not contiguous or divided or 'vertical_rules' not in page:
                structure_issues.append('complete_value_crosses_child_columns_without_unique_span'); continue
            merge(selected, 'literal_value_centered_under_printed_parent_group_no_vertical_divider')

    block_map = {b['block_id']: b for b in blocks}; covered = set(); issues = list(structure_issues)
    cells.sort(key=lambda c: (c['row_start'], c['col_start']))
    for cell in cells:
        by_block = {}
        for block, offset, glyph in cell.pop('items'):
            by_block.setdefault(block['block_id'], set()).add(offset); covered.add((block['block_id'], offset))
        segments = []
        for block_id, offsets in sorted(by_block.items(), key=lambda p: (block_map[p[0]]['bbox'][1], block_map[p[0]]['bbox'][0])):
            block = block_map[block_id]; start, end = min(offsets), max(offsets) + 1
            if any(not block['text'][i].isspace() and i not in offsets for i in range(start, end)):
                issues.append('noncontiguous_source_cell:' + block_id)
            segments.append({'block_id': block_id, 'text_version': source['text_version'], 'start': start, 'end': end})
        cell['source_segments'] = segments
        cell['bbox'] = [columns[cell['col_start']], row_edges[cell['row_start']], columns[cell['col_end']], row_edges[cell['row_end']]]
        cell['physical_page'] = number
        cell['row_span'] = cell['row_end'] - cell['row_start']; cell['col_span'] = cell['col_end'] - cell['col_start']
        cell['cell_id'] = 'sc-' + sha256(json.dumps([table['table_id'], cell['row_start'], cell['col_start'], segments], sort_keys=True).encode()).hexdigest()[:24]
        chars = [g for g in page['independent'] if inside(g, cell['bbox'])]
        chars.sort(key=lambda g: (min(range(cell['row_start'], cell['row_end']), key=lambda r: abs(
            (g['bbox'][1] + g['bbox'][3]) / 2 - (rows[r]['bbox'][1] + rows[r]['bbox'][3]) / 2)), g['bbox'][0]))
        raw = ''.join(block_map[s['block_id']]['text'][s['start']:s['end']] for s in segments)
        verified = compact(raw) == compact(''.join(g['text'] for g in chars))
        cell['status'] = 'geometry_checked' if verified and segments else 'blank_geometry_checked' if verified else 'source_conflict'
        if not verified: issues.append('independent_cell_characters_disagree:' + cell['cell_id'])
        cell['column_header_ids'] = []
        cell['row_group_cell_id'] = None
    for cell in cells:
        cell['column_header_ids'] = [h['cell_id'] for h in cells if h['role'] == 'column_header' and h['source_segments'] and h['row_end'] <= cell['row_start']
                                     and h['col_start'] <= cell['col_start'] and h['col_end'] >= cell['col_end']]
        cell['row_group_cell_id'] = next((g['cell_id'] for g in cells if g['role'] == 'row_group_label' and g['row_start'] <= cell['row_start'] < g['row_end']), None)
    if expected != covered: issues.append('raw_nonspace_source_coverage_incomplete')
    occupancy = [(r, c) for cell in cells for r in range(cell['row_start'], cell['row_end']) for c in range(cell['col_start'], cell['col_end'])]
    if len(occupancy) != len(set(occupancy)) or len(occupancy) != len(rows) * (len(columns) - 1): issues.append('reconstructed_grid_coverage_conflict')
    # Keep adjacent symbol-keyed footnotes in their own original spans.
    symbols = set(ch for b in blocks for ch in b['text'] if ch in '*†‡§')
    footnotes = []
    for block in source['blocks']:
        if block['page'] == number and abs(block['bbox'][0] - columns[0]) < 2 and 0 < block['bbox'][1] - full[-1]['y'] <= 12 and symbols.intersection(block['text']):
            footnotes.append({'block_id': block['block_id'], 'text_version': source['text_version'], 'start': 0, 'end': len(block['text'])})
    # Recover a numbered title from exact source glyphs in the same header band,
    # separately from native caption links. Side titles must be outside the grid;
    # ordinary same-page references or the Figure caption below do not qualify.
    title_candidates = []
    for block in source['blocks']:
        marker = re.match(r'(?i)^\s*(?:table\s*|表\s*)(\d+)(?!\d)', block['text'])
        if block['page'] != number or not marker: continue
        box = block['bbox']; height = box[3] - box[1]
        side = box[2] <= columns[0] - 2 and 0 <= columns[0] - box[2] <= 96 and abs(box[1] - full[0]['y']) <= height
        above = 0 <= full[0]['y'] - box[3] <= 24 and box[0] >= columns[0] - 2 and box[2] <= columns[-1] + 2
        if side or above: title_candidates.append((block, marker[1], side))
    caption_segments, caption_number, caption_status = [], None, 'unresolved'
    if len(title_candidates) == 1:
        first, caption_number, side = title_candidates[0]; title_blocks = [first]
        remaining = sorted([b for b in source['blocks'] if b['page'] == number and b['block_id'] != first['block_id']
                            and abs(b['bbox'][0] - first['bbox'][0]) <= 1 and b['bbox'][1] > first['bbox'][1]
                            and b['bbox'][1] <= (full[-1]['y'] if side else full[0]['y'])
                            and (not side or b['bbox'][2] <= columns[0] - 2)], key=lambda b: b['bbox'][1])
        for block in remaining:
            if 0 <= block['bbox'][1] - title_blocks[-1]['bbox'][3] <= 12 and not re.match(r'(?i)^\s*(?:table\s*\d|fig(?:ure)?\.?\s*\d|表\s*\d|图\s*\d)', block['text']): title_blocks.append(block)
            else: break
        valid = True
        for block in title_blocks:
            mapped = geometry.map_block(block)
            chars = sorted([g for g in page['independent'] if inside(g, block['bbox'])], key=lambda g: g['bbox'][0])
            if mapped is None or compact(block['text']) != compact(''.join(g['text'] for g in chars)): valid = False; break
        if valid:
            caption_status = 'geometry_checked_numbered_title'
            caption_segments = [{'block_id': b['block_id'], 'text_version': source['text_version'], 'start': 0, 'end': len(b['text'])} for b in title_blocks]
    result = {**base, 'status': 'geometry_checked' if not issues else 'source_conflict', 'issue_codes': list(dict.fromkeys(issues)),
              'n_rows': len(rows), 'n_cols': len(columns) - 1, 'header_rows': header_rows, 'column_bounds': columns, 'row_bounds': row_edges,
              'logical_header_rows': max((len(c['column_header_ids']) + 1 for c in cells if c['role'] == 'column_header' and c['source_segments']), default=1),
              'region_bbox': [columns[0], full[0]['y'], columns[-1], full[-1]['y']], 'native_region_bbox': list(region),
              'region_basis': 'unique_contained_repeated_segmented_rule_family',
              'caption_status': caption_status, 'caption_number': caption_number, 'caption_segments': caption_segments,
              'physical_page': number, 'cells': cells, 'footnote_segments': footnotes,
              'verification': {'raw_nonspace_codepoints': len(expected), 'covered_nonspace_codepoints': len(covered),
                               'all_cells_independently_checked': all(c['status'] != 'source_conflict' for c in cells),
                               'grid_slots_covered_once': len(occupancy) == len(set(occupancy)) == len(rows) * (len(columns) - 1),
                               'column_rule_witness_count': len(agreeing), 'literal_values_not_imputed': True}}
    result['grid_id'] = 'sg-' + sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()[:24]
    return result
