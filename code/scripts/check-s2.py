#!/usr/bin/env python3
"""Run offline S2 checks once; keep each run and expected unevaluable output separate."""
from datetime import datetime, timezone
from pathlib import Path
import json
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
stamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
OUT = ROOT / 'docs/acceptance/s2/checks' / stamp
OUT.mkdir(parents=True, exist_ok=False)
available = {
    'export-contracts': (['eval:export-contracts'], 0),
    'check': (['check'], 0),
    'test-evaluation': (['test:evaluation'], 0),
    'test-unit': (['test:unit'], 0),
    'test-integration': (['test:integration'], 0),
    'build-web': (['build:web'], 0),
    'fixture-example': (['eval:quality', '--', '--input', 'evaluation/fixtures/scoring/synthetic-example.json', '--output', f'evaluation/reports/fixtures/{stamp}.json'], 0),
    'real-pending-example': (['eval:quality', '--', '--input', 'evaluation/fixtures/scoring/unevaluable-real-input.json', '--output', f'evaluation/reports/real/{stamp}.json'], 2),
}
selected = sys.argv[1:] or list(available)
assert all(key in available for key in selected)
reports = []
for name in selected:
    args, expected = available[name]
    command = ['bash', 'scripts/with-node.sh', 'npm', 'run', *args]
    started = datetime.now(timezone.utc).isoformat()
    start = time.monotonic()
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=120)
    log = OUT / (name + '.log')
    log.write_text(result.stdout + '\nSTDERR\n' + result.stderr)
    counts = {k: int(v) for k, v in re.findall(r'^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)$', result.stdout, re.MULTILINE)}
    record = {'name': name, 'command': command, 'started_at': started, 'finished_at': datetime.now(timezone.utc).isoformat(),
              'duration_seconds': round(time.monotonic() - start, 3), 'exit_code': result.returncode, 'expected_exit_code': expected,
              'passed_expected_behavior': result.returncode == expected, 'log': str(log.relative_to(ROOT)), 'real_api_calls': 0}
    if counts:
        record['test_counts'] = counts
    reports.append(record)
    summary = {'started_at': reports[0]['started_at'], 'updated_at': datetime.now(timezone.utc).isoformat(), 'checks': reports,
               'all_expected_behaviors_passed': all(r['passed_expected_behavior'] for r in reports), 'real_api_calls': 0,
               'medical_quality_measured': False, 'S2_stage_passed': False}
    (OUT / 'result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(record, ensure_ascii=False), flush=True)
    if result.returncode != expected:
        print('Failure preserved at ' + str(log.relative_to(ROOT)), flush=True)
        raise SystemExit(1)
print(json.dumps({'result': str((OUT / 'result.json').relative_to(ROOT)), 'expected_behaviors_passed': True}, ensure_ascii=False))
