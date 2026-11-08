/** Offline only, after original paid outputs and their binding were finalized. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSameSourceReviewIndex, SAME_SOURCE_REVIEW_INDEX_VERSION } from '../../../../packages/agent/src/strict-source-groups.ts';

const here = dirname(fileURLToPath(import.meta.url)), base = resolve(here, '..'), code = resolve(here, '../../../..');
const rel = path => relative(code, path), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = async path => sha(await readFile(path)), json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const parentPath = resolve(base, 'output-binding.json'), parentHash = await hash(parentPath), parent = await json(parentPath);
assert.equal(parentHash, '77571cdec58805e18ddfc7ec79e735310c1da50c34b3dfdb08fe0bfb21b43826');
const plan = await json(resolve(code, parent.plan_path)), helper = 'packages/agent/src/strict-source-groups.ts';
const paidHash = plan.source_hashes[helper], currentHash = await hash(resolve(code, helper));
const oldBytes = await readFile(resolve(base, 'prepared/source-snapshot', helper)), newBytes = await readFile(resolve(code, helper));
assert.equal(sha(oldBytes), paidHash); assert.ok(newBytes.subarray(0, oldBytes.length).equals(oldBytes));
let otherCurrentSourcesChecked = 0;
for (const [path, expected] of Object.entries(plan.source_hashes)) {
  assert.equal(await hash(resolve(base, 'prepared/source-snapshot', path)), expected);
  if (path !== helper) { assert.equal(await hash(resolve(code, path)), expected); otherCurrentSourcesChecked++; }
}
assert.equal(otherCurrentSourcesChecked, 65);
const jobs = [], diagnostics = [];
for (const job of parent.jobs) {
  assert.equal(await hash(resolve(code, job.result_path)), job.result_sha256);
  const result = await json(resolve(code, job.result_path)), index = buildSameSourceReviewIndex(result.records);
  const delivered = await json(resolve(code, job.candidate_export.delivery_path));
  assert.equal(await hash(resolve(code, job.candidate_export.delivery_path)), job.candidate_export.delivery_sha256);
  assert.equal(await hash(resolve(code, job.candidate_export.manifest_path)), job.candidate_export.manifest_sha256);
  for (const [file, expected] of Object.entries(job.candidate_export.file_sha256)) if (expected !== null)
    assert.equal(await hash(resolve(code, job.candidate_export.directory, file)), expected);
  jobs.push({ job_id: job.job_id, result_path: job.result_path, result_sha256: job.result_sha256,
    original_strict_source_group_count: delivered.unique_source_group_count, original_strict_groups_replaced: false, index });
  const events = result.events, candidate = events.filter(e => e.type === 'candidate_validation_rejected'), protocol = events.filter(e => e.type === 'tool_protocol_rejected');
  const count = values => Object.fromEntries([...new Set(values)].map(k => [k, values.filter(v => v === k).length]));
  diagnostics.push({ job_id: job.job_id, candidate_validation_rejected_events: candidate.length,
    candidate_hard_issue_occurrences: count(candidate.flatMap(e => (e.detail.issues ?? []).filter(i => i.severity === 'reject').map(i => i.code))),
    tool_protocol_rejected_events: protocol.length, tool_protocol_error_occurrences: count(protocol.map(e => e.detail.error_code)),
    hard_issue_occurrences_are_not_unique_records: true, final_delivery_validation: result.delivery_validation,
    no_new_prompt_or_tool_protocol_change: true });
}
const l07 = jobs.find(j => j.job_id === 'L07-B0');
assert.equal(l07.index.raw_current_record_count, 26); assert.equal(l07.original_strict_source_group_count, 25);
assert.equal(l07.index.same_source_multi_member_group_count, 3); assert.equal(l07.index.source_context_group_count, 23);
const createdAt = new Date().toISOString(), indexPath = resolve(here, 'same-source-review-index.json');
await save(indexPath, { schema_version: SAME_SOURCE_REVIEW_INDEX_VERSION, generated_at: createdAt, evidence_kind: 'offline_derived_review_index_after_paid_execution',
  parent_output_binding_path: rel(parentPath), parent_output_binding_sha256: parentHash, jobs,
  changed_original_records: false, automatic_medical_deduplication: false, human_approval_propagated: false,
  used_in_paid_model_execution: false, extra_model_requests: 0,
  note: 'A source/context review index only. Clinical/numeric/attribution differences stay with every member; no same-patient conclusion, merge, representative selection or approval propagation. Existing strict groups/counts and original output bytes are unchanged.' });
const verificationPath = resolve(here, 'verification.json');
await save(verificationPath, { schema_version: 'same-source-review-postprocessing-verification-1', completed_at: createdAt,
  policy_version: SAME_SOURCE_REVIEW_INDEX_VERSION, parent_output_binding_sha256: parentHash,
  paid_runtime_source_files: 66, frozen_model_source_snapshots_all_match_plan: true, unchanged_other_current_runtime_files: otherCurrentSourcesChecked,
  only_current_runtime_source_path_changed: helper, previous_source_bytes_are_exact_prefix: true,
  original_results_exports_reviews_and_ledger_bytes_unchanged: true,
  original_strict_groups_and_all_delivery_fingerprints_unchanged: true,
  tests: { command: 'bash scripts/with-node.sh node --import tsx --test tests/extraction/same-source-review-index.test.ts tests/extraction/strict-source-groups.test.ts',
    tests: 15, passed: 15, failed: 0, skipped: 0, exit_code: 0, log_path: rel(resolve(here, 'offline-tests.log')), log_sha256: await hash(resolve(here, 'offline-tests.log')) },
  typescript: { command: 'bash scripts/with-node.sh npm exec tsc -- --noEmit', exit_code: 0, log_path: rel(resolve(here, 'typecheck.log')), log_sha256: await hash(resolve(here, 'typecheck.log')) },
  real_L07_replay: { raw_current_records: 26, original_strict_source_groups: 25, literal_source_context_review_groups: 23, multi_member_groups_seen: 3,
    no_medical_effective_description_count_claimed: true },
  internal_structure_reference_policy: 'Inspect each cited_references item irrespective of origin. Fig.2/Table markers require reference-role review; [26] is not an internal Figure marker. Attribution itself is retained, not corrected.',
  intermediate_paid_run_diagnostics: diagnostics,
  diagnostics_note: 'Intermediate submission/protocol rejections remain in original events and count toward the 72 paid requests. They are separate from final delivery rejection=0. No new paid correction, prompt change or protocol expansion is included here.',
  additional_real_model_provider_requests: 0, paid_authorization_remains_closed: true, formal_architecture_reviews_used: 3, medical_quality_approved: false,
  source_review_index_path: rel(indexPath), source_review_index_sha256: await hash(indexPath), helper_source_sha256: currentHash });
assert.equal(await hash(resolve(code, parent.ledger_path)), parent.ledger_sha256);
assert.equal(await hash(parentPath), parentHash);
const bindingPath = resolve(here, 'binding.json');
await save(bindingPath, { schema_version: 'b0-derived-source-review-binding-1', finalized: true, finalized_at: createdAt, path_base: 'code',
  policy_version: SAME_SOURCE_REVIEW_INDEX_VERSION, parent_output_binding_path: rel(parentPath), parent_output_binding_sha256: parentHash,
  helper_source_path: helper, model_runtime_sha256: paidHash, postprocessing_source_sha256: currentHash,
  model_runtime_source_snapshot_path: rel(resolve(base, 'prepared/source-snapshot', helper)),
  source_review_index_path: rel(indexPath), source_review_index_sha256: await hash(indexPath),
  offline_test_path: rel(resolve(here, 'offline-tests.log')), offline_test_sha256: await hash(resolve(here, 'offline-tests.log')),
  offline_typecheck_path: rel(resolve(here, 'typecheck.log')), offline_typecheck_sha256: await hash(resolve(here, 'typecheck.log')),
  verification_path: rel(verificationPath), verification_sha256: await hash(verificationPath),
  generator_path: rel(fileURLToPath(import.meta.url)), generator_sha256: await hash(fileURLToPath(import.meta.url)),
  source_results: jobs.map(j => ({ job_id: j.job_id, result_path: j.result_path, result_sha256: j.result_sha256 })),
  guard_policy: { all_66_model_snapshots_must_match_plan: true, other_65_current_sources_must_match_paid_plan: true,
    only_this_current_helper_accepts_the_new_derived_binding_hash: true, all_original_result_export_ledger_hash_guards_retained: true },
  helper_used_in_paid_model_execution: false, additional_real_model_provider_requests: 0, original_paid_outputs_rewritten: false, medical_quality_approved: false });
process.stdout.write(JSON.stringify({ binding_path: rel(bindingPath), binding_sha256: await hash(bindingPath), helper_source_path: helper,
  model_runtime_sha256: paidHash, postprocessing_source_sha256: currentHash, index_path: rel(indexPath), index_sha256: await hash(indexPath),
  jobs: jobs.map(j => ({ job_id: j.job_id, raw: j.index.raw_current_record_count, original_strict: j.original_strict_source_group_count,
    same_source_review_groups: j.index.source_context_group_count, multi_member_groups: j.index.same_source_multi_member_group_count,
    internal_reference_hints: j.index.internal_reference_hints.length })), extra_model_requests: 0 }) + '\n');
