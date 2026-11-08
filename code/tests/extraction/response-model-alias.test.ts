import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Usage } from '@earendil-works/pi-ai';
import { ExtractionBudget, S4_LIMITS, type ResponseModelAliasPolicy } from '../../packages/agent/src/extraction-budget.js';
import { createExtractionSession, developmentProfile, promptExtractionSession } from '../../packages/agent/src/extraction-pi.js';
import { ModelConfig } from '../../packages/agent/src/config.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';

const policy: ResponseModelAliasPolicy = { policy_id: 'synthetic-explicit-user-relayed-alias', source: 'synthetic:user-relayed-supplier-statement',
  recorded_at: '2026-11-03T00:00:00Z', exact_pairs: [{ requested_model: 'gpt-6-luna', response_model: 'igpt-6-luna' }] };
const usage: Usage = { input: 90, output: 30, cacheRead: 10, cacheWrite: 0, reasoning: 12, totalTokens: 130,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const remaining = { ...S4_LIMITS, requests: 271, input_tokens: 5_720_497, output_tokens: 377_383, seconds: 10800 };
const authorization = { id: 'synthetic-carry-forward-only', source: 'synthetic:original29-and-tokens-preserved', recorded_at: '2026-11-03T00:00:00Z' };
async function temporary<T>(body: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 't1-response-alias-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('explicit exact alias preserves original response name and confirmation source; reopens only with the same policy', async () => {
  await temporary(async directory => {
    const path = join(directory, 'ledger.json'), options = { limits: remaining, authorization, responseModelAliasPolicy: structuredClone(policy) };
    const budget = new ExtractionBudget(path, 'http://127.0.0.1:1/v1', Date.now, options);
    options.responseModelAliasPolicy.exact_pairs[0]!.response_model = 'must-not-change-active-policy';
    const entry = budget.begin('gpt-6-luna', 'synthetic', 0, '{}', 100);
    budget.observeResponseModel(entry, 'igpt-6-luna', 'response.completed'); budget.settle(entry, usage);
    assert.equal(entry.provider_response_model, 'igpt-6-luna');
    assert.equal(entry.response_model_identity_status, 'confirmed_alias');
    assert.equal(entry.response_model_observations![0]!.alias_confirmation_source, policy.source);
    assert.equal(budget.ledger.halted, null);
    assert.equal(new ExtractionBudget(path, budget.endpoint, Date.now, { limits: remaining, authorization, responseModelAliasPolicy: policy }).totals().requests, 1);
    assert.throws(() => new ExtractionBudget(path, budget.endpoint, Date.now, { limits: remaining, authorization }), /response_model_alias_policy_changed/);
    assert.throws(() => new ExtractionBudget(path, budget.endpoint, Date.now, { limits: remaining, authorization, responseModelAliasPolicy: { ...policy, policy_id: 'changed' } }), /response_model_alias_policy_changed/);
  });
});

test('a confirmed alias does not permit any prefix wildcard, alternate request model or later unlisted response', async () => {
  await temporary(async directory => {
    const budget = new ExtractionBudget(join(directory, 'ledger.json'), 'http://127.0.0.1:1/v1', Date.now, { responseModelAliasPolicy: policy });
    const entry = budget.begin('gpt-6-luna', 'synthetic', 0, '{}', 100);
    budget.observeResponseModel(entry, 'igpt-6-luna', 'response.created');
    budget.observeResponseModel(entry, 'gpt-6-luna', 'response.in_progress');
    assert.equal(entry.response_model_identity_status, 'confirmed_alias');
    budget.observeResponseModel(entry, 'iigpt-6-luna', 'response.completed');
    assert.equal(entry.response_model_identity_status, 'mismatch');
    assert.equal(entry.response_model_observations!.at(-1)!.actual_model, 'iigpt-6-luna');
    assert.throws(() => budget.settle(entry, usage), /response_model_identity_mismatch/);
    const invalid = { ...policy, exact_pairs: [{ requested_model: '*gpt-6-luna', response_model: 'igpt-6-luna' }] };
    assert.throws(() => new ExtractionBudget(join(directory, 'invalid.json'), budget.endpoint, Date.now, { responseModelAliasPolicy: invalid }), /invalid_response_model_alias_policy/);
    const reverse = new ExtractionBudget(join(directory, 'reverse.json'), budget.endpoint, Date.now, { responseModelAliasPolicy: policy });
    const request = reverse.begin('igpt-6-luna', 'not-authorized-by-one-way-runtime-policy', 0, '{}', 100);
    reverse.observeResponseModel(request, 'gpt-6-luna', 'response.completed');
    assert.equal(request.response_model_identity_status, 'mismatch');
  });
});

test('remaining request ceiling includes the carried 29 and never grants a fresh 300', async () => {
  await temporary(async directory => {
    const budget = new ExtractionBudget(join(directory, 'ledger.json'), 'http://127.0.0.1:1/v1', Date.now, { limits: remaining, authorization });
    for (let i = 0; i < 271; i++) {
      const entry = budget.begin('gpt-6-luna', 'synthetic-no-network', 0, '{}', 100);
      if (i === 270) assert.throws(() => budget.settle(entry, usage), /experiment_request_limit/);
      else budget.settle(entry, usage);
    }
    assert.equal(29 + budget.totals().requests, 300);
    assert.throws(() => budget.begin('gpt-6-luna', 'one-too-many', 0, '{}', 100), /experiment_request_limit/);
    assert.equal(budget.wallClockSeconds, 10800);
    assert.equal(279_503 + budget.limits.input_tokens, 6_000_000);
    assert.equal(22_617 + budget.limits.output_tokens, 400_000);
  });
});

test('real local Pi SSE accepts only the explicitly confirmed name while always requesting gpt-6-luna', async () => {
  await temporary(async directory => {
    const server = await createRuntimeResponsesFixture([{ text: 'Synthetic fixture only.', response_model: 'igpt-6-luna' }]);
    try {
      const config = new ModelConfig(server.config.provider, server.endpoint, 'gpt-6-luna', 'local-test-placeholder');
      const budget = new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint, Date.now, { limits: remaining, authorization, responseModelAliasPolicy: policy });
      const created = await createExtractionSession(config, developmentProfile('gpt-6-luna'), [], directory, budget, 'exact-alias-local-SSE');
      const result = await promptExtractionSession(created, 'Synthetic local fixture only.', budget);
      assert.equal(result.error, undefined);
      assert.equal(server.requests.length, 1); assert.equal(server.requests[0]!.body.model, 'gpt-6-luna');
      assert.equal(budget.ledger.requests[0]!.provider_response_model, 'igpt-6-luna');
      assert.equal(budget.ledger.requests[0]!.response_model_identity_status, 'confirmed_alias');
    } finally { await server.close(); }
  });
});
