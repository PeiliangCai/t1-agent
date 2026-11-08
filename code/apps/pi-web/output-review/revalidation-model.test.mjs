// Synthetic unit fixtures only. This file never supplies the delivered reader data.
import assert from "node:assert/strict";
import test from "node:test";
import { filteredRecords, partialRecords, safeAssetPath, validateReaderManifest, viewJobForRecord } from "./revalidation-model.ts";

const fragment = { block_id: "unit-only-block", text_version: "unit-only-text", start: 10, end: 15, exact_quote: "甲🙂-乙。", occurrence: 0, physical_page: 2, bbox: [10, 20, 100, 40], location_precision: "block" };
const group = () => ({ group_id: "unit-only-group", kind: "sentence", source_type: "native_text", segments: [structuredClone(fragment)], display_joiner: "\n", completeness: "complete", boundary_reasons: [], missing_source_spans: [] });
const usage = { requests: 0, input_tokens: 0, output_tokens: 0, actual_cost: null, cost_status: "unit-only-not-real" };
const fixture = () => ({ schema_version: "feedback-revalidation-reader-1", batch_id: "synthetic-unit-test-only", finalized_at: "2026-11-05T00:00:00.000Z", actual_model_outputs: true,
  usage_totals: { ...usage },
  rounds: [{ round_id: "unit-round", label: "Synthetic unit round", rule_note: "Unit-only fixture, not actual output", finalized_at: "2026-11-05T00:00:00.000Z" }],
  freeze_plans: [{ round_id: "unit-round", plan_path: "unit-test-only/plan.json", source_root: "unit-test-only/snapshot" }],
  source_artifacts: [{ path: "unit-test-only/result.json", sha256: "a".repeat(64) }], papers: [{ document_id: "L01", pdf_path: "pdf/L01.pdf", pdf_sha256: "b".repeat(64) }],
  jobs: [{ ...usage, round_id: "unit-round", job_id: "test-B0", document_id: "L01", method: "B0", state: "completed", independent_model_run: true, candidate_count: 1, delivered_count: 1 },
    { ...usage, round_id: "unit-round", job_id: "test-F", document_id: "L01", method: "F", state: "failed", independent_model_run: true, candidate_count: 0, delivered_count: 0, outcome_reason: "Synthetic failure, not an actual run" }],
  records: [{ record_id: "unit-only-record", job_id: "test-B0", document_id: "L01", record_version: 1, source_record_sha256: "c".repeat(64), original_groups: [group()], context_groups: [], figure_ids: [], automatic_checks: [] }],
  figures: [], issues: [{ old_item_id: "S03", old_note: "Unit fixture note, never delivered", document_id: "L01", old_original_groups: [group()], old_context_groups: [], new_record_ids: ["unit-only-record"], relation: "source_overlap_only", automatic_observations: [] }] });

test("reader accepts finalized zero-candidate or failed jobs without manufacturing records", () => {
  const value = fixture();
  assert.equal(validateReaderManifest(value), value);
  assert.equal(filteredRecords(value, "all", "B0").length, 1);
  assert.equal(filteredRecords(value, "all", "F").length, 0);
  assert.equal(filteredRecords(value, "L05", "all").length, 0);
  assert.equal(value.jobs[1].state, "failed");
});

test("reader rejects unfinalized or nonactual data and in-progress method views", () => {
  const changes = [v => { v.actual_model_outputs = false; }, v => { delete v.finalized_at; }, v => { v.finalized_at = "invalid"; },
    v => { v.jobs[0].state = "running"; }, v => { v.jobs[0].state = "prepared"; }, v => { v.source_artifacts = []; }];
  for (const change of changes) { const value = fixture(); change(value); assert.throws(() => validateReaderManifest(value)); }
});

test("reader preserves codepoint offsets, raw hyphens and per-span PDF positions", () => {
  const value = fixture();
  assert.equal(validateReaderManifest(value).records[0].original_groups[0].segments[0].exact_quote, "甲🙂-乙。");
  const edits = [v => { v.records[0].original_groups[0].segments[0].exact_quote = "甲🙂乙。"; },
    v => { v.records[0].original_groups[0].segments[0].end++; }, v => { v.records[0].original_groups[0].segments[0].physical_page = 0; },
    v => { v.records[0].original_groups[0].segments[0].bbox[2] = -1; }];
  for (const edit of edits) { const value = fixture(); edit(value); assert.throws(() => validateReaderManifest(value)); }
});

test("legacy comparison cannot refer to nonexistent candidates or assert no match while carrying matches", () => {
  for (const edit of [v => { v.issues[0].new_record_ids = ["missing"]; }, v => { v.issues[0].relation = "no_direct_match"; },
    v => { v.issues.push(structuredClone(v.issues[0])); }, v => { v.records[0].job_id = "missing"; }]) {
    const value = fixture(); edit(value); assert.throws(() => validateReaderManifest(value));
  }
});

test("static asset references stay local and cannot overwrite a parent path", () => {
  for (const path of ["/etc/passwd", "../original.json", "revalidation-assets/../old.png", "https://example.test/a.png", "data:image/png,test", "a\\b.png", "a.png?other=1", "a%2fb.png"]) assert.equal(safeAssetPath(path), false, path);
  assert.equal(safeAssetPath("revalidation-assets/figure-1.png"), true);
  const value = fixture(); value.papers[0].pdf_path = "https://example.test/L01.pdf";
  assert.throws(() => validateReaderManifest(value));
});

test("a reused method view shows the same actual record without duplicating independent outputs", () => {
  const value = fixture();
  value.jobs.push({ ...usage, round_id: "unit-round", job_id: "test-R", document_id: "L01", method: "R", state: "reused", independent_model_run: false, reused_from_job_id: "test-B0", candidate_count: 1, delivered_count: 1 });
  validateReaderManifest(value);
  assert.equal(filteredRecords(value, "L01", "R")[0], value.records[0]);
  assert.equal(filteredRecords(value, "all", "all").length, 1);
  assert.equal(viewJobForRecord(value, value.records[0], "R").job_id, "test-R");
  const invalid = structuredClone(value); invalid.jobs[2].independent_model_run = true;
  assert.throws(() => validateReaderManifest(invalid));
});

test("failed attempts and retries require explicit usage and totals cannot hide requests", () => {
  const value = fixture();
  value.jobs[1].attempts = [{ attempt: 1, state: "failed", ...usage, requests: 2 }];
  value.jobs[1].requests = 2; value.usage_totals.requests = 2;
  validateReaderManifest(value);
  const missing = structuredClone(value); delete missing.jobs[1].attempts[0].requests;
  assert.throws(() => validateReaderManifest(missing));
  const hidden = structuredClone(value); hidden.usage_totals.requests = 0;
  assert.throws(() => validateReaderManifest(hidden));
  const unknownCost = structuredClone(value); delete unknownCost.usage_totals.actual_cost;
  assert.throws(() => validateReaderManifest(unknownCost));
});

test("subsequent rules are separate rounds and never remove earlier actual records", () => {
  const value = fixture();
  value.rounds.push({ round_id: "unit-round-2", label: "Second unit-only round", rule_note: "Changed background rule in a unit fixture", finalized_at: "2026-11-05T01:00:00.000Z" });
  value.freeze_plans.push({ round_id: "unit-round-2", plan_path: "unit-test-only/second-plan.json", source_root: "unit-test-only/second-snapshot" });
  value.jobs.push({ ...usage, round_id: "unit-round-2", job_id: "second-B0", document_id: "L01", method: "B0", state: "completed", independent_model_run: true, candidate_count: 1, delivered_count: 1 });
  value.records.push({ ...structuredClone(value.records[0]), record_id: "second-actual-record", job_id: "second-B0" });
  validateReaderManifest(value);
  assert.deepEqual(filteredRecords(value, "L01", "B0", "unit-round").map(record => record.record_id), ["unit-only-record"]);
  assert.deepEqual(filteredRecords(value, "L01", "B0", "unit-round-2").map(record => record.record_id), ["second-actual-record"]);
  assert.equal(filteredRecords(value, "all", "all", "all").length, 2);
});

test("failed-attempt actual candidates retain their own bindings and never enter the representative list", () => {
  const value = fixture();
  const partial = { ...structuredClone(value.records[0]), record_id: "failed-attempt-actual", job_id: "test-F" };
  value.jobs[1].attempts = [{ ...usage, state: "partial", candidate_count: 1, partial_records: [partial] }];
  validateReaderManifest(value);
  assert.equal(partialRecords(value)[0], partial);
  assert.equal(filteredRecords(value, "all", "all").length, 1);
  const mismatched = structuredClone(value); mismatched.jobs[1].attempts[0].partial_records[0].job_id = "test-B0";
  assert.throws(() => validateReaderManifest(mismatched));
  const inappropriateLink = structuredClone(value); inappropriateLink.issues[0].new_record_ids = [partial.record_id];
  assert.throws(() => validateReaderManifest(inappropriateLink));
});
