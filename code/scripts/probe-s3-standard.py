#!/usr/bin/env python3
"""Bounded CPU Docling native-candidate probe; not the project text adapter.

Only verified upstream model files are downloaded. The original development
PDFs stay local. Model artifacts, caches, native results and logs stay in code/.
"""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from urllib.request import urlopen
import json
import os
import resource
import sys
import time
import traceback

CODE = Path(__file__).resolve().parents[1]
CACHE = CODE / '.tools/pdf-parser'
for key, value in {'HF_HOME': str(CACHE / 'hf'), 'HUGGINGFACE_HUB_CACHE': str(CACHE / 'hf/hub'),
                   'XDG_CACHE_HOME': str(CACHE / 'cache'), 'HF_HUB_DISABLE_TELEMETRY': '1',
                   'OMP_NUM_THREADS': '4', 'MKL_NUM_THREADS': '4', 'OPENBLAS_NUM_THREADS': '4'}.items():
    os.environ[key] = value


def main():
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    out = CODE / 'docs/acceptance/s3/standard' / stamp
    out.mkdir(parents=True, exist_ok=False)
    summary = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'parser': 'docling', 'version': '2.145.0',
               'status': 'preparing', 'formal_parser_selected': False, 'stage_passed': False,
               'integration_status': 'native_candidate_probe_only_not_DocumentIR_v2_adapter',
               'device': 'cpu', 'threads': 4, 'ocr': False, 'table_structure_enabled': True,
               'remote_services_enabled': False, 'llm_calls': 0, 'document_uploads': 0,
               'human_fidelity_verified': False, 'downloads': [], 'results': []}
    try:
        models = json.loads((CODE / 'docs/acceptance/s3/model-source-verification.json').read_text())['models']
        for model, name in zip(models, ['layout-heron', 'docling-models']):
            metadata = json.loads((CODE / f'docs/acceptance/s3/sources/{name}-metadata.json').read_text())
            folder = CACHE / 'models' / model['repository'].replace('/', '--')
            for item in metadata['siblings']:
                filename = item['rfilename']
                if not (filename.endswith(('.json', '.safetensors')) or filename == 'README.md'):
                    continue
                dest = folder / filename
                dest.parent.mkdir(parents=True, exist_ok=True)
                expected = item.get('lfs', {}).get('sha256')
                if not dest.exists():
                    url = f'https://huggingface.co/{model["repository"]}/resolve/{model["resolved_commit"]}/{filename}'
                    temporary = dest.with_suffix(dest.suffix + '.partial')
                    started = time.monotonic()
                    with urlopen(url, timeout=45) as response, temporary.open('wb') as f:
                        while chunk := response.read(1024 * 1024):
                            f.write(chunk)
                    if temporary.stat().st_size != item['size']:
                        raise RuntimeError('Model file size mismatch: ' + filename)
                    actual = sha256(temporary.read_bytes()).hexdigest()
                    if expected and actual != expected:
                        raise RuntimeError('Model file hash mismatch: ' + filename)
                    temporary.replace(dest)
                    summary['downloads'].append({'repository': model['repository'], 'commit': model['resolved_commit'], 'file': filename,
                                                 'url': url, 'bytes': item['size'], 'sha256': actual, 'lfs_sha256_verified': bool(expected),
                                                 'duration_seconds': round(time.monotonic() - started, 3)})
                    print(json.dumps({'downloaded': filename, 'bytes': item['size']}, ensure_ascii=False), flush=True)
                else:
                    actual = sha256(dest.read_bytes()).hexdigest()
                    if dest.stat().st_size != item['size'] or expected and actual != expected:
                        raise RuntimeError('Existing model file differs from verified source')
                    summary['downloads'].append({'repository': model['repository'], 'commit': model['resolved_commit'], 'file': filename,
                                                 'bytes': item['size'], 'sha256': actual, 'reused_verified_local_file': True})
                (out / 'result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
        import torch
        torch.set_num_threads(4)
        summary['torch_version'] = torch.__version__
        summary['torch_cuda_available'] = torch.cuda.is_available()
        options = PdfPipelineOptions(do_ocr=False, do_table_structure=True, enable_remote_services=False,
                                     artifacts_path=CACHE / 'models', document_timeout=180,
                                     accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=4))
        converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
        # Same five exposed files as the text backend; each native timing is
        # labelled for model initialization / subsequent converter reuse.
        for index, source_id in enumerate(['MED03', 'L07', 'L05', 'L01', 'L02']):
            path = CODE / 'evaluation/corpus/development-candidates' / (source_id + '.pdf')
            original_hash = sha256(path.read_bytes()).hexdigest()
            started = time.monotonic(); usage = resource.getrusage(resource.RUSAGE_SELF)
            result = converter.convert(path, raises_on_error=False)
            duration = time.monotonic() - started
            target = out / (source_id + '.native.json')
            target.write_text(json.dumps(result.document.export_to_dict(), ensure_ascii=False, indent=2) + '\n')
            after = resource.getrusage(resource.RUSAGE_SELF)
            record = {'source_id': source_id, 'status': result.status.value, 'file_sha256': original_hash,
                      'exposed_development_only': True, 'fixture': False, 'duration_seconds': round(duration, 6),
                      'timing_scope': 'includes_initial_model_loading' if index == 0 else 'same_converter_models_reused',
                      'native_pages': len(result.document.pages), 'native_text_items': len(result.document.texts),
                      'native_tables': len(result.document.tables), 'native_pictures': len(result.document.pictures),
                      'cpu_user_seconds': round(after.ru_utime - usage.ru_utime, 6), 'cpu_system_seconds': round(after.ru_stime - usage.ru_stime, 6),
                      'peak_rss_bytes': after.ru_maxrss * 1024, 'peak_rss_scope': 'process_lifetime_so_far_shared_converter',
                      'native_output': str(target.relative_to(CODE)), 'original_unchanged': sha256(path.read_bytes()).hexdigest() == original_hash,
                      'human_table_and_reading_order_fidelity_verified': False, 'native_error_count': len(result.errors)}
            summary['results'].append(record)
            (out / 'result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(record, ensure_ascii=False), flush=True)
        summary['status'] = 'native_probe_completed_quality_unverified'
    except Exception as exc:
        summary.update({'status': 'blocked_native_candidate_probe', 'error_type': type(exc).__name__, 'error': str(exc)[:500],
                        'text_adapter_remains_available': True})
        (out / 'failure.log').write_text(traceback.format_exc())
        print(json.dumps({'status': summary['status'], 'error_type': type(exc).__name__, 'error': str(exc)[:300]}, ensure_ascii=False), flush=True)
    summary['finished_at'] = datetime.now(timezone.utc).isoformat()
    (out / 'result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'result': str((out / 'result.json').relative_to(CODE)), 'status': summary['status']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
