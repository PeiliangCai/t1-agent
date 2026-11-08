#!/usr/bin/env python3
"""Run relevant offline checks in the final parser environment; preserve logs."""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import re
import subprocess
import sys
import time

CODE = Path(__file__).resolve().parents[1]
STAMP = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
OUT = CODE / 'docs/acceptance/s3/checks' / STAMP
NODE = ['bash', 'scripts/with-node.sh', 'npm', 'run']
CHECKS = {
    'parser-contracts': [*NODE, 'parser:contracts'],
    'check': [*NODE, 'check'],
    'test-parser-python': [str(CODE / '.venv/bin/python'), '-m', 'unittest', 'discover', '-s', 'services/pdf-parser/tests', '-v'],
    'test-parser': [*NODE, 'test:parser'],
    'test-unit': [*NODE, 'test:unit'],
    'test-integration': [*NODE, 'test:integration'],
    'test-evaluation': [*NODE, 'test:evaluation'],
    'build-web': [*NODE, 'build:web'],
}


def main():
    names = sys.argv[1:] or list(CHECKS)
    assert all(name in CHECKS for name in names)
    OUT.mkdir(parents=True, exist_ok=False)
    reports = []
    env = {**os.environ, 'OMP_NUM_THREADS': '4', 'OPENBLAS_NUM_THREADS': '4', 'MKL_NUM_THREADS': '4'}
    for name in names:
        command = CHECKS[name]
        start = time.monotonic()
        result = subprocess.run(command, cwd=CODE, env=env, capture_output=True, text=True, timeout=180)
        log = OUT / (name + '.log')
        log.write_text(result.stdout + '\nSTDERR\n' + result.stderr)
        record = {'name': name, 'command': command, 'duration_seconds': round(time.monotonic() - start, 3),
                  'exit_code': result.returncode, 'passed': result.returncode == 0, 'log': str(log.relative_to(CODE)), 'llm_calls': 0}
        counts = {k: int(v) for k, v in re.findall(r'^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)$', result.stdout, re.MULTILINE)}
        if counts:
            record['test_counts'] = counts
        python_count = re.search(r'Ran (\d+) tests? in', result.stderr)
        if python_count:
            record['python_tests_run'] = int(python_count.group(1))
        reports.append(record)
        (OUT / 'result.json').write_text(json.dumps({'recorded_at': datetime.now(timezone.utc).isoformat(), 'checks': reports,
            'all_checks_passed': all(r['passed'] for r in reports), 'stage_passed': False, 'human_quality_verified': False,
            'real_api_calls': 0, 'dependencies': 'Current isolated .venv; includes CPU-only full Docling installation'}, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(record, ensure_ascii=False), flush=True)
        if result.returncode:
            return 1
    print(json.dumps({'result': str((OUT / 'result.json').relative_to(CODE)), 'all_checks_passed': True, 'stage_passed': False}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
