/** Display persisted task-scope completion separately from the unchanged legacy run state. */
export function runPresentation(state: string | undefined, coverage: unknown) {
  const value = coverage && typeof coverage === "object" && !Array.isArray(coverage) ? coverage as Record<string, unknown> : {};
  const ended = ["completed", "partial", "failed", "cancelled", "interrupted"].includes(state ?? "");
  const unsuccessful = ["failed", "cancelled", "interrupted"].includes(state ?? "");
  const taskComplete = ended && !unsuccessful && value.task_processing_complete === true;
  const completionKnownFalse = value.task_processing_complete === false;
  const statusKey = taskComplete ? "completed"
    : state === "completed" || state === "partial" ? completionKnownFalse ? "taskEndedIncomplete" : "taskEndedUnknown"
    : state ?? "noSelectedTask";
  const hintKey = taskComplete ? "completedHint"
    : unsuccessful ? "cancelledHint"
    : ended ? completionKnownFalse ? "taskIncompleteHint" : "taskUnknownHint"
    : "runningHint";
  const hasItems = (items: unknown) => Array.isArray(items) && items.length > 0;
  const structure = value.parser_structure_limitations;
  const structureLimited = structure !== null && typeof structure === "object" && Object.values(structure).some(hasItems);
  const sourceLimited = value.parser_status === "partial" || value.parser_status === "failed"
    || value.source_text_layer_decode_complete === false || hasItems(value.parser_failed_pages)
    || hasItems(value.image_text_unverified_pages) || structureLimited;
  return { statusKey, hintKey, taskComplete, ended, sourceLimited };
}
