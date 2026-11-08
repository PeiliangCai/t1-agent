#!/usr/bin/env python3
"""Measure original PDFs with CPU candidates; model reuse never reuses results.

Modes: cold = fresh host/native process per PDF, reuse = one native model
instance for the sequence. Cold means process/model startup, not empty OS cache.
"""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import argparse
import json
import os
import resource
import signal
import subprocess
import sys
import threading
import time

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/s3/comparison-2026-11-02'
SOURCES = ['MED03', 'L07', 'L05', 'L01', 'L02']
CANDIDATES = ['docling-standard-cpu', 'mineru-basic-onnx-cpu']


def worker(args):
    sys.path.insert(0, str(CODE / 'services/pdf-parser'))
    from adapter import ParseInput, ParserError
    from structured import StructuredParserAdapter
    if hasattr(os, 'sched_getaffinity'):
        os.sched_setaffinity(0, set(sorted(os.sched_getaffinity(0))[:4]))
    folder = OUT / 'runs' / args.mode / args.candidate
    folder.mkdir(parents=True, exist_ok=True)
    adapter = StructuredParserAdapter(args.candidate, log_directory=OUT / 'native-logs' / args.mode)
    try:
        for source_id in args.sources:
            path = CODE / 'evaluation/corpus/development-candidates' / (source_id + '.pdf')
            digest = sha256(path.read_bytes()).hexdigest()
            print(json.dumps({'event': 'document_start', 'source_id': source_id}), flush=True)
            start, usage = time.monotonic(), resource.getrusage(resource.RUSAGE_SELF)
            try:
                document = adapter.parse(ParseInput('s3-cpu-comparison-' + args.mode, source_id, str(path), digest, False))
                payload = {'schema_version': 'parser-result-2', 'run_id': 's3-cpu-comparison-' + args.mode,
                           'status': 'ok' if document['parser']['status'] == 'parsed' else document['parser']['status'],
                           'document': document, 'error': None}
                record = {'status': payload['status'], 'physical_pages': len(document['pages']), 'native_pages': document['coverage']['native_pages'],
                          'source_blocks': len(document['blocks']), 'structure_units': len(document['structure']['units']),
                          'tables': len(document['structure']['tables']), 'pictures': len(document['structure']['pictures']),
                          'unmapped_units': len(document['coverage']['unmapped_unit_ids']),
                          'ambiguous_units': len(document['coverage']['ambiguous_unit_ids']), 'metrics': document['metrics'],
                          'native_errors': document['coverage']['native_errors'], 'failed_source_pages': document['coverage']['failed_pages'],
                          'image_text_unverified_pages': document['coverage']['image_text_unverified_pages'],
                          'text_version': document['text_version'], 'parser_config_digest': document['parser']['config_digest']}
            except Exception as exc:
                import traceback
                with (folder / (source_id + '.failure.log')).open('x') as log:
                    log.write(traceback.format_exc())
                error = exc.as_dict() if isinstance(exc, ParserError) else {'code': type(exc).__name__, 'message': str(exc)[:300], 'retryable': False}
                payload = {'schema_version': 'parser-result-2', 'run_id': 's3-cpu-comparison-' + args.mode, 'status': 'error', 'document': None, 'error': error}
                record = {'status': 'error', 'error': error}
            target = folder / (source_id + '.json')
            with target.open('x') as output:
                json.dump(payload, output, ensure_ascii=False, indent=2); output.write('\n')
            after = resource.getrusage(resource.RUSAGE_SELF)
            record.update({'source_id': source_id, 'candidate_id': args.candidate, 'mode': args.mode, 'file_sha256': digest,
                           'file_bytes': path.stat().st_size, 'adapter_wall_seconds': time.monotonic() - start,
                           'host_cpu_user_seconds': after.ru_utime - usage.ru_utime,
                           'host_cpu_system_seconds': after.ru_stime - usage.ru_stime,
                           'host_peak_rss_bytes_process_lifetime': after.ru_maxrss * 1024,
                           'original_unchanged': sha256(path.read_bytes()).hexdigest() == digest,
                           'output': str(target.relative_to(CODE)), 'native_log': str(adapter.worker.log_path.relative_to(CODE)),
                           'human_quality_verified': False, 'document_result_cache_used': False})
            print(json.dumps({'event': 'document_end', 'record': record}, ensure_ascii=False), flush=True)
    finally:
        adapter.close()


def run_group(candidate, mode, sources, sequence):
    import psutil
    command = [str(CODE / '.venv/bin/python'), str(Path(__file__).resolve()), '--worker', '--candidate', candidate,
               '--mode', mode, '--sources', *sources]
    log = OUT / 'benchmark-logs' / f'{mode}-{candidate}-{sequence}.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    from_env = {**os.environ, 'OMP_NUM_THREADS': '4', 'OPENBLAS_NUM_THREADS': '4', 'MKL_NUM_THREADS': '4'}
    process = subprocess.Popen(command, cwd=CODE, env=from_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', start_new_session=True)
    state = {'source_id': None, 'peak': 0, 'samples': 0, 'killed': None, 'start': started}
    stop = threading.Event()
    def monitor():
        while not stop.wait(0.05):
            try:
                root = psutil.Process(process.pid)
                rss = sum(p.memory_info().rss for p in [root, *root.children(recursive=True)] if p.is_running())
                state['peak'] = max(state['peak'], rss); state['samples'] += 1
                if rss > 8 * 1024 ** 3:
                    state['killed'] = 'rss_budget_8GiB_exceeded'; os.killpg(process.pid, signal.SIGKILL); return
                if time.monotonic() - state['start'] > 900:
                    state['killed'] = 'per_document_900_second_timeout'; os.killpg(process.pid, signal.SIGKILL); return
            except psutil.Error:
                continue
    watcher = threading.Thread(target=monitor, daemon=True); watcher.start()
    records = []
    with log.open('x') as stream:
        for line in process.stdout:
            stream.write(line); stream.flush()
            event = json.loads(line)
            if event['event'] == 'document_start':
                state.update({'source_id': event['source_id'], 'peak': 0, 'samples': 0, 'start': time.monotonic()})
            else:
                record = event['record']; record.update({'sampled_process_tree_peak_rss_bytes': state['peak'],
                    'rss_sample_interval_ms': 50, 'rss_samples': state['samples'], 'measurement_command': command,
                    'cold_process_wall_seconds_including_launch': time.monotonic() - started if mode == 'cold' else None,
                    'cpu_affinity_limit': 4, 'parallel_pdf_jobs': 1})
                records.append(record)
                print(json.dumps({k: record.get(k) for k in ['candidate_id', 'mode', 'source_id', 'status', 'adapter_wall_seconds', 'sampled_process_tree_peak_rss_bytes']}, ensure_ascii=False), flush=True)
    stderr = process.stderr.read(); code = process.wait(); stop.set(); watcher.join(timeout=1)
    log.with_suffix('.stderr.log').write_text(stderr)
    if state['killed'] or code != 0:
        records.append({'candidate_id': candidate, 'mode': mode, 'source_id': state['source_id'], 'status': 'process_failure',
                        'error': state['killed'] or 'worker_exit_' + str(code), 'peak_rss_bytes': state['peak'], 'failure_log': str(log.relative_to(CODE))})
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--candidate', choices=CANDIDATES)
    parser.add_argument('--candidates', nargs='+', choices=CANDIDATES, default=CANDIDATES)
    parser.add_argument('--mode', choices=['cold', 'reuse'])
    parser.add_argument('--modes', nargs='+', choices=['cold', 'reuse'], default=['cold', 'reuse'])
    parser.add_argument('--sources', nargs='+', choices=SOURCES, default=SOURCES)
    args = parser.parse_args()
    if args.worker:
        worker(args); return
    results = []
    summary_path = OUT / ('benchmark-' + datetime.now(timezone.utc).strftime('%H%M%S') + '.json')
    for candidate in args.candidates:
        for mode in args.modes:
            groups = [[s] for s in args.sources] if mode == 'cold' else [args.sources]
            for sequence, sources in enumerate(groups):
                results.extend(run_group(candidate, mode, sources, sequence))
                summary = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'results': results,
                    'cold_definition': 'Fresh host/native process per PDF; model files and OS caches already available; downloads excluded',
                    'reuse_definition': 'Same native model instance; every original PDF parsed again through local SDK, never a saved-result/doclib cache',
                    'rss_definition': '50ms sampled aggregate resident memory of host process and recursive native children; per-document peak, plus separate lifetime ru_maxrss records',
                    'capabilities_are_not_identical': True, 'quality_accuracy_not_inferred_from_counts': True,
                    'formal_parser_selected': False, 'S3_stage_passed': False, 'S2_medical_gold_available': False,
                    'paid_llm_calls': 0, 'remote_pdf_uploads': 0}
                summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'benchmark': str(summary_path.relative_to(CODE)), 'records': len(results)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
