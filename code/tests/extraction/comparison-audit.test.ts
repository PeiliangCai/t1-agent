import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { comparisonMeasurement, comparisonPresentation, comparisonCompletion, ledgerAccounting } from '../../scripts/audit-method-comparison.js';
import { COMPARISON_PLAN_SCHEMA, planPaperMethods } from '../../packages/agent/src/method-comparison.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';

const job = { job_id: 'L01-R', condition: 'R', label: '删除明确无关＋智能体', document_id: 'L01', source_selection_digest: 'fixture',
  model_source_input_sha256: 'fixture', representative_job_id: 'L01-F', independent_model_run: false };

test('comparison reports expose explicit task completion while legacy partial and image OCR remain separate', () => {
  const old = { state: 'partial', coverage: { selected_source_block_processing_complete: true, whole_document_summary_complete: true } };
  assert.equal(comparisonCompletion(old).task_processing_complete, null, 'never infer a new completion claim for historical data');
  const coverage = { task_processing_complete: true, task_scope_source_block_processing_complete: false, task_scope_source_blocks: 30,
    f_unselected_source_block_ids: ['deferred'], shared_bibliography_excluded_source_block_ids: ['ref'],
    source_text_layer_decode_complete: true, image_text_unverified_pages: [2] };
  const rows = [{ job_id: 'L01-F', independent_model_run: true, state: 'partial', task_processing_complete: true, coverage },
    { job_id: 'L01-R', independent_model_run: false, representative_job_id: 'L01-F' }];
  const row = comparisonMeasurement(job, rows);
  assert.equal(row.task_processing_complete, true); assert.equal(row.state, 'partial');
  assert.equal(row.task_scope_source_block_processing_complete, false); assert.equal(row.task_scope_source_blocks, 30);
  assert.equal(row.f_unselected_source_blocks, 1); assert.equal(row.shared_bibliography_excluded_source_blocks, 1);
  assert.equal(row.source_text_layer_decode_complete, true); assert.equal(row.image_text_unverified_pages, 1);
});
test('a reused method inherits representative cost/time instead of gaining a fictional zero-cost advantage', () => {
  const actual = [{ job_id: 'L01-F', independent_model_run: true, requests: 25, input_tokens_including_conservative_missing_usage: 80000,
    output_tokens_including_reasoning_or_missing_usage_reservation: 3000, seconds: 250, result_path: 'fixture/result.json', state: 'partial' },
  { job_id: 'L01-R', independent_model_run: false, requests: 0, representative_job_id: 'L01-F' }];
  const row = comparisonMeasurement(job, actual, { 'L01-F': 9 });
  assert.equal(row.method_requests, 25); assert.equal(row.method_input_tokens, 80000); assert.equal(row.method_seconds, 250);
  assert.equal(row.additional_physical_requests, 0); assert.equal(row.independent_measurement, false); assert.equal(row.candidate_count, 9);
  assert.equal(row.status, 'reused_not_independently_measured');
  assert.throws(() => comparisonMeasurement(job, actual.slice(1)), /missing_unique_representative/);
});
test('actual ledger totals include reservations and count reasoning/cache once without summing duplicated method rows', () => {
  const totals = ledgerAccounting([{ input_tokens: 100, output_tokens: 20, input_ceiling: 32768, output_ceiling: 8192,
    cache_read_tokens: 30, reasoning_tokens: 10, usage_status: 'provider_reported', response_model_identity_status: 'matched', finished_at: 'fixture' },
  { input_ceiling: 32768, output_ceiling: 8192, usage_status: 'missing_usage_conservative_reservation', response_model_identity_status: 'unknown' }]);
  assert.equal(totals.physical_requests, 2); assert.equal(totals.input_tokens_including_cache_and_missing_usage_reservation, 32868);
  assert.equal(totals.output_tokens_including_reasoning_and_missing_usage_reservation, 8212); assert.equal(totals.missing_usage_requests, 1);
  assert.equal(totals.actual_cost, null); assert.equal(totals.total_is_not_sum_of_method_rows, true);
});

test('offline report labels, conditions and reuse summaries follow saved three-method and new two-method plans', () => {
  const legacy = JSON.parse(readFileSync(new URL('../../docs/acceptance/user-feedback-2026-11-05/revalidation/metric-context-revision/prepared/plan.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(legacy), old = comparisonPresentation(legacy);
  assert.deepEqual(old.conditions, ['B0', 'F', 'R']); assert.equal(old.logical_method_count, 3);
  assert.equal(old.title, '三方案'); assert.equal(old.report_schema_version, 'three-method-automatic-comparison-1');
  assert.match(old.reuse_explanation, /L01-R复用L01-F/); assert.equal(JSON.stringify(legacy), before);
  const f = makeEvidenceFixture(['CT shows a thin rim.']);
  const planned = planPaperMethods(f.document, { model: 'synthetic-only-no-network' }, { maxCodePoints: 8500, maxBlocks: 128, contextBlocks: 6 });
  const current = comparisonPresentation({ schema_version: COMPARISON_PLAN_SCHEMA, papers: [{ methods: planned }] });
  assert.deepEqual(current.conditions, ['B0', 'F']); assert.equal(current.logical_method_count, 2);
  assert.equal(current.title, '两方案'); assert.equal(current.report_schema_version, 'two-method-automatic-comparison-1');
  assert.match(current.reuse_explanation, /synthetic-s4-document-F复用synthetic-s4-document-B0/);
  assert.equal(current.reuse_explanation.includes('L01-R'), false);
});
