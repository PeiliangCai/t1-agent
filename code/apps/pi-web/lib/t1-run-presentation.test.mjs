import assert from "node:assert/strict";
import test from "node:test";
import { runPresentation } from "../t1/run-presentation.ts";

test("explicit completed task scope survives legacy parser-partial state without a rerun hint", () => {
  const coverage = Object.freeze({ task_processing_complete: true, whole_document_summary_complete: true, parser_status: "partial", image_text_unverified_pages: [2] });
  const view = runPresentation("partial", coverage);
  assert.deepEqual(view, { statusKey: "completed", hintKey: "completedHint", taskComplete: true, ended: true, sourceLimited: true });
  assert.equal(coverage.parser_status, "partial");
});

test("false or missing task completion never becomes completed from summary or parser information", () => {
  for (const coverage of [undefined, null, {}, { task_processing_complete: "true" }, { parser_status: "partial", whole_document_summary_complete: true }]) {
    const view = runPresentation("partial", coverage);
    assert.equal(view.taskComplete, false); assert.equal(view.statusKey, "taskEndedUnknown"); assert.equal(view.hintKey, "taskUnknownHint");
  }
  for (const state of ["partial", "completed"]) {
    const view = runPresentation(state, { task_processing_complete: false, whole_document_summary_complete: true });
    assert.equal(view.statusKey, "taskEndedIncomplete"); assert.equal(view.hintKey, "taskIncompleteHint");
  }
});

test("failed, interrupted or cancelled runs retain their actual unsuccessful state even with a stale true flag", () => {
  for (const state of ["failed", "interrupted", "cancelled"]) {
    const view = runPresentation(state, { task_processing_complete: true });
    assert.equal(view.taskComplete, false); assert.equal(view.statusKey, state); assert.equal(view.hintKey, "cancelledHint"); assert.equal(view.ended, true);
  }
});

test("active runs do not claim completion before a real terminal state", () => {
  for (const state of ["queued", "parsing", "extracting", "reconciling"]) {
    const view = runPresentation(state, { task_processing_complete: true });
    assert.equal(view.taskComplete, false); assert.equal(view.statusKey, state); assert.equal(view.hintKey, "runningHint"); assert.equal(view.ended, false);
  }
});

test("successful terminal completion and source limitations are independent", () => {
  const complete = runPresentation("completed", { task_processing_complete: true, parser_status: "parsed" });
  assert.equal(complete.taskComplete, true); assert.equal(complete.sourceLimited, false);
  for (const coverage of [{ parser_failed_pages: [3] }, { image_text_unverified_pages: [2] }, { parser_structure_limitations: { ambiguous_unit_ids: ["u-1"] } }, { source_text_layer_decode_complete: false }]) assert.equal(runPresentation("partial", coverage).sourceLimited, true);
  assert.equal(runPresentation("partial", { source_block_processing_complete: false, full_document_extraction_completed: false, shared_bibliography_excluded_source_block_ids: ["ref-1"] }).sourceLimited, false, "task exclusions alone do not invent a parser failure");
});
