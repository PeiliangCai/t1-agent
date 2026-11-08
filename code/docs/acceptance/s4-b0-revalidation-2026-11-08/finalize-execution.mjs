/** Offline terminal audit only. Never starts/resumes a model run or edits its artifacts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allDeliveredRecords, buildEvidenceDelivery } from '../../../packages/agent/src/evidence-delivery.ts';
import { strictSourceGroupKey, internalStructureReferencesOnly } from '../../../packages/agent/src/strict-source-groups.ts';

const base = dirname(fileURLToPath(import.meta.url)), code = resolve(base, '../../..'), prepared = join(base, 'prepared'), execution = join(prepared, 'execution');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async path => hash(await readFile(path));
const rel = path => relative(code, path);
const fileBinding = async path => await exists(path) ? { path: rel(path), sha256: await fileHash(path) } : null;
const writeNew = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const planPath = join(prepared, 'plan.json'), reportPath = join(execution, 'report.json'), plan = await json(planPath), report = await json(reportPath);
assert.notEqual(report.status, 'running', 'Do not seal an intermediate output.');
const auth = await json(join(base, 'authorization.json')), owner = join(code, 'runtime-data/s4-budget-owners', hash(auth.authorization_id));
assert.equal(await exists(join(owner, 'active-owner.lock')), false, 'The sole executor must finish and release its lock first.');
const ledgerPath = join(owner, 'call-ledger.json'), ledgerHash = await fileHash(ledgerPath), reportHash = await fileHash(reportPath), ledger = await json(ledgerPath);
const requests = ledger.requests;
const sum = field => requests.reduce((n, r) => n + (r[field] ?? 0), 0);
const accounting = { requests: requests.length, input_tokens_including_cache_and_missing_usage_reservations: requests.reduce((n, r) => n + (r.input_tokens ?? r.input_ceiling), 0),
  output_tokens_including_reasoning_and_missing_usage_reservations: requests.reduce((n, r) => n + (r.output_tokens ?? r.output_ceiling), 0),
  cache_read_tokens_in_input: sum('cache_read_tokens'), reasoning_tokens_in_output: sum('reasoning_tokens'),
  missing_or_unsettled_usage_requests: requests.filter(r => r.usage_status !== 'provider_reported').length,
  first_request_at: ledger.experiment_started_at, last_request_finished_at: requests.at(-1)?.finished_at ?? null,
  approved_deadline_at: ledger.experiment_started_at ? new Date(Date.parse(ledger.experiment_started_at) + auth.limits.seconds * 1000).toISOString() : null,
  halted: ledger.halted, actual_cost: null, cost_status: 'unknown_gateway_billing',
  response_model_identity_counts: Object.fromEntries([...new Set(requests.map(r => r.response_model_identity_status ?? 'unknown'))].map(s => [s, requests.filter(r => (r.response_model_identity_status ?? 'unknown') === s).length])) };
accounting.within_approved_limits = {
  requests: accounting.requests <= auth.limits.requests,
  input_tokens: accounting.input_tokens_including_cache_and_missing_usage_reservations <= auth.limits.input_tokens,
  output_tokens: accounting.output_tokens_including_reasoning_and_missing_usage_reservations <= auth.limits.output_tokens,
};
const checkedSources = [];
for (const [path, expected] of Object.entries(plan.source_hashes)) {
  assert.equal(await fileHash(join(code, path)), expected, path + ': current source');
  assert.equal(await fileHash(join(prepared, 'source-snapshot', path)), expected, path + ': frozen source');
}
for (const paper of plan.papers) for (const [path, expected] of Object.entries({ [paper.pdf_path]: paper.pdf_sha256, [paper.ir_path]: paper.ir_sha256,
  [paper.figure_catalog_path]: paper.figure_catalog_sha256, ...paper.assets })) {
  assert.equal(await fileHash(join(code, path)), expected, path + ': current input');
  assert.equal(await fileHash(join(prepared, 'input-snapshot', path)), expected, path + ': frozen input'); checkedSources.push({ path, sha256: expected });
}
const overlaps = (a, b) => a.block_id === b.block_id && a.text_version === b.text_version && a.start < b.end && b.start < a.end;
const contains = (a, b) => a.block_id === b.block_id && a.text_version === b.text_version && a.start <= b.start && a.end >= b.end;
const coverage = (spans, target) => target.every(t => spans.some(s => contains(s, t)));
const anchors = spans => spans.map(({ block_id, text_version, start, end, exact_quote }) => ({ block_id, text_version, start, end, exact_quote }));
const observationField = field => field ? { value: field.value, status: field.status, evidence: anchors(field.evidence) } : null;
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : value && typeof value === 'object'
  ? '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}' : JSON.stringify(value);
const jobs = [], observations = [], sameSourceMetadataObservations = [], internalReferenceObservations = [];
for (const paper of plan.papers) {
  const jobDir = join(execution, paper.job_id), resultPath = join(jobDir, 'result.json'), result = await exists(resultPath) ? await json(resultPath) : null;
  const runId = result?.run_id ?? plan.batch_id + ':source-' + paper.document_id;
  const jobRequests = requests.filter(r => r.purpose.startsWith(runId + ':'));
  const candidateDir = join(jobDir, 'candidate-export'), deliveryPath = join(candidateDir, 'delivery.json'), manifestPath = join(candidateDir, 'manifest.json');
  const delivery = await exists(deliveryPath) ? await json(deliveryPath) : null;
  const current = result?.records ?? [], delivered = delivery ? allDeliveredRecords(delivery) : [];
  if (delivery) {
    const document = (await json(join(code, paper.ir_path))).document, catalog = await json(join(code, paper.figure_catalog_path));
    const rebuilt = buildEvidenceDelivery(document, current, catalog), expected = new Map(allDeliveredRecords(rebuilt).map(r => [r.record_id, r]));
    assert.equal(delivered.length, expected.size);
    for (const r of delivered) for (const field of ['record_version', 'source_record_sha256', 'text_fingerprint', 'delivery_fingerprint'])
      assert.equal(r[field], expected.get(r.record_id)[field], paper.job_id + '/' + r.record_id + '/' + field);
  }
  const groups = delivery?.strict_source_groups ?? [], byDelivered = new Map(delivered.map(r => [r.record_id, r]));
  const sameSource = new Map();
  for (const v of current) {
    const r = v.record, sourceCore = { document: r.document_id, family: r.article_family_id, PDF: r.source_version,
      text_version: r.text_version, run_id: r.extraction_trace.run_id, task_id: r.extraction_trace.task_id, scope: r.extraction_trace.scope,
      quote: r.original_quote, source: anchors(r.quote_span.segments), joiner: r.quote_span.display_joiner,
      context: { before: r.context.before, after: r.context.after, fragments: anchors(r.context.fragments),
        article_scope_status: r.context.article_scope_status, table_support: r.context.supporting_table_evidence ?? [] } };
    const key = hash(stable(sourceCore)), set = sameSource.get(key) ?? []; set.push(v); sameSource.set(key, set);
    if (internalStructureReferencesOnly(r.context.source_attribution.cited_references)) internalReferenceObservations.push({
      job_id: paper.job_id, record_id: r.record_id, record_version: v.version, full_original_quote: r.original_quote,
      source_attribution_unapproved: r.context.source_attribution, internal_structure_markers_present_in_cited_references: true,
      delivered_group_flags: groups.filter(g => g.members.some(m => m.record_id === r.record_id)).map(g => ({ group_id: g.group_id,
        internal_reference_attribution_needs_review: g.internal_reference_attribution_needs_review, attribution_conflict: g.attribution_conflict, status: g.status })),
      note: 'Keep the actual frozen flag. The current flag specifically detects cited_research with only internal markers; unclear plus Fig.2 is still unresolved attribution, not proof that the issue is fixed.' });
  }
  for (const [sourceKey, set] of sameSource) if (set.length > 1) {
    const fields = r => ({ disease: observationField(r.disease_or_lesion), modality: observationField(r.modality), sequence: observationField(r.sequence_or_phase),
      assertion: { value: r.assertion.value, original_wording: r.assertion.original_wording, evidence: anchors(r.assertion.evidence) },
      applicability: { status: r.applicability.status, original_wording: r.applicability.original_wording, evidence: anchors(r.applicability.evidence) },
      numeric_expressions: r.numeric_expressions });
    const values = set.map(v => fields(v.record)), differing = Object.keys(values[0]).filter(k => new Set(values.map(v => stable(v[k]))).size > 1);
    sameSourceMetadataObservations.push({ job_id: paper.job_id, same_source_quote_context_observation_key: sourceKey,
      full_original_quote: set[0].record.original_quote, same_literal_PDF_IR_quote_context: true,
      strict_source_key_count: new Set(set.map(v => strictSourceGroupKey(v.record))).size,
      differing_strict_guard_fields: differing,
      attribution_differs_between_members: new Set(set.map(v => stable(v.record.context.source_attribution))).size > 1,
      members: set.map((v, i) => ({ record_id: v.record.record_id, record_version: v.version, strict_source_key: strictSourceGroupKey(v.record),
        strict_guard_fields: values[i], source_attribution_unapproved: v.record.context.source_attribution,
        role_unapproved: byDelivered.get(v.record.record_id)?.primary_assessment ?? null,
        warnings: v.record.evidence_validation.warnings })),
      interpretation: differing.length ? 'Same literal source/context retained separately because structured clinical/numeric values or their selected evidence differ. This is a conservative metadata guard, not evidence of different patients or two independent descriptions.'
        : 'Same literal source/context and guarded fields: existing strict group indexes both original members. Raw records are retained.',
      medical_deduplication_or_human_adjudication: false, source_records_modified: false });
  }
  const row = report.jobs.find(j => j.job_id === paper.job_id);
  const counts = { raw_current_records: current.length, raw_versions: result?.versions?.length ?? 0,
    delivered_primary_candidates: delivery?.records.length ?? null, delivered_background_suggestions: delivery?.background_records?.length ?? (delivery ? 0 : null),
    delivered_total_records: delivery ? delivered.length : null, unique_source_group_count: delivery?.unique_source_group_count ?? null,
    duplicate_source_groups: delivery ? groups.filter(g => g.member_count > 1).length : null,
    duplicate_member_excess: delivery ? groups.reduce((n, g) => n + Math.max(0, g.member_count - 1), 0) : null,
    attribution_conflict_groups: delivery ? groups.filter(g => g.attribution_conflict).length : null,
    role_conflict_groups: delivery ? groups.filter(g => g.role_conflict).length : null,
    figure_conflict_groups: delivery ? groups.filter(g => g.figure_association_conflict).length : null,
    intermediate_candidate_submission_rejections: result?.events.filter(e => e.type === 'candidate_validation_rejected').length ?? 0,
    intermediate_summary_submission_rejections: result?.events.filter(e => e.type === 'summary_submission_rejected').length ?? 0,
    real_human_approvals: 0, medical_quality_approved: false };
  jobs.push({ job_id: paper.job_id, document_id: paper.document_id, method: 'B0', started: jobRequests.length > 0, attempted: Boolean(row || result),
    status: row?.status ?? 'not_started', result_path: await exists(resultPath) ? rel(resultPath) : null, result_sha256: await exists(resultPath) ? await fileHash(resultPath) : null,
    candidate_export: delivery ? { directory: rel(candidateDir), manifest_path: rel(manifestPath), manifest_sha256: await fileHash(manifestPath),
      delivery_path: rel(deliveryPath), delivery_sha256: await fileHash(deliveryPath),
      file_sha256: Object.fromEntries(await Promise.all(['records.jsonl', 'records.csv', 'background-records.jsonl', 'background-records.csv', 'coverage.json', 'sample-audit.json', 'reviews.json']
        .map(async file => [file, await exists(join(candidateDir, file)) ? await fileHash(join(candidateDir, file)) : null]))) } : null,
    requests: jobRequests.length, counts, task_processing_complete: result?.task_processing_complete ?? false,
    delivery_validation: result?.delivery_validation ?? null, primary_assessment_validation: result?.primary_assessment_validation ?? null,
    coverage: result?.coverage ?? null, failure_codes: row?.failure_codes ?? null, error: row?.error ?? result?.error ?? null });
  for (const target of plan.observations.filter(o => o.document_id === paper.document_id)) {
    const matches = current.map(v => {
      const r = v.record, quote = coverage(r.quote_span.segments, target.source_fragments), context = coverage(r.context.fragments, target.source_fragments),
        overlap = [...r.quote_span.segments, ...r.context.fragments].some(s => target.source_fragments.some(t => overlaps(s, t)));
      if (!quote && !context && !overlap) return null;
      const d = byDelivered.get(r.record_id);
      const exactTargetOnly = r.quote_span.segments.length === target.source_fragments.length && r.quote_span.segments.every((s, i) => {
        const t = target.source_fragments[i]; return s.block_id === t.block_id && s.text_version === t.text_version && s.start === t.start && s.end === t.end && s.exact_quote === t.exact_quote;
      });
      return { record_id: r.record_id, record_version: v.version, record_actor: v.actor, source_record_sha256: d?.source_record_sha256 ?? hash(JSON.stringify(r)),
        full_target_covered_in_quote: quote, full_target_covered_in_context: context, any_literal_overlap: overlap,
        quote_is_exact_target_spans_only: exactTargetOnly,
        full_new_original_quote: r.original_quote, full_new_quote_fragments: r.quote_span.segments,
        full_new_context_fragments: r.context.fragments, full_new_context_before: r.context.before, full_new_context_after: r.context.after,
        model_primary_assessment_unapproved: r.evidence_validation.model_semantic_review.primary_assessment ?? null,
        delivered_role: d?.primary_assessment?.effective_role ?? (d ? 'primary_candidate' : 'not_delivered'),
        source_attribution_unapproved: r.context.source_attribution, review_status: r.review_status,
        figure_association_unapproved: d?.figure_association ?? null, strict_source_key: strictSourceGroupKey(r) };
    }).filter(Boolean);
    const ids = new Set(matches.map(m => m.record_id)), relevantGroups = groups.filter(g => g.members.some(m => ids.has(m.record_id)));
    observations.push({ ...target, job_id: paper.job_id, actual_run_started: jobRequests.length > 0, output_available: Boolean(result),
      status: !result ? 'not_observed_job_not_run' : !matches.length ? 'source_span_not_emitted_in_current_records' : 'literal_source_matches_recorded_semantic_review_pending',
      matches, strict_source_groups_for_matches: relevantGroups,
      delivered_group_evidence_available: Boolean(delivery),
      actual_duplicate_conflict_triggered: delivery ? relevantGroups.some(g => g.member_count > 1 && g.attribution_conflict) : null,
      omissions_are_not_recall_pass_or_failure: true, known_isolated_negative_primary_match_requires_review: target.judgement_basis === 'user_confirmed_isolated_negative' &&
        matches.some(m => m.full_target_covered_in_quote && m.delivered_role === 'primary_candidate'),
      boundary_review_note: 'Literal inclusion is only a review pointer. Read the complete new quote and context: a larger statement with an actual lesion appearance/comparison is not automatically wrong because it contains the known normal/conclusion span.',
      ordinary_human_review_of_this_new_output: 'not_performed', medical_quality_approved: false });
  }
}
const generatedAt = new Date().toISOString(), observationPath = join(base, 'source-observations-audit.json');
await writeNew(observationPath, { schema_version: 'b0-source-observation-audit-1', finalized_at: generatedAt, evidence_kind: 'offline_literal_and_mechanical_observation_of_new_real_outputs',
  plan_path: rel(planPath), plan_sha256: await fileHash(planPath), observations, complete_gold: false, full_recall_measured: false,
  new_model_output_human_approved: false, medical_quality_approved: false, no_extra_model_calls: true,
  note: 'Known source spans are regression observations, not a complete gold set. A missing output is not recall success/failure. Model role suggestions and mechanical groups are not medical or business approval. 9mm/35HU remain synthetic unit examples only.' });
const auditPath = join(base, 'execution-audit.json');
await writeNew(auditPath, { schema_version: 'b0-terminal-execution-audit-1', finalized_at: generatedAt, execution_status: report.status,
  plan: await fileBinding(planPath), authorization: await fileBinding(join(base, 'authorization.json')), user_confirmation: await fileBinding(join(base, 'user-confirmation.json')),
  authorized_preflight: await fileBinding(join(base, 'authorized-preflight.json')), original_offline_preflight: await fileBinding(join(prepared, 'preflight.json')),
  execution_report: await fileBinding(reportPath), shared_ledger: await fileBinding(ledgerPath), accounting, approved_limits: auth.limits,
  runtime_sources_unchanged: Object.keys(plan.source_hashes).length, original_and_frozen_input_bindings: checkedSources,
  jobs, unstarted_job_ids: jobs.filter(j => !j.started).map(j => j.job_id), runner_unattempted_job_ids: report.not_started_job_ids,
  same_source_metadata_observations: sameSourceMetadataObservations, internal_reference_attribution_observations: internalReferenceObservations,
  unassigned_requests: requests.length - jobs.reduce((n, j) => n + j.requests, 0), all_attempts_in_one_ledger: true,
  authorization_closed_after_terminal: true, unused_budget_is_not_future_permission: true, automatic_second_round: false,
  model_output_human_approved: false, medical_quality_approved: false, full_recall_claimed: false, formal_architecture_reviews_used: 3,
  observation_audit: await fileBinding(observationPath), postprocessing_script: await fileBinding(fileURLToPath(import.meta.url)) });
assert.equal(await fileHash(ledgerPath), ledgerHash, 'Ledger changed during terminal audit.');
assert.equal(await fileHash(reportPath), reportHash, 'Execution report changed during terminal audit.');
const bindingPath = join(base, 'output-binding.json');
await writeNew(bindingPath, { schema_version: 'b0-finalized-output-binding-1', finalized: true, finalized_at: generatedAt, path_base: 'code',
  plan_path: rel(planPath), plan_sha256: await fileHash(planPath), execution_report_path: rel(reportPath), execution_report_sha256: reportHash,
  execution_status: report.status, authorization_id: auth.authorization_id, authorization_path: rel(join(base, 'authorization.json')),
  authorization_sha256: await fileHash(join(base, 'authorization.json')), ledger_path: rel(ledgerPath), ledger_sha256: ledgerHash,
  execution_audit_path: rel(auditPath), execution_audit_sha256: await fileHash(auditPath),
  observation_audit_path: rel(observationPath), observation_audit_sha256: await fileHash(observationPath), jobs,
  real_human_output_reviews: 0, medical_quality_approved: false, full_recall_claimed: false, old_143_results_or_feedback_rewritten: false });
process.stdout.write(JSON.stringify({ finalized: true, binding_path: rel(bindingPath), binding_sha256: await fileHash(bindingPath),
  execution_status: report.status, accounting, jobs: jobs.map(j => ({ job_id: j.job_id, started: j.started, counts: j.counts })),
  observations: observations.map(o => ({ case_id: o.case_id, status: o.status, matches: o.matches.length,
    known_negative_primary_flag: o.known_isolated_negative_primary_match_requires_review })) }) + '\n');
