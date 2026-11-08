import { createServer } from 'node:http';
import { once } from 'node:events';
import { ModelConfig } from '../../../packages/agent/src/config.js';

export interface ScriptedToolCall { name: string; arguments: unknown }
export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}
export interface ResponsesRequest {
  index: number;
  body: Record<string, unknown>;
  registered_tools: string[];
  tool_results: Array<{ call_id: string; output: string }>;
}
export type ResponsesStep = {
  text?: string;
  calls?: ScriptedToolCall[];
  usage?: ResponsesUsage | null;
  status?: number;
  incomplete?: boolean;
  hold?: boolean;
  stall_after_headers?: boolean;
};

const normalUsage: ResponsesUsage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };

/** Synthetic Responses SSE served on loopback. Runs the installed Pi SDK without any paid API. */
export async function createRuntimeResponsesFixture(
  steps: ResponsesStep[] | ((request: ResponsesRequest) => ResponsesStep),
) {
  const requests: ResponsesRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end(); return;
      }
      let payload = '';
      for await (const chunk of request) {
        payload += chunk.toString();
        if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new Error('fixture_request_too_large');
      }
      const body = JSON.parse(payload) as Record<string, unknown>;
      const input = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
      const tools = Array.isArray(body.tools) ? body.tools as Array<{ name?: string }> : [];
      const observation: ResponsesRequest = { index: requests.length, body,
        registered_tools: tools.flatMap(t => typeof t.name === 'string' ? [t.name] : []).sort(),
        tool_results: input.filter(i => i.type === 'function_call_output').map(i => ({ call_id: String(i.call_id), output: String(i.output) })) };
      requests.push(observation);
      const step = typeof steps === 'function' ? steps(observation) : steps[observation.index];
      if (!step || body.stream !== true) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'unscripted_fixture_request' } }));
        return;
      }
      if (step.hold) return;
      if (step.status && step.status !== 200) {
        response.writeHead(step.status, { 'content-type': 'application/json', 'x-request-id': `fixture-error-${observation.index}` });
        response.end(JSON.stringify({ error: { message: 'synthetic local failure', type: 'fixture_failure', code: 'fixture_failure' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
        'x-request-id': `fixture-request-${observation.index}` });
      response.flushHeaders();
      if (step.stall_after_headers) return;
      let sequence = 0;
      const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
      const id = `resp-fixture-${observation.index}`;
      send({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } });
      const output: Array<Record<string, unknown>> = [];
      for (const [index, call] of (step.calls ?? []).entries()) {
        const args = JSON.stringify(call.arguments);
        const item = { id: `fc-fixture-${observation.index}-${index}`, type: 'function_call',
          call_id: `call-fixture-${observation.index}-${index}`, name: call.name, arguments: args, status: 'completed' };
        send({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' } });
        send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: args });
        send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: args });
        send({ type: 'response.output_item.done', output_index: index, item });
        output.push(item);
      }
      if (step.text !== undefined) {
        const index = output.length;
        const item = { id: `msg-fixture-${observation.index}`, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: step.text, annotations: [] }] };
        send({ type: 'response.output_item.added', output_index: index, item: { ...item, content: [], status: 'in_progress' } });
        send({ type: 'response.output_text.delta', output_index: index, item_id: item.id, content_index: 0, delta: step.text });
        send({ type: 'response.output_item.done', output_index: index, item });
        output.push(item);
      }
      send({ type: step.incomplete ? 'response.incomplete' : 'response.completed', response: {
        id, object: 'response', model: body.model, status: step.incomplete ? 'incomplete' : 'completed', output,
        ...(step.incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        ...(step.usage === null ? {} : { usage: step.usage ?? normalUsage }),
      } });
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'synthetic_fixture_failure' } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_not_bound');
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  return { endpoint, requests,
    config: new ModelConfig('s4-runtime-fixture', endpoint, 's4-synthetic-responses', 'local-placeholder-not-a-secret'),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}
