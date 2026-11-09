#!/usr/bin/env python3
"""Fetch/verify the exact previously selected Docling CPU artifacts. No documents or model API."""
import hashlib
import json
from pathlib import Path
import sys
from urllib.request import urlopen

manifest = json.loads(Path(__file__).with_name('docling-models.json').read_text())
if len(sys.argv) != 3 or sys.argv[1] not in ('verify', 'download'):
    raise SystemExit('usage: python3 deploy/docling-models.py verify|download MODEL_DIRECTORY')
root = Path(sys.argv[2]).resolve()
for item in manifest['files']:
    target = root / item['path']
    if not target.exists() and sys.argv[1] == 'download':
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.partial')
        digest = hashlib.sha256()
        count = 0
        with urlopen(item['url'], timeout=90) as response, temporary.open('xb') as output:
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > item['bytes']:
                    raise RuntimeError('model_size_exceeded')
                digest.update(chunk)
                output.write(chunk)
        if count != item['bytes'] or digest.hexdigest() != item['sha256']:
            raise RuntimeError('model_download_hash_mismatch')
        temporary.rename(target)
    if target.is_symlink() or not target.is_file() or target.stat().st_size != item['bytes']:
        raise RuntimeError('model_file_missing_or_size_changed: ' + item['path'])
    digest = hashlib.sha256()
    with target.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != item['sha256']:
        raise RuntimeError('model_file_hash_mismatch: ' + item['path'])
print(json.dumps({'verified': True, 'files': len(manifest['files']), 'bytes': sum(f['bytes'] for f in manifest['files']), 'remote_model_calls': 0}))
