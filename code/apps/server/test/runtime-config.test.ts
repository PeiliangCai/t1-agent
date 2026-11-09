import test from 'node:test';
import assert from 'node:assert/strict';
import { serverRuntime } from '../src/runtime-config.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, RunStore, ModelConfig } from '@t1/agent';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { configuredWorkflowRunner } from '../src/workflow-runner.js';

test('ordinary defaults are preserved and container data stays inside code root', () => {
  assert.deepEqual(serverRuntime({}, '/app'), { host: '127.0.0.1', port: 3210, directory: '/app/runtime-data', database: '/app/runtime-data/t1.sqlite', workflowDirectory: '/app/runtime-data/workbench', importRetained: true });
  assert.equal(serverRuntime({ T1_DATA_DIR: 'runtime-data/isolated', T1_IMPORT_RETAINED: 'false', T1_SERVER_PORT: '3212' }, '/app').importRetained, false);
  for (const environment of [{ T1_DATA_DIR: '../outside' }, { T1_DATA_DIR: '/app' }, { T1_SERVER_HOST: 'public.example' }, { T1_SERVER_PORT: 'NaN' }, { T1_IMPORT_RETAINED: 'yes' }]) assert.throws(() => serverRuntime(environment, '/app'));
});

test('public model runtime reflects validated operator limits and never includes key, endpoint or paths', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s7-public-runtime-')), extraction = new ExtractionStore(':memory:');
  const runner = configuredWorkflowRunner({ T1_WORKBENCH_MODEL_ENABLED: 'true', T1_MODEL_PROVIDER: 'public-runtime-test',
    T1_MODEL_BASE_URL: 'https://example.invalid/v1', T1_MODEL_ID: 'configured-test-model', T1_MODEL_API_KEY: 'not-a-real-key',
    T1_WORKBENCH_MAX_REQUESTS: '7', T1_WORKBENCH_MAX_INPUT_TOKENS: '12345', T1_WORKBENCH_MAX_OUTPUT_TOKENS: '3456' });
  const workflow = new WorkbenchWorkflow(extraction, { directory, sources: false, runner });
  try {
    const runtime = workflow.capabilities().model_runtime!;
    assert.deepEqual(runtime, { provider: 'public-runtime-test', model_id: 'configured-test-model', reasoning_effort: 'medium',
      limits: { requests: 7, input_tokens: 12345, output_tokens: 3456, execution_seconds: 1800 } });
    assert.equal(/not-a-real-key|example.invalid|runtime-data|endpoint|api_key/u.test(JSON.stringify(runtime)), false);
    assert.equal(workflow.capabilities().extraction_start, true);
  } finally { await workflow.close(); extraction.close(); await rm(directory, { recursive: true, force: true }); }
});

test('runtime health and public model info report capabilities without stage acceptance claims', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s7-runtime-config-'));
  const legacy = new RunStore(), extraction = new ExtractionStore(':memory:');
  const workflow = new WorkbenchWorkflow(extraction, { sources: false, directory });
  const app = buildApp(legacy, undefined, workflow);
  try {
    const health = (await app.inject('/health')).json(), capabilities = (await app.inject('/api/workbench/capabilities')).json();
    assert.equal(health.status, 'ok'); assert.equal(health.runtime_mode, 'workflow'); assert.equal(health.extraction_available, false);
    for (const key of ['stage', 'new_paid_run_verified', 'parser_stage_passed', 'workflow_implemented']) assert.equal(key in health, false);
    assert.equal('full_S5_complete' in capabilities, false); assert.equal(capabilities.paper_upload, true); assert.equal(capabilities.extraction_start, false);
    const config = new ModelConfig('test', 'https://example.invalid/v1', 'test-model', 'private-test-key');
    assert.deepEqual(config.publicInfo(), { provider: 'test', endpoint: 'https://example.invalid/v1', model_id: 'test-model', api_key_present: true });
    assert.equal(JSON.stringify(config).includes('private-test-key'), false);
  } finally { await app.close(); legacy.close(); extraction.close(); await rm(directory, { recursive: true, force: true }); }
});
