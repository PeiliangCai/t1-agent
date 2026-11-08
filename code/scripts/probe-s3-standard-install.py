#!/usr/bin/env python3
"""Resolve full Docling with CPU-pinned torch; refuse CUDA and excess budget.

The --install flag performs the already-authorized isolated dependency install.
No PDF is opened and no model is fetched by this script.
"""
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
import argparse
import json
import subprocess
import sys
import time

CODE = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    out = CODE / 'docs/acceptance/s3/install' / ('standard-' + stamp)
    out.mkdir(parents=True, exist_ok=False)
    base = [sys.executable, '-m', 'pip', '--python', str(CODE / '.venv/bin/python'), '--disable-pip-version-check',
            'install', '--index-url', 'https://pypi.org/simple', '--extra-index-url', 'https://download.pytorch.org/whl/cpu',
            '--cache-dir', str(CODE / '.tools/pdf-parser/pip-cache')]
    packages = ['docling==2.145.0', 'torch==2.15.0+cpu', 'torchvision==0.29.2+cpu']
    command = [*base, '--dry-run', '--report', str(out / 'dry-run-report.json'), *packages]
    start = time.monotonic()
    with (out / 'dry-run.log').open('w') as log:
        resolved = subprocess.run(command, cwd=CODE, stdout=log, stderr=subprocess.STDOUT, timeout=600)
    summary = {'dry_run_command': command, 'dry_run_exit_code': resolved.returncode,
               'duration_seconds': round(time.monotonic() - start, 3), 'cuda_packages_allowed': False,
               'system_python_modified': False, 'formal_parser_selected': False, 'installation_performed': False}
    if resolved.returncode == 0:
        report = json.loads((out / 'dry-run-report.json').read_text())
        entries = [{'name': item['metadata']['name'], 'version': item['metadata']['version'], 'url': item['download_info']['url']}
                   for item in report['install']]
        forbidden = [p for p in entries if any(term in p['name'].lower() for term in ['nvidia', 'cuda', 'triton'])]
        summary.update({'resolved_packages': entries, 'forbidden_cuda_packages': forbidden})
        if forbidden:
            summary['decision'] = 'refuse_cuda_resolution'
        else:
            sizes = []
            for p in entries:
                with urlopen(Request(p['url'], method='HEAD'), timeout=30) as response:
                    sizes.append({'name': p['name'], 'download_bytes': int(response.headers['Content-Length'])})
            total = sum(p['download_bytes'] for p in sizes)
            summary.update({'wheel_sizes': sizes, 'additional_compressed_download_bytes': total,
                            'budget_bytes': 6 * 1024 ** 3, 'model_and_expansion_reserve_bytes': 3 * 1024 ** 3})
            safe = total + 3 * 1024 ** 3 < 6 * 1024 ** 3
            summary['decision'] = 'cpu_resolution_within_budget' if safe else 'defer_exceeds_budget'
            if safe and args.install:
                install = [*base, '--report', str(out / 'install-report.json'), *packages]
                with (out / 'install.log').open('w') as log:
                    result = subprocess.run(install, cwd=CODE, stdout=log, stderr=subprocess.STDOUT, timeout=900)
                summary.update({'installation_performed': True, 'install_exit_code': result.returncode, 'install_command': install})
                if result.returncode == 0:
                    frozen = subprocess.check_output([sys.executable, '-m', 'pip', '--python', str(CODE / '.venv/bin/python'), 'freeze'], text=True)
                    (out / 'installed-freeze.txt').write_text(frozen)
    else:
        summary['decision'] = 'full_standard_dependency_resolution_unavailable_keep_text_backend'
    (out / 'result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'result': str((out / 'result.json').relative_to(CODE)), **{k: v for k, v in summary.items() if k not in ['resolved_packages', 'wheel_sizes']}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
