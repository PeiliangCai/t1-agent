import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { FixtureTools, RunStore, makeFixture } from '@t1/agent';
import { buildApp } from '../../apps/server/src/app.js';

const executeFile = promisify(execFile);
test('session creation failure leaves the already persisted run failed with a terminal event, without API calls', async () => {
  const directory = await mkdtemp(resolve('runtime-data/init-failure-'));
  try {
    await mkdir(join(directory, 'runtime-data'), { recursive: true });
    // ENOTDIR in the first createRestrictedSession mkdir is deterministic and precedes all model setup/network.
    await writeFile(join(directory, 'runtime-data/runs'), 'directory creation failure fixture');
    const result = await executeFile(resolve('.tools/node/bin/node'), [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/smoke-pi.ts')], {
      cwd: directory, env: { ...process.env, T1_MODEL_PROVIDER: 'local-test', T1_MODEL_BASE_URL: 'https://example.invalid/v1', T1_MODEL_ID: 'fake', T1_MODEL_API_KEY: 'local-test-placeholder' },
    }).then(value => ({ ...value, code: 0 }), error => ({ code: error.code, stdout: error.stdout as string, stderr: error.stderr as string }));
    assert.equal(result.code, 1);
    assert.ok(!result.stdout.includes('local-test-placeholder')); assert.ok(!result.stderr.includes('local-test-placeholder'));
    const store = new RunStore(join(directory, 'runtime-data/t1.sqlite'));
    try {
      const row = store.db.prepare('SELECT id,state FROM runs').get()!;
      assert.equal(row.state, 'failed', 'initialization error must not strand a run in extracting');
      const events = store.events(row.id as string); assert.equal(events.at(-1)?.stage, 'failed');
      assert.equal(store.records(row.id as string).length, 0);
    } finally { store.close(); }
    const reports = (await readdir(join(directory, 'docs/acceptance/s1'))).filter(x => x.startsWith('smoke-pi-') && !x.includes('latest'));
    const report = JSON.parse(await readFile(join(directory, 'docs/acceptance/s1', reports[0]!), 'utf8'));
    assert.equal(report.status, 'failed'); assert.ok(!JSON.stringify(report).includes('local-test-placeholder'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP SSE delivers a candidate committed through an independent SQLite connection without reconnecting', async () => {
  const directory = await mkdtemp(resolve('runtime-data/cross-connection-'));
  const filename = join(directory, 'runs.sqlite'); const writer = new RunStore(filename); const readerStore = new RunStore(filename);
  const fixture = makeFixture({ provider: 'local-test', modelId: 'fake', baseUrl: 'https://example.invalid/v1' });
  writer.create(fixture.input); writer.transition(fixture.input.run_id, 'extracting');
  const tools = new FixtureTools(fixture.input, fixture.document, fixture.catalog, writer);
  let activeSubscriptions = 0;
  const onEvent = readerStore.onEvent.bind(readerStore);
  readerStore.onEvent = (runId, callback) => { activeSubscriptions++; const release = onEvent(runId, callback); return () => { activeSubscriptions--; release(); }; };
  const app = buildApp(readerStore); const controller = new AbortController();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/runs/${fixture.input.run_id}/events`, { headers: { 'last-event-id': '1' }, signal: controller.signal });
    const stream = response.body!.getReader(); const decoder = new TextDecoder();
    assert.ok(decoder.decode((await stream.read()).value).includes('id: 2\n'));
    const bound = { run_id: fixture.input.run_id, document_id: fixture.input.document_id };
    await tools.invoke('read_document_blocks', { ...bound, block_ids: ['demo-block-1'] }, 'read');
    await tools.invoke('submit_candidate_records', { ...bound, records: [{ block_id: 'demo-block-1', original_quote: 'The sample shape has a blue rim measuring 7 mm.', feature_binding_id: null }] }, 'submit');
    assert.equal(readerStore.records(fixture.input.run_id).length, 1, 'candidate is committed and visible through the other connection');
    const result = await Promise.race([stream.read().then(chunk => decoder.decode(chunk.value)), new Promise<string>(done => setTimeout(() => done('TIMEOUT_NO_EXTERNAL_EVENT'), 900))]);
    assert.ok(result.includes('event: candidate\n'), `live SSE missed another connection: ${result}`);
    assert.ok(result.includes('id: 3\n')); assert.ok(!result.includes('id: 2\n'));
    writer.event(fixture.input.run_id, 'external_followup', 'extracting', 'committed external followup');
    const followup = decoder.decode((await stream.read()).value); assert.ok(followup.includes('id: 4\n')); assert.ok(!followup.includes('id: 3\n'));
    controller.abort(); await stream.cancel().catch(() => {});
    assert.equal(readerStore.snapshot(fixture.input.run_id).state, 'extracting');
  } finally { controller.abort(); await app.close(); assert.equal(activeSubscriptions, 0); readerStore.close(); writer.close(); await rm(directory, { recursive: true, force: true }); }
});
