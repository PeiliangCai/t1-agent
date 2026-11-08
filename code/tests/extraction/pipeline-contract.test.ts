import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { buildArticleScope, planExtractionBatches } from '../../packages/agent/src/article-scope.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { validationFailureDiagnostic } from '../../packages/agent/src/evidence-validation-diagnostic.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../../packages/agent/src/visual-evidence-policy.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { FEATURE_NAME_RAW_RULE, STATEMENT_SELECTOR_RULE, STRUCTURE_HINT_RULE, SOURCE_UNIT_BOUNDARY_RULE,
  TABLE_SUPPORT_RULE, statementIndexRule, FEATURE_NAME_RAW_CONTRACT_VERSION } from '../../packages/agent/src/extraction-protocol.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';

const candidate = (feature: string | null) => ({ source_line_indices: [0], feature_name_raw: feature,
  feature_category: 'synthetic-margin', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors' });
const summary = (updates: unknown[], complete = false) => ({ summary: 'Synthetic offline contract fixture only.',
  reviews: [], links: [], updates, summary_complete: complete });
const execute = async (tools: { definitions(): ToolDefinition[] }, name: string, params: unknown) =>
  tools.definitions().find(t => t.name === name)!.execute('synthetic-pipeline-contract', params, undefined, undefined, {} as never);
const body = (result: Awaited<ReturnType<typeof execute>>) => JSON.parse((result.content[0] as { text: string }).text);

test('FLOW01: future fixture rejections retain bounded field/source diagnostics and summary rollback survives reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pipeline-diagnostic-')), path = join(directory, 'evidence.sqlite');
  const f = makeEvidenceFixture(), article = buildArticleScope(f.document);
  const context = { ...f.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
  let store = new ExtractionStore(path);
  try {
    store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
    const tools = new ExtractionTools(context, planExtractionBatches(f.document, article)[0]!, article, store, 'batch_lines');
    await execute(tools, 'read_document_blocks', {});
    const rejected = body(await execute(tools, 'submit_candidate_records', { records: [candidate('lobulation')], batch_complete: false }));
    assert.equal(rejected.rejected[0].issues.some((i: { code: string }) => i.code === 'feature_name_not_in_evidence'), true);
    const batch = store.events(f.input.run_id).find(e => e.type === 'candidate_validation_rejected')!.detail.validation_diagnostic;
    assert.equal(batch.field_samples[0].path, 'records[0].feature_name_raw'); assert.equal(batch.field_samples[0].preview, 'lobulation');
    assert.equal(batch.source_references[0].document_line_index, 0); assert.equal(batch.source_references[0].read_in_current_window, true);
    store.transition(f.input.run_id, 'reconciling');
    const tools2 = new ExtractionSummaryTools(context, article, store, 'baseline');
    await execute(tools2, 'read_document_blocks', { line_indices: [0] });
    await assert.rejects(execute(tools2, 'submit_candidate_records', summary([candidate('spiculation'), candidate('lobulation')])), /summary_update_validation_failed/);
    assert.equal(store.versions(f.input.run_id).length, 0); assert.equal(tools2.completed, false);
    assert.equal(store.snapshot(f.input.run_id).state, 'reconciling');
    const diagnostic = store.events(f.input.run_id).find(e => e.type === 'summary_submission_rejected')!.detail;
    assert.equal(diagnostic.atomic_evidence_rollback, true); assert.equal(diagnostic.evidence_changes_saved, false);
    assert.equal(diagnostic.validation_diagnostic.field_samples[0].path, 'updates[1].feature_name_raw');
    assert.equal(diagnostic.validation_diagnostic.field_samples[0].sha256, createHash('sha256').update('lobulation').digest('hex'));
    assert.deepEqual(diagnostic.validation_diagnostic.source_references[0].span, { start: 0, end: Array.from(f.document.blocks[0]!.text).length });
    assert.equal(JSON.stringify(diagnostic.validation_diagnostic).includes(f.document.blocks[0]!.text), false);
    store.close(); store = new ExtractionStore(path);
    assert.deepEqual(store.events(f.input.run_id).find(e => e.type === 'summary_submission_rejected')!.detail, diagnostic);
    assert.equal(store.current(f.input.run_id).length, 0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('FLOW01: diagnostic samples only allowlisted fields, redact credential-like strings and cap every source array', () => {
  const f = makeEvidenceFixture(), issues = [{ code: 'feature_name_not_in_evidence', severity: 'reject' as const, path: 'feature_name_raw', detail: '' }];
  const value = { feature_name_raw: 'Bearer synthetic-private-key', api_key: 'MUST_NOT_BE_SAVED', prompt: 'MUST_NOT_BE_SAVED',
    source_fragments: Array.from({ length: 100 }, () => f.submission.source_fragments[0]),
    modality: { evidence: Array.from({ length: 100 }, () => f.submission.source_fragments[0]) } };
  const diagnostic = validationFailureDiagnostic(value, issues, f.document, new Set(), 'updates[0]');
  assert.equal(diagnostic.field_samples[0]!.preview, null); assert.equal(diagnostic.field_samples[0]!.preview_redacted, true);
  assert.ok(diagnostic.source_references.length <= 16); assert.equal(diagnostic.source_references_truncated, true);
  assert.equal(JSON.stringify(diagnostic).includes('MUST_NOT_BE_SAVED'), false);
  assert.equal(JSON.stringify(diagnostic).includes('synthetic-private-key'), false);
  const malformed = validationFailureDiagnostic({ feature_name_raw: { arbitrary_secret: 'MUST_NOT_BE_SAVED' } }, issues, f.document, new Set(), 'records[0]');
  assert.equal(malformed.field_samples[0]!.value_type, 'object'); assert.equal(JSON.stringify(malformed).includes('arbitrary_secret'), false);
  const long = validationFailureDiagnostic({ feature_name_raw: '原文字段'.repeat(100) }, issues, f.document, new Set(), 'records[0]');
  assert.equal(Array.from(long.field_samples[0]!.preview!).length, 80); assert.equal(long.field_samples[0]!.preview_truncated, true);
});

test('PROMPT01: real batch/summary tools and loopback user prompts expose the shared field, selector and structure contract', async () => {
  const f = makeEvidenceFixture(), article = buildArticleScope(f.document), context = { ...f.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
  const directory = await mkdtemp(join(tmpdir(), 'pipeline-shared-contract-')), store = new ExtractionStore(':memory:');
  const server = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }, { name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: summary([], true) }] },
  ]);
  try {
    const batch = new ExtractionTools(context, planExtractionBatches(f.document, article)[0]!, article, store, 'batch_lines');
    const whole = new ExtractionSummaryTools(context, article, store, 'baseline');
    for (const [tools, stage, key] of [[batch, 'batch', 'records'], [whole, 'summary', 'updates']] as const) {
      const definition = tools.definitions().find(t => t.name === 'submit_candidate_records')!;
      const schema = definition.parameters as any;
      assert.equal(schema.properties[key].items.properties.feature_name_raw.description, FEATURE_NAME_RAW_RULE);
      for (const rule of [FEATURE_NAME_RAW_RULE, STATEMENT_SELECTOR_RULE, TABLE_SUPPORT_RULE, statementIndexRule(stage)])
        assert.ok(definition.description.includes(rule), stage + ' submit contract');
      const read = tools.definitions().find(t => t.name === 'read_document_blocks')!;
      assert.ok(read.description.includes(STRUCTURE_HINT_RULE)); assert.ok(read.description.includes(SOURCE_UNIT_BOUNDARY_RULE));
    }
    f.input.runtime_profile = { ...f.input.runtime_profile, provider: server.config.provider, model_id: server.config.modelId, endpoint: server.endpoint };
    const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
      profile: developmentProfile(server.config.modelId), config: server.config, budget: new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint),
      store, directory: join(directory, 'run'), strategy: 'baseline' });
    assert.equal(result.error, undefined); assert.equal(result.coverage.whole_document_summary_complete, true); assert.equal(server.requests.length, 2);
    for (const [index, stage] of ['batch', 'summary'].entries()) for (const rule of [FEATURE_NAME_RAW_RULE, STATEMENT_SELECTOR_RULE,
      STRUCTURE_HINT_RULE, SOURCE_UNIT_BOUNDARY_RULE, TABLE_SUPPORT_RULE, statementIndexRule(stage as 'batch' | 'summary')])
      assert.ok(JSON.stringify(server.requests[index]!.body).includes(rule), stage + ' actual model-visible contract');
    assert.ok(server.endpoint.startsWith('http://127.0.0.1:'));
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('ALIGN01: raw feature accepts exact characters/null and rejects case, spacing, NFC, translation and invented terms without altering source', () => {
  const cases: Array<[string, string | null, boolean]> = [['spiculation', 'spiculation', true], ['spiculation', null, true],
    ['spiculation', 'Spiculation', false], ['ground  glass', 'ground glass', false], ['Café', 'Cafe\u0301', false],
    ['spiculation', '毛刺', false], ['spiculation', 'spiculation and lobulation', false], ['spiculation', 'picul', false], ['spiculation', '', false]];
  for (const [source, feature, expected] of cases) {
    const f = makeEvidenceFixture([`We observed ${source} on CT in lung cancer.`]), before = JSON.stringify(f.document);
    f.submission.feature_name_raw = feature;
    const result = validateEvidenceSubmission(f.submission, f.context);
    assert.equal(result.accepted, expected, JSON.stringify({ source, feature, issues: result.issues }));
    if (expected) { assert.equal(result.record!.feature_name_raw, feature); assert.equal(result.record!.original_quote, f.document.blocks[0]!.text);
      assert.ok(result.record!.evidence_validation.automatic_checks.checks.includes(FEATURE_NAME_RAW_CONTRACT_VERSION)); }
    else assert.ok(result.issues.some(i => i.code === 'feature_name_not_in_evidence' && i.severity === 'reject'));
    assert.equal(JSON.stringify(f.document), before);
  }
  const f = makeEvidenceFixture(); f.submission.modality.value = 'ct'; f.submission.disease_or_lesion.value = 'LUNG  CANCER';
  const result = validateEvidenceSubmission(f.submission, f.context);
  assert.equal(result.accepted, true); assert.equal(result.record!.modality.value, 'ct');
  assert.equal(result.record!.disease_or_lesion.value, 'LUNG  CANCER');
});

test('ALIGN01: a raw feature split across source lines keeps the exact newline and hyphen or uses null', () => {
  const f = makeEvidenceFixture(['We observed ground-', 'glass on CT in lung cancer.']);
  const fragments = f.document.blocks.map(b => ({ block_id: b.block_id, exact_quote: b.text }));
  f.submission.display_joiner = '\n';
  f.submission.source_fragments = fragments; f.submission.assertion.evidence = fragments;
  f.submission.assertion.original_wording = fragments.map(f => f.exact_quote).join('\n');
  for (const feature of ['ground-\nglass', 'ground-glass', 'ground glass', null]) {
    f.submission.feature_name_raw = feature;
    const result = validateEvidenceSubmission(f.submission, f.context);
    assert.equal(result.accepted, feature === null || feature === 'ground-\nglass');
    if (result.accepted) assert.equal(result.record!.original_quote, fragments.map(f => f.exact_quote).join(f.submission.display_joiner));
    else assert.ok(result.issues.some(i => i.code === 'feature_name_not_in_evidence'));
  }
});

test('ALIGN01: real batch and summary tools enforce selector exclusivity while unverified boundaries remain reviewable', async () => {
  const f = makeEvidenceFixture(['CT shows spiculation.', 'The patient has lung cancer.']), article = buildArticleScope(f.document);
  const context = { ...f.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION }, store = new ExtractionStore(':memory:');
  store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
  try {
    const batch = new ExtractionTools(context, planExtractionBatches(f.document, article)[0]!, article, store, 'batch_lines');
    const read = body(await execute(batch, 'read_document_blocks', {}));
    const source = read.source_units.find((u: { line_spans: Array<{ line_index: number }> }) => u.line_spans.some(s => s.line_index === 0));
    const contextUnit = read.source_units.find((u: { line_spans: Array<{ line_index: number }> }) => u.line_spans.some(s => s.line_index === 1));
    assert.equal(source.completeness, 'unverified'); assert.ok(source.boundary_reasons.length > 0);
    const { source_line_indices: _, ...base } = candidate(null), valid = { ...base, source_unit_ids: [source.unit_id] };
    const variants = [{ ...valid, source_line_indices: [0] },
      { ...valid, context_unit_ids: [contextUnit.unit_id], context_line_indices: [1] }, { ...valid, source_unit_ids: ['su-does-not-exist'] }];
    for (const [index, invalid] of variants.entries()) await assert.rejects(execute(batch, 'submit_candidate_records', { records: [invalid], batch_complete: false }),
      index === 0 ? /choose_source_units_or_source_lines/ : index === 1 ? /choose_context_units_or_context_lines/ : /source_unit_not_available/);
    assert.equal(store.current(f.input.run_id).length, 0);
    const accepted = body(await execute(batch, 'submit_candidate_records', { records: [valid], batch_complete: true }));
    assert.equal(accepted.rejected.length, 0); assert.equal(batch.completed, true);
    assert.ok(store.current(f.input.run_id)[0]!.record.evidence_validation.issues.some(i => i.code === 'source_statement_boundary_requires_review'));
    store.transition(f.input.run_id, 'reconciling'); const whole = new ExtractionSummaryTools(context, article, store, 'baseline');
    await execute(whole, 'read_document_blocks', { line_indices: [0, 1] });
    for (const [index, invalid] of variants.entries()) await assert.rejects(execute(whole, 'submit_candidate_records', summary([invalid])),
      index === 0 ? /choose_source_units_or_source_lines/ : index === 1 ? /choose_context_units_or_context_lines/ : /source_unit_not_available/);
    await execute(whole, 'submit_candidate_records', summary([{ ...valid, context_unit_ids: [contextUnit.unit_id] }]));
    assert.equal(whole.completed, false); assert.equal(store.current(f.input.run_id)[0]!.record.review_status === 'approved', false);
  } finally { store.close(); }
});

test('ALIGN01: actual batch-local indices differ from summary document indices; unread and stale references still fail', async () => {
  const f = makeEvidenceFixture(Array.from({ length: 302 }, (_, i) => i === 300 ? 'CT shows spiculation.' : `Synthetic unrelated source line ${i}.`));
  const article = buildArticleScope(f.document), context = { ...f.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
  const store = new ExtractionStore(':memory:'); store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
  try {
    const planned = planExtractionBatches(f.document, { ...article, included_block_ids: [f.document.blocks[300]!.block_id] }, { contextBlocks: 0 });
    const batch = new ExtractionTools(context, planned[0]!, article, store, 'batch_lines');
    const unread = body(await execute(batch, 'submit_candidate_records', { records: [candidate('spiculation')], batch_complete: false }));
    assert.ok(unread.rejected[0].issues.some((i: { code: string }) => i.code === 'source_block_not_read'));
    await execute(batch, 'read_document_blocks', { line_indices: [0] });
    await assert.rejects(execute(batch, 'submit_candidate_records', { records: [{ ...candidate('spiculation'), source_line_indices: [300] }], batch_complete: false }));
    const rawRejected = body(await execute(batch, 'submit_candidate_records', { records: [candidate('Spiculation')], batch_complete: false }));
    assert.ok(rawRejected.rejected[0].issues.some((i: { code: string }) => i.code === 'feature_name_not_in_evidence'));
    await execute(batch, 'submit_candidate_records', { records: [candidate('spiculation')], batch_complete: true });
    assert.equal(store.current(f.input.run_id)[0]!.record.original_quote, f.document.blocks[300]!.text);
    store.transition(f.input.run_id, 'reconciling'); const whole = new ExtractionSummaryTools(context, article, store, 'baseline');
    const update = { ...candidate('spiculation'), source_line_indices: [300] };
    await assert.rejects(execute(whole, 'submit_candidate_records', summary([update])), /summary_update_validation_failed/);
    await execute(whole, 'read_document_blocks', { line_indices: [300] });
    await assert.rejects(execute(whole, 'submit_candidate_records', summary([{ ...update, feature_name_raw: 'Spiculation' }])), /summary_update_validation_failed/);
    await execute(whole, 'submit_candidate_records', summary([update]));
    assert.equal(whole.completed, false);
    const before = JSON.stringify(f.document), stale = { ...f.submission, binding: { ...f.submission.binding, text_version: 'stale-version' } };
    const rejected = validateEvidenceSubmission(stale, f.context);
    assert.equal(rejected.accepted, false); assert.ok(rejected.issues.some(i => i.code === 'binding_text_version_mismatch'));
    assert.equal(JSON.stringify(f.document), before);
  } finally { store.close(); }
});
