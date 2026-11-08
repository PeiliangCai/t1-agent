import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EvidenceRecord, EvidenceVersion, PrimaryAssessment, DeliveryReview } from '@t1/contracts';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { expandBatchLineEvidence } from '../../packages/agent/src/extraction-protocol.js';
import { EXTRACTION_SYSTEM_RULES } from '../../packages/agent/src/extraction-pi.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { buildArticleScope, planExtractionBatches } from '../../packages/agent/src/article-scope.js';
import { reconcileEvidence } from '../../packages/agent/src/reconciliation.js';
import { allDeliveredRecords, auditOutputSample, buildEvidenceDelivery, deliveryRecordCounts, exportEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';
import { prepareOutputSample } from '../../evaluation/src/output-sampling.js';
import { selectVersionedOutputSample } from '../../evaluation/src/output-review-pack.js';
import { PRIMARY_ASSESSMENT_POLICY_VERSION, PRIMARY_SCOPE_RULE } from '../../packages/agent/src/primary-evidence-assessment.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

const root = 'docs/acceptance/s0-s4-recheck-2026-11-08';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function actualCase(prefix: string) {
  const pack = await json(root + '/output-review/data.json'), c = pack.cases.find((v: any) => v.case_id.startsWith(prefix));
  const job = c.source_binding.job_id;
  const result = await json(root + (job === 'L07-B0' ? '/comparison/offline-delivery-recovery/recovered-L07-B0-result.json' : `/comparison/execution/${job}/result.json`));
  const version = result.versions.find((v: EvidenceVersion) => v.record.record_id === c.source_binding.record_id && v.version === c.source_binding.record_version) as EvidenceVersion;
  return { c, version, document: (await json(root + `/production/${c.source_id}/parser-result.json`)).document,
    catalog: await json(root + `/production/${c.source_id}/figure-assets/catalog.json`) };
}
function assessed(version: EvidenceVersion, value: PrimaryAssessment): EvidenceVersion {
  const next = structuredClone(version); next.version++;
  next.record.evidence_validation.model_semantic_review = { status: 'reviewed_unapproved', model_id: 'synthetic-router-only',
    issue_codes: [], primary_assessment: value, assessment_policy_version: PRIMARY_ASSESSMENT_POLICY_VERSION };
  return next;
}

test('actual C03/C06 legacy issue strings never silently classify; explicit structured background routing retains every source span', async () => {
  for (const prefix of ['C03-', 'C06-']) {
    const f = await actualCase(prefix), before = JSON.stringify(f.version);
    const legacy = buildEvidenceDelivery(f.document, [f.version], f.catalog);
    assert.equal(legacy.records.length, 1); assert.equal(legacy.background_records, undefined);
    const next = assessed(f.version, 'context_only_suggested'), delivery = buildEvidenceDelivery(f.document, [f.version, next], f.catalog);
    assert.equal(delivery.records.length, 0); assert.equal(delivery.background_records!.length, 1);
    const bg = delivery.background_records![0]!;
    assert.deepEqual(bg.original_fragments, f.version.record.quote_span.segments);
    assert.deepEqual(bg.context_fragments, f.version.record.context.fragments);
    assert.equal(bg.primary_assessment!.value, 'context_only_suggested');
    assert.equal(bg.primary_assessment!.model_id, 'synthetic-router-only');
    assert.equal(bg.primary_assessment!.record_version, next.version);
    assert.equal(bg.primary_assessment!.human_approved, false);
    assert.notEqual(bg.delivery_fingerprint, legacy.records[0]!.delivery_fingerprint);
    assert.equal(JSON.stringify(f.version), before);
  }
});

test('mixed and uncertain actual C07/C09 retain complete text; literal Fig.2, caption membership and measurement words are separate facts', async () => {
  for (const [prefix, value] of [['C07-', 'mixed_or_needs_context'], ['C09-', 'uncertain']] as const) {
    const f = await actualCase(prefix), delivery = buildEvidenceDelivery(f.document, [assessed(f.version, value)], f.catalog);
    const record = delivery.records[0]!;
    assert.equal(allDeliveredRecords(delivery).length, 1); assert.equal(delivery.background_records!.length, 0);
    assert.deepEqual(record.original_fragments, f.version.record.quote_span.segments);
    if (prefix === 'C07-') {
      assert.ok(record.original_fragments.map(f => f.exact_quote).join('\n').includes('but not'));
      assert.equal(record.figure_association.exact_markers[0]!.number, '2');
      assert.equal(record.figure_association.status, 'pending');
    } else assert.equal(record.figure_association.status, 'no_explicit_reference');
  }
  const f = await actualCase('C14-'), source = f.version.record.quote_span.segments;
  const members = f.catalog.figures.filter((g: any) => g.caption_segments.some((c: any) => source.some(s => c.block_id === s.block_id && c.start < s.end && s.start < c.end)));
  assert.deepEqual(members.map((g: any) => g.figure_number), ['2']);
});

test('both real delivery-rejected L07 records still fail the original context guard even when suggested as background', async () => {
  for (const prefix of ['C13-', 'C14-']) {
    const f = await actualCase(prefix);
    assert.throws(() => buildEvidenceDelivery(f.document, [assessed(f.version, 'context_only_suggested')], f.catalog), /delivery_visual_statement_policy_failed/);
  }
});

test('user-confirmed scope examples route complete appearance and necessary negation, standalone conclusion and pure normal tissue/range separately', async () => {
  const visual = await actualCase('C07-'), normal = await actualCase('C09-');
  const vd = buildEvidenceDelivery(visual.document, [assessed(visual.version, 'visual_evidence_suggested')], visual.catalog);
  assert.deepEqual(vd.records[0]!.original_fragments, visual.version.record.quote_span.segments);
  assert.ok(vd.records[0]!.original_fragments.map(f => f.exact_quote).join('\n').includes('but not'));
  const nd = buildEvidenceDelivery(normal.document, [assessed(normal.version, 'context_only_suggested')], normal.catalog);
  assert.equal(nd.records.length, 0); assert.deepEqual(nd.background_records![0]!.original_fragments, normal.version.record.quote_span.segments);
  for (const [quote, role] of [['Rectal tumor abutting the peritoneum alone should not be considered peritoneal invasion.', 'context_only_suggested'],
    ['The normal submucosal layer is hyperintense on T2WI.', 'context_only_suggested'],
    ['The tumor is hypointense compared with the adjacent normal submucosal layer on T2WI.', 'visual_evidence_suggested'],
    ['By measurement, the CT image shows a 9 mm nodule measuring 35 HU.', 'visual_evidence_suggested']] as const) {
    const f = makeEvidenceFixture([quote]);
    const submission = expandBatchLineEvidence({ source_line_indices: [0], feature_name_raw: null, feature_category: 'synthetic-routing',
      evidence_type: 'imaging_observation', assertion: 'unknown', origin: 'study_authors' }, f.document.blocks, f.submission.binding);
    const result = validateEvidenceSubmission(submission, { ...f.context, evidencePolicyVersion: 'visual-statements-2' });
    assert.equal(result.accepted, true, JSON.stringify(result.issues));
    const d = buildEvidenceDelivery(f.document, [assessed({ record: result.record!, version: 1, status: 'active', actor: 'automatic' }, role)]);
    assert.equal(d.records.length, role === 'context_only_suggested' ? 0 : 1);
    assert.equal(allDeliveredRecords(d)[0]!.original_fragments.map(f => f.exact_quote).join('\n'), quote);
  }
  // Routing uses explicitly scripted user-confirmed example roles. This is not a
  // claim that a real model now infers those roles correctly.
});

function summaryFixture() {
  const f = makeEvidenceFixture(), store = new ExtractionStore(':memory:');
  store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
  const context = { ...f.context, evidencePolicyVersion: 'visual-statements-2' as const, primaryAssessmentPolicyVersion: PRIMARY_ASSESSMENT_POLICY_VERSION };
  const record = validateEvidenceSubmission(f.submission, context).record!;
  store.apply(f.input.run_id, reconcileEvidence(record, [])); store.transition(f.input.run_id, 'reconciling');
  const tools = new ExtractionSummaryTools(context, buildArticleScope(f.document), store, 'baseline');
  const invoke = (name: string, p: object) => tools.invoke(name, { ...p, run_id: f.input.run_id, document_id: f.input.document_id }, 'synthetic-summary');
  const params = { summary: 'Synthetic contract check, not medical/model quality validation.', reviews: [], links: [], updates: [], summary_complete: true };
  return { f, store, tools, record, invoke, params };
}

test('new shared summary requires assessment, exposes omitted coverage, and rechecks a new version; old protocol remains readable', async () => {
  const c = summaryFixture();
  try {
    assert.ok(EXTRACTION_SYSTEM_RULES.includes(PRIMARY_SCOPE_RULE));
    const article = buildArticleScope(c.f.document), batch = planExtractionBatches(c.f.document, article)[0]!;
    assert.ok(new ExtractionTools({ ...c.f.context, evidencePolicyVersion: 'visual-statements-2' }, batch, article, c.store, 'batch_lines')
      .definitions().find(t => t.name === 'submit_candidate_records')!.description.includes(PRIMARY_SCOPE_RULE));
    assert.ok(c.tools.definitions().find(t => t.name === 'submit_candidate_records')!.description.includes(PRIMARY_SCOPE_RULE));
    await c.invoke('get_document_context', {});
    const missing = await c.invoke('submit_candidate_records', c.params) as any;
    assert.equal(missing.complete, false);
    assert.ok(missing.completion_blockers.some((v: any) => v.code === 'primary_assessment_coverage_incomplete'));
    const unassessed = buildEvidenceDelivery(c.f.document, c.store.current(c.f.input.run_id));
    assert.equal(unassessed.records[0]!.primary_assessment!.status, 'not_performed');
    assert.equal(unassessed.records[0]!.primary_assessment!.value, null);
    assert.equal(unassessed.background_records!.length, 0);
    const review = { record_id: c.record.record_id, expected_version: 1, issue_codes: [] };
    await assert.rejects(c.invoke('submit_candidate_records', { ...c.params, reviews: [review] }), /summary_primary_assessment_required/);
    assert.equal(c.store.current(c.f.input.run_id)[0]!.version, 1);
    const submit = c.tools.definitions().find(d => d.name === 'submit_candidate_records')!;
    assert.ok((submit.parameters as any).properties.reviews.items.required.includes('primary_assessment'));
    await assert.rejects(submit.execute('synthetic-missing-field', { ...c.params, reviews: [review] }, undefined, undefined,
      {} as Parameters<typeof submit.execute>[4]), /summary_primary_assessment_required/);
    const done = await c.invoke('submit_candidate_records', { ...c.params, reviews: [{ ...review, primary_assessment: 'uncertain' }] }) as any;
    assert.equal(done.complete, true);
    const current = c.store.current(c.f.input.run_id)[0]!, changed = structuredClone(current.record);
    changed.evidence_validation.model_semantic_review = { status: 'not_performed', model_id: null, issue_codes: [] };
    c.store.apply(c.f.input.run_id, { action: 'update', changes: [{ kind: 'append', record_id: changed.record_id, expected_version: current.version, record: changed }], issues: [] } as any);
    const stale = await c.invoke('submit_candidate_records', c.params) as any;
    assert.equal(stale.complete, false); assert.ok(stale.completion_blockers.some((v: any) => v.code === 'primary_assessment_coverage_incomplete'));
    const legacy = new ExtractionSummaryTools(c.f.context, buildArticleScope(c.f.document), c.store, 'baseline');
    assert.equal((legacy.definitions().find(d => d.name === 'submit_candidate_records')!.parameters as any).properties.reviews.items.required.includes('primary_assessment'), false);
  } finally { c.store.close(); }
});

test('model assessment of a human current version remains a proposal and cannot move that version to background', async () => {
  const c = summaryFixture();
  try {
    const current = c.store.current(c.f.input.run_id)[0]!, human = { ...current, actor: 'human' as const };
    c.store.db.prepare('UPDATE s4_versions SET envelope_json=? WHERE run_id=? AND record_id=? AND version=?')
      .run(JSON.stringify(human), c.f.input.run_id, c.record.record_id, current.version);
    const before = c.store.current(c.f.input.run_id)[0]!;
    const proposal = c.store.modelReview(c.f.input.run_id, c.record.record_id, before.version, 'synthetic-router-only', [], 'context_only_suggested');
    assert.equal(proposal.status, 'proposed'); assert.deepEqual(c.store.current(c.f.input.run_id)[0], before);
    const delivery = buildEvidenceDelivery(c.f.document, c.store.versions(c.f.input.run_id));
    assert.equal(delivery.records.length, 1); assert.equal(delivery.background_records!.length, 0);
  } finally { c.store.close(); }
});

test('background JSON/CSV, sampling and audit retain total denominator; a genuine bound human approval can override the suggestion', async () => {
  const f = await actualCase('C03-'), next = assessed(f.version, 'context_only_suggested');
  const directory = await mkdtemp(resolve('.tools/primary-assessment-'));
  try {
    const opts = { codeRoot: process.cwd(), directory: resolve(directory, 'candidates'), mode: 'candidates' as const, coverage: { complete: false } };
    const exported = await exportEvidenceDelivery(f.document, [next], opts);
    assert.deepEqual(deliveryRecordCounts(exported.delivery), { total_output_count: 1, primary_candidate_count: 0, background_suggestion_count: 1,
      unique_source_group_count: 1, same_source_duplicate_member_count: 0, source_grouping_is_not_medical_deduplication: true,
      model_classification_is_not_quality_improvement: true });
    assert.equal(exported.manifest.record_count, 1); assert.equal(exported.sample.output_count, 1); assert.equal(exported.sample.unreviewed_count, 1);
    assert.equal((await readFile(resolve(opts.directory, 'records.jsonl'), 'utf8')), '');
    const bg = JSON.parse(await readFile(resolve(opts.directory, 'background-records.jsonl'), 'utf8'));
    assert.deepEqual(bg.original_fragments, next.record.quote_span.segments);
    assert.ok((await readFile(resolve(opts.directory, 'background-records.csv'), 'utf8')).includes('nodules ≤ 12.6 mm'));
    const prepared = prepareOutputSample(exported.delivery, { count: 1, seed: 'synthetic-routing', selectionMethod: 'all sources, not a model test' });
    assert.equal(prepared.output_count, 1); assert.equal(prepared.selected_records.length, 1);
    assert.equal(selectVersionedOutputSample(exported.delivery, { count: 1, seed: 'synthetic-routing', jobId: 'synthetic' }).records.length, 1);
    assert.equal(auditOutputSample(exported.delivery).medical_precision, null);
    await assert.rejects(exportEvidenceDelivery(f.document, [next], { ...opts, directory: resolve(directory, 'unapproved'), mode: 'approved' }), /each_record_confirmation/);
    const review: DeliveryReview = { record_id: bg.record_id, record_version: bg.record_version, review_scope: 'text_only',
      text_fingerprint: bg.text_fingerprint, delivery_fingerprint: null, decision: 'approved', actor: 'synthetic-human',
      reviewed_at: '2026-11-08T00:00:00Z', source_text_checked: true, relevance_checked: true, context_checked: true,
      figure_pairing_checked: false, reason: 'Synthetic precedence test, not a medical approval of this real quote.' };
    const approved = await exportEvidenceDelivery(f.document, [next], { ...opts, directory: resolve(directory, 'human-approved-fixture'), mode: 'approved', reviews: [review] });
    assert.equal(approved.delivery.records.length, 1); assert.equal(approved.delivery.background_records!.length, 0);
    assert.equal(approved.delivery.records[0]!.primary_assessment!.human_confirmation_overrides_grouping, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
