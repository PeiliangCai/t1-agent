#!/usr/bin/env python3
"""Parse exactly the five exposed development candidates, preserving each run."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json
import os
import subprocess
import sys
import time

CODE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CODE / 'services/pdf-parser'))
from adapter import resolve_segments


def main():
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    out = CODE / 'docs/acceptance/s3/runs' / stamp
    out.mkdir(parents=True, exist_ok=False)
    registry = json.loads((CODE / 'evaluation/manifests/source-register.json').read_text())
    downloads = json.loads((CODE / 'docs/acceptance/s2/downloads.json').read_text())
    records = []
    env = {**os.environ, 'OMP_NUM_THREADS': '4', 'OPENBLAS_NUM_THREADS': '4', 'MKL_NUM_THREADS': '4'}
    for source_id in ['MED03', 'L07', 'L05', 'L01', 'L02']:
        source = next(s for s in registry['sources'] if s['source_id'] == source_id)
        download = next(s for s in downloads['sources'] if s['source_id'] == source_id)
        path = CODE / source['access']['local_path']
        actual = sha256(path.read_bytes()).hexdigest()
        assert actual == source['access']['sha256'] == download['sha256']
        assert not source['exposure']['independent_acceptance_eligible']
        target = out / (source_id + '.result.json')
        command = [str(CODE / '.venv/bin/python'), 'services/pdf-parser/cli.py', 'parse', '--run-id', 's3-' + stamp,
                   '--document-id', source_id, '--file-reference', source['access']['local_path'], '--file-sha256', actual,
                   '--output', str(target.relative_to(CODE))]
        started = time.monotonic()
        result = subprocess.run(command, cwd=CODE, env=env, text=True, capture_output=True, timeout=180)
        elapsed = time.monotonic() - started
        (out / (source_id + '.stdout.log')).write_text(result.stdout)
        (out / (source_id + '.stderr.log')).write_text(result.stderr)
        record = {'source_id': source_id, 'file_reference': source['access']['local_path'], 'sha256': actual,
                  'exposed_development_only': True, 'independent_acceptance': False, 'command': command,
                  'exit_code': result.returncode, 'cli_wall_seconds': round(elapsed, 6), 'output': str(target.relative_to(CODE)),
                  'upload_transport_seconds': None, 'source_original_unchanged': sha256(path.read_bytes()).hexdigest() == actual,
                  'human_fidelity_passed': False, 'medical_gold_available': False}
        if target.exists():
            payload = json.loads(target.read_text())
            document = payload['document']
            record.update({'status': payload['status'], 'physical_pages': len(document['pages']), 'blocks': len(document['blocks']),
                           'text_code_points': sum(len(b['text']) for b in document['blocks']), 'metrics': document['metrics'],
                           'decoded_pages': document['coverage']['decoded_pages'], 'failed_pages': document['coverage']['failed_pages'],
                           'pages_without_text': document['coverage']['pages_without_text'],
                           'image_text_unverified_pages': document['coverage']['image_text_unverified_pages'],
                           'text_layer_decode_complete': document['coverage']['text_layer_decode_complete'],
                           'full_content_coverage_verified': False, 'table_structure': 'not_reconstructed',
                           'reading_order': 'backend_textline_order_unverified', 'parser': document['parser'], 'text_version': document['text_version']})
            # Exact engineering locations only; these spans are not medical predictions.
            useful = [b for b in document['blocks'] if len(b['text'].strip()) >= 8]
            chosen = []
            for block in useful:
                if not chosen or block['page'] != chosen[-1]['page']:
                    chosen.append(block)
                if len(chosen) == 2:
                    break
            if chosen:
                reference = {'document_id': source_id, 'text_version': document['text_version'], 'joiner': '\n',
                             'segments': [{'block_id': b['block_id'], 'text_version': document['text_version'], 'start': 0, 'end': min(24, len(b['text']))} for b in chosen]}
                location = resolve_segments(document, **reference)
                reference_path = out / (source_id + '.reference.json')
                reference_path.write_text(json.dumps(reference, ensure_ascii=False, indent=2) + '\n')
                (out / (source_id + '.location.json')).write_text(json.dumps({'purpose': 'engineering_source_location_not_medical_extraction',
                                                                             'human_fidelity_verified': False, **location}, ensure_ascii=False, indent=2) + '\n')
                record['localization_reference'] = str(reference_path.relative_to(CODE))
                record['localization_command'] = [str(CODE / '.venv/bin/python'), 'services/pdf-parser/cli.py', 'locate',
                                                   '--document', str(target.relative_to(CODE)), '--reference', str(reference_path.relative_to(CODE))]
        else:
            record['status'] = 'error'
            record['error'] = json.loads(result.stdout).get('error') if result.stdout.startswith('{') else {'code': 'no_structured_output'}
        records.append(record)
        summary = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'status': 'engineering_measurement_only',
                   'stage': 'S3', 'stage_passed': False, 'formal_parser_selected': False, 'independent_acceptance': False,
                   'all_originals_unchanged': all(r['source_original_unchanged'] for r in records),
                   'sample_count': len(records), 'real_pdf_not_fixture': True, 'results': records,
                   'coverage_interpretation': 'All emitted text-layer blocks and physical pages enumerated; this does not establish no missing text, correct reading order, table fidelity, OCR coverage, or human localization acceptance.',
                   'first_text_timing_interpretation': 'Internal first decoded text readiness; CLI returns only when finished; not an interactive first candidate latency.',
                   'resource_measurement': 'Each CLI is a fresh process; peak RSS is Linux ru_maxrss, includes imports, measured in bytes; no GPU metric measured.',
                   'llm_calls': 0, 'remote_document_uploads': 0}
        (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({k: record.get(k) for k in ['source_id', 'status', 'physical_pages', 'blocks', 'text_code_points', 'cli_wall_seconds', 'failed_pages', 'image_text_unverified_pages']}, ensure_ascii=False), flush=True)
    print(json.dumps({'summary': str((out / 'summary.json').relative_to(CODE)), 'stage_passed': False, 'samples': len(records)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
