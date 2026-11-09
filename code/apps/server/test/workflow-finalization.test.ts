import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtractionStore } from '@t1/agent';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { controlledFixture } from './controlled-fixture.js';

test('terminal engine state remains finalizing until coverage is persisted; cache and download use the final snapshot', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(resolve('runtime-data/s7-finalization-')), store = new ExtractionStore(resolve(directory, 'workflow.sqlite'));
  const replay = await controlledFixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), inFinalization = new Promise<void>(resolve => { entered = resolve; });
  const coverage = { selected_source_block_processing_complete: true, whole_document_summary_complete: false,
    task_processing_complete: false, task_processing_blockers: ['summary_incomplete'], explicit_controlled_runner: true, paid_requests: 0 };
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false, parse: replay.parse, discover: replay.discover,
    runner: { controlled: true, provider: 'controlled-finalization', model_id: 'no-model-call', execute: async context => {
      context.store.transition(context.input.run_id, 'extracting'); context.store.transition(context.input.run_id, 'reconciling');
      context.store.transition(context.input.run_id, 'partial'); entered(); await gate;
      return { coverage, summary: 'Controlled terminal/file-write delay. No model was called.' };
    } } });
  try {
    const paper = (await workflow.upload(await readFile('evaluation/corpus/development-candidates/L05.pdf'), 'controlled-finalization.pdf')).paper;
    const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await inFinalization;
    assert.equal(store.snapshot(id).state, 'partial');
    const early = await workflow.runDetail(id);
    assert.equal(early.run.state, 'reconciling'); assert.equal(early.output.state, 'reconciling');
    assert.equal(early.run.result_ready, false); assert.equal(early.output.result_ready, false); assert.equal(early.output.coverage, undefined);
    let exported = false;
    const pendingExport = workflow.export(id, 'candidate_jsonl').then(value => { exported = true; return value; });
    await delay(25); assert.equal(exported, false, 'terminal export must wait for final coverage rather than emit null');
    const racingRead = workflow.runDetail(id); release(); await workflow.waitForIdle(); await pendingExport;
    const race = await racingRead; if (race.run.result_ready) assert.deepEqual(race.output.coverage, coverage);
    for (let i = 0; i < 2; i++) {
      const final = await workflow.runDetail(id); assert.equal(final.run.state, 'partial'); assert.equal(final.run.result_ready, true);
      assert.equal(final.output.result_ready, true); assert.deepEqual(final.output.coverage, coverage);
    }
    const row = store.db.prepare('SELECT payload_json FROM workbench_exports ORDER BY rowid DESC LIMIT 1').get()!;
    const saved = JSON.parse(await readFile(resolve(JSON.parse(row.payload_json as string).directory, 'coverage.json'), 'utf8'));
    assert.equal(saved.whole_document_summary_complete, false); assert.equal(saved.task_processing_complete, false); assert.equal(saved.result_ready, true);
    assert.equal(workflow.events(id, 0).filter(event => event.type === 'run_result_saved' && event.detail.finalization_complete === true).length, 1);
  } finally { release?.(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
