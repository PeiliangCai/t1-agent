#!/usr/bin/env python3
"""Freeze locally recovered grids/flows and concrete review cases, no LLM/inference."""
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
import html
import importlib.util
import json
import sys
import argparse

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/pdf-structure-review-2026-11-07'
REPLACE_CURRENT = False
sys.path.insert(0, str(CODE / 'services/pdf-parser'))
from adapter import DoclingParseTextAdapter, ParseInput
from structured import build_ir

spec = importlib.util.spec_from_file_location('rebuild_source', CODE / 'scripts/diagnose-pdf-input-quality.py')
prior = importlib.util.module_from_spec(spec); spec.loader.exec_module(prior)


def write_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w' if REPLACE_CURRENT else 'x', encoding='utf-8') as stream: stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def cells_for_review(document, table, grid=False):
    blocks = {b['block_id']: b for b in document['blocks']}; units = {u['unit_id']: u for u in document['structure']['units']}
    return [{**c, 'text': '\n'.join(blocks[s['block_id']]['text'][s['start']:s['end']] for s in c['source_segments']) if grid else units[c['unit_id']]['native_text'],
             'column_header': c['role'] == 'column_header' if grid else c['column_header'],
             'row_header': c['role'] == 'row_group_label' if grid else c['row_header']} for c in table['cells']]


def render_table(title, data, note):
    rows = []
    for r in range(data['n_rows']):
        values = []
        for cell in data['cells']:
            if cell['row_start'] != r: continue
            tag = 'th' if cell['column_header'] else 'td'
            values.append(f'<{tag} rowspan="{cell["row_end"] - r}" colspan="{cell["col_end"] - cell["col_start"]}">{html.escape(cell["text"]) if cell["text"] else "<span class=blank>空白</span>"}</{tag}>')
        rows.append('<tr>'+''.join(values)+'</tr>')
    return '<!doctype html><meta charset=utf-8><title>'+html.escape(title)+'</title><style>body{font:15px sans-serif;padding:24px}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:6px;vertical-align:top;white-space:pre-wrap}th{background:#eef}.blank{color:#aaa;font-size:11px}</style><h1>'+html.escape(title)+'</h1><p>'+html.escape(note)+'</p><table>'+''.join(rows)+'</table>'


def main():
    global OUT, REPLACE_CURRENT
    current = OUT.resolve()
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--output', type=Path, default=OUT)
    cli.add_argument('--replace-current', action='store_true', help='Replace only this task unpublished current artifacts; never an archived destination')
    args = cli.parse_args(); OUT = args.output.resolve(); REPLACE_CURRENT = args.replace_current
    if not OUT.is_relative_to(CODE): raise ValueError('All source recovery evidence must remain in code/')
    if REPLACE_CURRENT and OUT != current: raise ValueError('Replacement is restricted to the authorized unpublished current task directory')
    sources, cases, report_sources = [], [], []
    for source_id in ['L01', 'L05', 'L07']:
        old_path = CODE / 'docs/acceptance/pdf-input-quality-2026-11-07/derived' / source_id / 'parser-result.json'
        old_payload = json.loads(old_path.read_text()); old = old_payload['document']
        DoclingParseTextAdapter()._read(ParseInput('source-structure-freeze', old['document_id'], old['source']['file_reference'], old['file_sha256']))
        artifact = CODE / old['native_artifact']['path']
        if sha256(artifact.read_bytes()).hexdigest() != old['native_artifact']['sha256']: raise ValueError('native_artifact_hash_mismatch')
        metrics = deepcopy(old['metrics']['native_metrics']); metrics.update(total_seconds=0, native_artifact_reused=True,
            native_model_inference_performed=False, document_result_cache_used=True, cache_policy='Explicit offline source-grid/flow rebuild from retained native; fresh original-PDF character/rule verification')
        doc = build_ir(prior.retained_source(old), json.loads(artifact.read_text()), old['parser']['id'], metrics, old['coverage']['native_errors'], old['native_artifact'])
        if prior.anchor_digest(doc) != prior.anchor_digest(old): raise ValueError('raw_source_changed')
        path = OUT / 'derived' / source_id / 'parser-result.json'
        write_new(path, {**old_payload, 'run_id': 'pdf-source-structure-' + source_id, 'document': doc,
                         'status': 'ok' if doc['parser']['status'] == 'parsed' else doc['parser']['status']})
        binding = {'source_id': source_id, 'document_id': doc['document_id'], 'source_pdf_sha256': doc['file_sha256'],
                   'pdf_path': doc['source']['file_reference'], 'text_version': doc['text_version'], 'parser_result': str(path.relative_to(CODE)),
                   'parser_result_sha256': sha256(path.read_bytes()).hexdigest()}
        sources.append(binding)
        blocks = {b['block_id']: b for b in doc['blocks']}; units = {u['unit_id']: u for u in doc['structure']['units']}
        def part(unit):
            located = [{**s, 'exact_quote': blocks[s['block_id']]['text'][s['start']:s['end']], 'physical_page': blocks[s['block_id']]['page'],
                        'bbox': blocks[s['block_id']]['bbox']} for s in unit['source_segments']]
            return {'unit_id': unit['unit_id'], 'native_ref': unit['native_ref'], 'text': '\n'.join(s['exact_quote'] for s in located),
                    'segments': located, 'physical_pages': list(dict.fromkeys(s['physical_page'] for s in located)), 'provenance': unit['provenance']}
        if source_id == 'L05':
            for index, number in [(3, '4'), (1, '2'), (2, '3')]:
                table = doc['structure']['tables'][index]; grid = table['source_grid']
                if grid['status'] != 'geometry_checked': raise ValueError('required_source_grid_not_recovered')
                before = {'n_rows': table['n_rows'], 'n_cols': table['n_cols'], 'cells': cells_for_review(doc, table), 'text_role': 'native_processed_not_literal_quote'}
                after = {**grid, 'cells': cells_for_review(doc, grid, True), 'index_interval': '[row_start,row_end) and [col_start,col_end)', 'status': 'geometry_checked', 'human_approved': False}
                page = grid['physical_page']; case = {**binding, 'case_id': f'L05-p{page}-Table{number}', 'kind': 'table', 'physical_page': page,
                    'physical_pages': [page], 'original_page_png': None, 'bbox': units[table['table_id']]['provenance'][0]['bbox'],
                    'title': f'L05 · Table {number} · 原网格与按原PDF恢复的源网格', 'before': before, 'after': after,
                    'footnotes': [{'text': blocks[s['block_id']]['text'][s['start']:s['end']], 'source_segment': s} for s in grid['footnote_segments']],
                    'questions': ['每一行/列的文字、数值、单位、斜线与空白是否对应原页？', '多级表头和左侧分组的合并范围是否正确？', '脚注是否完整且属于此表？'],
                    'engineering_check_is_not_medical_or_user_approval': True}
                write_new(OUT / 'tables' / f'L05-Table{number}-grid.json', case)
                html_path = OUT / 'tables' / f'L05-Table{number}-final.html'
                with html_path.open('w' if REPLACE_CURRENT else 'x') as stream: stream.write(render_table(case['title'], after, f'原PDF SHA:{doc["file_sha256"]}；新IR:{doc["text_version"]}。原字符/空白不改，几何核对已完成，用户审核独立。'))
                if number == '3': case['questions'] += ['LASSO与Coefficient是否为同一表头的换行，而非两列子表头？', 'Group2末行12.78(±4.71)是否完整保留在同一格？', 'Table3表题、表底脚注与下方Fig3是否清楚分开？']
                cases.append(case)
        recovery = doc['structure']['organization']['continuation_recovery']
        for edge in recovery['relations'] + recovery['unresolved']:
            left, right = units[edge['from_unit_id']], units[edge['to_unit_id']]
            parts = [part(left), part(right)]; pages = list(dict.fromkeys(p for p in parts for p in p['physical_pages']))
            token = sha256((left['native_ref'] + '>' + right['native_ref']).encode()).hexdigest()[:10]
            cases.append({**binding, 'case_id': source_id + '-continuation-' + token, 'kind': 'continuation', 'physical_pages': pages,
                'original_page_png': None, 'title': source_id + ' · ' + ('跨页' if edge['boundary'] == 'physical_page' else '跨栏') + '原文续接',
                'before': {'parts': parts, 'status': 'separate_native_units'},
                'after': {'ordered_parts': parts, 'status': edge['status'], 'proof_method': edge.get('proof_method'), 'proof_codes': edge['proof_codes'],
                          'boundary': edge['boundary'], 'source_type': edge['source_type'], 'human_approved': False, 'literal_characters_rewritten': False},
                'questions': ['两段是否是原文同一段落/同一条目或图注的连续部分？', '显示顺序、页码/栏与原文字符（含连字符）是否正确？'],
                'unresolved_reason': edge.get('reason'), 'engineering_check_is_not_medical_or_user_approval': True})
        report_sources.append({**binding, 'raw_anchors_identical': True, 'native_artifact': old['native_artifact'],
            'grids': [{'native_ref': t['native_ref'], 'native_rows': t['n_rows'], 'native_cols': t['n_cols'], 'source_grid_status': t['source_grid']['status'],
                       'source_rows': t['source_grid'].get('n_rows'), 'source_cols': t['source_grid'].get('n_cols')} for t in doc['structure']['tables']],
            'checked_continuations': len(recovery['relations']), 'unresolved_continuations': len(recovery['unresolved'])})
    write_new(OUT / 'structure-manifest.json', {'schema_version': 'pdf-source-structure-manifest-1', 'sources': report_sources,
        'native_layout_model_inference_performed': False, 'fresh_original_PDF_glyph_and_rule_verification': True, 'LLM_calls': 0})
    write_new(OUT / 'review-cases-tables-continuations.json', {'schema_version': 'pdf-source-review-cases-1', 'sources': sources, 'cases': cases,
        'user_feedback_changes_parser_or_product_approval': False, 'source_characters_unchanged': True})
    print(json.dumps({'sources': len(sources), 'review_cases': len(cases), 'output': str(OUT.relative_to(CODE)), 'LLM_calls': 0}))


if __name__ == '__main__': main()
