import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { b0CompletionIssues, executeB0Revalidation, makeB0RevalidationPlan, preflightB0Revalidation,
  prepareB0Revalidation, runB0Sequence, type B0RevalidationConfig } from '../../packages/agent/src/b0-revalidation.js';
import { B0_REVALIDATION_PURPOSE, validateB0RevalidationAuthorization, validateComparisonAuthorization,
  b0RevalidationBudgetAuthorization, type B0RevalidationAuthorization } from '../../packages/agent/src/experiment-authorization.js';
import { ExtractionBudget, S4_LIMITS } from '../../packages/agent/src/extraction-budget.js';

const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const limits = { ...S4_LIMITS, requests: 128, input_tokens: 2_500_000, output_tokens: 160_000, seconds: 3600, document_seconds: 1800, batch_responses: 16 };
const expected = { plan_sha256: 'a'.repeat(64), batch_id: 'synthetic-only-no-model-batch', model_id: 'synthetic-no-model', reasoning_effort: 'medium' as const,
  provider: 'synthetic-no-provider', api: 'openai-responses' as const, endpoint: 'https://example.invalid/v1', proposed_limits: limits,
  document_ids: ['synthetic-one', 'synthetic-two'] };
function authorization(): B0RevalidationAuthorization {
  return { schema_version: 'b0-revalidation-authorization-1', status: 'authorized', purpose: B0_REVALIDATION_PURPOSE, method: 'B0',
    document_ids: expected.document_ids, authorization_id: 'synthetic-fixture-never-provider-authorized', user_confirmation_source: 'synthetic-unit-test-only',
    approved_at: '2026-11-08T00:00:00Z', prepared_plan_sha256: expected.plan_sha256, batch_id: expected.batch_id,
    model_id: expected.model_id, reasoning_effort: expected.reasoning_effort, provider: expected.provider, api: expected.api,
    endpoint: expected.endpoint, limits: structuredClone(limits) };
}

test('B0 authorization shares strict binding/cap rules and rejects wrong purpose, method, plan, model, source order and old schema', () => {
  const a = authorization(); assert.deepEqual(validateB0RevalidationAuthorization(a, expected), a);
  assert.deepEqual(b0RevalidationBudgetAuthorization(a), { id: a.authorization_id, source: a.user_confirmation_source, recorded_at: a.approved_at });
  for (const mutation of [{ purpose: 'comparison' }, { method: 'F' }, { prepared_plan_sha256: 'b'.repeat(64) }, { model_id: 'another-model' },
    { endpoint: 'https://example.invalid/another' }, { document_ids: [...expected.document_ids].reverse() }, { document_ids: ['another-source'] },
    { status: 'pending_user_confirmation' }, { schema_version: 'two-method-authorization-1' }, { revision: {} },
    { limits: { ...limits, requests: 129 } }, { limits: { ...limits, input_tokens: 2_500_001 } },
    { limits: { ...limits, seconds: 3601 } }, { limits: { ...limits, transient_retries: 3 } }])
    assert.throws(() => validateB0RevalidationAuthorization({ ...a, ...mutation }, expected));
  assert.throws(() => validateComparisonAuthorization(a, expected), /new_comparison_user_authorization_required/);
});

test('B0 preparation refuses another method/purpose and a larger proposal before reading papers or calling a model', async () => {
  const config = await json('config/b0-s4-revalidation.json') as B0RevalidationConfig;
  for (const patch of [{ method: 'F' }, { purpose: 'comparison' }, { proposed_limits: { ...config.proposed_limits, requests: 129 } }])
    await assert.rejects(makeB0RevalidationPlan({ ...config, ...patch } as B0RevalidationConfig, 'config/b0-s4-revalidation.json'));
});

test('actual three-source prepare/preflight freeze B0 only with zero fetch, no execution, unsigned template and exact observation spans', async () => {
  const directory = await mkdtemp(resolve('runtime-data/b0-preflight-test-')), prepared = resolve(directory, 'prepared');
  const originalFetch = globalThis.fetch; let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('No provider request is allowed in an offline test.'); };
  try {
    const { plan, plan_sha256 } = await prepareB0Revalidation('config/b0-s4-revalidation.json', prepared);
    assert.deepEqual(plan.execution_order, ['L07-B0', 'L01-B0', 'L05-B0']); assert.ok(plan.papers.every(p => p.method === 'B0'));
    assert.equal(plan.papers.find(p => p.document_id === 'L01')!.language, 'zh');
    assert.ok(plan.source_hashes['packages/agent/src/b0-revalidation.ts']);
    assert.ok(plan.source_hashes['packages/agent/src/prepared-extraction-sources.ts']);
    assert.ok(plan.observations.every(c => c.source_fragments.length > 0 && c.sent_to_model_as_answers === false));
    const templatePath = resolve(prepared, 'authorization-template.json'), template = await json(templatePath);
    assert.equal(template.prepared_plan_sha256, plan_sha256); assert.equal(template.status, 'pending_user_confirmation');
    assert.equal(template.authorization_id, null); assert.equal(template.purpose, B0_REVALIDATION_PURPOSE);
    const { report } = await preflightB0Revalidation(prepared);
    assert.equal(report.status, 'offline_inputs_ready_pending_new_user_authorization'); assert.equal(report.execution_started, false);
    assert.equal(report.authorization_binding_checked, false); assert.equal(report.model_provider_requests, 0);
    await assert.rejects(executeB0Revalidation(prepared, templatePath), /new_b0_revalidation_user_authorization_required/);
    await assert.rejects(access(resolve(prepared, 'execution'))); assert.equal(fetches, 0);
    const originalPlan = await readFile(resolve(prepared, 'plan.json'));
    const changed = structuredClone(plan); changed.papers[0]!.pdf_sha256 = 'c'.repeat(64);
    await writeFile(resolve(prepared, 'plan.json'), JSON.stringify(changed));
    await assert.rejects(preflightB0Revalidation(prepared), /b0_prepared_input_or_observation_changed/);
    await writeFile(resolve(prepared, 'plan.json'), originalPlan);
    const snapshot = resolve(prepared, 'source-snapshot/packages/agent/src/strict-source-groups.ts'), originalModule = await readFile(snapshot);
    await writeFile(snapshot, Buffer.concat([originalModule, Buffer.from('\n// tampered offline snapshot\n')]));
    await assert.rejects(preflightB0Revalidation(prepared), /prepared_runtime_source_snapshot_changed/);
    await writeFile(snapshot, originalModule);
    const inputSnapshot = resolve(prepared, 'input-snapshot', plan.papers[0]!.ir_path), originalIR = await readFile(inputSnapshot);
    await writeFile(inputSnapshot, Buffer.concat([originalIR, Buffer.from('\n')]));
    await assert.rejects(preflightB0Revalidation(prepared), /b0_frozen_input_snapshot_changed/);
    await writeFile(inputSnapshot, originalIR); assert.equal(fetches, 0);
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/revalidate-b0.ts', 'execute', '--directory', prepared], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stdout, /new_b0_revalidation_user_authorization_required/);
    await assert.rejects(access(resolve(prepared, 'execution')));
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('B0 terminal checks separate raw parser partial from current task/summary/assessment/delivery failure', async () => {
  const real = await json('docs/acceptance/output-feedback-2026-11-08/comparison/execution/L07-B0/result.json');
  assert.equal(real.state, 'partial'); assert.deepEqual(b0CompletionIssues(real), []);
  for (const mutate of [
    (r: any) => { r.task_processing_complete = false; },
    (r: any) => { r.coverage.whole_document_summary_complete = false; },
    (r: any) => { r.primary_assessment_validation.status = 'incomplete'; },
    (r: any) => { r.records[0].record.evidence_validation.model_semantic_review.primary_assessment = undefined; },
    (r: any) => { r.delivery_validation.status = 'rejected'; },
    (r: any) => { r.error = { code: 'whole_document_summary_incomplete' }; },
  ]) { const failed = structuredClone(real); mutate(failed); assert.ok(b0CompletionIssues(failed).length > 0); }
});

test('one shared budget counts all offline attempts, persists a terminal failure and never starts the following papers', async () => {
  const directory = await mkdtemp(resolve('runtime-data/b0-sequence-test-'));
  try {
    const budget = new ExtractionBudget(resolve(directory, 'ledger.json'), expected.endpoint, Date.now, { limits,
      authorization: b0RevalidationBudgetAuthorization(authorization()) });
    const started: string[] = [], reports: any[] = [];
    const report = await runB0Sequence(['L07-B0', 'L01-B0', 'L05-B0'], async job => {
      started.push(job);
      // Ledger-only attempts, no fetch or semantic/model claim. Both attempts use the same owner.
      for (let i = 0; i < 2; i++) { budget.check(); const entry = budget.begin('synthetic-no-model', 'offline-retry-accounting', i, '{}', 16); budget.settle(entry); }
      return { job_id: job, failure_codes: ['b0_summary_assessment_incomplete'], result_path: 'synthetic-preserved-result.json' };
    }, () => budget.totals(), async r => { reports.push(structuredClone(r)); await writeFile(resolve(directory, 'report.json'), JSON.stringify(r)); });
    assert.deepEqual(started, ['L07-B0']); assert.equal(report.status, 'stopped_after_failure');
    assert.deepEqual(report.not_started_job_ids, ['L01-B0', 'L05-B0']); assert.equal(budget.totals().requests, 2);
    assert.equal((report.totals as any).requests, 2); assert.equal(reports.at(-1).totals.requests, 2);
    const reopened = new ExtractionBudget(resolve(directory, 'ledger.json'), expected.endpoint, Date.now, { limits,
      authorization: b0RevalidationBudgetAuthorization(authorization()) });
    assert.equal(reopened.totals().requests, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a thrown budget or source failure is persisted before any later job and never silently resumes', async () => {
  const started: string[] = [], saved: any[] = [];
  const report = await runB0Sequence(['first', 'second'], async job => { started.push(job); throw new Error('Offline source-contract fixture failure'); },
    () => ({ requests: 0 }), async r => { saved.push(structuredClone(r)); });
  assert.deepEqual(started, ['first']); assert.equal(report.status, 'stopped_after_failure');
  assert.deepEqual(report.not_started_job_ids, ['second']); assert.equal(saved.at(-1).status, 'stopped_after_failure');
});
