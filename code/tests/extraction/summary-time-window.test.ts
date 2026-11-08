import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Usage } from '@earendil-works/pi-ai';
import { ExtractionBudget, S4_LIMITS, type ExtractionBudgetLimits, type RequestAccounting } from '../../packages/agent/src/extraction-budget.js';
import { SummaryTimeBudget, SUMMARY_RESUME_JOBS, SUMMARY_RESUME_SECONDS, sha256,
  validateSummaryTimeAuthorization, type SummaryTimeAuthorization, type SummaryTimeRuntime } from '../../scripts/lib/summary-time-window.js';

const endpoint = 'http://synthetic-summary-resume.invalid/v1';
const start = Date.parse('2026-11-04T16:00:00Z'), paused = start + 2_800_000, resumed = start + 60_000_000;
const authorization = { id: 'synthetic-summary-time-test', source: 'SYNTHETIC ONLY; never a paid authorization', recorded_at: new Date(start).toISOString() };
const defaultLimits: ExtractionBudgetLimits = { ...S4_LIMITS, requests: 300, input_tokens: 6_000_000, seconds: 14400 };
const usage = (input = 10, output = 1): Usage => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
async function fixture(body: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>, limits = defaultLimits) {
  await mkdir('runtime-data', { recursive: true });
  const directory = await mkdtemp('runtime-data/synthetic-summary-time-');
  try { await body(await createFixture(directory, limits)); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function createFixture(directory: string, limits: ExtractionBudgetLimits) {
  const path = join(directory, 'ledger.json'), options = { limits, authorization };
  const original = new ExtractionBudget(path, endpoint, () => start, options);
  original.settle(original.begin('synthetic', 'completed-original-experiment', 0, '{}', 1), usage());
  const bytes = await readFile(path, 'utf8');
  const runtime: SummaryTimeRuntime = { authorization_id: authorization.id, replay_id: 'synthetic-replay', jobs: [...SUMMARY_RESUME_JOBS],
    replay_manifest_sha256: 'a'.repeat(64), original_driver_sha256: 'b'.repeat(64), resumed_driver_sha256: 'c'.repeat(64),
    time_module_sha256: 'd'.repeat(64), pause_record_sha256: 'e'.repeat(64), paused_at: new Date(paused).toISOString() };
  const grant: SummaryTimeAuthorization = { schema_version: 'summary-replay-time-resume-1', status: 'authorized',
    extension_id: 'synthetic-explicit-time-only', authorization_id: authorization.id,
    user_confirmation_source: 'SYNTHETIC ONLY; never a paid authorization', approved_at: new Date(resumed).toISOString(),
    user_response: { verbatim: 'SYNTHETIC explicit resume', received_from: 'synthetic test', recorded_at: new Date(resumed).toISOString() },
    paused_at: runtime.paused_at, original_deadline_utc: new Date(start + limits.seconds * 1000).toISOString(),
    resume_at: new Date(resumed).toISOString(), deadline_utc: new Date(resumed + SUMMARY_RESUME_SECONDS * 1000).toISOString(), resume_seconds: SUMMARY_RESUME_SECONDS,
    ledger_anchor: { sha256: sha256(bytes), request_count: original.totals().requests, requests_sha256: sha256(JSON.stringify(original.ledger.requests)),
      experiment_started_at: original.ledger.experiment_started_at!, limits },
    experiment_scope: { ...runtime, jobs: [...SUMMARY_RESUME_JOBS] } };
  let now = resumed;
  return { path, bytes, grant, runtime, original, now: () => now, advance: (ms: number) => { now += ms; },
    open: (value: unknown = grant, chosenRuntime = runtime) => new SummaryTimeBudget(path, endpoint,
      { ...options, runtime: chosenRuntime, timeAuthorizationBytes: JSON.stringify(value) }, () => now) };
}

test('unsigned, widened, changed-runtime or expired time grants fail before any ledger mutation', async () => {
  await fixture(async f => {
    const invalid = [
      { ...f.grant, status: 'awaiting_user_confirmation' }, { ...f.grant, user_response: { ...f.grant.user_response, verbatim: '' } },
      { ...f.grant, resume_seconds: 11521 }, { ...f.grant, authorization_id: 'another-authorization' },
      { ...f.grant, deadline_utc: new Date(resumed + (SUMMARY_RESUME_SECONDS + 1) * 1000).toISOString() },
      { ...f.grant, resume_at: new Date(resumed + 1).toISOString() },
      { ...f.grant, experiment_scope: { ...f.grant.experiment_scope, resumed_driver_sha256: 'f'.repeat(64) } },
      { ...f.grant, experiment_scope: { ...f.grant.experiment_scope, jobs: [...SUMMARY_RESUME_JOBS, 'L01-F'] } },
      { ...f.grant, ledger_anchor: { ...f.grant.ledger_anchor, requests_sha256: 'f'.repeat(64) } },
    ];
    for (const grant of invalid) {
      assert.throws(() => f.open(grant), /summary_resume_/);
      assert.equal(await readFile(f.path, 'utf8'), f.bytes);
    }
    assert.throws(() => f.open(f.grant, { ...f.runtime, jobs: ['L01-F'] }), /outside_authorized_scope/);
    f.advance(SUMMARY_RESUME_SECONDS * 1000);
    assert.throws(() => f.open(), /deadline_invalid_or_expired/);
    assert.equal(await readFile(f.path, 'utf8'), f.bytes);
  });
});

test('explicit absolute deadline preserves original start, limits and requests while truthfully counting pause wall time', async () => {
  await fixture(async f => {
    const budget = f.open(); budget.check();
    assert.ok(budget.totals().elapsed_seconds > f.grant.ledger_anchor.limits.seconds);
    assert.equal(budget.wallClockSeconds * 1000 + start, Date.parse(f.grant.deadline_utc));
    assert.equal(budget.ledger.experiment_started_at, f.original.ledger.experiment_started_at);
    assert.deepEqual(budget.ledger.limits, f.original.ledger.limits);
    assert.deepEqual(budget.ledger.requests, f.original.ledger.requests);
    const audit = JSON.parse(await readFile(f.path, 'utf8')).summary_resume_time_authorization;
    assert.equal(audit.authorization_sha256, sha256(JSON.stringify(f.grant)));
    assert.deepEqual(audit.record, f.grant);
    assert.equal(budget.timeWindowEvidence().deadline_utc, f.grant.deadline_utc);
  });
});

test('reopening and changing groups share the same bound deadline and cannot acquire another resume allowance', async () => {
  await fixture(async f => {
    const budget = f.open(); budget.settle(budget.begin('synthetic', 'synthetic-replay:L01-B0:before', 0, '{}', 1), usage(100, 2));
    f.advance(60_000);
    const same = f.open(f.grant, { ...f.runtime, jobs: ['L05-B0', 'L05-F', 'L05-R'] });
    assert.equal(same.wallClockSeconds, budget.wallClockSeconds);
    assert.equal(same.totals().requests, 2);
    assert.equal(same.totals().input_tokens, 110);
    const bytes = await readFile(f.path, 'utf8');
    const replacement = { ...f.grant, resume_at: new Date(resumed + 60_000).toISOString(),
      deadline_utc: new Date(resumed + 60_000 + SUMMARY_RESUME_SECONDS * 1000).toISOString() };
    assert.throws(() => f.open(replacement), /already_bound/);
    assert.equal(await readFile(f.path, 'utf8'), bytes);
    assert.throws(() => same.begin('synthetic', 'synthetic-replay:L01-F:after', 0, '{}', 1), /purpose_outside_scope/);
    assert.throws(() => same.begin('synthetic', 'unrelated', 0, '{}', 1), /purpose_outside_scope/);
    assert.equal(same.totals().requests, 2);
  });
});

test('time-only resumption keeps cumulative request, input and output reservation caps', async () => {
  for (const limits of [{ ...defaultLimits, requests: 2 }, { ...defaultLimits, input_tokens: 32777 }, { ...defaultLimits, output_tokens: 1 }]) {
    await fixture(async f => {
      const budget = f.open();
      if (limits.requests === 2) {
        const entry = budget.begin('synthetic', 'synthetic-replay:L05-B0:before', 0, '{}', 1);
        assert.throws(() => budget.settle(entry, usage()), /request_limit/);
        assert.equal(budget.totals().requests, 2);
      } else {
        assert.throws(() => budget.begin('synthetic', 'synthetic-replay:L05-B0:before', 0, '{}', 1), /token_limit/);
        assert.equal(budget.totals().requests, 1);
      }
      assert.ok(budget.ledger.halted);
      assert.throws(() => f.open(), /anchor_or_settlement_mismatch/);
    }, limits);
  }
});

test('new absolute deadline bounds the actual guarded transport and expires without resetting history', async t => {
  await fixture(async f => {
    const budget = f.open(), entries: RequestAccounting[] = [];
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('synthetic response'); });
    f.advance(SUMMARY_RESUME_SECONDS * 1000 - 500);
    const guarded = budget.guardedFetch('synthetic', 'synthetic-replay:L05-R:after', 0, entries);
    const result = await guarded(endpoint + '/responses', { method: 'POST', body: JSON.stringify({ model: 'synthetic', stream: true, store: false }) });
    await result.text(); budget.settle(entries[0]!, usage());
    assert.equal(entries[0]!.configured_deadline_ms, 500);
    assert.equal(requests, 1);
    f.advance(500);
    assert.throws(() => budget.check(), /experiment_time_limit/);
    assert.equal(budget.ledger.experiment_started_at, new Date(start).toISOString());
    assert.equal(budget.totals().requests, 2);
  });
});

test('runtime validation rejects a user record that would repay more than the actual original unused time', async () => {
  await fixture(async f => {
    const tooLatePause = new Date(start + defaultLimits.seconds * 1000 - (SUMMARY_RESUME_SECONDS - 1) * 1000).toISOString();
    assert.throws(() => validateSummaryTimeAuthorization({ ...f.grant, paused_at: tooLatePause },
      { ...f.runtime, paused_at: tooLatePause }, resumed), /deadline_invalid_or_expired/);
  });
});
