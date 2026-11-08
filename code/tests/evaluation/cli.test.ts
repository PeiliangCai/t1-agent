import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = (input: string, output: string) => spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/evaluate-quality.ts', '--input', input, '--output', output], { cwd: root, encoding: 'utf8', timeout: 20000 });

test('CLI keeps synthetic scoring in fixture reports and preserves previous output', () => {
  const output = `evaluation/reports/fixtures/test-${randomUUID()}.json`;
  try {
    const a = execute('evaluation/fixtures/scoring/synthetic-example.json', output);
    assert.equal(a.status, 0, a.stderr);
    const report = JSON.parse(readFileSync(root + output, 'utf8'));
    assert.equal(report.status, 'fixture_scored'); assert.equal(report.totals.tp, 2); assert.equal(report.totals.fp, 1);
    assert.equal(execute('evaluation/fixtures/scoring/synthetic-example.json', output).status, 1);
    assert.equal(JSON.parse(readFileSync(root + output, 'utf8')).input_sha256, report.input_sha256);
  } finally { rmSync(root + output, { force: true }); }
});

test('CLI refuses to put a fixture report in the real-report directory', () => {
  const output = `evaluation/reports/real/test-${randomUUID()}.json`;
  const r = execute('evaluation/fixtures/scoring/synthetic-example.json', output);
  assert.equal(r.status, 1); assert.match(r.stderr, /purpose_specific_report_directory/);
});

test('CLI returns a distinct unevaluable exit code for an unpopulated real input', () => {
  const output = `evaluation/reports/real/test-${randomUUID()}.json`;
  try {
    const r = execute('evaluation/fixtures/scoring/unevaluable-real-input.json', output);
    assert.equal(r.status, 2, r.stderr);
    const report = JSON.parse(readFileSync(root + output, 'utf8'));
    assert.equal(report.status, 'not_evaluable'); assert.equal(report.totals, null); assert.equal(report.official_acceptance, 'not_assessed');
  } finally { rmSync(root + output, { force: true }); }
});
