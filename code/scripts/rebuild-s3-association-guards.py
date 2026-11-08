#!/usr/bin/env python3
"""Derive guarded IR from immutable real native runs, not a new speed benchmark."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import argparse
import json
import sys

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/s3/comparison-2026-11-02'
sys.path.insert(0, str(CODE / 'services/pdf-parser'))
from adapter import ParseInput, DoclingParseTextAdapter
from structured import build_ir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--revision', default='guarded')
    args = parser.parse_args()
    records = []
    for mode in ['cold', 'reuse']:
        for source_id in ['MED03', 'L07', 'L05', 'L01', 'L02']:
            previous = OUT / 'runs' / mode / args.candidate / (source_id + '.json')
            if not previous.exists():
                continue
            payload = json.loads(previous.read_text())
            if not payload.get('document'):
                continue
            old = payload['document']
            artifact = CODE / old['native_artifact']['path']
            assert sha256(artifact.read_bytes()).hexdigest() == old['native_artifact']['sha256']
            pdf = CODE / 'evaluation/corpus/development-candidates' / (source_id + '.pdf')
            source = DoclingParseTextAdapter().parse(ParseInput(payload['run_id'], source_id, str(pdf), old['file_sha256'], False))
            metrics = {**old['metrics']['native_metrics'], 'native_result_reused_for_IR_guard_migration': True,
                       'native_measurement_origin': str(previous.relative_to(CODE))}
            document = build_ir(source, json.loads(artifact.read_text()), args.candidate, metrics,
                                old['coverage']['native_errors'], old['native_artifact'])
            target = OUT / 'runs' / args.revision / mode / args.candidate / (source_id + '.json')
            target.parent.mkdir(parents=True, exist_ok=True)
            result = {'schema_version': 'parser-result-2', 'run_id': payload['run_id'],
                      'status': 'ok' if document['parser']['status'] == 'parsed' else document['parser']['status'], 'document': document, 'error': None}
            with target.open('x') as stream:
                json.dump(result, stream, ensure_ascii=False, indent=2); stream.write('\n')
            record = {'source_id': source_id, 'candidate_id': args.candidate, 'mode': mode,
                      'original_measurement_result': str(previous.relative_to(CODE)), 'guarded_IR': str(target.relative_to(CODE)),
                      'native_parser_rerun': False, 'guard_migration_is_not_native_speed_measurement': True,
                      'table_conflicts': sum(t['association_status'] == 'conflict' for t in document['structure']['tables']),
                      'picture_conflicts': sum(t['association_status'] == 'conflict' for t in document['structure']['pictures'])}
            records.append(record)
    report = OUT / (args.revision + '-derivations-' + args.candidate + '.json')
    report.write_text(json.dumps({'recorded_at': datetime.now(timezone.utc).isoformat(), 'records': records,
                                  'native_outputs_unchanged': True, 'human_approval': False}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'derivations': len(records), 'report': str(report.relative_to(CODE))}, ensure_ascii=False))


if __name__ == '__main__':
    main()
