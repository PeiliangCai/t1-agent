/** Offline audit only: reconstruct retained successful read results and compare their actual recorded SHA. No model session/network. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ExtractionStore } from '../../../../packages/agent/src/extraction-store.js';
import { ExtractionSummaryTools } from '../../../../packages/agent/src/extraction-summary.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../../../../packages/agent/src/visual-evidence-policy.js';

const base = resolve('docs/acceptance/s4-reliability-2026-11-05');
const prepared = join(base, 'revalidation-prepared'), plan = JSON.parse(await readFile(join(prepared, 'plan.json'), 'utf8'));
const db = new DatabaseSync(join(prepared, 'execution/evidence.sqlite'), { readOnly: true });
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const observations: any[] = [];
try {
  for (const job of plan.execution_job_ids) {
    const directory = join(prepared, 'execution', job), actual = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    const row = db.prepare('SELECT input_json,metadata_json FROM s4_runs WHERE id=?').get(actual.run_id)!;
    const input = JSON.parse(row.input_json as string), metadata = JSON.parse(row.metadata_json as string);
    const paper = plan.papers.find((p: any) => p.document_id === actual.document_id);
    const document = JSON.parse(await readFile(resolve(paper.ir_path), 'utf8')).document;
    const article = JSON.parse(await readFile(join(directory, 'article-scope.json'), 'utf8'));
    const selection = JSON.parse(await readFile(join(directory, 'source-selection.json'), 'utf8'));
    for (const name of (await readdir(directory)).filter(name => /^whole-document-summary-attempt-\d+\.json$/.test(name)).sort()) {
      const report = JSON.parse(await readFile(join(directory, name), 'utf8'));
      const events = report.result.events, store = new ExtractionStore(':memory:');
      store.create(input, metadata); store.transition(input.run_id, 'extracting'); store.transition(input.run_id, 'reconciling');
      const tools = new ExtractionSummaryTools({ input, metadata, document, catalog: plan.config.catalog,
        evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION }, article, store, 'baseline', [], selection);
      const read = tools.definitions().find(t => t.name === 'read_document_blocks')!;
      try {
        for (const start of events.filter((e: any) => e.type === 'tool_execution_start' && e.tool === 'read_document_blocks')) {
          const end = events.find((e: any) => e.type === 'tool_execution_end' && e.call_id === start.call_id);
          if (!end || end.error) {
            observations.push({ job, summary_attempt_file: name, call_id: start.call_id, successful_actual_read: false,
              actual_error: end?.error_code ?? 'missing_tool_end', original_argument_sha256: start.argument_sha256,
              original_safe_selector_arrays: start.selectors, no_new_model_call: true });
            continue;
          }
          const params = start.selectors;
          const replay = await read.execute(start.call_id, params, undefined, undefined, {} as any);
          const body = JSON.parse((replay.content[0] as any).text), ids = body.source_window.line_indices;
          observations.push({ job, summary_attempt_file: name, call_id: start.call_id, successful_actual_read: true,
            original_argument_sha256: start.argument_sha256, original_safe_selector_arrays: params,
            actual_tool_result_sha256: end.result_sha256, reconstructed_tool_result_sha256: sha(replay),
            exact_actual_result_sha_match: end.result_sha256 === sha(replay),
            actual_result_characters: end.result_characters, reconstructed_result_characters: JSON.stringify(replay).length,
            source_window: body.source_window,
            complete_source_units: body.source_units.length,
            original_line_text_and_boundaries_preserved: body.blocks.every((b: any) => b.text === document.blocks[b.line_index].text),
            every_source_unit_span_in_current_window: body.source_units.every((u: any) => u.line_spans.every((s: any) => ids.includes(s.line_index))),
            window_at_most128: ids.length <= 128,
            necessary_cross_line_units_needing_explicit_reread: body.source_units_needing_reread,
            no_new_model_call: true });
        }
      } finally { store.close(); }
    }
  }
} finally { db.close(); }
const successful = observations.filter(o => o.successful_actual_read);
const report = { schema_version: 'actual-summary-read-result-sha-audit-1', recorded_at: new Date().toISOString(),
  audit_kind: 'Deterministic offline reconstruction of each retained successful original read call against the same frozen IR and code, compared to the actual SDK tool-result SHA; not a new model result.',
  new_model_API_requests: 0, successful_actual_reads: successful.length,
  all_successful_result_SHA_match: successful.every(o => o.exact_actual_result_sha_match),
  all_windows_bounded_and_all_source_text_units_exact: successful.every(o => o.window_at_most128 && o.original_line_text_and_boundaries_preserved && o.every_source_unit_span_in_current_window),
  observations };
await writeFile(join(base, 'live-revalidation/summary-read-result-audit.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ successful_reads: successful.length, all_SHA_match: report.all_successful_result_SHA_match,
  all_exact_and_bounded: report.all_windows_bounded_and_all_source_text_units_exact, new_model_API_requests: 0 }) + '\n');
