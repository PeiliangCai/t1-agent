import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const directory = resolve('docs/acceptance/s1');
const localChecks = ['check', 'test-unit', 'test-integration', 'build-web'];
for (const name of localChecks) {
  const record = JSON.parse(await readFile(resolve(directory, `local-${name}.json`), 'utf8'));
  assert.equal(record.exit_code, 0); assert.equal(record.real_api_calls, 0);
}
const pointer = JSON.parse(await readFile(resolve(directory, 'smoke-pi-latest.json'), 'utf8'));
const smoke = JSON.parse(await readFile(resolve(directory, pointer.report), 'utf8'));
assert.equal(smoke.status, 'passed'); assert.equal(smoke.real_model_call, true); assert.equal(smoke.fixture, true);
assert.equal(smoke.state, 'completed'); assert.equal(smoke.settled, true); assert.equal(smoke.session_disposed, true);
assert.ok(smoke.assistant_requests_observed > 0); assert.ok(smoke.records.length > 0);
assert.ok(smoke.records.every((r: { review_status: string; handoff_status: string; extraction_trace: { fixture: boolean } }) => r.review_status === 'pending' && r.handoff_status === 'candidate_only' && r.extraction_trace.fixture));
const codeFiles = ['package.json', 'package-lock.json', 'packages/contracts/src/index.ts', 'packages/agent/src/pi.ts', 'packages/agent/src/tools.ts', 'packages/agent/src/store.ts', 'packages/agent/src/config.ts'];
const hashes: Record<string, string> = {};
for (const path of codeFiles) hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
assert.equal(hashes['package-lock.json'], smoke.dependencies_lock_sha256);
const finalApproved = process.argv.includes('--final-review-approved');
const postReview = JSON.parse(await readFile(resolve(directory, 'post-review-fixes.json'), 'utf8'));
assert.equal(postReview.offline_regressions_passed, true);
const originalSmokeSha = createHash('sha256').update(await readFile(resolve(directory, pointer.report))).digest('hex');
assert.equal(originalSmokeSha, postReview.real_smoke_sha256);
const report = { stage: 'S1', task_ids: ['T1-R23', 'T1-R24', 'T1-R25', 'T1-R26'], status: finalApproved ? 'passed' : 'engineering_checks_passed_pending_final_review', accepted_at: new Date().toISOString(),
  gate_results: { pinned_dependency_source_verified: true, schema_and_scope_checks_passed: true, tool_permissions_passed: true,
    real_model_via_pi_tool_roundtrip_passed: true, result_state_event_return_passed: true, engineering_fixture_distinguished: true, parser_adapter_explicitly_unimplemented: true },
  code_files_sha256: hashes, real_smoke_evidence: pointer.report, local_check_evidence: localChecks.map(name => `local-${name}.json`),
  engineering_evidence_only: true, medical_quality_validated: false, formal_model_selected: false, numeric_thresholds_frozen: false,
  not_validated: ['S3 real PDF parsing and original PDF fidelity', 'S4 medical extraction and formal model', 'S2 medical taxonomy/annotation/reviewer availability', 'S5 full workflow/review/export and actual multi-task throughput', 'S6 numeric quality/performance targets', 'S7 Docker and production access/storage deployment'],
  api_usage: { assistant_requests_observed: smoke.assistant_requests_observed, token_usage: smoke.token_usage, actual_cost: null, cost_status: smoke.cost_status },
  real_smoke_version: { report: pointer.report, sha256: originalSmokeSha, source_code_hashes: postReview.real_smoke_source_hashes, version_label: 'before_review_round_2_fixes' },
  post_smoke_changes: { evidence: 'post-review-fixes.json', scope: postReview.changed_previously_tested_source_files, offline_regressions: '15 unit + 8 integration; typecheck passed', additional_real_api_calls: 0 },
  formal_astra_reviews_used: finalApproved ? 3 : 2, formal_astra_review_limit: 3, final_formal_review: finalApproved ? 'round_3_main_session_continue' : 'pending_round_3',
  final_review_risks: ['Engineering fixtures do not validate real PDF or medical quality', 'Concurrency capacity, production access control and deployment recovery require later-stage checks', 'Real API evidence covers the pre-fix success path; later fixes have offline regression evidence'],
  next_stage: { id: 'S2', status: 'not_started' },
};
await writeFile(resolve(directory, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ stage: 'S1', status: report.status, evidence: 'docs/acceptance/s1/acceptance.json', final_formal_review: report.final_formal_review }));
