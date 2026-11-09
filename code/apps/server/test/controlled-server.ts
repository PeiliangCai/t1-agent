import { resolve } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';

// Explicit test entrypoint; production main.ts never imports this controlled runner.
const directory = resolve('runtime-data/s5-controlled-browser');
const legacy = new RunStore(resolve(directory, 'legacy.sqlite'));
const store = new ExtractionStore(resolve(directory, 'workflow.sqlite'));
const workflow = new WorkbenchWorkflow(store, { directory, ...await controlledFixture({ delayMs: 12000 }) });
const app = buildApp(legacy, undefined, workflow);
await app.listen({ host: '127.0.0.1', port: 3210 });
console.log('Controlled S5 backend on 127.0.0.1:3210; saved-source replay, no provider calls.');
const close = async () => { await app.close(); legacy.close(); store.close(); };
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
