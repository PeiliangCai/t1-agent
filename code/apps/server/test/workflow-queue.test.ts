import test from 'node:test';
import assert from 'node:assert/strict';
import { backup } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtractionStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow, type WorkflowOptions } from '../src/workflow.js';

// Queue engineering only: the parser is a controlled gate, not a PDF/medical quality probe.
const PDF = Buffer.from('%PDF-1.4\n% ENGINEERING QUEUE STUB\n%%EOF\n');
async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await condition()) return; await delay(10); }
  throw new Error('queue_fixture_timeout');
}
function gatedOptions() {
  const started: string[] = [], release = new Map<string, () => void>(); let running = 0, peak = 0;
  const options: WorkflowOptions = { sources: false, runner: { controlled: true, provider: 'queue-gate', model_id: 'no-model', execute: async () => { throw new Error('queue gate must not invoke a model'); } },
    parse: async (input, _path, _directory, signal) => {
      started.push(input.run_id); running++; peak = Math.max(peak, running);
      return new Promise((_resolve, reject) => {
        let ended = false;
        const finish = () => { if (ended) return; ended = true; running--; release.delete(input.run_id); signal.removeEventListener('abort', finish); reject(new ContractError('queue_engineering_gate_finished')); };
        release.set(input.run_id, finish); signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
      });
    } };
  return { options, started, release, peak: () => peak, running: () => running };
}

test('two independent slots keep FIFO waiting durable, cancel queued work without parsing, release and cancel one slot independently', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s7-queue-')), store = new ExtractionStore(resolve(directory, 'queue.sqlite')), gate = gatedOptions();
  const workflow = new WorkbenchWorkflow(store, { ...gate.options, directory });
  try {
    const paper = (await workflow.upload(PDF, 'queue-engineering.pdf')).paper;
    const start = async () => (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id;
    const a = await start(), b = await start(), c = await start(), d = await start();
    await until(() => gate.started.length === 2);
    assert.equal(store.snapshot(c).state, 'queued'); assert.equal(store.snapshot(d).state, 'queued'); assert.equal(gate.running(), 2);
    assert.equal((await workflow.runs(c))[0]!.execution_started_at, undefined);
    await workflow.cancel(c); assert.equal(store.snapshot(c).state, 'cancelled'); assert.equal(gate.started.includes(c), false);
    await delay(30); gate.release.get(a)!();
    await until(() => gate.started.includes(d));
    assert.deepEqual(gate.started, [a, b, d]); assert.equal(gate.peak(), 2); assert.equal(store.snapshot(b).state, 'parsing');
    const executing = (await workflow.runs(d))[0]!; assert.ok(executing.execution_started_at); assert.ok(executing.queue_wait_ms! >= 20);
    await workflow.cancel(d); await until(() => gate.running() === 1); assert.equal(store.snapshot(b).state, 'parsing');
    await workflow.cancel(b); await workflow.waitForIdle(); assert.equal(gate.running(), 0);
    assert.equal(workflow.capabilities().max_concurrent_runs, 2);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('each execution slot gets its full parse/model clock and waiting does not consume the queued run allowance', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s7-slot-clock-')), store = new ExtractionStore(resolve(directory, 'queue.sqlite')), gate = gatedOptions();
  const workflow = new WorkbenchWorkflow(store, { ...gate.options, directory, runTimeoutMs: 400 });
  try {
    const paper = (await workflow.upload(PDF, 'clock-engineering.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const a = (await workflow.start(paper.id, scope)).run.run_id, b = (await workflow.start(paper.id, scope)).run.run_id, c = (await workflow.start(paper.id, scope)).run.run_id;
    await until(() => gate.started.includes(c));
    const slot = (await workflow.runs(c))[0]!;
    assert.equal(store.snapshot(a).state, 'failed'); assert.equal(store.snapshot(b).state, 'failed'); assert.equal(store.snapshot(c).state, 'parsing');
    assert.ok(slot.queue_wait_ms! >= 250); assert.equal(Date.parse(slot.runtime_deadline!) - Date.parse(slot.execution_started_at!), 400);
    await workflow.waitForIdle(); assert.equal(store.snapshot(c).state, 'failed');
    assert.ok(workflow.events(c, 0).some(event => event.type === 'run_deadline' && event.detail.queue_wait_excluded === true));
    assert.equal(gate.peak(), 2);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a consistent restart image of running and queued jobs preserves them as interrupted and never starts them automatically', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s7-queue-restart-')), store = new ExtractionStore(resolve(directory, 'queue.sqlite')), gate = gatedOptions();
  const workflow = new WorkbenchWorkflow(store, { ...gate.options, directory });
  let restored: ExtractionStore | undefined, restarted: WorkbenchWorkflow | undefined;
  try {
    const paper = (await workflow.upload(PDF, 'restart-engineering.pdf')).paper, scope = workflow.scopeCatalog().default_scope;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await workflow.start(paper.id, scope)).run.run_id);
    await until(() => gate.started.length === 2); assert.equal(store.snapshot(ids[2]!).state, 'queued');
    const snapshotPath = resolve(directory, 'crash-snapshot.sqlite'); await backup(store.db, snapshotPath);
    await workflow.close(); store.close();
    restored = new ExtractionStore(snapshotPath); const after = gatedOptions(); restarted = new WorkbenchWorkflow(restored, { ...after.options, directory });
    await restarted.initialize();
    for (const id of ids) assert.equal(restored.snapshot(id).state, 'interrupted');
    await delay(30); assert.equal(after.started.length, 0);
    const next = (await restarted.start(paper.id, scope)).run.run_id;
    await until(() => after.started.includes(next)); assert.ok(!ids.includes(next));
    for (const id of ids) assert.equal(restored.snapshot(id).state, 'interrupted');
    await restarted.cancel(next); await restarted.waitForIdle();
  } finally { await workflow.close(); if (!restored) store.close(); await restarted?.close(); restored?.close(); await rm(directory, { recursive: true, force: true }); }
});
