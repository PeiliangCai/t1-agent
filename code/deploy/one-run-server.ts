import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, RunStore, createConfiguredPdfParserAdapter, discoverPdfFigures, loadModelConfig } from '@t1/agent';
import { buildApp } from '../apps/server/src/app.js';
import { serverRuntime } from '../apps/server/src/runtime-config.js';
import { WorkbenchWorkflow } from '../apps/server/src/workflow.js';
import { executeWorkbenchExtraction } from '../apps/server/src/workflow-runner.js';
import { ContainerOneRunAllowance, type ContainerRunPlan } from './one-run-allowance.js';

// Separate, bounded operator verification entrypoint. Product main.ts never imports it.
// Private key is read from a read-only secret file, absent from image and Docker Config.Env.
const bytes = await readFile('/run/t1-verification/plan.json'), plan = JSON.parse(bytes.toString()) as ContainerRunPlan;
const planSha = createHash('sha256').update(bytes).digest('hex'), runtime = serverRuntime();
const config = loadModelConfig('/run/secrets/t1-model.env', { T1_MODEL_PROVIDER: plan.model.provider, T1_MODEL_BASE_URL: plan.model.endpoint, T1_MODEL_ID: plan.model.model_id });
await mkdir(runtime.directory, { recursive: true, mode: 0o700 });
const store = new ExtractionStore(runtime.database), legacy = new RunStore(runtime.database);
const allowance = new ContainerOneRunAllowance(plan, planSha, config, process.cwd(), runtime.directory);
const workflow = new WorkbenchWorkflow(store, { directory: runtime.workflowDirectory, sources: false,
  runner: { controlled: false, provider: config.provider, model_id: config.modelId, public_runtime: { provider: config.provider, model_id: config.modelId, reasoning_effort: plan.model.reasoning_effort, limits: { requests: plan.limits.requests, input_tokens: plan.limits.input_tokens, output_tokens: plan.limits.output_tokens, execution_seconds: plan.limits.seconds } }, available: allowance.available, prepare: allowance.prepare,
    execute: async context => {
      allowance.bindSource(resolve(runtime.workflowDirectory, 'pdf', plan.input.sha256 + '.pdf'), resolve(context.directory, 'document-ir.json'));
      store.event(context.input.run_id, 's7_deployment_verification', { plan_id: plan.plan_id, plan_sha256: planSha, business_approval_added: false });
      try { return await executeWorkbenchExtraction({ ...context, signal: allowance.signal(context.signal) }, config, allowance.budget!, allowance.remainingMs(), true); }
      finally { allowance.close('single_container_run_finished_unused_allowance_closed'); }
    } },
  parse: (input, file, directory, signal) => createConfiguredPdfParserAdapter({ logDirectory: directory, timeoutMs: Math.min(600_000, allowance.remainingMs()) }).parse({ run_id: input.run_id, document_id: input.document_id, file_reference: file, file_sha256: input.file_sha256, fixture: false }, allowance.signal(signal)),
  discover: (document, directory, signal) => discoverPdfFigures(document, directory, allowance.signal(signal ?? new AbortController().signal)),
});
const app = buildApp(legacy, undefined, workflow);
await app.listen({ host: runtime.host, port: runtime.port });
console.log('S7 bounded one-container verification ready; one pinned upload/run only; no approval added.');
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const watch = setInterval(() => { if (allowance.admittedRunId && terminal.has(store.snapshot(allowance.admittedRunId).state)) allowance.close('terminal'); }, 1000);
watch.unref();
const close = async () => { clearInterval(watch); allowance.close('container_server_closed'); await app.close(); legacy.close(); store.close(); };
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
