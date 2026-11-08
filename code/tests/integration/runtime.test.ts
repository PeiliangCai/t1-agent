import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureTools, RunStore, makeFixture, executeFixture, type SessionLike } from '@t1/agent';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { buildApp } from '../../apps/server/src/app.js';
import { ContractError } from '@t1/contracts';

type Listener = Parameters<SessionLike['subscribe']>[0];
class FakeSession implements SessionLike {
  private listener: Listener = () => {};
  disposed = false; aborted = false;
  constructor(readonly work: (emit: (e: AgentSessionEvent) => void) => Promise<void>) {}
  subscribe(listener: Listener) { this.listener = listener; return () => { this.listener = () => {}; }; }
  async prompt(_text: string) { await this.work(event => this.listener(event)); }
  async abort() { this.aborted = true; }
  dispose() { this.disposed = true; }
}
function context() {
  const fixture = makeFixture({ provider: 'local-test', modelId: 'fake', baseUrl: 'https://example.invalid/v1' });
  const store = new RunStore(); store.create(fixture.input); store.transition(fixture.input.run_id, 'extracting');
  return { ...fixture, store, tools: new FixtureTools(fixture.input, fixture.document, fixture.catalog, store) };
}
test('a settled mock Pi loop requires actual bound read/submission and persists business events', async () => {
  const c = context();
  const session = new FakeSession(async emit => {
    const bound = { run_id: c.input.run_id, document_id: c.input.document_id };
    await c.tools.invoke('read_document_blocks', { ...bound, block_ids: ['demo-block-1'] }, 'read');
    await c.tools.invoke('submit_candidate_records', { ...bound, records: [{ block_id: 'demo-block-1', original_quote: 'The sample shape has a blue rim measuring 7 mm.', feature_binding_id: null }] }, 'submit');
    emit({ type: 'agent_end', messages: [], willRetry: false }); emit({ type: 'agent_settled', aborted: false });
  });
  try { const result = await executeFixture(c.tools, session); assert.equal(result.state, 'completed'); assert.equal(session.disposed, true); assert.equal(result.assistant_requests_observed, 0); assert.equal(result.actual_cost, null); }
  finally { c.store.close(); }
});
test('agent_end alone or a settled zero-read/no-submission run is failed, not completed', async () => {
  for (const settled of [false, true]) {
    const c = context(); const session = new FakeSession(async emit => { emit({ type: 'agent_end', messages: [], willRetry: false }); if (settled) emit({ type: 'agent_settled', aborted: false }); });
    try { const result = await executeFixture(c.tools, session); assert.equal(result.state, 'failed'); assert.equal(session.disposed, true); }
    finally { c.store.close(); }
  }
});
test('a cancelled run releases its session and remains cancelled', async () => {
  const c = context(); const controller = new AbortController(); controller.abort(); const session = new FakeSession(async () => {});
  try { const result = await executeFixture(c.tools, session, controller.signal); assert.equal(result.state, 'cancelled'); assert.equal(session.disposed, true); }
  finally { c.store.close(); }
});
test('runtime errors preserve an existing failed/cancelled terminal state and the original sanitized cause', async () => {
  for (const terminal of ['failed', 'cancelled'] as const) {
    const c = context(); let count = 0;
    const session = new FakeSession(async () => {
      c.store.transition(c.input.run_id, terminal); count = c.store.events(c.input.run_id).length;
      throw new ContractError('injected_runtime_failure');
    });
    try {
      const result = await executeFixture(c.tools, session);
      assert.equal(result.state, terminal); assert.equal(result.error?.code, 'injected_runtime_failure'); assert.equal(session.disposed, true);
      assert.equal(c.store.events(c.input.run_id).length, count);
      assert.equal(c.store.terminateIfRunning(c.input.run_id), terminal); assert.equal(c.store.events(c.input.run_id).length, count);
    } finally { c.store.close(); }
  }
});
test('debug HTTP APIs expose fixture status and reject unknown IDs without model calls', async () => {
  const c = context(); const app = buildApp(c.store);
  try {
    assert.equal((await app.inject('/health')).json().fixture_only, true);
    const response = await app.inject(`/api/runs/${c.input.run_id}`); assert.equal(response.statusCode, 200); assert.equal(response.json().input.fixture, true);
    assert.equal((await app.inject('/api/runs/unknown')).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/documents' })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/runs/${c.input.run_id}/events`, headers: { 'last-event-id': 'not-an-integer' } })).statusCode, 400);
  } finally { await app.close(); c.store.close(); }
});
test('SSE reconnect replays ordered saved events after the cursor; disconnect does not cancel the task', async () => {
  const c = context(); const app = buildApp(c.store); const controller = new AbortController();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/runs/${c.input.run_id}/events`, { headers: { 'last-event-id': '1' }, signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader(); const data = new TextDecoder().decode((await reader.read()).value);
    assert.ok(data.includes('id: 2\n')); assert.ok(!data.includes('id: 1\n')); assert.ok(data.includes(c.input.run_id));
    controller.abort(); await reader.cancel().catch(() => {});
    assert.equal(c.store.snapshot(c.input.run_id).state, 'extracting');
    assert.deepEqual(c.store.events(c.input.run_id).map(e => e.seq), [1, 2]);
  } finally { controller.abort(); await app.close(); c.store.close(); }
});
