#!/usr/bin/env python3
"""Run only deterministic local checks; this command never invokes smoke:pi."""
from pathlib import Path
from datetime import datetime, timezone
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/acceptance/s1'
OUT.mkdir(parents=True, exist_ok=True)
selected = sys.argv[1:] or ['check', 'test:unit', 'test:integration', 'build:web']
allowed = {'check', 'test:unit', 'test:integration', 'build:web'}
assert all(name in allowed for name in selected)
reports = []
for name in selected:
    command = ['bash', 'scripts/with-node.sh', 'npm', 'run', name]
    started = datetime.now(timezone.utc).isoformat()
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    record = {'command': command, 'cwd': str(ROOT), 'started_at': started,
              'finished_at': datetime.now(timezone.utc).isoformat(), 'exit_code': result.returncode,
              'stdout': result.stdout, 'stderr': result.stderr, 'real_api_calls': 0}
    path = OUT / ('local-' + name.replace(':', '-') + '.json')
    if path.exists():
        prior = json.loads(path.read_text())
        if prior['exit_code'] != 0:
            previous_time = prior['started_at'].replace(':', '-').replace('.', '-')
            path.rename(OUT / (path.stem + '-failed-' + previous_time + '.json'))
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    reports.append({'check': name, 'exit_code': result.returncode, 'log': str(path.relative_to(ROOT))})
    print(json.dumps(reports[-1]), flush=True)
    if result.returncode:
        print(result.stdout[-8000:])
        print(result.stderr[-2000:])
        raise SystemExit(result.returncode)
print(json.dumps({'local_checks_passed': reports, 'real_api_calls': 0}))
