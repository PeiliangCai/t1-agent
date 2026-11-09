import Fastify from 'fastify';
import { catalog, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchSources, WORKBENCH_CAPABILITIES } from './workbench.js';
import { MAX_PDF_BYTES, WorkbenchWorkflow, WorkflowConflict, WorkflowCatalogConflict } from './workflow.js';
import type { Scope } from '@t1/contracts';
import type { WorkbenchExportKind, WorkbenchRevisionInput, WorkbenchReviewInput, WorkbenchFigureCheckInput } from '../../../packages/contracts/src/workbench.js';

export function buildApp(store: RunStore, sources = new WorkbenchSources(), workflow?: WorkbenchWorkflow) {
  const app = Fastify({ logger: false, bodyLimit: 32768, forceCloseConnections: true });
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of streams) close(); await workflow?.close(); });
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof ContractError ? error.code : 'request_failed';
    if (error instanceof WorkflowConflict) return reply.code(409).send({ error: code, message: 'This record has a newer saved version. Reload before applying your changes.', current_version: error.current_version });
    if (error instanceof WorkflowCatalogConflict) return reply.code(409).send({ error: code, message: 'The Figure catalog has a newer version. Reload before confirming.', current_catalog_sha256: error.current_catalog_sha256 });
    if ((error as { statusCode?: number }).statusCode === 413 || code === 'pdf_size_out_of_bounds') return reply.code(413).send({ error: 'pdf_size_out_of_bounds' });
    return reply.code(code === 'run_not_found' || code.endsWith('_not_found') || code === 'workbench_figure_not_available' ? 404 : 400).send({ error: code });
  });
  app.get('/health', async () => workflow ? { status: 'ok', stage: 'S5', workflow_implemented: true, controlled_fixture: workflow.capabilities().controlled_fixture, new_paid_run_verified: false } : ({ status: 'ok', stage: 'S1', fixture_only: true,
    real_pdf_parser: 'local_cli_implemented_http_not_connected', parser_engineering_stage: 'S3', parser_stage_passed: false }));
  app.get('/api/catalog', async () => catalog);
  app.get('/api/workbench/capabilities', async () => workflow?.capabilities() ?? WORKBENCH_CAPABILITIES);
  app.get('/api/workbench/papers', async () => ({ papers: await (workflow ?? sources).papers() }));
  app.get('/api/workbench/runs', async () => workflow ? { runs: await workflow.runs() } : ({ runs: store.db.prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 100').all().map(row => {
    const value = store.snapshot(row.id as string);
    return { run_id: value.input.run_id, document_id: value.input.document_id, state: value.state,
      fixture: value.fixture, candidate_count: value.candidate_count };
  }) }));
  app.get<{ Params: { paperId: string } }>('/api/workbench/papers/:paperId', async request => (workflow ?? sources).detail(request.params.paperId));
  app.get<{ Params: { paperId: string } }>('/api/workbench/papers/:paperId/pdf', async (request, reply) =>
    reply.type('application/pdf').header('x-content-type-options', 'nosniff').send(await (workflow ?? sources).pdf(request.params.paperId)));
  app.get<{ Params: { paperId: string; assetId: string } }>('/api/workbench/papers/:paperId/figures/:assetId', async (request, reply) =>
    reply.type('image/png').header('x-content-type-options', 'nosniff').send(await (workflow ?? sources).figure(request.params.paperId, request.params.assetId)));
  if (workflow) {
    app.addHook('onReady', () => workflow.initialize());
    app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: MAX_PDF_BYTES }, (_request, body, done) => done(null, body));
    app.get('/api/workbench/catalog', async () => workflow.scopeCatalog());
    const decoded = (value: string | string[] | undefined) => { if (typeof value !== 'string') return undefined; try { return decodeURIComponent(value); } catch { throw new ContractError('invalid_upload_header'); } };
    app.post('/api/workbench/papers', { bodyLimit: MAX_PDF_BYTES }, async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) throw new ContractError('application_pdf_required');
      return reply.code(201).send(await workflow.upload(request.body, decoded(request.headers['x-t1-filename']) ?? 'paper.pdf', decoded(request.headers['x-t1-title'])));
    });
    app.put<{ Params: { paperId: string } }>('/api/workbench/papers/:paperId/pdf', { bodyLimit: MAX_PDF_BYTES }, async request => {
      if (!Buffer.isBuffer(request.body)) throw new ContractError('application_pdf_required'); return workflow.restorePdf(request.params.paperId, request.body);
    });
    app.delete<{ Params: { paperId: string } }>('/api/workbench/papers/:paperId', async request => workflow.deletePaper(request.params.paperId));
    app.post<{ Params: { paperId: string }; Body: { scope: Scope } }>('/api/workbench/papers/:paperId/runs', async (request, reply) => {
      if (!request.body || Object.keys(request.body).some(k => k !== 'scope')) throw new ContractError('immutable_server_run_configuration');
      return reply.code(202).send(await workflow.start(request.params.paperId, request.body.scope));
    });
    app.get<{ Params: { runId: string } }>('/api/workbench/runs/:runId', async request => workflow.runDetail(request.params.runId));
    app.get<{ Params: { runId: string; assetId: string } }>('/api/workbench/runs/:runId/figures/:assetId', async (request, reply) =>
      reply.type('image/png').header('x-content-type-options', 'nosniff').send(await workflow.runFigure(request.params.runId, request.params.assetId)));
    app.post<{ Params: { runId: string; figureId: string }; Body: WorkbenchFigureCheckInput }>('/api/workbench/runs/:runId/figures/:figureId/verify', async request =>
      workflow.verifyFigure(request.params.runId, request.params.figureId, request.body));
    app.post<{ Params: { runId: string } }>('/api/workbench/runs/:runId/cancel', async request => workflow.cancel(request.params.runId));
    app.post<{ Params: { runId: string }; Body: WorkbenchRevisionInput }>('/api/workbench/runs/:runId/records', async request => workflow.revise(request.params.runId, undefined, request.body));
    app.patch<{ Params: { runId: string; recordId: string }; Body: WorkbenchRevisionInput }>('/api/workbench/runs/:runId/records/:recordId', async request => workflow.revise(request.params.runId, request.params.recordId, request.body));
    app.delete<{ Params: { runId: string; recordId: string }; Body: WorkbenchRevisionInput }>('/api/workbench/runs/:runId/records/:recordId', async request => workflow.deleteRecord(request.params.runId, request.params.recordId, request.body));
    app.post<{ Params: { runId: string; recordId: string }; Body: WorkbenchReviewInput }>('/api/workbench/runs/:runId/records/:recordId/review', async request => workflow.reviewRecord(request.params.runId, request.params.recordId, request.body));
    app.get<{ Params: { runId: string; kind: WorkbenchExportKind } }>('/api/workbench/runs/:runId/exports/:kind', async (request, reply) => {
      const output = await workflow.export(request.params.runId, request.params.kind); return reply.type(output.type).header('content-disposition', `attachment; filename="${output.filename}"`).header('x-content-type-options', 'nosniff').send(output.bytes);
    });
    app.get<{ Params: { runId: string }; Querystring: { after?: string } }>('/api/workbench/runs/:runId/events', async (request, reply) => {
      const raw = request.headers['last-event-id'] ?? request.query.after ?? '0';
      if (typeof raw !== 'string' || !/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ContractError('invalid_event_cursor');
      const id = request.params.runId; workflow.events(id); let cursor = Number(raw), closed = false;
      reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' }); reply.raw.flushHeaders();
      const flush = () => { if (closed) return; try { for (const event of workflow.events(id, cursor)) { reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.seq; } } catch { close(); } };
      const poll = setInterval(flush, 200), heartbeat = setInterval(() => { if (!closed) reply.raw.write(': keepalive\n\n'); }, 15000);
      function close() { if (closed) return; closed = true; clearInterval(poll); clearInterval(heartbeat); streams.delete(close); reply.raw.end(); }
      streams.add(close); reply.raw.on('close', close); flush();
    });
  }
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
