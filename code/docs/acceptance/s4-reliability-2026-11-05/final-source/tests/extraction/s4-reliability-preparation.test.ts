import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { validateComparisonAuthorization } from '../../packages/agent/src/experiment-authorization.js';

const code = resolve('.');
function cli(args: string[]) {
  return execFileSync('bash', ['scripts/with-node.sh', 'node_modules/.bin/tsx', 'scripts/compare-extraction-methods.ts', ...args],
    { cwd: code, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function fixture() {
  const parent = JSON.parse(await readFile('docs/acceptance/user-feedback-2026-11-05/revalidation/metric-context-revision/prepared/plan.json', 'utf8'));
  const config = structuredClone(parent.config);
  config.papers = config.papers.filter((p: { source_id: string }) => p.source_id === 'L05');
  config.optimization.parent_plan = null; config.optimization.declared_change = null;
  config.execution_job_ids = ['L05-B0', 'L05-F'];
  config.proposed_limits = { ...config.proposed_limits, requests: 64, input_tokens: 1500000, output_tokens: 160000, seconds: 1800 };
  return { config, parent };
}

test('existing runner prepares only two selected independent smoke jobs, preserves all method inputs and refuses unsigned execution', async () => {
  const directory = await mkdtemp(resolve('runtime-data/reliability-prepare-fixture-'));
  try {
    const { config, parent } = await fixture(), configPath = join(directory, 'config.json'), prepared = join(directory, 'prepared');
    await writeFile(configPath, JSON.stringify(config));
    const result = JSON.parse(cli(['prepare', '--directory', relative(code, prepared), '--config', relative(code, configPath)]));
    assert.equal(result.paid_calls, 0); assert.deepEqual(result.execution_job_ids, ['L05-B0', 'L05-F']);
    const plan = JSON.parse(await readFile(join(prepared, 'plan.json'), 'utf8'));
    assert.match(plan.experiment_purpose, /no_single_variable_gain_or_method_ranking/);
    const before = parent.papers.find((p: { document_id: string }) => p.document_id === 'L05');
    for (const j of plan.papers[0].methods.jobs) {
      const old = before.methods.jobs.find((v: { job_id: string }) => v.job_id === j.job_id);
      assert.deepEqual(j.selection, old.selection); assert.deepEqual(j.batches, old.batches);
    }
    const authorization = join(prepared, 'authorization-template.json');
    const template = JSON.parse(await readFile(authorization, 'utf8'));
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

test('a reused non-independent method cannot become a selected smoke job', async () => {
  const directory = await mkdtemp(resolve('runtime-data/reliability-reuse-cohort-'));
  try {
    const { config, parent } = await fixture();
    config.papers = parent.config.papers.filter((p: { source_id: string }) => p.source_id === 'L01');
    config.execution_job_ids = ['L01-R'];
    const configPath = join(directory, 'config.json'); await writeFile(configPath, JSON.stringify(config));
    assert.throws(() => cli(['prepare', '--directory', relative(code, join(directory, 'prepared')), '--config', relative(code, configPath)]), /reliability_smoke_requires_independent_jobs/);
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
