#!/usr/bin/env python3
"""Capture current primary metadata/source evidence without installing candidate stacks."""
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
import hashlib
import importlib.util
import json
import os
import platform
import shutil
import sys

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/s3'
SOURCES = OUT / 'sources'


def main():
    SOURCES.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    entries = []

    def fetch(name, url):
        dest = SOURCES / name
        if dest.exists():
            raw = dest.read_bytes()
            checked = datetime.fromtimestamp(dest.stat().st_mtime, timezone.utc).isoformat()
        else:
            with urlopen(Request(url, headers={'User-Agent': 'T1-S3-reproducibility/1'}), timeout=45) as response:
                raw = response.read()
            dest.write_bytes(raw)
            checked = now
        entries.append({'url': url, 'checked_at': checked, 'path': str(dest.relative_to(CODE)), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
        return raw

    packages = {}
    for package in ['docling', 'docling-slim', 'docling-parse', 'mineru', 'pypdfium2', 'psutil', 'pypdf', 'reportlab']:
        payload = json.loads(fetch(package + '-pypi.json', f'https://pypi.org/pypi/{package}/json'))
        info = payload['info']
        packages[package] = {k: info.get(k) for k in ['name', 'version', 'requires_python', 'license', 'license_expression', 'requires_dist', 'project_urls']}
        packages[package]['distributions'] = [{k: f.get(k) for k in ['filename', 'size', 'digests', 'upload_time_iso_8601', 'url']} for f in payload['urls']]
    repos = {}
    for label, repo in [('docling', 'docling-project/docling'), ('mineru', 'opendatalab/MinerU')]:
        release = json.loads(fetch(label + '-latest-release.json', f'https://api.github.com/repos/{repo}/releases/latest'))
        commit = json.loads(fetch(label + '-release-commit.json', f'https://api.github.com/repos/{repo}/commits/{release["tag_name"]}'))['sha']
        repos[label] = {'repository': repo, 'latest_release': {k: release.get(k) for k in ['tag_name', 'published_at', 'html_url', 'prerelease']}, 'source_commit': commit}
        for filename in ['README.md', 'LICENSE' if label == 'docling' else 'LICENSE.md', 'pyproject.toml']:
            fetch(label + '-' + filename, f'https://raw.githubusercontent.com/{repo}/{commit}/{filename}')
    env = {'recorded_at': now, 'python': sys.version, 'platform': platform.platform(), 'machine': platform.machine(),
           'logical_cpus': os.cpu_count(), 'meminfo': {s.split(':')[0]: s.split(':')[1].strip() for s in Path('/proc/meminfo').read_text().splitlines()[:3]},
           'disk_bytes': dict(zip(['total', 'used', 'free'], shutil.disk_usage(CODE))),
           'available_before_install': {x: bool(importlib.util.find_spec(x)) for x in ['docling', 'pypdfium2', 'pypdf', 'fitz', 'reportlab', 'PIL', 'psutil', 'torch']},
           'executables': {x: shutil.which(x) for x in ['nvidia-smi', 'pdftotext', 'pdfinfo', 'uv', 'docker']},
           'gpu_confirmed': False, 'gpu_note': 'nvidia-smi absent; no GPU parsing capability established. CPU path only.',
           'system_python_modified': False, 'server_specification_changed': False}
    (OUT / 'candidate-source-verification.json').write_text(json.dumps({'checked_at': now, 'packages': packages, 'repositories': repos, 'sources': entries, 'formal_parser_selected': False}, ensure_ascii=False, indent=2) + '\n')
    (OUT / 'environment-before-install.json').write_text(json.dumps(env, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'versions': {k: p['version'] for k, p in packages.items()}, 'release_commits': repos, 'environment': {'cpu': env['logical_cpus'], 'meminfo': env['meminfo'], 'gpu_confirmed': False}, 'sources': len(entries)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
