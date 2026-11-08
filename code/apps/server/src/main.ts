import { resolve } from 'node:path';
import { RunStore } from '@t1/agent';
import { buildApp } from './app.js';

const store = new RunStore(resolve('runtime-data/t1.sqlite'));
const app = buildApp(store);
await app.listen({ host: '127.0.0.1', port: 3210 });
console.log('T1 S1 fixture inspector: http://127.0.0.1:3210');
const shutdown = async () => { await app.close(); store.close(); };
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
