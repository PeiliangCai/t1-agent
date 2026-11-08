import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { assertComparisonSourceUse, assertSingleOptimization, planPaperMethods } from '../../packages/agent/src/method-comparison.js';
import { RETIRED_EXPERIMENT_ENTRYPOINTS, comparisonBudgetOwner, validateComparisonAuthorization } from '../../packages/agent/src/experiment-authorization.js';
import { independentIdentityDigest, type IndependentCorpus, type IndependentPaper } from '../../evaluation/src/corpus-isolation.js';
import type { SourceManifest } from '../../evaluation/src/contracts.js';
import { ExtractionBudget, S4_LIMITS } from '../../packages/agent/src/extraction-budget.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { createRuntimeResponsesFixture, type ResponsesStep } from './fixtures/runtime-responses.js';

const historical = JSON.parse(readFileSync(new URL('../../evaluation/manifests/source-register.json', import.meta.url), 'utf8')) as SourceManifest;
const empty: IndependentCorpus = { schema_version: 'independent-corpus-1', purpose: 'new_unexposed_papers_only', formal_sample_count: null,
  medical_quality_approved: false, papers: [] };
const options = { maxCodePoints: 8500, maxBlocks: 128, contextBlocks: 6 };
test('B0/F differ on explicit administrative/statistical selection while unknown features and original text survive', () => {
  const f = makeEvidenceFixture(['Unlisted novel phenotype.', 'Ambiguous passage.', 'Another unknown phrase.',
    'All statistical analyses were performed using SPSS.', 'Unclassified boundary.', 'Unclassified boundary.', 'Unclassified boundary.',
    'CT showed a thin rim (Fig. 1).', 'No obvious invasion was seen; diameter was 3 mm.']);
  const original = JSON.stringify(f.document), planned = planPaperMethods(f.document, { model: 'same-fixture', figures: 'same-catalog' }, options);
  assert.deepEqual(planned.jobs.map(j => j.condition), ['B0', 'F']);
  const [b, positive] = planned.jobs;
  assert.equal(positive!.selection.entries[3]!.state, 'deferred'); assert.equal(b!.selection.entries[3]!.state, 'kept');
  for (const job of planned.jobs) {
    assert.equal(job.selection.entries[0]!.state, 'kept'); assert.equal(job.selection.entries[7]!.state, 'kept'); assert.equal(job.selection.entries[8]!.state, 'kept');
    assert.equal(job.common_sha256, b!.common_sha256);
  }
  assert.ok(planned.jobs.every(job => job.independent_model_run));
  assert.equal(planned.logical_methods, 2);
  assert.equal(planned.unique_inputs, 2); assert.equal(JSON.stringify(f.document), original);
});
test('positive seed neighborhood restores boundary context and identical masks are reported honestly', () => {
  const f = makeEvidenceFixture(['All statistical analyses were performed using SPSS.', 'CT showed a thin rim.']);
  const p = planPaperMethods(f.document, { same: true }, options);
  assert.equal(p.jobs[1]!.selection.entries[0]!.state, 'kept');
  assert.ok(p.jobs[1]!.selection.entries[0]!.rule_ids.includes('KEEP_CONTEXT_NEIGHBOR'));
  assert.equal(p.all_method_inputs_identical, true); assert.equal(p.unique_inputs, 1);
  assert.deepEqual(p.jobs.map(j => j.independent_model_run), [true, false]);
});
test('comparison rejects unknown input status and sealed independent families before paper loading', () => {
  const old = historical.sources.find(s => s.access.file_verified)!;
  const identity = { source_id: old.source_id, article_family_id: old.article_family_id, doi: old.doi, file_sha256: old.access.sha256! };
  assert.equal(assertComparisonSourceUse(identity, historical, empty).independent_acceptance, false);
  assert.throws(() => assertComparisonSourceUse({ ...identity, source_id: 'UNKNOWN' }, historical, empty), /status_unknown/);
  const paper: IndependentPaper = { source_id: 'NEW-HOLDOUT', article_family_id: 'new-family', doi: '10.0000/new-fixture', title: 'Fixture only',
    source_url: 'https://example.invalid/fixture', registered_at: '2026-11-04T00:00:00Z',
    file: { path: 'evaluation/corpus/independent-sealed/NEW-HOLDOUT.pdf', sha256: 'f'.repeat(64), bytes: 100 },
    identity_review: { status: 'confirmed', actor: 'fixture', checked_at: '2026-11-04T00:00:00Z' }, state: 'sealed', seal: null, exposures: [] };
  paper.seal = { actor: 'fixture', sealed_at: '2026-11-04T00:00:00Z', identity_sha256: independentIdentityDigest(paper) };
  const isolated = { ...empty, papers: [paper] };
  for (const alias of [{ source_id: paper.source_id, article_family_id: paper.article_family_id, doi: paper.doi, file_sha256: paper.file.sha256 },
    { source_id: 'RENAMED', article_family_id: 'other', doi: null, file_sha256: paper.file.sha256 }]) {
    assert.throws(() => assertComparisonSourceUse(alias, historical, isolated), /forbidden_for_development/);
  }
});
test('the actual preparation CLI rejects sealed independent input before any absent PDF/IR can be read', () => {
  const code = fileURLToPath(new URL('../../', import.meta.url)), directory = mkdtempSync(join(code, '.tools/comparison-isolation-'));
  try {
    const paper: IndependentPaper = { source_id: 'FRESH-FIXTURE', article_family_id: 'fresh-fixture-family', doi: null, title: 'Fixture only',
      source_url: 'https://example.invalid/fixture', registered_at: '2026-11-04T00:00:00Z',
      file: { path: 'evaluation/corpus/independent-sealed/FRESH-FIXTURE.pdf', sha256: 'e'.repeat(64), bytes: 10 },
      identity_review: { status: 'confirmed', actor: 'fixture', checked_at: '2026-11-04T00:00:00Z' }, state: 'sealed', seal: null, exposures: [] };
    paper.seal = { actor: 'fixture', sealed_at: '2026-11-04T00:00:00Z', identity_sha256: independentIdentityDigest(paper) };
    mkdirSync(join(directory, 'evaluation/manifests'), { recursive: true });
    writeFileSync(join(directory, 'evaluation/manifests/source-register.json'), JSON.stringify(historical));
    writeFileSync(join(directory, 'evaluation/manifests/independent-intake.json'), JSON.stringify({ ...empty, papers: [paper] }));
    const config = JSON.parse(readFileSync(join(code, 'config/two-method-comparison.json'), 'utf8'));
    config.papers = [{ source_id: paper.source_id, prepared_directory: 'absent-must-never-be-read' }];
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(code, 'scripts/compare-extraction-methods.ts'), 'prepare',
      '--config', 'config.json', '--directory', 'must-not-be-created'], { cwd: directory, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /independent_corpus_forbidden_for_development_or_selection/u);
    assert.ok(!result.stderr.includes('ENOENT')); assert.equal(result.stdout, '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('new execution needs a matching explicit authorization; unsigned proposals, old caps and changed model cannot execute', () => {
  const expected = { plan_sha256: 'a'.repeat(64), batch_id: 'new-fixture', model_id: 'gpt-6-luna', reasoning_effort: 'medium' as const,
    provider: 'agicto', api: 'openai-responses' as const, proposed_limits: { ...S4_LIMITS, requests: 300, input_tokens: 6_000_000 } };
  const grant = { schema_version: 'two-method-authorization-1', status: 'authorized', authorization_id: 'fixture-no-network',
    user_confirmation_source: 'synthetic test only', approved_at: '2026-11-04T00:00:00Z', prepared_plan_sha256: expected.plan_sha256,
    batch_id: expected.batch_id, model_id: expected.model_id, reasoning_effort: 'medium', provider: 'agicto', api: 'openai-responses', limits: expected.proposed_limits };
  assert.equal(validateComparisonAuthorization(grant, expected).authorization_id, 'fixture-no-network');
  assert.equal(comparisonBudgetOwner(grant.authorization_id), comparisonBudgetOwner(grant.authorization_id));
  for (const changed of [{ schema_version: 'three-method-authorization-1' }, { status: 'pending_user_confirmation' }, { prepared_plan_sha256: 'b'.repeat(64) }, { batch_id: 'old-batch' },
    { model_id: 'gpt-6-astra' }, { limits: { ...expected.proposed_limits, requests: 400 } }, { user_confirmation_source: null }]) {
    assert.throws(() => validateComparisonAuthorization({ ...grant, ...changed }, expected), /authorization_required|limits_invalid/);
  }
});
test('a follow-up cannot combine optimization points or silently change model/source/scope', () => {
  const before = { model: 'Luna', papers: ['same'], batch_options: { size: 1 }, strategy: 'baseline' };
  assert.doesNotThrow(() => assertSingleOptimization(before, { ...before, batch_options: { size: 2 } }, 'batch_options'));
  assert.throws(() => assertSingleOptimization(before, { ...before, batch_options: { size: 2 }, strategy: 'other' }, 'batch_options'), /one_declared/);
  assert.throws(() => assertSingleOptimization(before, { ...before, model: 'other' }, 'model'), /frozen_model/);
});
test('two plans with the same authorization share spent requests and the original wall clock; limits cannot reset', () => {
  const directory = mkdtempSync(join(tmpdir(), 't1-comparison-owner-'));
  try {
    const limits = { ...S4_LIMITS, requests: 300, input_tokens: 6_000_000 }, authorization = {
      id: 'fixture-shared-budget', source: 'synthetic test only', recorded_at: '2026-11-04T00:00:00Z' };
    const path = join(directory, comparisonBudgetOwner(authorization.id), 'call-ledger.json');
    const initial = new ExtractionBudget(path, 'http://127.0.0.1:1', () => 1000, { limits, authorization });
    initial.begin('fixture', 'first-plan', 0, '{}', 100);
    const followup = new ExtractionBudget(path, 'http://127.0.0.1:1', () => 2000, { limits, authorization });
    assert.equal(followup.totals().requests, 1); assert.equal(followup.totals().elapsed_seconds, 1);
    assert.throws(() => new ExtractionBudget(path, 'http://127.0.0.1:1', () => 2000, { limits: { ...limits, requests: 301 }, authorization }), /limits_changed/);
    const expired = new ExtractionBudget(path, 'http://127.0.0.1:1', () => 1000 + limits.seconds * 1000, { limits, authorization });
    assert.throws(() => expired.check(), /experiment_time_limit/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('equal B0/F inputs yield equal actual Pi model prompts, schemas and tool results without exposing condition labels', async () => {
  const directory = mkdtempSync(join(tmpdir(), 't1-method-model-view-'));
  const batch: ResponsesStep[] = [
    { calls: [{ name: 'read_document_blocks', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { summary: 'Synthetic fixture only', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ];
  const server = await createRuntimeResponsesFixture([...batch, ...batch]);
  const f = makeEvidenceFixture(['CT showed a thin rim.', 'No obvious invasion was seen; diameter was 3 mm.']);
  f.input.runtime_profile = { ...f.input.runtime_profile, provider: server.config.provider, model_id: server.config.modelId, endpoint: server.endpoint };
  try {
    for (const condition of ['B0', 'F'] as const) {
      const store = new ExtractionStore(':memory:');
      try {
        const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
          profile: developmentProfile(server.config.modelId), config: server.config, budget: new ExtractionBudget(join(directory, condition + '-ledger.json'), server.endpoint),
          store, directory: join(directory, condition), strategy: 'baseline', sourceSelectionCondition: condition, figureDiscovery: 'not_requested' });
        assert.equal(result.error, undefined); assert.equal(result.coverage.selected_source_block_processing_complete, true);
      } finally { store.close(); }
    }
    assert.equal(server.requests.length, 8);
    const neutral = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(neutral);
      if (!v || typeof v !== 'object') return v;
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k,
        ['id', 'call_id'].includes(k) && typeof x === 'string' && /^(?:fc|call|resp|msg)-fixture-/u.test(x) ? 'opaque-fixture-generated-id' : neutral(x)]));
    };
    for (let i = 0; i < 4; i++) assert.deepEqual(neutral(server.requests[i]!.body), neutral(server.requests[i + 4]!.body), 'provider request ' + i);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('historical fixed-budget runners and package commands are retired; the current comparison entrypoint remains', () => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  for (const script of RETIRED_EXPERIMENT_ENTRYPOINTS) assert.equal(existsSync(join(cwd, 'scripts', script)), false, script);
  const scripts = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['s4:probe'], undefined); assert.equal(scripts['s4:development'], undefined);
  assert.equal(scripts['s4:compare'], 'tsx scripts/compare-extraction-methods.ts');
});
