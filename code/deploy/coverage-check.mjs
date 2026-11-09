/** Operational completion can coexist with disclosed source quarantine; it is never full recall. */
export function processableScopeCompleted(browser) {
  const coverage = browser.coverage ?? {}, glyph = new Set(coverage.source_glyph_quarantined_block_ids ?? []);
  return ['completed', 'partial'].includes(browser.state) && coverage.selected_source_block_processing_complete === true &&
    coverage.whole_document_summary_complete === true && !(coverage.failed_source_block_ids ?? []).length && !(coverage.task_scope_failed_source_block_ids ?? []).length &&
    (coverage.task_processing_blockers ?? []).every(value => value === 'source_glyph_quarantine_unresolved') &&
    (coverage.task_scope_unprocessed_source_block_ids ?? []).every(id => glyph.has(id)) &&
    (!glyph.size || coverage.source_glyph_gaps_are_not_completed_or_task_exclusions === true) && browser.source_gap_disclosed === true;
}
