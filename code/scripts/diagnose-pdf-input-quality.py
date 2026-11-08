#!/usr/bin/env python3
"""Offline, immutable PDF-structure rebuild from retained native/decoded artifacts.

No native layout inference, network, OCR or LLM calls. The source/native/PDF SHA
checks happen before writing a new version; historical evidence is read only.
"""
from collections import Counter
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
import argparse
import json
import sys
import time

CODE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CODE / 'services/pdf-parser'))
from adapter import DoclingParseTextAdapter, ParseInput
from structured import build_ir
from figure_assets import extract_catalog

BASE = CODE / 'docs/acceptance/s3/comparison-2026-11-02'
FEEDBACK = CODE / 'docs/acceptance/user-feedback-2026-11-05/revalidation/sources'
DEFAULT = CODE / 'docs/acceptance/pdf-input-quality-2026-11-07'


def write_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def anchor_digest(document):
    return sha256(json.dumps([(b['block_id'], b['raw_text'], b['text'], b['bbox'], b['normalization_map'])
                            for b in document['blocks']], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def retained_source(document):
    schema = json.loads((CODE / 'packages/contracts/schema/DocumentIRV2.json').read_text())
    source = {k: deepcopy(v) for k, v in document.items() if k in schema['properties']}
    source['schema_version'] = '2'
    source['parser'] = deepcopy(document['parser']['config']['source_parser'])
    source['text_version'] = document['source_extraction']['text_version']
    source['raw_text_version'] = source['text_version'] + '-raw'
    for b in source['blocks']:
        b['text_version'] = source['text_version']
    source['coverage'] = {k: deepcopy(v) for k, v in source['coverage'].items() if k in schema['properties']['coverage']['properties']}
    source['coverage'].update(scope='emitted_text_layer_blocks_only', table_structure='not_reconstructed', reading_order='backend_textline_order_unverified')
    source['metrics'] = deepcopy(document['metrics']['host_metrics'])
    source['metrics']['original_source_decode_seconds'] = source['metrics']['total_seconds']
    source['metrics']['total_seconds'] = 0
    return source


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--output', type=Path, default=DEFAULT)
    args = cli.parse_args()
    out = args.output.resolve()
    if not out.is_relative_to(CODE):
        raise ValueError('All evidence must remain in code/')
    if (out / 'parser-diagnostics.json').exists():
        raise FileExistsError('Choose a fresh immutable output directory')
    report = {'schema_version': 'pdf-input-quality-rebuild-1', 'native_inference_performed': False, 'llm_calls': 0,
              'remote_calls': 0, 'formal_reviews_added': 0, 'formal_reviews_used': 3, 'sources': [],
              'limits': ['Engineering source/layout checks, not human/medical approval',
                         'No claim that original content, native order, cells or Figure groups are fully verified',
                         'L05 Table 4 native grid is not repaired; source-conflicted support relationships are blocked']}
    for source_id in ['L01', 'L05', 'L07', 'L02']:
        start = time.monotonic()
        path = FEEDBACK / source_id / 'parser-result.json' if source_id in ['L01', 'L05'] else BASE / 'runs/guarded-v4/reuse/docling-standard-cpu' / (source_id + '.json')
        payload = json.loads(path.read_text()); old = payload['document']
        DoclingParseTextAdapter()._read(ParseInput('pdf-quality-rebuild', old['document_id'], old['source']['file_reference'], old['file_sha256'], old['fixture']))
        artifact = CODE / old['native_artifact']['path']
        if sha256(artifact.read_bytes()).hexdigest() != old['native_artifact']['sha256']:
            raise ValueError('Retained native artifact SHA mismatch')
        native = json.loads(artifact.read_text())
        metrics = deepcopy(old['metrics']['native_metrics'])
        metrics.update(original_native_inference_seconds=metrics['total_seconds'], total_seconds=0,
                       native_artifact_reused=True, native_model_inference_performed=False, document_result_cache_used=True,
                       cache_policy='Explicit offline adapter rebuild of SHA-bound retained native output; no native inference')
        new = build_ir(retained_source(old), native, old['parser']['id'], metrics, old['coverage']['native_errors'], old['native_artifact'])
        target = out / 'derived' / source_id
        rebuilt = {**payload, 'run_id': 'pdf-quality-rebuild-' + source_id, 'document': new,
                   'status': 'ok' if new['parser']['status'] == 'parsed' else new['parser']['status']}
        write_new(target / 'parser-result.json', rebuilt)
        catalog = extract_catalog(new, target / 'figure-assets')
        before, after = anchor_digest(old), anchor_digest(new)
        if before != after:
            raise ValueError('Offline rebuilding changed immutable source anchors')
        native_order_before = [next(u['native_ref'] for u in old['structure']['units'] if u['unit_id'] == uid) for uid in old['structure']['reading_order']]
        native_order_after = [next(u['native_ref'] for u in new['structure']['units'] if u['unit_id'] == uid) for uid in new['structure']['reading_order']]
        if native_order_before != native_order_after:
            raise ValueError('Offline rebuilding changed native reading order')
        report['sources'].append({'source_id': source_id, 'source_pdf_sha256': old['file_sha256'], 'frozen_parser_result': str(path.relative_to(CODE)),
             'frozen_parser_result_sha256': sha256(path.read_bytes()).hexdigest(), 'native_artifact': old['native_artifact'],
             'derived_parser_result': str((target / 'parser-result.json').relative_to(CODE)),
             'derived_parser_result_sha256': sha256((target / 'parser-result.json').read_bytes()).hexdigest(),
             'derived_figure_catalog': str((target / 'figure-assets/catalog.json').relative_to(CODE)),
             'old_text_version': old['text_version'], 'new_text_version': new['text_version'],
             'raw_anchor_digest': before, 'raw_anchors_identical': True, 'native_order_identical': True,
             'physical_pages': len(new['pages']), 'raw_block_count': len(new['blocks']),
             'mapping_before': dict(Counter(u['mapping']['status'] for u in old['structure']['units'])),
             'mapping_after': dict(Counter(u['mapping']['status'] for u in new['structure']['units'])),
             'organization': new['structure']['organization'],
             'table_audits': [{'native_ref': t['native_ref'], 'native_rows': t['n_rows'], 'native_cols': t['n_cols'],
               'source_baselines': len(t['source_layout']['source_rows']), 'status': t['source_layout']['status'],
               'issue_codes': t['source_layout']['issue_codes'], 'support_semantics': t['source_layout']['support_semantics']} for t in new['structure']['tables']],
             'figure_candidates': [{'number': f['figure_number'], 'source_segments': len(f['caption_segments']), 'regions': len(f['regions']),
               'status': f['verification']['status'], 'notes': f['verification']['notes']} for f in catalog['figures']],
             'parser_status': new['parser']['status'], 'elapsed_rebuild_seconds': round(time.monotonic() - start, 3)})
    write_new(out / 'parser-diagnostics.json', report)
    print(json.dumps({'output': str(out.relative_to(CODE)), 'sources_rebuilt': len(report['sources']), 'llm_calls': 0, 'native_inference_performed': False}))


if __name__ == '__main__':
    main()
