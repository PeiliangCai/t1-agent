/** Offline audit of the preserved failed round. Never creates a model session or writes the original SQL/ledger. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { allDeliveredRecords, deliveryRecordCounts, buildEvidenceDelivery, evidenceDigest, exportEvidenceDelivery } from '../packages/agent/src/evidence-delivery.js';
import { visualStatementIssues } from '../packages/agent/src/visual-evidence-policy.js';
import { comparisonMeasurement, comparisonCompletion, ledgerAccounting } from './audit-method-comparison.js';

const root = 'docs/acceptance/s0-s4-recheck-2026-11-08', directory = join(root, 'comparison');
const recovery = join(directory, 'offline-delivery-recovery'), output = join(directory, 'automatic-audit');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const fileSha = async (p: string) => sha(await readFile(p));
const save = async (p: string, v: unknown) => writeFile(p, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
const planBytes = await readFile(join(directory, 'plan.json')), plan = JSON.parse(planBytes.toString());
const originalReportPath = join(directory, 'execution/report.json'), originalReport = await json(originalReportPath);
assert.equal(originalReport.status, 'stopped_partial_or_failed'); assert.equal(originalReport.error.code, 'delivery_visual_statement_policy_failed');
const owner = await json(join(directory, 'execution/budget-owner.json')), ledgerPath = owner.ledger, ledger = await json(ledgerPath);
assert.equal(ledger.requests.length, 116); assert.equal(ledger.halted, null);
const originals = { [originalReportPath]: await fileSha(originalReportPath), [ledgerPath]: await fileSha(ledgerPath),
  [join(directory, 'execution/evidence.sqlite')]: await fileSha(join(directory, 'execution/evidence.sqlite')),
  [join(recovery, 'evidence-snapshot.sqlite')]: await fileSha(join(recovery, 'evidence-snapshot.sqlite')) };
for (const [p, digest] of Object.entries(plan.source_hashes) as Array<[string, string]>)
  assert.equal(await fileSha(join(directory, 'execution/source-snapshot', p)), digest, 'the actual paid runtime snapshot stays frozen');
const db = new DatabaseSync(join(recovery, 'evidence-snapshot.sqlite'), { readOnly: true });
const rawRun = db.prepare("SELECT * FROM s4_runs WHERE id LIKE '%:source-L07:%'").get()!;
const runId = rawRun.id as string, input = JSON.parse(rawRun.input_json as string);
const versions = db.prepare('SELECT envelope_json FROM s4_versions WHERE run_id=? ORDER BY record_id,version').all(runId).map(v => JSON.parse(v.envelope_json as string));
const events = db.prepare('SELECT payload_json FROM s4_events WHERE run_id=? ORDER BY seq').all(runId).map(v => JSON.parse(v.payload_json as string));
const batches = db.prepare('SELECT payload_json FROM s4_batches WHERE run_id=? ORDER BY batch_id').all(runId).map(v => JSON.parse(v.payload_json as string)); db.close();
const current = new Map<string, any>(); for (const v of versions) if (v.status !== 'proposed') current.set(v.record.record_id, v);
assert.equal(current.size, 50); assert.equal(versions.length, 67); assert.equal(batches.length, 8);
const paper = plan.papers.find((p: any) => p.document_id === 'L07'), job = paper.methods.jobs.find((j: any) => j.job_id === 'L07-B0');
const document = (await json(paper.ir_path)).document, figures = await json(paper.figure_catalog_path);
assert.equal(await fileSha(paper.ir_path), paper.ir_sha256); assert.equal(await fileSha(paper.pdf_path), paper.pdf_sha256);
const summary = await json(join(directory, 'execution/L07-B0/whole-document-summary.json'));
assert.equal(summary.attempts.at(-1).status, 'completed'); assert.ok(batches.every(b => b.status === 'completed' && b.explicit_completion_received));
const rejected: any[] = [], valid: any[] = [];
for (const v of current.values()) {
  try { buildEvidenceDelivery(document, [v], figures); valid.push(v); }
  catch (cause) {
    const r = v.record, field = [r.disease_or_lesion, r.modality, r.sequence_or_phase, r.assertion, r.applicability,
      r.context.source_attribution, ...r.numeric_expressions].flatMap((f: any) => f?.evidence ?? []);
    const issues = visualStatementIssues(document, r, r.quote_span.segments, r.context.fragments, field, r.context.supporting_table_evidence ?? [])
      .filter(i => i.severity === 'reject').map(i => ({ ...i, missing_spans: i.code === 'incomplete_context_statement' ?
        JSON.parse(i.detail.slice(i.detail.indexOf('['))).map((s: any) => { const b = document.blocks.find((b: any) => b.block_id === s.block_id);
          return { ...s, exact_quote: Array.from(b.text).slice(s.start, s.end).join(''), physical_page: b.page, bbox: b.bbox,
            diagnostic_only_not_added_to_record: true }; }) : [] }));
    assert.ok(issues.length); assert.match(String(cause), /delivery_visual_statement_policy_failed/);
    rejected.push({ job_id: job.job_id, run_id: runId, record_id: r.record_id, record_version: v.version,
      source_record_sha256: evidenceDigest(r), record: r, original_version: v, delivery_fingerprint: null, text_fingerprint: null,
      delivery_status: 'rejected_original_record_for_source_review_only', issues });
  }
}
assert.equal(valid.length, 48); assert.equal(rejected.length, 2);
const requests = ledger.requests.filter((r: any) => r.purpose.startsWith(runId + ':'));
const total = (key: string) => requests.reduce((n: number, r: any) => n + r[key], 0);
assert.equal(requests.length, 56);
const completed = [...new Set(batches.flatMap(b => b.assigned_block_ids))], read = [...new Set(batches.flatMap(b => b.read_block_ids))];
const summaryReads = new Set<string>(); for (const e of summary.result.events) if (e.type === 'tool_execution_start' && e.tool === 'read_document_blocks')
  for (const i of e.selectors?.line_indices ?? []) summaryReads.add(document.blocks[i].block_id);
const coverage = { physical_pages: document.pages.length, parser_status: document.parser.status,
  all_source_blocks: document.blocks.length, assigned_source_blocks: paper.methods.article.included_block_ids.length,
  bibliography_scope_rule_version: plan.common.bibliography_scope_rule_version, task_scope_source_blocks: job.selection.kept_block_ids.length,
  selected_source_block_processing_complete: true, explicitly_completed_source_blocks: completed.length, completed_source_block_ids: completed,
  task_scope_source_block_processing_complete: true, task_scope_unprocessed_source_block_ids: [], task_scope_failed_source_block_ids: [],
  task_processing_complete: false, task_processing_blockers: ['delivery_visual_statement_policy_failed'],
  whole_document_summary_complete: true, full_document_extraction_completed: false, source_block_processing_complete: false,
  f_unselected_source_block_ids: [], shared_bibliography_excluded_source_block_ids: job.selection.excluded_block_ids,
  dispatched_source_blocks: job.selection.kept_block_ids.length, source_blocks_read: new Set([...read, ...summaryReads]).size,
  summary_reread_source_block_ids: [...summaryReads], original_article_unprocessed_source_block_ids: job.selection.excluded_block_ids,
  unprocessed_source_block_ids: [], failed_source_block_ids: [], source_text_layer_decode_complete: document.coverage.text_layer_decode_complete,
  source_pages_without_text: document.coverage.pages_without_text, parser_failed_pages: document.coverage.failed_pages,
  image_text_unverified_pages: document.coverage.image_text_unverified_pages, source_fidelity_human_verified: false,
  medical_recall_proven_by_coverage: false, recovered_offline: true,
  recovered_from: 'SQL batch rows + completed summary artifact + exact source-bound saved versions; not a successful live result write' };
const recoveredPath = join(recovery, 'recovered-L07-B0-result.json');
const recovered = { schema_version: 's4-extraction-run-1', recovered_offline: true, live_process_exit_code: 1,
  original_live_result_json_written: false, original_live_delivery_json_written: false, run_id: runId, document_id: 'L07',
  model_id: plan.config.model.model_id, reasoning_effort: plan.config.model.reasoning_effort, strategy: plan.config.strategy,
  source_selection_condition: 'B0', source_selection_digest: job.source_selection_digest, state: rawRun.state,
  task_processing_complete: false, candidate_count: 50, candidate_versions: versions.length, summary_attempts: summary.attempts,
  summary: summary.summary, error: originalReport.error, records: [...current.values()], versions, events, coverage,
  medical_quality_approved: false, human_gold_complete: false, actual_human_reviewed_count: 0,
  delivery_validation: { status: 'rejected', error: originalReport.error, rejected_record_ids: rejected.map(r => r.record_id),
    independently_exportable_current_records: 48, original_live_run_is_not_a_successful_delivery: true },
  resources: null, original_process_cpu_and_rss_measurements: 'not_saved_before_the_exception; not reconstructed',
  total_seconds: (Date.parse(requests.at(-1).finished_at) - Date.parse(requests[0].started_at)) / 1000,
  timing_scope: 'offline_ledger_first_request_start_to_last_request_finish_not_original_process_timer',
  ledger_totals: { requests: requests.length, input_tokens: total('input_tokens'), output_tokens: total('output_tokens') },
  recovery_sources: originals };
await save(recoveredPath, recovered); const recoveredSha = await fileSha(recoveredPath);
for (const r of rejected) r.source_binding = { document_id: paper.document_id, file_sha256: paper.pdf_sha256, pdf_sha256: paper.pdf_sha256,
  ir_sha256: paper.ir_sha256, text_version: document.text_version, job_id: job.job_id, logical_job_ids: [job.job_id], run_id: runId,
  result_path: recoveredPath, result_sha256: recoveredSha, recovered_offline: true, record_id: r.record_id, record_version: r.record_version,
  source_record_sha256: r.source_record_sha256, delivery_fingerprint: null, delivery_rejected: true };
const rejectedPath = join(recovery, 'rejected-views.json'); await save(rejectedPath, { schema_version: 'offline-rejected-output-views-1',
  recovered_offline: true, full_record_fields_and_context_unchanged: true, diagnostic_spans_never_added_to_record: true,
  medical_quality_approved: false, product_export_approved: false, views: rejected });
const row = { job_id: job.job_id, independent_model_run: true, recovered_offline: true, state: rawRun.state,
  candidate_count: 50, task_processing_complete: false, coverage, seconds: recovered.total_seconds,
  timing_scope: recovered.timing_scope, requests: requests.length, input_tokens_including_conservative_missing_usage: total('input_tokens'),
  output_tokens_including_reasoning_or_missing_usage_reservation: total('output_tokens'), error: originalReport.error,
  result_path: recoveredPath, result_sha256: recoveredSha, delivery_validation: recovered.delivery_validation };
const effective = [...originalReport.jobs, row]; await mkdir(output);
const audits: any[] = [], counts: Record<string, number> = {};
for (const p of plan.papers) {
  const doc = (await json(p.ir_path)).document, catalog = await json(p.figure_catalog_path);
  assert.equal(await fileSha(p.ir_path), p.ir_sha256); assert.equal(await fileSha(p.pdf_path), p.pdf_sha256);
  assert.equal(await fileSha(p.figure_catalog_path), p.figure_catalog_sha256);
  for (const [path, hash] of Object.entries(p.assets)) assert.equal(await fileSha(path), hash);
  for (const j of p.methods.jobs.filter((j: any) => j.independent_model_run)) {
    const actual = effective.find(r => r.job_id === j.job_id); if (!actual?.result_path) continue;
    const result = await json(actual.result_path), allowedIds = new Set(j.selection.kept_block_ids.concat(j.selection.deferred_block_ids));
    for (const v of result.versions) for (const f of [...v.record.quote_span.segments, ...v.record.context.fragments]) assert.ok(allowedIds.has(f.block_id));
    const safeVersions = actual.recovered_offline ? result.versions.filter((v: any) => !rejected.some(r => r.record_id === v.record.record_id)) : result.versions;
    const exportPath = join(output, j.job_id + '-candidates');
    const exported = await exportEvidenceDelivery(doc, safeVersions, { codeRoot: process.cwd(), directory: exportPath, mode: 'candidates', catalog, coverage: result.coverage });
    const delivery = exported.delivery; counts[j.job_id] = result.candidate_count;
    audits.push({ job_id: j.job_id, run_id: result.run_id, recovered_offline: !!actual.recovered_offline,
      automatic_source_and_asset_checks_passed: !actual.recovered_offline, source_and_asset_bindings_checked: true,
      whole_live_delivery_passed: !actual.recovered_offline, total_current_candidates: result.candidate_count,
      output_count: allDeliveredRecords(delivery).length, ...deliveryRecordCounts(delivery), valid_source_delivery_records: allDeliveredRecords(delivery).length,
      rejected_current_record_count: actual.recovered_offline ? 2 : 0, candidate_export: exportPath,
      result_path: actual.result_path, result_sha256: await fileSha(actual.result_path), ...comparisonCompletion(result),
      selected_processing_complete: result.coverage.selected_source_block_processing_complete,
      whole_document_summary_complete: result.coverage.whole_document_summary_complete,
      figure_associations: Object.fromEntries([...new Set(allDeliveredRecords(delivery).map(r => r.figure_association.status))].map(s => [s, allDeliveredRecords(delivery).filter(r => r.figure_association.status === s).length])),
      source_pdf_human_fidelity_checked: false, actual_human_reviewed_count: 0, medical_quality_approved: false,
      error: result.error ?? null });
  }
}
const rows = plan.papers.flatMap((p: any) => p.methods.jobs.map((j: any) => ({ ...comparisonMeasurement(j, effective, counts),
  rejected_current_record_count: j.job_id === 'L07-B0' ? 2 : 0,
  valid_source_delivery_records: audits.find(a => a.job_id === (j.representative_job_id ?? j.job_id))?.valid_source_delivery_records ?? null,
  recovered_offline: j.job_id === 'L07-B0', unstarted_reason: j.job_id === 'L07-F' ? 'previous_job_delivery_validation_failed; round closed; not a budget halt' : null })));
const classification: any[] = [], seen = new Set<string>();
for (const p of plan.papers) for (const j of p.methods.jobs.filter((j: any) => j.independent_model_run)) {
  let paths: string[] = []; try { paths = (await readdir(join(directory, 'execution', j.job_id))).filter(n => /-attempt-\d+\.json$/.test(n)); } catch { continue; }
  const result = effective.find(r => r.job_id === j.job_id), sourceEvents = result?.result_path ? (await json(result.result_path)).events : [];
  for (const name of paths.sort()) {
    const path = join(directory, 'execution', j.job_id, name), phase = await json(path), accounting = phase.request_accounting;
    const groups: any[] = []; for (const e of phase.result.events) {
      if (e.type === 'assistant_response') groups.push({ stop_reason: e.stop_reason, tools: [], errors: [] });
      else if (e.type === 'tool_execution_start') groups.at(-1)?.tools.push(e);
      else if (e.type === 'tool_execution_end' && e.error) groups.at(-1)?.errors.push(e.tool);
    }
    const aligned = groups.length === accounting.length && JSON.stringify(phase.result.request_ids) === JSON.stringify(accounting.map((r: any) => r.id));
    const perRequest = accounting.map((r: any, i: number) => {
      assert.ok(!seen.has(r.id)); seen.add(r.id); const stored = ledger.requests.find((v: any) => v.id === r.id); assert.ok(stored);
      assert.equal(stored.input_tokens, r.input_tokens); assert.equal(stored.output_tokens, r.output_tokens);
      return { request_id: r.id, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
        emitted_tool_calls: aligned ? groups[i].tools.map((e: any) => e.tool) : null,
        tool_errors: aligned ? groups[i].errors : null, alignment_verified: aligned,
        classification: !aligned ? 'unknown_do_not_infer' : groups[i].tools.length > 1 ? 'mixed_tools' : groups[i].tools[0]?.tool ?? 'assistant_without_tool' };
    });
    const toolCounts: Record<string, number> = {}; for (const g of groups) for (const e of g.tools) toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
    classification.push({ job_id: j.job_id, phase: phase.batch_id ?? 'whole_document_summary', path, sha256: await fileSha(path),
      requests: accounting.length, input_tokens: accounting.reduce((n: number, r: any) => n + r.input_tokens, 0),
      output_tokens: accounting.reduce((n: number, r: any) => n + r.output_tokens, 0), tools: toolCounts,
      bounded_protocol_corrections: sourceEvents.filter((e: any) => e.type === 'protocol_correction' &&
        (phase.batch_id ? e.detail.batch_id === phase.batch_id : e.detail.phase === 'whole_document_summary')).length,
      tool_counts_are_not_additional_HTTP_requests: true, per_request: perRequest });
  }
}
assert.equal(seen.size, ledger.requests.length);
const binding = { schema_version: 'offline-delivery-recovery-binding-1', recovered_offline: true, live_process_exit_code: 1,
  round_closed: true, more_API_authorized: false, original_live_error: originalReport.error, original_execution_report: originalReportPath,
  original_execution_report_sha256: originals[originalReportPath], plan_sha256: sha(planBytes), ledger_path: ledgerPath,
  ledger_sha256: originals[ledgerPath], source_SQL_snapshot: join(recovery, 'evidence-snapshot.sqlite'),
  effective_jobs: effective, unstarted_jobs: ['L07-F'], original_live_job_rows_unchanged: true,
  recovered_result_path: recoveredPath, recovered_result_sha256: recoveredSha, rejected_views: rejectedPath,
  rejected_views_sha256: await fileSha(rejectedPath), legal_delivery_record_count: 48, rejected_current_record_count: 2,
  total_current_candidates: 56, total_legal_source_delivery_records: 54,
  new_code_paid_retest_performed: false, actual_runtime_snapshot_source_hashes: plan.source_hashes,
  current_code_changes_after_paid_failure: Object.fromEntries((await Promise.all(Object.entries(plan.source_hashes).map(async ([p, old]) =>
    [p, { actual_paid_runtime_sha256: old, current_sha256: await fileSha(p) }] as const))).filter(([, v]) => v.actual_paid_runtime_sha256 !== v.current_sha256)),
  interpretation: '48 legal L07 records are an offline audit partition; the original 50-record live delivery failed and was never written successfully.' };
await save(join(recovery, 'recovery-binding.json'), binding);
const comparison = { schema_version: 'two-method-automatic-comparison-1', recovered_offline: true,
  execution_status: originalReport.status, original_live_error: originalReport.error, actual_human_reviewed_count: 0,
  medical_quality_approved: false, stage_passed: false, winner: null, rows, automatic_audits: audits,
  accounting: ledgerAccounting(ledger.requests), limits: ledger.limits, halted: ledger.halted,
  started_at: ledger.experiment_started_at, round_closed: true, recovery_binding: join(recovery, 'recovery-binding.json'),
  request_purpose_analysis: classification, method_comparison_limit: 'L07-F never started after B0 delivery failure; no matched L07 method comparison. Candidate counts are not quality.' };
await save(join(output, 'comparison.json'), comparison);
await save(join(output, 'error-cases.json'), { original_live_error: originalReport.error, rejected_views: rejectedPath,
  guard_rejections: rejected.map(r => ({ record_id: r.record_id, record_version: r.record_version, issues: r.issues })),
  recovery_does_not_approve_any_record: true });
for (const [p, hash] of Object.entries(originals)) assert.equal(await fileSha(p), hash, 'original paid/failure evidence unchanged');
process.stdout.write(JSON.stringify({ offline_only: true, paid_requests_added: 0, original_paid_requests: 116,
  total_candidates: 56, legal_source_deliveries: 54, rejected_current_versions: 2,
  recovered_result: recoveredPath, recovery_binding: join(recovery, 'recovery-binding.json'), automatic_audit: output,
  classified_requests: seen.size, source_and_asset_checks: audits.map(a => ({ job: a.job_id, valid: a.output_count, rejected: a.rejected_current_record_count })) }) + '\n');
