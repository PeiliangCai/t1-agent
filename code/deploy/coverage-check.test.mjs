import test from 'node:test';
import assert from 'node:assert/strict';
import { processableScopeCompleted } from './coverage-check.mjs';

test('source-limited partial is accepted only when every processable block and summary completed and quarantine stays disclosed', () => {
  const full = { state: 'completed', source_gap_disclosed: true, coverage: { selected_source_block_processing_complete: true, whole_document_summary_complete: true,
    failed_source_block_ids: [], task_scope_failed_source_block_ids: [], task_processing_blockers: [], task_scope_unprocessed_source_block_ids: [] } };
  assert.equal(processableScopeCompleted(full), true);
  const partial = { ...full, state: 'partial', coverage: { ...full.coverage, task_processing_complete: false, task_processing_blockers: ['source_glyph_quarantine_unresolved'],
    source_glyph_quarantined_block_ids: ['glyph-1', 'glyph-2'], task_scope_unprocessed_source_block_ids: ['glyph-1', 'glyph-2'], source_glyph_gaps_are_not_completed_or_task_exclusions: true } };
  assert.equal(processableScopeCompleted(partial), true);
  for (const coverage of [
    { ...partial.coverage, whole_document_summary_complete: false },
    { ...partial.coverage, task_processing_blockers: ['source_glyph_quarantine_unresolved', 'summary_incomplete'] },
    { ...partial.coverage, task_scope_unprocessed_source_block_ids: ['glyph-1', 'unprocessed-safe-block'] },
    { ...partial.coverage, failed_source_block_ids: ['failed-safe-block'] },
    { ...partial.coverage, source_glyph_gaps_are_not_completed_or_task_exclusions: false },
  ]) assert.equal(processableScopeCompleted({ ...partial, coverage }), false);
});
