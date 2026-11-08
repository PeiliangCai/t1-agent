import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { buildArticleScope, type ExtractionDocument } from '../../packages/agent/src/article-scope.js';
import { selectSourceBlocks, isSourceSelectionCondition, type SourceSelectionCondition,
  SOURCE_SELECTION_VERSION, type SourceSelectionManifest } from '../../packages/agent/src/source-selection.js';
import { assertCurrentComparisonPlan, COMPARISON_PLAN_SCHEMA } from '../../packages/agent/src/method-comparison.js';
import { comparisonBudgetAuthorization, validateComparisonAuthorization, type ComparisonAuthorization,
  type LegacyComparisonAuthorization } from '../../packages/agent/src/experiment-authorization.js';
import { S4_LIMITS } from '../../packages/agent/src/extraction-budget.js';
import { comparisonMeasurement } from '../../scripts/audit-method-comparison.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

const code = resolve('.');
const frozen = 'docs/acceptance/user-feedback-2026-11-05/revalidation/metric-context-revision/prepared';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const cli = (script: string, args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args],
  { cwd: code, encoding: 'utf8', timeout: 20_000 });

test('retired R/FR cannot select source blocks through the current runtime API', () => {
  const f = makeEvidenceFixture(), before = JSON.stringify(f.document);
  for (const condition of ['R', 'FR', 'unknown']) {
    assert.equal(isSourceSelectionCondition(condition), false);
    assert.throws(() => selectSourceBlocks(f.document, buildArticleScope(f.document), condition as SourceSelectionCondition),
      /invalid_source_selection_condition/);
  }
  assert.equal(JSON.stringify(f.document), before);
});

test('frozen historical masks remain readable and unchanged while the current shared task scope is a new version', async () => {
  const planBytes = await readFile(join(frozen, 'plan.json')), plan = JSON.parse(planBytes.toString('utf8'));
  const expected = { L01: { B0: 409, F: 344 }, L05: { B0: 615, F: 524 } };
  for (const paper of plan.papers) {
    const irBytes = await readFile(paper.ir_path); assert.equal(sha(irBytes), paper.ir_sha256);
    const document = JSON.parse(irBytes.toString('utf8')).document as ExtractionDocument;
    const before = JSON.stringify(document);
    for (const condition of ['B0', 'F'] as const) {
      const current = selectSourceBlocks(document, buildArticleScope(document), condition);
      const historical = paper.methods.jobs.find((job: { condition: string }) => job.condition === condition);
      assert.equal(historical.selection.kept_block_ids.length, expected[paper.document_id as keyof typeof expected][condition]);
      assert.equal(historical.selection.rule_version, 's4-explainable-source-selection-1');
      assert.deepEqual(historical.selection.excluded_block_ids, []);
      assert.equal(current.rule_version, SOURCE_SELECTION_VERSION);
      assert.equal(current.bibliography_scope_rule_version, 'explicit-bibliography-task-scope-1');
      assert.notEqual(current.digest, historical.selection.digest);
      assert.ok(current.excluded_block_ids.length > 0);
      assert.ok(current.entries.filter(e => e.state === 'excluded').every(e => e.article_eligible && e.rule_ids.includes('TASK_BIBLIOGRAPHY_EXCLUDED')));
    }
    const reverse = paper.methods.jobs.find((job: { condition: string }) => job.condition === 'R');
    const legacy: SourceSelectionManifest = JSON.parse(JSON.stringify(reverse.selection));
    assert.equal(legacy.condition, 'R');
    assert.equal(typeof paper.methods.all_three_inputs_identical, 'boolean');
    assert.equal(comparisonMeasurement(reverse, []).condition, 'R');
    assert.equal(JSON.stringify(document), before);
  }
  assert.throws(() => assertCurrentComparisonPlan(plan), /comparison_current_two_method_plan_required/);
  assert.equal(sha(await readFile(join(frozen, 'plan.json'))), sha(planBytes));
});

test('current plan gates reject old schemas and retired jobs without silently migrating either', () => {
  const current = { schema_version: COMPARISON_PLAN_SCHEMA,
    papers: [{ methods: { logical_methods: 2, jobs: [{ condition: 'B0' }, { condition: 'F' }] } }] };
  assertCurrentComparisonPlan(current);
  for (const plan of [{ ...current, schema_version: 'three-method-prepared-comparison-1' },
    { ...current, papers: [{ methods: { logical_methods: 2, jobs: [{ condition: 'B0' }, { condition: 'R' }] } }] },
    { ...current, papers: [{ methods: { logical_methods: 3, jobs: [{ condition: 'B0' }, { condition: 'F' }, { condition: 'R' }] } }] }]) {
    assert.throws(() => assertCurrentComparisonPlan(plan), /comparison_current_two_method_plan_required/);
  }
});

test('historical authorization is readable but cannot authorize a current plan or become a live budget', async () => {
  const legacy = JSON.parse(await readFile('docs/acceptance/user-feedback-2026-11-05/revalidation/metric-context-revision/authorization.json', 'utf8')) as LegacyComparisonAuthorization;
  assert.equal(legacy.schema_version, 'three-method-authorization-1');
  assert.throws(() => validateComparisonAuthorization(legacy, { plan_sha256: legacy.prepared_plan_sha256, batch_id: legacy.batch_id,
    model_id: legacy.model_id, reasoning_effort: legacy.reasoning_effort, provider: legacy.provider, api: legacy.api,
    proposed_limits: legacy.limits }), /new_comparison_user_authorization_required/);
  assert.throws(() => comparisonBudgetAuthorization(legacy as unknown as ComparisonAuthorization), /new_comparison_user_authorization_required/);
});

test('actual comparison and summary replay CLIs refuse frozen three-method execution before outputs or authorization reads', async () => {
  const directory = await mkdtemp(resolve('runtime-data/two-method-legacy-cli-'));
  const planBefore = sha(await readFile(join(frozen, 'plan.json')));
  try {
    const prepare = cli('scripts/compare-extraction-methods.ts', ['prepare', '--directory', relative(code, join(directory, 'comparison')),
      '--config', 'config/three-method-comparison.json']);
    assert.equal(prepare.status, 1); assert.match(prepare.stderr, /comparison_current_two_method_config_required/);
    const execute = cli('scripts/compare-extraction-methods.ts', ['execute', '--directory', frozen, '--authorization', 'absent-must-not-be-read.json']);
    assert.equal(execute.status, 1); assert.match(execute.stderr, /comparison_current_two_method_plan_required/);
    assert.equal(execute.stderr.includes('ENOENT'), false);
    const replay = cli('scripts/summary-reread-replay.ts', ['prepare', '--parent', frozen, '--directory', relative(code, join(directory, 'replay'))]);
    assert.equal(replay.status, 1); assert.match(replay.stderr, /comparison_current_two_method_plan_required/);
    await assert.rejects(access(join(directory, 'comparison')));
    await assert.rejects(access(join(directory, 'replay')));
    assert.equal(sha(await readFile(join(frozen, 'plan.json'))), planBefore);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('general paper CLI rejects R/FR before parsing, output creation or any model request', async () => {
  const directory = await mkdtemp(resolve('runtime-data/two-method-paper-cli-'));
  try {
    const pdf = join(directory, 'synthetic.pdf'); await writeFile(pdf, '%PDF-synthetic-not-parsed');
    for (const condition of ['R', 'FR']) {
      const config = join(directory, condition + '.json'), output = join(directory, condition + '-run');
      await writeFile(config, JSON.stringify({ schema_version: 'paper-extraction-run-config-1', status: 'authorized', execute_model_calls: true,
        model_id: 'synthetic-no-network', reasoning_effort: 'medium', api: 'openai-responses', source_selection: condition,
        budget: { limits: S4_LIMITS, authorization: { id: 'synthetic-no-network', source: 'fixture-only', recorded_at: '2026-11-07T00:00:00Z' } } }));
      const result = cli('scripts/extract-paper.ts', ['--pdf', pdf, '--document-id', 'synthetic-retired-condition', '--directory', output, '--run-config', config]);
      assert.equal(result.status, 1); assert.deepEqual(JSON.parse(result.stdout), { status: 'failed', phase: 'input',
        error_code: 'new_explicit_run_configuration_required', paid_calls: 0, previous_artifacts_overwritten: false });
      await assert.rejects(access(output));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a new B0/F configuration cannot relabel stale frozen parser output as the current formal input', async () => {
  const directory = await mkdtemp(resolve('runtime-data/two-method-stale-parser-'));
  try {
    const config = JSON.parse(await readFile('config/two-method-comparison.json', 'utf8'));
    const plan = JSON.parse(await readFile(join(frozen, 'plan.json'), 'utf8'));
    const paper = plan.papers.find((p: { document_id: string }) => p.document_id === 'L05');
    const parsed = JSON.parse(await readFile(paper.ir_path, 'utf8'));
    parsed.document.parser.config.adapter_sha256 = '0'.repeat(64);
    const source = join(directory, 'stale-source'); await mkdir(source);
    await writeFile(join(source, 'parser-result.json'), JSON.stringify(parsed));
    config.papers = [{ source_id: 'L05', prepared_directory: relative(code, source) }];
    const configPath = join(directory, 'config.json'); await writeFile(configPath, JSON.stringify(config));
    const output = join(directory, 'prepared');
    const result = cli('scripts/compare-extraction-methods.ts', ['prepare', '--config', relative(code, configPath), '--directory', relative(code, output)]);
    assert.equal(result.status, 1); assert.match(result.stderr, /comparison_requires_same_current_formal_parser/);
    assert.equal(result.stderr.includes('ENOENT'), false); await assert.rejects(access(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
