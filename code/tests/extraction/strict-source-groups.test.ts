import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeliveryReview, EvidenceRecord, EvidenceVersion } from '@t1/contracts';
import { buildArticleScope } from '../../packages/agent/src/article-scope.js';
import { allDeliveredRecords, auditOutputSample, buildEvidenceDelivery, deliveryRecordCounts, exportEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';
import { validateEvidenceSubmission, locateEvidenceFragment } from '../../packages/agent/src/evidence-validation.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { PRIMARY_ASSESSMENT_POLICY_VERSION } from '../../packages/agent/src/primary-evidence-assessment.js';
import { reconcileEvidence } from '../../packages/agent/src/reconciliation.js';
import { buildStrictSourceGroups, internalStructureReferencesOnly, strictSourceGroupKey, STRICT_SOURCE_GROUPING_POLICY_VERSION } from '../../packages/agent/src/strict-source-groups.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

const CODE = fileURLToPath(new URL('../../', import.meta.url));
const root = 'docs/acceptance/output-feedback-2026-11-08/comparison';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const version = (record: EvidenceRecord, actor: EvidenceVersion['actor'] = 'automatic'): EvidenceVersion => ({ record, version: 1, actor, status: 'active' });
const actualIds = ['ev-a8bb249f2b80f0a8f2878610eb4dc0297767b4de', 'ev-fc01b021580cdaac93c13a38b4f1256eba40bf92'];
async function actualPair(job: 'L07-F' | 'L07-B0') {
  const result = await json(`${root}/execution/${job}/result.json`), plan = await json(root + '/plan.json');
  const paper = plan.papers.find((p: any) => p.document_id === 'L07');
  const ids = job === 'L07-F' ? actualIds : ['ev-95bad412ee4bf8ba86160321ddd49cbffa45392d', 'ev-95bad412ee4bf8ba86160321ddd49cbffa45392d-6e59670944b6'];
  return { pair: ids.map(id => result.records.find((v: EvidenceVersion) => v.record.record_id === id)) as EvidenceVersion[],
    document: (await json(paper.ir_path)).document, catalog: await json(paper.figure_catalog_path),
    frozenDelivery: await json(`${root}/execution/${job}/delivery.json`) };
}
function syntheticPair() {
  const f = makeEvidenceFixture(['We observed spiculation on CT in lung cancer (Fig. 1).']);
  const first = validateEvidenceSubmission(f.submission, f.context).record!;
  const secondSubmission = structuredClone(f.submission);
  secondSubmission.feature_category = 'another model grouping'; secondSubmission.provenance.origin = 'cited_research';
  secondSubmission.provenance.cited_references = ['Fig. 1'];
  const validated = validateEvidenceSubmission(secondSubmission, f.context);
  assert.equal(validated.accepted, true); assert.ok(validated.issues.some(i => i.code === 'internal_structure_reference_does_not_establish_external_attribution'));
  return { ...f, first, second: validated.record! };
}

test('frozen F attribution variants form one mechanical group with both versions, unresolved Figure and original fingerprints intact', async () => {
  const f = await actualPair('L07-F'), before = JSON.stringify(f.pair);
  const delivery = buildEvidenceDelivery(f.document, f.pair, f.catalog), group = delivery.strict_source_groups![0]!;
  assert.equal(delivery.records.length, 2); assert.equal(delivery.unique_source_group_count, 1);
  assert.equal(delivery.source_grouping_policy_version, STRICT_SOURCE_GROUPING_POLICY_VERSION);
  assert.deepEqual(group.members.map(m => m.record_id), actualIds); assert.deepEqual(group.members.map(m => m.record_version), [4, 3]);
  assert.deepEqual(group.members.map(m => m.source_attribution.origin), ['cited_research', 'study_authors']);
  assert.equal(group.attribution_conflict, true); assert.equal(group.internal_reference_attribution_needs_review, true);
  assert.equal(group.needs_review, true); assert.equal(group.automatic_member_selection, false);
  for (const record of allDeliveredRecords(delivery)) {
    const original = allDeliveredRecords(f.frozenDelivery).find(r => r.record_id === record.record_id)!;
    assert.equal(record.source_record_sha256, original.source_record_sha256);
    assert.equal(record.text_fingerprint, original.text_fingerprint);
    assert.equal(record.delivery_fingerprint, original.delivery_fingerprint);
    assert.equal(record.figure_association.status, 'pending');
    assert.equal(group.members.find(m => m.record_id === record.record_id)!.source_record_sha256, record.source_record_sha256);
  }
  const sample = auditOutputSample(delivery);
  assert.equal(sample.output_count, 2); assert.equal(sample.unique_source_group_count, 1);
  assert.equal(sample.reviewed_deduplicated_effective_description_count, null);
  assert.equal(JSON.stringify(f.pair), before, 'the historical records and ordinary feedback binding are never rewritten');
});

test('frozen B0 category-only duplicate retains both records but has one source group', async () => {
  const f = await actualPair('L07-B0'), delivery = buildEvidenceDelivery(f.document, f.pair, f.catalog);
  assert.equal(delivery.records.length, 2); assert.equal(delivery.unique_source_group_count, 1);
  assert.equal(delivery.strict_source_groups![0]!.attribution_conflict, false);
  assert.equal(deliveryRecordCounts(delivery).same_source_duplicate_member_count, 1);
});

test('strict grouping never joins different source bindings, clinical evidence, conditions, literal anchors or actual contexts', () => {
  const f = makeEvidenceFixture(['We observed spiculation on CT and MRI in lung cancer and colon cancer, in arterial and venous phase.',
    'Case 1 context.', 'Case 2 context.']);
  const original = validateEvidenceSubmission(f.submission, f.context).record!;
  const changes: Array<[string, (r: EvidenceRecord) => void]> = [
    ['document', r => { r.document_id += '-another'; }], ['family', r => { r.article_family_id += '-another'; }],
    ['PDF hash', r => { r.source_version.file_sha256 = 'e'.repeat(64); }], ['source version', r => { r.source_version.version += '-another'; }],
    ['IR version', r => { r.text_version += '-another'; }], ['run', r => { r.extraction_trace.run_id += '-another'; }],
    ['task', r => { r.extraction_trace.task_id += '-another'; }], ['scope', r => { r.extraction_trace.scope.cancers.ids = ['another']; }],
    ['disease', r => { r.disease_or_lesion.value = 'colon cancer'; }], ['modality', r => { r.modality.value = 'MRI'; }],
    ['phase', r => { r.sequence_or_phase = { value: 'arterial phase', status: 'source_observed', evidence: r.quote_span.segments }; }],
    ['condition', r => { r.applicability = { status: 'specified', original_wording: 'arterial phase', evidence: r.quote_span.segments }; }],
    ['assertion', r => { r.assertion.value = 'negated'; }], ['source span', r => { r.quote_span.segments[0]!.block_id += '-another'; }],
    ['actual context', r => { r.context.fragments = [locateEvidenceFragment(f.document, { block_id: f.document.blocks[1]!.block_id, exact_quote: f.document.blocks[1]!.text })]; }],
    ['clinical evidence', r => { r.modality.evidence = [locateEvidenceFragment(f.document, { block_id: f.document.blocks[2]!.block_id, exact_quote: f.document.blocks[2]!.text })]; }],
  ];
  for (const [name, change] of changes) {
    const other = structuredClone(original); other.record_id += '-variant'; change(other);
    assert.notEqual(strictSourceGroupKey(original), strictSourceGroupKey(other), name);
    assert.equal(buildStrictSourceGroups([version(original), version(other)]).length, 2, name);
  }
  const firstContext = structuredClone(original), secondContext = structuredClone(original); secondContext.record_id += '-case-2';
  firstContext.context.fragments = [locateEvidenceFragment(f.document, { block_id: f.document.blocks[1]!.block_id, exact_quote: f.document.blocks[1]!.text })];
  secondContext.context.fragments = [locateEvidenceFragment(f.document, { block_id: f.document.blocks[2]!.block_id, exact_quote: f.document.blocks[2]!.text })];
  assert.equal(buildStrictSourceGroups([version(firstContext), version(secondContext)]).length, 2);
});

test('role, Figure and human-decision disagreements remain visible without selecting or changing a member', () => {
  const f = syntheticPair(), a = version(f.first, 'human'), b = version(f.second, 'human');
  a.record.review_status = 'approved'; b.record.review_status = 'rejected';
  const before = JSON.stringify([a, b]);
  const group = buildStrictSourceGroups([a, b], [
    { record_id: a.record.record_id, record_version: 1, effective_role: 'primary_candidate',
      figure_association: { status: 'pending', figure_ids: [], proposed_figure_ids: ['figure-1'], exact_markers: [] } },
    { record_id: b.record.record_id, record_version: 1, effective_role: 'background_suggestion',
      figure_association: { status: 'pending', figure_ids: [], proposed_figure_ids: ['figure-2'], exact_markers: [] } },
  ])[0]!;
  assert.equal(group.role_conflict, true); assert.equal(group.figure_association_conflict, true);
  assert.equal(group.human_review_disagreement, true); assert.equal(group.status, 'conflicting_members_need_review');
  assert.equal(JSON.stringify([a, b]), before);
  const externalReview: DeliveryReview = { record_id: b.record.record_id, record_version: b.version, review_scope: 'text_only',
    text_fingerprint: 'a'.repeat(64), delivery_fingerprint: null, decision: 'approved', actor: 'synthetic-another-human',
    reviewed_at: '2026-11-08T00:00:00Z', source_text_checked: true, relevance_checked: true, context_checked: true,
    figure_pairing_checked: false, reason: 'Synthetic disagreeing review preservation fixture.' };
  const retainedDisagreement = buildStrictSourceGroups([b], [{ record_id: b.record.record_id, record_version: b.version, human_confirmation: externalReview }])[0]!;
  assert.equal(retainedDisagreement.human_review_disagreement, true, 'a newer external confirmation does not erase an original human rejection from the group view');
  const proposal = { ...version(structuredClone(f.second)), status: 'proposed' as const, version: 2 };
  assert.equal(buildStrictSourceGroups([a, proposal])[0]!.members.length, 1);
});

test('new same-source attribution variants receive symmetric unresolved links and idempotent replay preserves every original version', () => {
  const f = syntheticPair(), store = new ExtractionStore(':memory:');
  try {
    store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
    store.apply(f.input.run_id, reconcileEvidence(f.first, []));
    const reconciliation = reconcileEvidence(f.second, store.versions(f.input.run_id));
    assert.equal(reconciliation.action, 'conflict');
    assert.ok(reconciliation.issues.some(i => i.startsWith('strict_same_source_attribution_conflict:')));
    store.apply(f.input.run_id, reconciliation);
    const current = store.current(f.input.run_id);
    assert.equal(current.length, 2); assert.equal(buildStrictSourceGroups(current).length, 1);
    for (const v of current) {
      assert.equal(v.record.review_status, 'needs_context');
      assert.ok(v.record.duplicate_and_conflict_links.some(l => l.relationship === 'possible_conflict' && l.record_id !== v.record.record_id));
    }
    assert.deepEqual(store.versions(f.input.run_id).find(v => v.record.record_id === f.first.record_id && v.version === 1)!.record, f.first);
    const beforeReplay = JSON.stringify(store.versions(f.input.run_id));
    const replay = reconcileEvidence(f.second, store.versions(f.input.run_id)); assert.equal(replay.action, 'idempotent');
    store.apply(f.input.run_id, replay); assert.equal(JSON.stringify(store.versions(f.input.run_id)), beforeReplay);
  } finally { store.close(); }
});

test('conflict linking protects a human current version and preserves its original approval as an immutable version', () => {
  for (const actor of ['human', 'automatic'] as const) {
    const f = syntheticPair(), store = new ExtractionStore(':memory:');
    try {
      store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
      const human = version(f.first, actor); human.record.review_status = 'approved'; human.record.handoff_status = 'approved_for_T2';
      human.record.review_events = [{ action: 'approve', actor: 'synthetic-human-only', timestamp: '2026-11-08T00:00:00Z', reason: 'Synthetic immutable approval fixture', version: 1 }];
      store.db.prepare('INSERT INTO s4_versions VALUES(?,?,?,?)').run(f.input.run_id, human.record.record_id, 1, JSON.stringify(human));
      const before = JSON.stringify(human);
      store.apply(f.input.run_id, reconcileEvidence(f.second, store.versions(f.input.run_id)));
      assert.equal(JSON.stringify(store.current(f.input.run_id).find(v => v.record.record_id === human.record.record_id)), before);
      assert.ok(store.versions(f.input.run_id).some(v => v.record.record_id === human.record.record_id && v.status === 'proposed'));
      assert.equal(buildStrictSourceGroups(store.current(f.input.run_id))[0]!.member_count, 2);
    } finally { store.close(); }
  }
});

test('one existing summary sees the group but must still assess both current member versions, without derived-group writes', async () => {
  const f = syntheticPair(), store = new ExtractionStore(':memory:');
  try {
    store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
    store.apply(f.input.run_id, reconcileEvidence(f.first, [])); store.apply(f.input.run_id, reconcileEvidence(f.second, store.versions(f.input.run_id)));
    store.transition(f.input.run_id, 'reconciling');
    const tools = new ExtractionSummaryTools({ ...f.context, primaryAssessmentPolicyVersion: PRIMARY_ASSESSMENT_POLICY_VERSION }, buildArticleScope(f.document), store, 'baseline');
    const invoke = (name: string, p: object) => tools.invoke(name, { ...p, run_id: f.input.run_id, document_id: f.document.document_id }, 'synthetic-no-model');
    const before = JSON.stringify(store.versions(f.input.run_id)), context = await invoke('get_document_context', {}) as any;
    assert.equal(context.records.length, 2); assert.equal(context.unique_source_group_count, 1);
    assert.equal(context.strict_source_groups[0].attribution_conflict, true);
    await invoke('get_document_context', {}); assert.equal(JSON.stringify(store.versions(f.input.run_id)), before);
    const params = { summary: 'Synthetic coverage test; no actual model inference.',
      links: store.current(f.input.run_id).map(v => ({ record_id: v.record.record_id,
        related_record_id: v.record.record_id === f.first.record_id ? f.second.record_id : f.first.record_id, relationship: 'possible_conflict' })),
      updates: [], summary_complete: true };
    const reviews = store.current(f.input.run_id).map(v => ({ record_id: v.record.record_id, expected_version: v.version, issue_codes: [], primary_assessment: 'uncertain' }));
    const incomplete = await invoke('submit_candidate_records', { ...params, reviews: [reviews[0]] }) as any;
    assert.equal(incomplete.complete, false); assert.ok(incomplete.completion_blockers.some((b: any) => b.code === 'primary_assessment_coverage_incomplete'));
    const complete = await invoke('submit_candidate_records', { ...params, reviews: [reviews[1]] }) as any;
    assert.equal(complete.complete, true); assert.equal(buildStrictSourceGroups(store.current(f.input.run_id)).length, 1);
    const finalVersions = store.versions(f.input.run_id).length;
    assert.equal(finalVersions, JSON.parse(before).length + 2, 'existing symmetric links do not invalidate assessments or append more versions');
    await invoke('get_document_context', {}); assert.equal(store.versions(f.input.run_id).length, finalVersions);
  } finally { store.close(); }
});

test('approved export never borrows another member approval or includes a member outside the actual export set', async () => {
  const directory = await mkdtemp(resolve(CODE, '.tools/source-group-export-'));
  try {
    const f = makeEvidenceFixture(), bytes = Buffer.from('%PDF synthetic source group export fixture only');
    const sha = createHash('sha256').update(bytes).digest('hex'), pdfPath = resolve(directory, 'source.pdf');
    await writeFile(pdfPath, bytes); f.document.source.file_reference = pdfPath; f.document.file_sha256 = sha; f.input.file_sha256 = sha;
    f.context.metadata.source_version.file_sha256 = sha; f.submission.binding.file_sha256 = sha;
    const first = validateEvidenceSubmission(f.submission, f.context).record!, second = structuredClone(first);
    second.record_id += '-another'; second.feature_category = 'second model label';
    const versions = [version(first), version(second)], delivery = buildEvidenceDelivery(f.document, versions);
    const reviews: DeliveryReview[] = delivery.records.map(r => ({ record_id: r.record_id,
      record_version: r.record_version, text_fingerprint: r.text_fingerprint, delivery_fingerprint: null, review_scope: 'text_only', decision: 'approved',
      actor: 'synthetic-reviewer', reviewed_at: '2026-11-08T00:00:00Z', source_text_checked: true, relevance_checked: true,
      context_checked: true, figure_pairing_checked: false, reason: 'Synthetic approval gate fixture; no real medical review.' }));
    const options = { codeRoot: CODE, mode: 'approved' as const, coverage: { fixture: true } };
    const denied = resolve(directory, 'denied');
    await assert.rejects(exportEvidenceDelivery(f.document, versions, { ...options, directory: denied, reviews: [reviews[0]!] }), /approved_export_requires_each_record_confirmation/);
    await assert.rejects(access(denied));
    const subset = await exportEvidenceDelivery(f.document, [versions[0]!], { ...options, directory: resolve(directory, 'subset'), reviews: [reviews[0]!] });
    assert.equal(subset.delivery.strict_source_groups![0]!.member_count, 1);
    assert.equal(subset.delivery.strict_source_groups![0]!.members[0]!.record_id, first.record_id);
    const both = await exportEvidenceDelivery(f.document, versions, { ...options, directory: resolve(directory, 'both'), reviews });
    assert.equal(both.manifest.record_count, 2); assert.equal(both.manifest.unique_source_group_count, 1);
    assert.equal(both.delivery.strict_source_groups![0]!.member_count, 2);
    assert.ok(both.delivery.strict_source_groups![0]!.members.every(m => m.human_confirmation?.decision === 'approved'));
    assert.equal((await readFile(resolve(directory, 'both/records.jsonl'), 'utf8')).trim().split('\n').length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only explicit internal structure markers trigger the narrow provenance warning; external citations are not rewritten', () => {
  assert.equal(internalStructureReferencesOnly(['Fig. 2', 'Table 3']), true);
  assert.equal(internalStructureReferencesOnly(['Fig. 2', '[26]']), false);
  assert.equal(internalStructureReferencesOnly(['Smith et al. 2024']), false);
  assert.equal(internalStructureReferencesOnly([]), false);
});

test('future offline preparation binds the standalone grouping module and its version without rewriting the frozen plan', async () => {
  const directory = await mkdtemp(resolve(CODE, 'runtime-data/source-group-prepare-'));
  const frozenPath = resolve(CODE, root, 'plan.json'), before = await readFile(frozenPath);
  try {
    const output = resolve(directory, 'prepared');
    const prepared = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/compare-extraction-methods.ts', 'prepare',
      '--directory', output, '--config', 'config/two-method-comparison.json'], { cwd: CODE, encoding: 'utf8', timeout: 20_000 });
    assert.equal(prepared.status, 0, prepared.stderr);
    const plan = await json(resolve(output, 'plan.json')), modulePath = 'packages/agent/src/strict-source-groups.ts';
    assert.equal(plan.source_hashes[modulePath], createHash('sha256').update(await readFile(resolve(CODE, modulePath))).digest('hex'));
    assert.equal(plan.common.source_grouping_policy_version, STRICT_SOURCE_GROUPING_POLICY_VERSION);
    assert.equal(plan.common.normal_anatomic_scope_rule_version, 'normal-anatomic-and-tissue-context-only-2');
    assert.equal(plan.status, 'prepared_no_model_calls_pending_new_user_authorization');
    await assert.rejects(access(resolve(output, 'execution')));
    assert.deepEqual(await readFile(frozenPath), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
