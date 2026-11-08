#!/usr/bin/env python3
"""Install the pinned official Node binary inside this project, checking SHA256."""
from pathlib import Path
import hashlib
import json
import os
import platform
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = ROOT.joinpath('.node-version').read_text().strip()
if platform.system() != 'Linux' or platform.machine() != 'x86_64':
    raise SystemExit('This bootstrap is pinned to Linux x86_64; select a matching official binary first.')
TOOLS = ROOT / '.tools'
TOOLS.mkdir(exist_ok=True)
NAME = f'node-v{VERSION}-linux-x64'
ARCHIVE = NAME + '.tar.xz'
BASE_URL = f'https://nodejs.org/dist/v{VERSION}/'
with urllib.request.urlopen(BASE_URL + 'SHASUMS256.txt', timeout=60) as response:
    checksums = response.read().decode()
expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == ARCHIVE)
target = TOOLS / NAME
if not target.joinpath('bin/node').is_file():
    archive = TOOLS / ARCHIVE
    try:
        with urllib.request.urlopen(BASE_URL + ARCHIVE, timeout=60) as response, archive.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit('Official Node archive SHA256 mismatch; installation stopped.')
        with tarfile.open(archive) as bundle:
            bundle.extractall(TOOLS, filter='data')
    finally:
        archive.unlink(missing_ok=True)
link = TOOLS / 'node'
if link.is_symlink():
    if os.readlink(link) != NAME:
        link.unlink()
elif link.exists():
    raise SystemExit('.tools/node exists and is not the managed symlink; left untouched.')
if not link.exists():
    link.symlink_to(NAME, target_is_directory=True)
node = subprocess.check_output([str(target / 'bin/node'), '--version'], text=True).strip()
env = dict(os.environ, PATH=str(target / 'bin') + os.pathsep + os.environ.get('PATH', ''))
npm = subprocess.check_output([str(target / 'bin/npm'), '--version'], env=env, text=True).strip()
record = {'node': node, 'npm': npm, 'distribution_url': BASE_URL + ARCHIVE,
          'checksum_source': BASE_URL + 'SHASUMS256.txt', 'archive_sha256': expected,
          'install_directory': '.tools/' + NAME, 'system_node_configuration_changed': False}
destination = ROOT / 'docs/acceptance/s0/node-provenance.json'
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))
