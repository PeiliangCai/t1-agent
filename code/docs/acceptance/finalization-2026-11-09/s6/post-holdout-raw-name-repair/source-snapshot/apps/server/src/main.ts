import { mkdir } from 'node:fs/promises';
import { RunStore, ExtractionStore } from '@t1/agent';
import { buildApp } from './app.js';
import { WorkbenchWorkflow } from './workflow.js';
import { configuredWorkflowRunner } from './workflow-runner.js';
import { configuredEvidenceCatalog } from './catalog-config.js';
import { serverRuntime } from './runtime-config.js';

const runtime = serverRuntime();
await mkdir(runtime.directory, { recursive: true, mode: 0o700 });
const store = new RunStore(runtime.database);
const extractionStore = new ExtractionStore(runtime.database);
const workflow = new WorkbenchWorkflow(extractionStore, { directory: runtime.workflowDirectory, catalog: configuredEvidenceCatalog(), ...(runtime.importRetained ? {} : { sources: false }), runner: configuredWorkflowRunner() });
const app = buildApp(store, undefined, workflow);
await app.listen({ host: runtime.host, port: runtime.port });
console.log(`T1 workbench listening on ${runtime.host}:${runtime.port}; retained import=${runtime.importRetained}`);
const shutdown = async () => { await app.close(); store.close(); extractionStore.close(); };
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
