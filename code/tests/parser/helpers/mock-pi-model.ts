import { createServer } from 'node:http';
import { once } from 'node:events';
import { ModelConfig } from '@t1/agent';

export interface MockCall { name: string; arguments: unknown }
export type MockStep = MockCall[] | string;
export interface ContextGuardObservation { document_id: string; fixture: boolean; native_association_conflicts: number;
  rejected_caption_relationships: number; unusable_structures: number }
/** Scripted loopback responses only. This executes the actual Pi SDK, with no paid model or document upload. */
export async function createLoopbackMockModel(steps: MockStep[]) {
  const requests: Array<{ index: number; registered_tools: string[]; tool_result_count: number;
    context_guard_observations: ContextGuardObservation[] }> = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end(); return;
      }
      let text = '';
      for await (const chunk of request) {
        text += chunk.toString();
        if (text.length > 32 * 1024 * 1024) throw new Error('mock_request_too_large');
      }
      const body = JSON.parse(text) as { model: string; stream: boolean; tools?: Array<{ function: { name: string } }>;
        messages?: Array<{ role: string; content?: unknown }> };
      const index = requests.length;
      const observations: ContextGuardObservation[] = [];
      for (const message of body.messages ?? []) {
        if (message.role !== 'tool' || typeof message.content !== 'string') continue;
        try {
          const data = JSON.parse(message.content) as { document_id?: string; fixture?: boolean; structure?: {
            tables?: Array<{ association_status?: string; caption_relationships?: Array<{ project_status: string }>; usable_for_semantic_interpretation?: boolean }>;
            pictures?: Array<{ association_status?: string; caption_relationships?: Array<{ project_status: string }>; usable_for_semantic_interpretation?: boolean }> } };
          if (!data.structure || !Array.isArray(data.structure.tables) || !Array.isArray(data.structure.pictures)) continue;
          const structures = [...data.structure.tables, ...data.structure.pictures];
          observations.push({ document_id: data.document_id ?? '', fixture: data.fixture === true,
            native_association_conflicts: structures.filter(s => s.association_status === 'conflict').length,
            rejected_caption_relationships: structures.flatMap(s => s.caption_relationships ?? []).filter(r => r.project_status === 'rejected_conflict').length,
            unusable_structures: structures.filter(s => s.usable_for_semantic_interpretation === false).length });
        } catch { /* Expected rejected tool results may be non-JSON error strings. Never retain their bodies. */ }
      }
      requests.push({ index, registered_tools: (body.tools ?? []).map(t => t.function.name).sort(),
        tool_result_count: (body.messages ?? []).filter(m => m.role === 'tool').length, context_guard_observations: observations });
      const step = steps[index];
      if (step === undefined || !body.stream) { response.writeHead(400).end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const base = { id: `local-scripted-${index}`, object: 'chat.completion.chunk', created: 0, model: body.model };
      const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      send({ ...base, choices: [{ index: 0, delta: typeof step === 'string' ? { role: 'assistant', content: step } : {
        role: 'assistant', tool_calls: step.map((call, toolIndex) => ({ index: toolIndex, id: `call-${index}-${toolIndex}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: typeof step === 'string' ? 'stop' : 'tool_calls' }] });
      send({ ...base, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      response.end('data: [DONE]\n\n');
    } catch { response.writeHead(400).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock_server_not_bound');
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  return { config: new ModelConfig('s3-local-scripted', endpoint, 's3-scripted-no-llm', 'local-placeholder-not-a-secret'), requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
