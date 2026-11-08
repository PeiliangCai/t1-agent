import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Usage } from '@earendil-works/pi-ai';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { createExtractionSession, developmentProfile, promptExtractionSession } from '../../packages/agent/src/extraction-pi.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';

const usage: Usage = { input: 70, output: 30, cacheRead: 20, cacheWrite: 10, reasoning: 12, totalTokens: 130,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
async function temporary<T>(body: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 't1-response-identity-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('literal mismatch preserves every raw observation and usage, and the halt survives later matching events and reopen', async () => {
  await temporary(async directory => {
    const path = join(directory, 'ledger.json'), budget = new ExtractionBudget(path, 'http://127.0.0.1:1/v1');
    const entry = budget.begin('gpt-6-luna', 'synthetic-not-paid', 0, '{}', 100);
    budget.observeResponseModel(entry, undefined, 'response.created');
    assert.equal(entry.response_model_identity_status, 'unknown');
    budget.observeResponseModel(entry, 'gpt-6-luna', 'response.in_progress');
    budget.observeResponseModel(entry, 'igpt-6-luna', 'response.completed');
    budget.observeResponseModel(entry, 'gpt-6-luna', 'response.completed');
    assert.equal(entry.provider_response_model, 'gpt-6-luna');
    assert.equal(entry.response_model_identity_status, 'mismatch');
    assert.equal(budget.ledger.halted, 'response_model_identity_mismatch');
    assert.deepEqual(entry.response_model_observations!.map(o => o.actual_model), [undefined, 'gpt-6-luna', 'igpt-6-luna', 'gpt-6-luna']);
    assert.ok(entry.response_model_observations!.every(o => o.source === 'provider_stream_event.response.model'));
    assert.throws(() => budget.settle(entry, usage), /response_model_identity_mismatch/);
    assert.equal(entry.usage_status, 'provider_reported');
    assert.equal(entry.input_tokens, 100); assert.equal(entry.output_tokens, 30); assert.equal(entry.reasoning_tokens, 12);
    assert.ok(entry.finished_at);
    const reopened = new ExtractionBudget(path, budget.endpoint);
    assert.throws(() => reopened.begin('gpt-6-luna', 'must-not-send-next', 0, '{}', 100), /response_model_identity_mismatch/);
    assert.equal(reopened.totals().requests, 1);
    assert.equal(reopened.ledger.requests[0]!.response_model_observations![2]!.actual_model, 'igpt-6-luna');
  });
});

test('an absent model name stays unknown, never counts as a matched model or authenticated weights', async () => {
  await temporary(async directory => {
    const budget = new ExtractionBudget(join(directory, 'ledger.json'), 'http://127.0.0.1:1/v1');
    const entry = budget.begin('gpt-6-luna', 'synthetic-not-paid', 0, '{}', 100);
    for (const missing of [undefined, null, 7, {}]) budget.observeResponseModel(entry, missing, 'response.created');
    budget.settle(entry, usage);
    assert.equal(entry.response_model_identity_status, 'unknown');
    assert.equal(entry.provider_response_model, undefined);
    assert.equal(budget.ledger.halted, null);
    assert.equal(entry.response_model_identity_evidence_scope, 'provider_reported_name_only_not_weight_identity_or_HTTP_body_replay');
  });
});

test('a normal local SSE preserves the provider name verbatim and allows a matching session to finish', async () => {
  await temporary(async directory => {
    const server = await createRuntimeResponsesFixture([{ text: 'Synthetic fixture only.' }]);
    try {
      const budget = new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint);
      const created = await createExtractionSession(server.config, developmentProfile(server.config.modelId), [], directory, budget, 'matching-local-SSE');
      const result = await promptExtractionSession(created, 'Synthetic local fixture only.', budget);
      assert.equal(result.error, undefined);
      assert.equal(result.settled, true); assert.equal(server.requests.length, 1);
      assert.equal(budget.ledger.requests[0]!.provider_response_model, server.config.modelId);
      assert.equal(budget.ledger.requests[0]!.response_model_identity_status, 'matched');
      assert.equal(budget.ledger.halted, null);
    } finally { await server.close(); }
  });
});

test('a mismatch on the final SSE response fails even when the session otherwise settled with no next request', async () => {
  await temporary(async directory => {
    const rawModel = 'igpt-6-luna';
    const server = await createRuntimeResponsesFixture([{ text: 'Synthetic fixture only.', response_model: rawModel,
      usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 17 } } }]);
    try {
      const budget = new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint);
      const created = await createExtractionSession(server.config, developmentProfile(server.config.modelId), [], directory, budget, 'last-response-local-SSE');
      const result = await promptExtractionSession(created, 'Synthetic local fixture only.', budget);
      assert.equal(result.settled, true);
      assert.equal(result.error?.code, 'response_model_identity_mismatch');
      assert.equal(result.transient_error, false);
      assert.equal(server.requests.length, 1);
      const entry = budget.ledger.requests[0]!;
      assert.equal(entry.provider_response_model, rawModel);
      assert.equal(entry.response_model_identity_status, 'mismatch');
      assert.equal(entry.usage_status, 'provider_reported');
      assert.equal(entry.input_tokens, 120); assert.equal(entry.cache_read_tokens, 20);
      assert.equal(entry.output_tokens, 40); assert.equal(entry.reasoning_tokens, 17);
      assert.equal(entry.response_hash_scope, 'complete_decoded_HTTP_body');
      assert.equal(entry.response_model_observations!.at(-1)!.event_type, 'response.completed');
      const next = await createExtractionSession(server.config, developmentProfile(server.config.modelId), [], join(directory, 'next'), budget, 'must-not-send-next-session');
      const stopped = await promptExtractionSession(next, 'Must not reach HTTP.', budget);
      assert.equal(stopped.error?.code, 'response_model_identity_mismatch');
      assert.equal(next.entries.length, 0); assert.equal(server.requests.length, 1);
    } finally { await server.close(); }
  });
});

test('a tool-complete response with an unapproved name cannot make a paper condition pass or launch summary/next paper', async () => {
  await temporary(async directory => {
    const server = await createRuntimeResponsesFixture([{ response_model: 'igpt-6-luna', calls: [
      { name: 'read_document_blocks', arguments: {} },
      { name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } },
    ] }]);
    const store = new ExtractionStore(':memory:');
    try {
      const budget = new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint);
      for (const n of [1, 2]) {
        const f = makeEvidenceFixture(['Synthetic imaging statement.'], { runId: 'identity-run-' + n, documentId: 'identity-document-' + n });
        f.input.runtime_profile = { ...f.input.runtime_profile, provider: server.config.provider, model_id: server.config.modelId, endpoint: server.endpoint };
        const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
          profile: developmentProfile(server.config.modelId), config: server.config, budget, store, directory: join(directory, 'run-' + n), strategy: 'baseline' });
        assert.ok(result.error);
        assert.notEqual(result.state, 'completed');
        assert.equal(result.coverage.whole_document_summary_complete, false);
        assert.equal(result.coverage.full_document_extraction_completed, false);
        assert.equal(budget.ledger.halted, 'response_model_identity_mismatch');
        assert.equal(server.requests.length, 1);
      }
      assert.equal(budget.totals().requests, 1);
    } finally { store.close(); await server.close(); }
  });
});
