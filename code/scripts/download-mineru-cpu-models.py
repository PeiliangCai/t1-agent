#!/usr/bin/env python3
"""Fetch the verified official ONNX snapshot locally and verify exact bytes."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json
import os
import time

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/s3/comparison-2026-11-02'
ROOT = CODE / '.tools/pdf-parser'
os.environ.update({'MINERU_HOME': str(ROOT / 'mineru-home'), 'MINERU_MODEL_BASE_DIR': str(ROOT / 'mineru-models'),
                   'MINERU_MODEL_SMALL_BACKEND': 'onnx', 'MINERU_MODEL_ONNX_DEVICE': 'cpu',
                   'MINERU_TELEMETRY_DISABLED': '1', 'HF_HOME': str(ROOT / 'mineru-hf'),
                   'HF_HUB_DISABLE_TELEMETRY': '1', 'HF_HUB_DISABLE_XET': '1'})


def digest(path):
    h = sha256()
    with path.open('rb') as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def main():
    from huggingface_hub import snapshot_download
    from mineru.model.registry import MINERU_4_MODELS_ONNX
    from mineru.model.download import verify_model_repo
    metadata = json.loads((OUT / 'sources/mineru-onnx-model-metadata.json').read_text())
    folder = MINERU_4_MODELS_ONNX.local_dir()
    assert folder.is_relative_to(CODE), folder
    start = time.monotonic()
    snapshot_download(metadata['id'], revision=metadata['sha'], local_dir=folder, max_workers=2)
    checked = []
    for item in metadata['siblings']:
        path = folder / item['rfilename']
        expected = item.get('lfs', {}).get('sha256')
        actual = digest(path)
        assert path.stat().st_size == item['size'], item['rfilename']
        if expected:
            assert actual == expected, item['rfilename']
        checked.append({'file': item['rfilename'], 'bytes': item['size'], 'sha256': actual,
                        'lfs_sha256_verified': bool(expected)})
    ready = verify_model_repo(MINERU_4_MODELS_ONNX)
    assert ready.ready, ready
    report = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'repository': metadata['id'],
              'resolved_commit': metadata['sha'], 'local_path': str(folder.relative_to(CODE)),
              'duration_seconds': round(time.monotonic() - start, 3), 'files': checked,
              'official_readiness_verified': True, 'completion_markers_manually_forged': False,
              'model_license_verification': 'model-license-verification.json', 'remote_document_uploads': 0}
    target = OUT / ('mineru-model-download-' + datetime.now(timezone.utc).strftime('%H%M%S') + '.json')
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'result': str(target.relative_to(CODE)), 'ready': True, 'files': len(checked)}), flush=True)


if __name__ == '__main__':
    main()
