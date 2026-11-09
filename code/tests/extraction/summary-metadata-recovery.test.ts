import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { reconcileEvidence } from '../../packages/agent/src/reconciliation.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { buildArticleScope } from '../../packages/agent/src/article-scope.js';
import { BoundedToolRecovery, classifyToolError } from '../../packages/agent/src/extraction-tool-recovery.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../../packages/agent/src/visual-evidence-policy.js';
import { createRuntimeResponsesFixture, type ResponsesStep } from './fixtures/runtime-responses.js';
import { createExtractionSession, developmentProfile, promptExtractionSession } from '../../packages/agent/src/extraction-pi.js';
import { ExtractionBudget, S4_LIMITS } from '../../packages/agent/src/extraction-budget.js';

function fixture() {
  const f = makeEvidenceFixture(['We observed high tissue con', 'trast on CT.', 'CT showed an irregular margin.']);
  f.document.structure.units.push({ unit_id: 'synthetic-joined-sentence', native_ref: '#/test/paragraph', kind: 'text', native_label: 'text',
    native_text: 'Untrusted native display', native_original_text: null, native_text_role: 'processed_native_not_literal_quote', content_layer: 'body',
    source_segments: f.document.blocks.slice(0, 2).map(b => ({ block_id: b.block_id, text_version: f.document.text_version, start: 0, end: Array.from(b.text).length })),
    provenance: [], mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_4', matched_native_code_points: 1,
      alignable_native_code_points: 1, transformations: [], warnings: [] } });
  const source = f.document.blocks.slice(0, 2).map(b => ({ block_id: b.block_id, exact_quote: b.text }));
  f.submission.source_fragments = source; f.submission.display_joiner = '\n'; f.submission.feature_name_raw = null; f.submission.feature_category = 'contrast';
  f.submission.disease_or_lesion = { value: null, status: 'unknown', evidence: [] };
  f.submission.modality = { value: 'CT', status: 'source_observed', evidence: [source[1]!] };
  f.submission.assertion = { value: 'affirmed', original_wording: source.map(s => s.exact_quote).join('\n'), evidence: source };
  f.submission.provenance.evidence = source;
  const context = { ...f.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
  const validation = validateEvidenceSubmission(f.submission, context); assert.ok(validation.record, JSON.stringify(validation.issues));
  const store = new ExtractionStore(':memory:'); store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
  store.apply(f.input.run_id, reconcileEvidence(validation.record, [])); store.transition(f.input.run_id, 'reconciling');
  const tools = new ExtractionSummaryTools(context, buildArticleScope(f.document), store, 'baseline');
  const ids = { run_id: f.input.run_id, document_id: f.input.document_id };
  const invoke = (name: string, value: object) => tools.invoke(name, { ...ids, ...value }, 'metadata-fixture');
  const params = { summary: 'Synthetic metadata recovery only.', reviews: [], links: [], updates: [], summary_complete: false };
  return { f, context, store, tools, invoke, params, record: validation.record };
}

test('raw-name-only failure rolls back reviews atomically; explicit literal metadata preserves every original fragment', async () => {
  const c = fixture();
  try {
    await c.invoke('get_document_context', {}); await c.invoke('read_document_blocks', { block_ids: c.f.document.blocks.slice(0, 2).map(b => b.block_id) });
    const before = c.store.versions(c.f.input.run_id), update = { ...c.f.submission, updates_record_id: c.record.record_id, feature_name_raw: 'contrast' };
    const inputBefore = structuredClone(update);
    await assert.rejects(c.invoke('submit_candidate_records', { ...c.params, reviews: [{ record_id: c.record.record_id, expected_version: 1, issue_codes: [] }], updates: [update] }), /summary_raw_name_requires_literal_source/);
    assert.deepEqual(update, inputBefore); assert.deepEqual(c.store.versions(c.f.input.run_id), before); assert.equal(c.tools.reviewedIds.size, 0);
    await c.invoke('submit_candidate_records', { ...c.params, updates: [{ ...update, feature_name_raw: 'con\ntrast' }] });
    const current = c.store.current(c.f.input.run_id)[0]!;
    const proposed = c.store.versions(c.f.input.run_id).find(v => v.status === 'proposed')!;
    assert.equal(current.record.feature_name_raw, null); assert.equal(proposed.record.feature_name_raw, 'con\ntrast');
    assert.equal(proposed.record.original_quote, c.record.original_quote);
    assert.deepEqual(proposed.record.quote_span.segments, c.record.quote_span.segments); assert.deepEqual(proposed.record.context.fragments, c.record.context.fragments);
    assert.notEqual(current.record.review_status, 'approved');
  } finally { c.store.close(); }
});

test('other source failures, a missing target and a changed current version never become raw-name correction', async () => {
  for (const kind of ['unread', 'binding', 'missing', 'version'] as const) {
    const c = fixture();
    try {
      await c.invoke('get_document_context', {});
      if (kind !== 'unread') await c.invoke('read_document_blocks', { block_ids: c.f.document.blocks.map(b => b.block_id) });
      if (kind === 'version') c.store.modelReview(c.f.input.run_id, c.record.record_id, 1, 'synthetic-concurrent-version', []);
      const update = { ...structuredClone(c.f.submission), updates_record_id: kind === 'missing' ? 'synthetic-missing' : c.record.record_id, feature_name_raw: 'contrast' };
      if (kind === 'binding') update.binding.file_sha256 = 'f'.repeat(64);
      const before = c.store.versions(c.f.input.run_id);
      await assert.rejects(c.invoke('submit_candidate_records', { ...c.params, updates: [update] }), error => {
        assert.ok(error instanceof Error); assert.ok(!error.message.includes('summary_raw_name_requires_literal_source')); return true;
      });
      assert.deepEqual(c.store.versions(c.f.input.run_id), before);
    } finally { c.store.close(); }
  }
});

test('validated same-source wrong-feature replacement stays rejected/atomic and requires an explicit later choice', async () => {
  const c = fixture();
  try {
    await c.invoke('get_document_context', {}); await c.invoke('read_document_blocks', { block_ids: c.f.document.blocks.map(b => b.block_id) });
    const source = { block_id: c.f.document.blocks[2]!.block_id, exact_quote: c.f.document.blocks[2]!.text };
    const update = { ...c.f.submission, updates_record_id: c.record.record_id, source_fragments: [source], feature_name_raw: 'irregular margin', feature_category: 'margin',
      modality: { value: 'CT', status: 'source_observed' as const, evidence: [source] },
      assertion: { value: 'affirmed' as const, original_wording: source.exact_quote, evidence: [source] }, provenance: { ...c.f.submission.provenance, evidence: [source] } };
    const before = c.store.versions(c.f.input.run_id), original = structuredClone(update);
    await assert.rejects(c.invoke('submit_candidate_records', { ...c.params, updates: [update] }), /summary_target_feature_requires_explicit_choice/);
    assert.deepEqual(update, original); assert.deepEqual(c.store.versions(c.f.input.run_id), before);
    const { updates_record_id: _target, ...separate } = update;
    await c.invoke('submit_candidate_records', { ...c.params, updates: [separate] });
    assert.equal(c.store.current(c.f.input.run_id).length, 2); assert.deepEqual(c.store.current(c.f.input.run_id).find(v => v.record.record_id === c.record.record_id), before[0]);
  } finally { c.store.close(); }
});

test('target-conflict correction never covers missing/cross-source targets, stale versions, unread source or bad bindings', async () => {
  for (const kind of ['missing', 'cross-source', 'version', 'unread', 'binding', 'glyph'] as const) {
    const c = fixture();
    try {
      await c.invoke('get_document_context', {});
      await c.invoke('read_document_blocks', { block_ids: c.f.document.blocks.slice(0, kind === 'unread' ? 2 : 3).map(b => b.block_id) });
      if (kind === 'version') c.store.modelReview(c.f.input.run_id, c.record.record_id, 1, 'synthetic-concurrent-version', []);
      const source = { block_id: c.f.document.blocks[2]!.block_id, exact_quote: c.f.document.blocks[2]!.text };
      const update = { ...structuredClone(c.f.submission), updates_record_id: kind === 'missing' ? 'synthetic-missing' : c.record.record_id,
        source_fragments: [source], feature_name_raw: 'irregular margin', feature_category: 'margin',
        modality: { value: 'CT', status: 'source_observed' as const, evidence: [source] },
        assertion: { value: 'affirmed' as const, original_wording: source.exact_quote, evidence: [source] },
        provenance: { ...c.f.submission.provenance, evidence: [source] } };
      if (kind === 'cross-source') {
        const foreign = makeEvidenceFixture(undefined, { runId: 'synthetic-other-run', documentId: 'synthetic-other-paper' });
        const other = validateEvidenceSubmission(foreign.submission, foreign.context).record!;
        c.store.create(foreign.input, foreign.context.metadata); c.store.transition(foreign.input.run_id, 'extracting');
        c.store.apply(foreign.input.run_id, reconcileEvidence(other, [])); update.updates_record_id = other.record_id;
      }
      if (kind === 'binding') update.binding.file_sha256 = 'f'.repeat(64);
      if (kind === 'glyph') c.f.document.blocks[2]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 0, end: 1,
        font_name: 'synthetic-font', font_program_sha256: 'a'.repeat(64), pdf_character_code: 109, precision: 'glyph_offset' }];
      const before = c.store.versions(c.f.input.run_id);
      await assert.rejects(c.invoke('submit_candidate_records', { ...c.params, updates: [update] }), error => {
        assert.ok(error instanceof Error); assert.ok(!error.message.includes('requires_explicit_choice'));
        assert.ok(!error.message.includes('requires_literal_source')); return true;
      });
      assert.deepEqual(c.store.versions(c.f.input.run_id), before);
    } finally { c.store.close(); }
  }
});

async function wireRecovery(options: { repeated?: boolean; requestLimit?: number; target?: boolean; mixedLimit?: boolean } = {}) {
  const c = fixture(), directory = await mkdtemp(join(tmpdir(), 'summary-metadata-wire-'));
  const common = { updates_record_id: c.record.record_id, source_unit_ids: ['su-000001'], feature_category: 'contrast', evidence_type: 'imaging_observation',
    assertion: 'affirmed', origin: 'study_authors', modality: { value: 'CT', line_indices: [1] } };
  const submit = (name: string | null): ResponsesStep => ({ calls: [{ name: 'submit_candidate_records', arguments: { ...c.params, updates: [{ ...common, feature_name_raw: name }] } }] });
  const targetUpdate = { ...common, source_unit_ids: ['su-000002'], feature_name_raw: 'irregular margin', feature_category: 'margin', modality: { value: 'CT', line_indices: [2] } };
  const badTarget: ResponsesStep = { calls: [{ name: 'submit_candidate_records', arguments: { ...c.params, updates: [targetUpdate] } }] };
  const { updates_record_id: _target, ...newCandidate } = targetUpdate;
  const separate: ResponsesStep = { calls: [{ name: 'submit_candidate_records', arguments: { ...c.params, updates: [newCandidate] } }] };
  const bad = options.target ? badTarget : submit('contrast');
  const first: ResponsesStep = { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'read_document_blocks', arguments: { line_indices: [0, 1, 2] } }] };
  const finish: ResponsesStep = { calls: [{ name: 'get_document_context', arguments: {} },
      { name: 'submit_candidate_records', arguments: { ...c.params, summary_complete: true } }] };
  const steps: ResponsesStep[] = options.mixedLimit ? [first,
    { calls: [{ name: 'submit_candidate_records', arguments: { ...c.params, unregistered_field: true } }] }, submit('contrast'), badTarget, finish] :
    [first, bad, options.repeated ? bad : options.target ? separate : submit('con\ntrast'), finish];
  const server = await createRuntimeResponsesFixture(steps);
  try {
    const budget = new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint, Date.now, { limits: { ...S4_LIMITS, requests: options.requestLimit ?? 10 },
      authorization: { id: 'synthetic-loopback-only', source: 'no-external-provider', recorded_at: '2026-11-09T00:00:00Z' } });
    const created = await createExtractionSession(server.config, developmentProfile(server.config.modelId), c.tools.definitions(), directory, budget, 'metadata-wire', 0, 8);
    const diagnostics: Array<{ type: string; detail: Record<string, unknown> }> = [];
    const recovery = new BoundedToolRecovery(created.session.agent, (type, detail) => diagnostics.push({ type, detail }));
    created.session.agent.finishTurn = turn => { const decision = recovery.afterTurn(turn); return recovery.stopped || c.tools.completed ? { action: 'end' } : decision; };
    const outcome = await promptExtractionSession(created, 'Local deterministic metadata regression, no clinical evaluation.', budget);
    const current = c.store.current(c.f.input.run_id)[0]!;
    return { outcome, diagnostics, requestCount: server.requests.length, totals: budget.totals(), completed: c.tools.completed,
      quoteUnchanged: c.store.current(c.f.input.run_id).find(v => v.record.record_id === c.record.record_id)!.record.original_quote === c.record.original_quote,
      rawName: current.record.feature_name_raw, activeRecords: c.store.current(c.f.input.run_id).length,
      proposedRawName: c.store.versions(c.f.input.run_id).find(v => v.status === 'proposed')?.record.feature_name_raw };
  } finally { c.store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
}

test('installed SDK error serialization is classified into bounded correction; explicit later metadata finishes with exact source', async () => {
  const r = await wireRecovery(); assert.equal(r.outcome.error, undefined); assert.equal(r.completed, true); assert.equal(r.requestCount, 4);
  assert.equal(r.totals.requests, 4); assert.equal(r.rawName, null); assert.equal(r.proposedRawName, 'con\ntrast'); assert.equal(r.quoteUnchanged, true);
  const error = r.outcome.events.find(e => e.type === 'tool_execution_end' && e.error === true)!;
  assert.equal(error.error_code, 'summary_raw_name_requires_literal_source');
  assert.equal(r.diagnostics.filter(d => d.type === 'protocol_correction').length, 1);
});

test('serialized target-conflict diagnosis keeps its underlying rejection and explicitly saves a separate candidate', async () => {
  const r = await wireRecovery({ target: true }); assert.equal(r.outcome.error, undefined); assert.equal(r.completed, true);
  assert.equal(r.requestCount, 4); assert.equal(r.totals.requests, 4); assert.equal(r.activeRecords, 2); assert.equal(r.quoteUnchanged, true);
  assert.equal(r.outcome.events.find(e => e.type === 'tool_execution_end' && e.error === true)?.error_code, 'summary_target_feature_requires_explicit_choice');
  assert.equal(r.diagnostics.filter(d => d.type === 'protocol_correction').length, 1);
});

test('schema, raw-name and target-conflict errors share the same two-correction ceiling through actual SDK serialization', async () => {
  const r = await wireRecovery({ mixedLimit: true }); assert.equal(r.completed, false); assert.equal(r.requestCount, 4); assert.equal(r.totals.requests, 4);
  assert.equal(r.diagnostics.filter(d => d.type === 'protocol_correction').length, 2); assert.equal(r.diagnostics.filter(d => d.type === 'protocol_diagnostic_pause').length, 1);
  assert.equal(r.quoteUnchanged, true); assert.equal(r.activeRecords, 1);
});

test('repeated serialized invalid arguments stop and a correction cannot bypass the existing physical request cap', async () => {
  const repeated = await wireRecovery({ repeated: true }); assert.equal(repeated.completed, false); assert.equal(repeated.requestCount, 3);
  assert.equal(repeated.diagnostics.filter(d => d.type === 'protocol_correction').length, 1);
  assert.equal(repeated.diagnostics.filter(d => d.type === 'protocol_diagnostic_pause').length, 1);
  const capped = await wireRecovery({ requestLimit: 2 }); assert.equal(capped.completed, false); assert.equal(capped.requestCount, 2); assert.equal(capped.totals.requests, 2);
});

test('a real identity/source/version fatal marker wins even if a safe metadata code is also present', () => {
  for (const safe of ['summary_raw_name_requires_literal_source', 'summary_target_feature_requires_explicit_choice'])
    for (const code of ['source_binding_mismatch', 'source_block_not_read', 'evidence_version_conflict'])
      assert.equal(classifyToolError(JSON.stringify({ error: safe, cause: code })), code);
});
