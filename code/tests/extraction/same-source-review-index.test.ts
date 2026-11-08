import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { EvidenceRecord, EvidenceVersion } from '@t1/contracts';
import { buildSameSourceReviewIndex, buildStrictSourceGroups, sameSourceReviewKey, SAME_SOURCE_REVIEW_INDEX_VERSION } from '../../packages/agent/src/strict-source-groups.js';
import { buildEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';

const base = 'docs/acceptance/s4-b0-revalidation-2026-11-08';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function actual() {
  const resultPath = base + '/prepared/execution/L07-B0/result.json', bytes = await readFile(resultPath);
  const result = JSON.parse(bytes.toString('utf8'));
  return { resultPath, bytes, result, versions: result.records as EvidenceVersion[] };
}

test('the real 26 L07 records expose all three same-source pairs without changing original members, links or 25 strict groups', async () => {
  const f = await actual(), before = JSON.stringify(f.versions), oldStrict = buildStrictSourceGroups(f.versions);
  const index = buildSameSourceReviewIndex(f.versions);
  assert.equal(index.schema_version, SAME_SOURCE_REVIEW_INDEX_VERSION); assert.equal(index.raw_current_record_count, 26);
  assert.equal(index.source_context_group_count, 23); assert.equal(index.same_source_multi_member_group_count, 3);
  assert.equal(oldStrict.length, 25); assert.deepEqual(buildStrictSourceGroups(f.versions), oldStrict);
  const annular = index.groups.find(g => g.shared_literal_source.original_quote.startsWith('Partly annular/semicircumferential'))!;
  assert.equal(annular.member_count, 2); assert.equal(annular.strict_source_key_count, 2);
  assert.ok(annular.evidence_field_differences.includes('disease_or_lesion'));
  assert.ok(annular.evidence_field_differences.includes('numeric_expressions'));
  assert.ok(annular.members.every(m => m.original_duplicate_and_conflict_links.length === 0));
  const mucin = index.groups.find(g => g.shared_literal_source.original_quote.startsWith('Mucin-containing rectal cancer'))!;
  assert.equal(mucin.member_count, 2); assert.equal(mucin.strict_source_key_count, 2);
  assert.ok(mucin.evidence_field_differences.includes('disease_or_lesion'));
  assert.ok(mucin.evidence_field_differences.includes('source_attribution'));
  const mrf = index.groups.find(g => g.shared_literal_source.original_quote.startsWith(' C Tumor at the level'))!;
  assert.equal(mrf.member_count, 2); assert.equal(mrf.strict_source_key_count, 1);
  for (const group of index.groups) for (const m of group.members) {
    const v = f.versions.find(v => v.record.record_id === m.record_id && v.version === m.record_version)!;
    assert.equal(m.source_record_sha256, sha(JSON.stringify(v.record)));
    assert.deepEqual(m.original_duplicate_and_conflict_links, v.record.duplicate_and_conflict_links);
    assert.deepEqual(m.evidence_fields.source_attribution, v.record.context.source_attribution);
    assert.equal(group.patient_equivalence_claimed, false); assert.equal(group.automatic_record_merge, false);
    assert.equal(group.automatic_member_selection, false); assert.equal(group.approval_propagated, false);
  }
  assert.equal(JSON.stringify(f.versions), before); assert.deepEqual(await readFile(f.resultPath), f.bytes);
});

test('different run/task/scope/PDF/IR/ordered source anchors or actual context never share the review key', async () => {
  const f = await actual(), original = f.versions[0]!.record;
  const changes: Array<(r: EvidenceRecord) => void> = [
    r => { r.extraction_trace.run_id += '-another'; }, r => { r.extraction_trace.task_id += '-another'; },
    r => { r.extraction_trace.scope.cancers.ids = ['another']; }, r => { r.document_id += '-another'; },
    r => { r.article_family_id += '-another'; }, r => { r.source_version.file_sha256 = 'b'.repeat(64); },
    r => { r.source_version.version += '-another'; }, r => { r.text_version += '-another'; },
    r => { r.quote_span.segments[0]!.block_id += '-another'; }, r => { r.quote_span.segments[0]!.start++; },
    r => { r.quote_span.segments.reverse(); }, r => { r.context.before += 'A different actual case context.'; },
    r => { r.context.fragments = [structuredClone(r.quote_span.segments[0]!)]; },
  ];
  for (const change of changes) {
    const other = structuredClone(original); other.record_id += '-another'; change(other);
    assert.notEqual(sameSourceReviewKey(original), sameSourceReviewKey(other));
    const index = buildSameSourceReviewIndex([{ record: original, version: 1, status: 'active', actor: 'automatic' },
      { record: other, version: 1, status: 'active', actor: 'automatic' }]);
    assert.equal(index.source_context_group_count, 2);
  }
});

test('Fig.2 in cited references is visible even with unclear origin or mixed external citations, while [26] is not a Figure marker', async () => {
  const f = await actual(), index = buildSameSourceReviewIndex(f.versions);
  const unclearFigures = index.internal_reference_hints.filter(h => h.original_origin_unapproved === 'unclear' && h.internal_structure_markers.some(m => /fig/iu.test(m)));
  assert.ok(unclearFigures.length >= 2);
  assert.ok(index.internal_reference_hints.every(h => !h.internal_structure_markers.includes('[26]')));
  const r = structuredClone(f.versions[0]!.record); r.context.source_attribution.origin = 'unclear';
  r.context.source_attribution.cited_references = ['Fig. 2', '[26]', 'Table 3']; const before = JSON.stringify(r);
  const mixed = buildSameSourceReviewIndex([{ record: r, version: 1, actor: 'automatic', status: 'active' }]);
  assert.deepEqual(mixed.internal_reference_hints[0]!.internal_structure_markers, ['Fig. 2', 'Table 3']);
  assert.equal(mixed.internal_reference_hints[0]!.origin_modified, false);
  assert.equal(JSON.stringify(r), before);
});

test('an original human decision remains unchanged and proposals never become active index members', async () => {
  const f = await actual(), human = structuredClone(f.versions[0]!); human.actor = 'human'; human.record.review_status = 'approved';
  human.record.review_events = [{ action: 'approve', actor: 'synthetic-test-human', timestamp: '2026-11-08T00:00:00Z', reason: 'Synthetic protection fixture only', version: human.version }];
  const proposal = structuredClone(human); proposal.status = 'proposed'; proposal.version++;
  proposal.record.context.source_attribution.origin = 'unclear'; const before = JSON.stringify([human, proposal]);
  const index = buildSameSourceReviewIndex([human, proposal]);
  assert.equal(index.raw_current_record_count, 1); assert.equal(index.groups[0]!.members[0]!.record_actor, 'human');
  assert.deepEqual(index.groups[0]!.members[0]!.review_events, human.record.review_events);
  assert.equal(index.human_approval_modified, false); assert.equal(JSON.stringify([human, proposal]), before);
  index.groups[0]!.members[0]!.evidence_fields.source_attribution.origin = 'study_authors';
  assert.equal(JSON.stringify([human, proposal]), before, 'derived copies do not alias the original human version');
});

test('all paid delivery bytes/fingerprints, existing strict groups and the finalized original binding remain unchanged', async () => {
  const bindingPath = base + '/output-binding.json', bindingBytes = await readFile(bindingPath), binding = JSON.parse(bindingBytes.toString('utf8'));
  const plan = await json(base + '/prepared/plan.json');
  for (const job of binding.jobs) {
    assert.equal(await readFile(job.result_path).then(sha), job.result_sha256);
    const r = await json(job.result_path), paper = plan.papers.find((p: any) => p.job_id === job.job_id);
    const document = (await json(paper.ir_path)).document, catalog = await json(paper.figure_catalog_path);
    const rebuilt = buildEvidenceDelivery(document, r.records, catalog), paidRaw = await json(base + '/prepared/execution/' + job.job_id + '/delivery.json');
    assert.equal(JSON.stringify(rebuilt), JSON.stringify(paidRaw), 'existing full raw delivery including strict groups and fingerprints is byte-equivalent');
    buildSameSourceReviewIndex(r.records);
    assert.equal(await readFile(job.candidate_export.delivery_path).then(sha), job.candidate_export.delivery_sha256);
    assert.equal(await readFile(job.candidate_export.manifest_path).then(sha), job.candidate_export.manifest_sha256);
    for (const [file, expected] of Object.entries(job.candidate_export.file_sha256)) if (expected !== null)
      assert.equal(await readFile(job.candidate_export.directory + '/' + file).then(sha), expected);
  }
  assert.deepEqual(await readFile(bindingPath), bindingBytes);
  assert.equal(await readFile(binding.ledger_path).then(sha), binding.ledger_sha256);
});
