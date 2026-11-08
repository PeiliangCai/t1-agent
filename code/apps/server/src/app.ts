import Fastify from 'fastify';
import { catalog, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchSources, WORKBENCH_CAPABILITIES } from './workbench.js';

export function buildApp(store: RunStore, sources = new WorkbenchSources()) {
  const app = Fastify({ logger: false, bodyLimit: 32768 });
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of streams) close(); });
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof ContractError ? error.code : 'request_failed';
    return reply.code(code === 'run_not_found' || code.endsWith('_not_found') || code === 'workbench_figure_not_available' ? 404 : 400).send({ error: code });
  });
  app.get('/health', async () => ({ status: 'ok', stage: 'S1', fixture_only: true,
    real_pdf_parser: 'local_cli_implemented_http_not_connected', parser_engineering_stage: 'S3', parser_stage_passed: false }));
  app.get('/api/catalog', async () => catalog);
  app.get('/api/workbench/capabilities', async () => WORKBENCH_CAPABILITIES);
  app.get('/api/workbench/papers', async () => ({ papers: await sources.papers() }));
  app.get('/api/workbench/runs', async () => ({ runs: store.db.prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 100').all().map(row => {
    const value = store.snapshot(row.id as string);
    return { run_id: value.input.run_id, document_id: value.input.document_id, state: value.state,
      fixture: value.fixture, candidate_count: value.candidate_count };
  }) }));
  app.get<{ Params: { paperId: string } }>('/api/workbench/papers/:paperId', async request => sources.detail(request.params.paperId));
  app.get<{ Params: { paperId: string } }>('/api/workbench/papers/:paperId/pdf', async (request, reply) =>
    reply.type('application/pdf').header('x-content-type-options', 'nosniff').send(await sources.pdf(request.params.paperId)));
  app.get<{ Params: { paperId: string; assetId: string } }>('/api/workbench/papers/:paperId/figures/:assetId', async (request, reply) =>
    reply.type('image/png').header('x-content-type-options', 'nosniff').send(await sources.figure(request.params.paperId, request.params.assetId)));
  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async request => store.snapshot(request.params.runId));
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/records', async request => ({ fixture_only: true, records: store.records(store.snapshot(request.params.runId).input.run_id) }));
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/events', async (request, reply) => {
    const { runId } = request.params; store.snapshot(runId);
    const raw = request.headers['last-event-id'];
    if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) throw new ContractError('invalid_event_cursor');
    let cursor = Number(raw ?? 0);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    reply.raw.flushHeaders();
    let closed = false;
    const write = (event: ReturnType<RunStore['events']>[number]) => {
      if (closed || event.seq <= cursor) return;
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.seq;
    };
    // SQLite is the event authority; a local emitter alone cannot observe the CLI's separate connection/process.
    const flushCommitted = () => {
      if (closed) return;
      try { store.events(runId, cursor).forEach(write); } catch { close(); }
    };
    const unsubscribe = store.onEvent(runId, flushCommitted);
    const poll = setInterval(flushCommitted, 200);
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
    function close() {
      if (closed) return;
      closed = true; clearInterval(poll); clearInterval(heartbeat); unsubscribe(); streams.delete(close); reply.raw.end();
    }
    streams.add(close);
    reply.raw.on('close', close);
    flushCommitted();
  });
  return app;
}
