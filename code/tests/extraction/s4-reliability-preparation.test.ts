import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { validateComparisonAuthorization } from '../../packages/agent/src/experiment-authorization.js';
import { buildArticleScope, type ExtractionDocument } from '../../packages/agent/src/article-scope.js';
import { selectSourceBlocks } from '../../packages/agent/src/source-selection.js';

const code = resolve('.');
function cli(args: string[]) {
  return execFileSync('bash', ['scripts/with-node.sh', 'node_modules/.bin/tsx', 'scripts/compare-extraction-methods.ts', ...args],
    { cwd: code, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function fixture() {
  const config = JSON.parse(await readFile('config/two-method-comparison.json', 'utf8'));
  config.papers = config.papers.filter((p: { source_id: string }) => p.source_id === 'L05');
  config.optimization.parent_plan = null; config.optimization.declared_change = null;
  config.execution_job_ids = ['L05-B0', 'L05-F'];
  config.proposed_limits = { ...config.proposed_limits, requests: 64, input_tokens: 1500000, output_tokens: 160000, seconds: 1800 };
  return { config };
}

test('current runner prepares two independent B0/F smoke jobs with exact current selections and refuses unsigned execution', async () => {
  const directory = await mkdtemp(resolve('runtime-data/reliability-prepare-fixture-'));
  try {
    const { config } = await fixture(), configPath = join(directory, 'config.json'), prepared = join(directory, 'prepared');
    await writeFile(configPath, JSON.stringify(config));
    const result = JSON.parse(cli(['prepare', '--directory', relative(code, prepared), '--config', relative(code, configPath)]));
    assert.equal(result.paid_calls, 0); assert.deepEqual(result.execution_job_ids, ['L05-B0', 'L05-F']);
    const plan = JSON.parse(await readFile(join(prepared, 'plan.json'), 'utf8'));
    assert.match(plan.experiment_purpose, /no_single_variable_gain_or_method_ranking/);
    assert.equal(plan.schema_version, 'two-method-prepared-comparison-1');
    assert.equal(plan.input_quality_status, 'source_binding_checked_input_readiness_recorded_separately');
    assert.equal(plan.input_readiness_report, config.input_readiness_report);
    assert.equal(plan.offline_preparation_is_input_quality_approval, false);
    assert.equal(plan.papers[0].methods.logical_methods, 2);
    const document = JSON.parse(await readFile(plan.papers[0].ir_path, 'utf8')).document as ExtractionDocument;
    for (const j of plan.papers[0].methods.jobs) {
      assert.ok(['B0', 'F'].includes(j.condition));
      assert.deepEqual(j.selection, selectSourceBlocks(document, buildArticleScope(document), j.condition));
    }
    const authorization = join(prepared, 'authorization-template.json');
    const template = JSON.parse(await readFile(authorization, 'utf8'));
    assert.equal(template.schema_version, 'two-method-authorization-1');
    assert.equal(template.status, 'pending_user_confirmation'); assert.equal(template.authorization_id, null);
    assert.match(template.scope_note, /Integrated reliability smoke only/);
    const planBytes = await readFile(join(prepared, 'plan.json'));
    assert.equal(template.prepared_plan_sha256, createHash('sha256').update(planBytes).digest('hex'));
    const altered = structuredClone(plan); altered.config.execution_job_ids = ['L05-B0', 'L05-R'];
    assert.throws(() => validateComparisonAuthorization({ ...template, status: 'authorized', authorization_id: 'synthetic-validation-only',
      user_confirmation_source: 'synthetic-not-an-actual-approval', approved_at: '2026-11-05T00:00:00Z' }, {
      plan_sha256: createHash('sha256').update(JSON.stringify(altered)).digest('hex'), batch_id: plan.batch_id,
      ...plan.config.model, proposed_limits: plan.config.proposed_limits,
    }), /new_comparison_user_authorization_required/);
    assert.throws(() => cli(['execute', '--directory', relative(code, prepared), '--authorization', relative(code, authorization)]), /new_comparison_user_authorization_required/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a retired R method cannot become a selected smoke job', async () => {
  const directory = await mkdtemp(resolve('runtime-data/reliability-reuse-cohort-'));
  try {
    const { config } = await fixture();
    config.papers = [{ source_id: 'L01', prepared_directory: 'absent-must-not-be-read' }];
    config.execution_job_ids = ['L01-R'];
    const configPath = join(directory, 'config.json'); await writeFile(configPath, JSON.stringify(config));
    assert.throws(() => cli(['prepare', '--directory', relative(code, join(directory, 'prepared')), '--config', relative(code, configPath)]), /comparison_execution_jobs_invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an empty, duplicate or unknown smoke cohort is rejected before preparing or loading model credentials', async () => {
  const directory = await mkdtemp(resolve('runtime-data/reliability-invalid-cohort-'));
  try {
    const { config } = await fixture();
    for (const [i, jobs] of [[], ['L05-F', 'L05-F'], ['L01-B0'], ['L05-B9']].entries()) {
      config.execution_job_ids = jobs;
      const configPath = join(directory, `config-${i}.json`); await writeFile(configPath, JSON.stringify(config));
      assert.throws(() => cli(['prepare', '--directory', relative(code, join(directory, `prepared-${i}`)), '--config', relative(code, configPath)]), /comparison_execution_jobs_invalid/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('current runner rejects missing or drifted auxiliary parser fingerprints before loading figure assets', async () => {
  const directory = await mkdtemp(resolve('runtime-data/parser-fingerprint-fixture-'));
  try {
    const { config } = await fixture();
    const original = JSON.parse(await readFile(join(config.papers[0].prepared_directory, 'parser-result.json'), 'utf8'));
    for (const [index, mode] of ['missing', 'changed'].entries()) {
      const source = join(directory, 'source-' + index); await mkdir(source);
      const parsed = structuredClone(original);
      if (mode === 'missing') delete parsed.document.parser.config.auxiliary_module_sha256;
      else parsed.document.parser.config.auxiliary_module_sha256['source_tables.py'] = '0'.repeat(64);
      await writeFile(join(source, 'parser-result.json'), JSON.stringify(parsed));
      const changed = structuredClone(config); changed.papers[0].prepared_directory = relative(code, source);
      changed.papers[0].figure_catalog = 'absent-must-not-be-read.json';
      const path = join(directory, 'config-' + index + '.json'); await writeFile(path, JSON.stringify(changed));
      assert.throws(() => cli(['prepare', '--directory', relative(code, join(directory, 'prepared-' + index)), '--config', relative(code, path)]),
        /comparison_requires_same_current_formal_parser/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
