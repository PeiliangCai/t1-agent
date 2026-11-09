import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { ModelConfig, S4_LIMITS } from '@t1/agent';
import type { RunInput } from '@t1/contracts';
import { unavailableMedicalCatalog } from '../apps/server/src/workflow.js';
import { assertContainerPlan, ContainerOneRunAllowance, type ContainerRunPlan } from './one-run-allowance.js';

test('one-container admission binds source/scope, survives restart, starts clock at HTTP and closes remainder without requests', async () => {
  const root = await mkdtemp(resolve('runtime-data/s7-allowance-offline-')), pin = resolve(root, 'pin.txt'), directory = resolve(root, 'workbench/runs/test');
  await mkdir(directory, { recursive: true }); await writeFile(pin, 'original');
  let now = 1_000;
  const scope = { scope_version: '1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] }, features: { mode: 'all', binding_ids: [] }, catalog_version: unavailableMedicalCatalog.catalog_version, matching_policy_version: 'exact-explicit-synonyms-1' } as const;
  const plan = { schema_version: 's7-one-container-run-1', plan_id: 'offline-guard-test-not-authorization',
    authorization: { authorized_runs: 1, scope: 'S7_single_container_deployment_reverification', observed_at: '1970-01-01T00:00:01.000Z' }, input: { document_id: 'engineering', sha256: 'a'.repeat(64) },
    model: { provider: 'agicto', endpoint: 'https://api.agicto.cn/v1', model_id: 'gpt-6-luna', reasoning_effort: 'medium' },
    hard_stop_utc: '1970-01-01T00:40:00.000Z', limits: { ...S4_LIMITS, requests: 40, input_tokens: 1_000_000, output_tokens: 60_000, seconds: 1800, document_seconds: 1800, batch_responses: 16 },
    scope, code_sha256: { [relative(process.cwd(), pin)]: createHash('sha256').update('original').digest('hex') } } as unknown as ContainerRunPlan;
  const config = new ModelConfig('agicto', 'https://api.agicto.cn/v1', 'gpt-6-luna', 'offline-dummy-no-network');
  const input = { file_sha256: plan.input.sha256, scope: plan.scope, run_id: 'offline-test-run' } as RunInput;
  const allowance = new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), root, () => now);
  try {
    assertContainerPlan(plan); assert.equal(allowance.available(), true);
    assert.throws(() => allowance.prepare({ ...input, file_sha256: 'c'.repeat(64) }, directory), /input_or_scope_not_authorized/);
    assert.equal(allowance.available(), true);
    allowance.prepare(input, directory);
    assert.equal(allowance.budget!.totals().requests, 0); assert.equal(allowance.remainingMs(), 1800_000);
    assert.equal(allowance.available(), false); assert.throws(() => allowance.prepare(input, directory), /single_container_allowance_closed/);
    const restarted = new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), root, () => now);
    assert.equal(restarted.available(), false);
    now += 1800_001; assert.throws(() => allowance.remainingMs(), /experiment_time_limit/);
    allowance.close('offline_guard_test_finished');
    const saved = JSON.parse(await readFile(resolve(root, 'allowance.json'), 'utf8'));
    assert.equal(saved.closed, true); assert.equal(saved.unused_allowance_closed, true);
    assert.equal(allowance.budget!.totals().requests, 0);
    const lateDirectory = resolve(root, 'late'), lateRun = resolve(lateDirectory, 'runs/late'); await mkdir(lateRun, { recursive: true });
    const shortWindow = new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), lateDirectory, () => Date.parse(plan.hard_stop_utc) - 1000);
    assert.equal(shortWindow.available(), true); shortWindow.prepare({ ...input, run_id: 'late-test' }, lateRun);
    assert.equal(shortWindow.budget!.wallClockSeconds, 1); shortWindow.close('offline_short_window_closed');
    const tooLate = new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), resolve(root, 'past'), () => Date.parse(plan.hard_stop_utc));
    assert.equal(tooLate.available(), false);
    const latest = new ContainerOneRunAllowance({ ...plan, latest_admission_utc: '1970-01-01T00:00:02.000Z' }, 'b'.repeat(64), config, process.cwd(), resolve(root, 'late-admission'), () => 2001);
    assert.equal(latest.available(), false);
    assert.throws(() => assertContainerPlan({ ...plan, limits: { ...plan.limits, transient_retries: 3 } }), /invalid_container_verification_limit/);
    await writeFile(pin, 'changed');
    assert.throws(() => new ContainerOneRunAllowance(plan, 'b'.repeat(64), config, process.cwd(), root), /pin_changed/);
  } finally { allowance.close('offline_test_cleanup'); await rm(root, { recursive: true, force: true }); }
});
