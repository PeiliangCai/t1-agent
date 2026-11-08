import test from 'node:test';
import assert from 'node:assert/strict';
import { ScopeSchema, CandidateRecordSchema, assertSchema, assertScope, defaultScope, reconcileScope, immutable, locateQuote, UnimplementedParserAdapter } from '@t1/contracts';
import { catalog, makeFixture, parseModelConfig, safeError } from '@t1/agent';

test('first scope is all at all levels and an empty catalog does not block open mode', () => {
  const scope = defaultScope(catalog.catalog_version); assertScope(scope, catalog);
  assert.deepEqual([scope.cancers.mode, scope.image_types.mode, scope.features.mode], ['all', 'all', 'all']);
  assertScope(scope, { ...catalog, cancers: [], image_types: [], bindings: [], features: [] });
});
test('each selected-empty mode is rejected rather than silently widened', () => {
  for (const level of ['cancers', 'image_types', 'features'] as const) {
    const scope = defaultScope(catalog.catalog_version); scope[level].mode = 'selected';
    assert.throws(() => assertScope(scope, catalog), /selected_empty/);
    assert.equal(scope[level].mode, 'selected');
  }
});
test('all mode cannot hide selected IDs; unknown IDs and catalog mismatch are rejected', () => {
  const scope = defaultScope(catalog.catalog_version); scope.cancers.ids = ['demo_cancer_a'];
  assert.throws(() => assertScope(scope, catalog), /all_has_selections/);
  scope.cancers.mode = 'selected'; scope.cancers.ids = ['unknown']; assert.throws(() => assertScope(scope, catalog), /unknown_selection/);
  scope.cancers.ids = ['demo_cancer_a']; scope.catalog_version = 'stale'; assert.throws(() => assertScope(scope, catalog), /catalog_version_mismatch/);
  assert.throws(() => assertSchema(ScopeSchema, { ...scope, invented: true }), /schema/);
});
test('upstream changes preserve valid bindings and mark invalid choices until user resolves', () => {
  const scope = defaultScope(catalog.catalog_version); scope.cancers = { mode: 'selected', ids: ['demo_cancer_a'] };
  scope.features = { mode: 'selected', binding_ids: ['demo_rim_a', 'demo_rim_b'] };
  const result = reconcileScope(scope, catalog);
  assert.deepEqual(result.valid_binding_ids, ['demo_rim_a']); assert.deepEqual(result.invalid_binding_ids, ['demo_rim_b']);
  assert.deepEqual(result.scope.features.binding_ids, ['demo_rim_a', 'demo_rim_b']);
  assert.throws(() => assertScope(result.scope, catalog), /invalid_binding/);
});
test('image/cancer applicability is explicit and does not form a Cartesian product', () => {
  const scope = defaultScope(catalog.catalog_version); scope.cancers = { mode: 'selected', ids: ['demo_cancer_a'] }; scope.image_types = { mode: 'selected', ids: ['demo_image_b'] };
  assert.throws(() => assertScope(scope, catalog), /invalid_image_type/);
});
test('immutable run input is independent of later selector changes and deeply frozen', () => {
  const input = makeFixture({ provider: 'test', modelId: 'test', baseUrl: 'https://example.invalid/v1' }).input;
  const snapshot = immutable(input); input.scope.cancers.mode = 'selected';
  assert.equal(snapshot.scope.cancers.mode, 'all');
  assert.throws(() => { snapshot.scope.cancers.ids.push('mutated'); }, TypeError);
});
test('quote offsets count Unicode code points, preserve source version and reject ambiguous/fabricated quotes', () => {
  const block = makeFixture({ provider: 'test', modelId: 'test', baseUrl: 'https://example.invalid/v1' }).document.blocks[0]!;
  const quote = 'The sample shape has a blue rim measuring 7 mm.';
  const span = locateQuote(block, quote);
  assert.equal(Array.from(block.text).slice(span.start, span.end).join(''), quote);
  assert.notEqual(span.start, block.text.indexOf(quote));
  assert.throws(() => locateQuote(block, 'invented quote'), /quote_not_in_source/);
  assert.throws(() => locateQuote({ ...block, text: 'same same' }, 'same'), /ambiguous/);
  assert.equal(Object.keys(CandidateRecordSchema.properties).length, 28);
});
test('the historical S1 placeholder still rejects explicit stub calls; S3 local adapter is separate', async () => {
  await assert.rejects(new UnimplementedParserAdapter().parse(), /not_implemented_until_S3/);
});
test('dotenv parses key/value text without executing shell syntax; environment takes precedence', () => {
  const text = 'T1_MODEL_PROVIDER=agicto\nT1_MODEL_BASE_URL="https://example.invalid/v1"\nT1_MODEL_ID=test\nT1_MODEL_API_KEY="$(do_not_execute)"';
  const config = parseModelConfig(text, { T1_MODEL_ID: 'override' });
  assert.equal(config.modelId, 'override'); assert.equal(config.apiKey(), '$(do_not_execute)');
  assert.ok(!JSON.stringify(config).includes('do_not_execute'));
  assert.throws(() => parseModelConfig(text.replace('https://example.invalid/v1', 'https://secret@example.invalid/v1')), /without_credentials/);
  assert.deepEqual(safeError(Object.assign(new Error('credential-in-error'), { request: { authorization: 'credential-in-error' }, status: 401 })), { type: 'Error', status: 401, code: undefined, request_id: undefined });
  assert.ok(!JSON.stringify(safeError(new Error('credential-in-error'))).includes('credential-in-error'));
});
