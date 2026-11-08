#!/usr/bin/env python3
"""Install isolated parser dependencies and preserve actual install logs."""
from datetime import datetime, timezone
from pathlib import Path
import json
import subprocess
import sys
import time
import venv

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/s3/install'
STAMP = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    directory = OUT / STAMP
    directory.mkdir(exist_ok=False)
    virtual = CODE / '.venv'
    if not (virtual / 'pyvenv.cfg').exists():
        # The host lacks ensurepip. Use the existing pip runner to manage only
        # this venv, without installing/upgrading any host Python packages.
        venv.EnvBuilder(with_pip=False).create(virtual)
    python = virtual / 'bin/python'
    command = [sys.executable, '-m', 'pip', '--python', str(python), '--disable-pip-version-check', 'install', '--index-url', 'https://pypi.org/simple',
               '--cache-dir', str(CODE / '.tools/pdf-parser/pip-cache'), '--report', str(directory / 'pip-report.json'),
               '-r', 'services/pdf-parser/requirements-test.txt']
    start = time.monotonic()
    with (directory / 'pip-install.log').open('w') as log:
        result = subprocess.run(command, cwd=CODE, stdout=log, stderr=subprocess.STDOUT, timeout=900)
    summary = {'command': command, 'exit_code': result.returncode, 'duration_seconds': round(time.monotonic() - start, 3),
               'virtual_environment': str(virtual.relative_to(CODE)), 'system_python_modified': False,
               'formal_parser_selected': False, 'full_docling_pipeline_installed': False}
    if result.returncode == 0:
        frozen = subprocess.check_output([sys.executable, '-m', 'pip', '--python', str(python), 'freeze'], cwd=CODE, text=True)
        (directory / 'installed-freeze.txt').write_text(frozen)
    (directory / 'result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'result': str((directory / 'result.json').relative_to(CODE)), **summary}, ensure_ascii=False))
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
