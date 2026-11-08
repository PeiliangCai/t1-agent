import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertSchema, RunInputSchema, EvidenceCatalogSchema, ContractError, type RunInput,
  type EvidenceCatalog, type EvidenceValidationContext, type FigureAssetCatalog } from '@t1/contracts';
import { safeError, type ModelConfig } from './config.js';
import { assertParsedDocument } from './parser.js';
import { buildArticleScope, planExtractionBatches, type ExtractionDocument } from './article-scope.js';
import { ExtractionStore } from './extraction-store.js';
import { ExtractionBudget, S4_LIMITS } from './extraction-budget.js';
import { createExtractionSession, promptExtractionSession, type ExtractionModelProfile } from './extraction-pi.js';
import { ExtractionTools } from './extraction-tools.js';
import { ExtractionSummaryTools, assertSemanticAuditCases, type ExtractionSemanticAuditCase } from './extraction-summary.js';
import { evidenceScopeIssues } from './scope-matching.js';
import { selectSourceBlocks, type SourceSelectionCondition } from './source-selection.js';
import { assertLivePdfSource, discoverPdfFigures } from './figure-assets.js';
import { assertFigureCatalog, buildEvidenceDelivery } from './evidence-delivery.js';
import { addSourceStatementContext, SOURCE_EVIDENCE_UNIT_VERSION } from './source-evidence-units.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from './visual-evidence-policy.js';
import { BoundedToolRecovery } from './extraction-tool-recovery.js';

export interface ExtractionRunOptions {
  input: RunInput; document: ExtractionDocument; catalog: EvidenceCatalog; metadata: EvidenceValidationContext['metadata'];
  profile: ExtractionModelProfile; config: ModelConfig; budget: ExtractionBudget; store: ExtractionStore; directory: string;
  strategy: 'baseline' | 'independent_context_review'; signal?: AbortSignal;
  batchOptions?: { maxCodePoints?: number; maxBlocks?: number; contextBlocks?: number }; allowDevelopmentCatalog?: boolean;
  /** Default keeps the historical 15-minute limit; explicit new runs may use the authorized 30-minute maximum. */
  documentTimeoutMs?: number;
  batchMaxResponses?: number;
  executionConcurrency?: 1 | 2;
  semanticAuditCases?: readonly ExtractionSemanticAuditCase[];
  sourceSelectionCondition?: SourceSelectionCondition;
  figureCatalog?: FigureAssetCatalog;
  /** Real-PDF runs discover local assets; explicit omission is recorded, never called no-image. */
  figureDiscovery?: 'discover' | 'not_requested';
}
export async function runExtractionDocument(options: ExtractionRunOptions) {
  const { input, document, catalog, metadata, profile, config, budget, store, directory, strategy } = options;
  assertSchema(RunInputSchema, input); assertSchema(EvidenceCatalogSchema, catalog); assertParsedDocument(document);
  if (options.figureCatalog) assertFigureCatalog(document, options.figureCatalog);
  if (input.document_id !== document.document_id || input.file_sha256 !== document.file_sha256 || input.fixture !== document.fixture) throw new ContractError('extraction_document_identity_mismatch');
  if (metadata.source_version.file_sha256 !== document.file_sha256) throw new ContractError('extraction_metadata_source_mismatch');
  await assertLivePdfSource(document);
  const article = buildArticleScope(document), selection = selectSourceBlocks(document, article, options.sourceSelectionCondition ?? 'B0');
  const batches = addSourceStatementContext(document,
    planExtractionBatches(document, { ...article, included_block_ids: selection.kept_block_ids }, options.batchOptions), article.included_block_ids);
  const documentTimeout = options.documentTimeoutMs ?? S4_LIMITS.document_seconds * 1000;
  if (documentTimeout < 1 || documentTimeout > 1800 * 1000) throw new ContractError('document_deadline_exceeds_authorized_limit');
  const batchMaxResponses = options.batchMaxResponses ?? S4_LIMITS.batch_responses;
  if (!Number.isInteger(batchMaxResponses) || batchMaxResponses < 1 || batchMaxResponses > 16) throw new ContractError('batch_response_limit_exceeds_authorized_limit');
  const started = performance.now(), startedEpoch = Date.now(), cpuStart = process.cpuUsage(); let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), documentTimeout);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let figureCatalog = options.figureCatalog;
  let figureDiscovery: { status: string; error_code?: string } = { status: figureCatalog ? 'provided' : 'not_requested' };
  if (!figureCatalog && !document.fixture && options.figureDiscovery !== 'not_requested') {
    try { figureCatalog = await discoverPdfFigures(document, directory, signal); figureDiscovery = { status: 'local_discovery_complete' }; }
    catch (cause) {
      // Source identity failures are not ordinary image-render failures and must stop before model calls.
      try { await assertLivePdfSource(document); }
      catch (identityError) { clearInterval(sampler); clearTimeout(timeout); throw identityError; }
      figureDiscovery = { status: 'failed_text_still_deliverable', error_code: safeError(cause).code };
    }
  }
  store.create(input, { ...metadata, strategy, model_profile: profile, parser: document.parser,
    source_ir_reused: true, original_pdf_modified: false, medical_quality_approved: false,
    evidence_policy_version: VISUAL_STATEMENT_POLICY_VERSION, source_evidence_unit_version: SOURCE_EVIDENCE_UNIT_VERSION });
  await writeFile(resolve(directory, 'article-scope.json'), JSON.stringify(article, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(directory, 'source-selection.json'), JSON.stringify(selection, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(directory, 'batch-plan.json'), JSON.stringify(batches, null, 2) + '\n', { flag: 'wx' });
  const read = new Set<string>(), summaryRead = new Set<string>(), completed = new Set<string>(), failed = new Set<string>();
  let firstCandidate: number | null = null, contextExposures = 0, summaryCompleted = false, documentSummary = '';
  const attempts: Array<Record<string, unknown>> = [];
  const summaryAttempts: Array<Record<string, unknown>> = [];
  let error: ReturnType<typeof safeError> | undefined;
  try {
    if (input.scope.catalog_version !== catalog.catalog_version) throw new ContractError('catalog_version_mismatch');
    if (input.scope.features.mode === 'selected' && catalog.status !== 'approved' && !(catalog.status === 'development_only' && options.allowDevelopmentCatalog)) throw new ContractError('strict_extraction_requires_approved_catalog');
    const scopeIssues = evidenceScopeIssues(input.scope, catalog, { fixture: input.fixture, allowDevelopmentCatalog: options.allowDevelopmentCatalog });
    if (scopeIssues.length) throw new ContractError(scopeIssues.join(','));
    assertSemanticAuditCases({ input, document, catalog, metadata }, article, options.semanticAuditCases ?? []);
    if (signal.aborted) throw new ContractError('run_cancelled');
    store.transition(input.run_id, 'extracting');
    store.event(input.run_id, 'coverage_inventory', { all_source_blocks: document.blocks.length,
      assigned_blocks: article.included_block_ids.length, quarantined_blocks: article.quarantined_block_ids.length,
      dispatched_blocks: selection.kept_block_ids.length, deferred_blocks: selection.deferred_block_ids.length,
      excluded_input_copy_blocks: selection.excluded_block_ids.length, source_selection_digest: selection.digest,
      unselected_is_not_processed: true,
      parser_status: document.parser.status, native_structure_human_verified: false });
    for (const batch of batches) {
      if (signal.aborted) throw new ContractError(options.signal?.aborted ? 'run_cancelled' : 'document_time_limit');
      budget.check(); let succeeded = false;
      for (let attempt = 0; attempt <= S4_LIMITS.transient_retries; attempt++) {
        const context = { input, document, catalog, metadata, allowDevelopmentCatalog: options.allowDevelopmentCatalog,
          evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
        const tools = new ExtractionTools(context, batch, article, store, 'batch_lines');
        const created = await createExtractionSession(config, profile, tools.definitions(), resolve(directory, batch.batch_id + '-attempt-' + attempt), budget,
          input.run_id + ':' + batch.batch_id, attempt, batchMaxResponses);
        const previousFinish = created.session.agent.finishTurn;
        const recovery = new BoundedToolRecovery(created.session.agent, (type, detail) =>
          store.event(input.run_id, type, { batch_id: batch.batch_id, ...detail }));
        created.session.agent.finishTurn = async (turn, finishSignal) => {
          const decision = await previousFinish?.(turn, finishSignal);
          const correction = !signal.aborted ? recovery.afterTurn(turn) : undefined;
          return recovery.stopped || tools.completed ? { action: 'end' } : correction ?? decision ?? undefined;
        };
        const result = await promptExtractionSession(created,
          'Extract the current assigned batch. Task, document, source and batch identity are immutable and bound by the host; do not supply or copy IDs into tool arguments.\n' +
          `Immutable scope: ${JSON.stringify(input.scope)}; catalog_status=${catalog.status}; strategy=${strategy}.\n` +
          'First call read_document_blocks with {} to read all assigned source text and boundary context efficiently; never add an empty property name. ' +
          `Use ${VISUAL_STATEMENT_POLICY_VERSION}: extract in-scope prose/caption visual appearance, definitions or dimensions; preserve complete statements and necessary qualifiers across source lines. ` +
          'Use evidence_type and source provenance to distinguish definitions, this-study observations and cited research. ' +
          'Unknown facts remain unknown with null values and empty evidence. Do not infer facts from selection. ' +
          'feature_name_raw must be a literal term appearing in the selected source lines, or null; do not paraphrase, translate, combine names or normalize its spacing. Put a grouping suggestion in feature_category. ' +
          'Submit candidates in groups of at most THREE. Prefer source_unit_ids to select COMPLETE exact original sentences. Alternatively use source_line_indices for whole lines; incomplete known sentence spans are rejected. Choose exactly one source selector. ALL medical/numeric line_indices and *_line_indices refer directly to the SAME returned source_lines.line_index table; NEVER renumber within a record. No source_indices/exact_quote/source_fragments/context_fragments fields exist. The host saves exact text and identity. ' +
          'Independent table rows, feature-name/measurement checklists, evaluators, cohort/experimental setup and pure statistical associations are not primary visual statements. General visual definitions do not require a case/image. Keep all necessary subjects/conditions and literal dimensions; do not reject entire Methods/Conclusion sections or all numbers. Table values are support only when explicitly cited in the primary visual sentence. Semantics and figure type remain unapproved. ' +
          'Prefer independent complete source statements. Do not duplicate one list sentence into separate records for every named feature; do not combine distant repeated mentions into a new continuous assertion. Keep different conditions or conflicts separate. ' +
          'After all assigned blocks have been considered, call submit_candidate_records with batch_complete=true, including records=[] if there are no candidates. ' +
          'The host ends the session after the successful completion tool result; no acknowledgement response is needed. A medical reviewer has not approved any result.', budget, signal,
          Math.max(1, documentTimeout - (performance.now() - started)));
        if (recovery.stopped) result.error = safeError(new ContractError('model_tool_protocol_diagnostic_pause'));
        for (const id of tools.readBlocks) read.add(id);
        contextExposures += batch.context_block_ids.filter(id => tools.readBlocks.has(id)).length;
        const detail = { ...batch, attempt, status: !result.error && tools.completed ? 'completed' : 'failed',
          read_block_ids: [...tools.readBlocks], explicit_completion_received: tools.completed, result,
          tool_calls: tools.calls, issues: tools.issues, candidate_count_so_far: store.current(input.run_id).length };
        attempts.push(detail); store.batch(input.run_id, batch.batch_id, detail);
        await writeFile(resolve(directory, batch.batch_id + '-attempt-' + attempt + '.json'), JSON.stringify({ ...detail,
          audit: created.audit, request_accounting: created.entries }, null, 2) + '\n', { flag: 'wx' });
        if (firstCandidate === null && store.current(input.run_id).length) {
          const event = store.events(input.run_id).find(e => e.type === 'candidate');
          firstCandidate = event ? Math.max(0, Date.parse(event.timestamp) - startedEpoch) / 1000 : (performance.now() - started) / 1000;
        }
        process.stdout.write(JSON.stringify({ run_id: input.run_id, model_id: profile.model_id, strategy, batch_id: batch.batch_id,
          status: detail.status, completed_blocks: completed.size + (detail.status === 'completed' ? batch.assigned_block_ids.length : 0),
          expected_blocks: article.included_block_ids.length, candidates: store.current(input.run_id).length, requests: budget.totals().requests }) + '\n');
        if (!result.error && tools.completed) { batch.assigned_block_ids.forEach(id => completed.add(id)); succeeded = true; break; }
        if (recovery.stopped) throw new ContractError('model_tool_protocol_diagnostic_pause');
        if (signal.aborted) throw new ContractError(options.signal?.aborted ? 'run_cancelled' : 'document_time_limit');
        if (!result.transient_error || attempt === S4_LIMITS.transient_retries) break;
        store.event(input.run_id, 'retry', { batch_id: batch.batch_id, next_attempt: attempt + 1, reason: 'transient_provider_or_transport_error' });
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
      if (!succeeded) batch.assigned_block_ids.forEach(id => failed.add(id));
    }
    store.transition(input.run_id, 'reconciling');
    let finalSummaryReport: Record<string, unknown> | undefined;
    for (let summaryAttempt = 0; summaryAttempt <= S4_LIMITS.transient_retries; summaryAttempt++) {
    if (signal.aborted) throw new ContractError(options.signal?.aborted ? 'run_cancelled' : 'document_time_limit');
    budget.check();
    const summaryTools = new ExtractionSummaryTools({ input, document, catalog, metadata,
      allowDevelopmentCatalog: options.allowDevelopmentCatalog, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION }, article, store, strategy, options.semanticAuditCases, selection);
    const summarySession = await createExtractionSession(config, profile, summaryTools.definitions(), resolve(directory, 'whole-document-summary-attempt-' + summaryAttempt), budget,
      input.run_id + ':whole-document-summary', summaryAttempt, batchMaxResponses);
    const previousSummaryTransform = summarySession.session.agent.transformContext;
    summarySession.session.agent.transformContext = async (messages, transformSignal) =>
      summaryTools.projectModelMessages(previousSummaryTransform ? await previousSummaryTransform(messages, transformSignal) : messages);
    const previousSummaryFinish = summarySession.session.agent.finishTurn;
    const summaryRecovery = new BoundedToolRecovery(summarySession.session.agent, (type, detail) =>
      store.event(input.run_id, type, { phase: 'whole_document_summary', ...detail }));
    summarySession.session.agent.finishTurn = async (turn, finishSignal) => {
      const decision = await previousSummaryFinish?.(turn, finishSignal);
      const correction = !signal.aborted ? summaryRecovery.afterTurn(turn) : undefined;
      return summaryRecovery.stopped || summaryTools.completed ? { action: 'end' } : correction ?? decision ?? undefined;
    };
    const summaryResult = await promptExtractionSession(summarySession,
      'Perform single-paper whole-document reconciliation. Identity is host-bound: do not include run/document IDs in tool arguments. ' +
      'Call get_document_context to read ALL candidates with exact source segments. Check same-paper duplicates/conflicts, disease/modality applicability, pronouns and later conditions. ' +
      'Use read_document_blocks to resolve missing source context; keep ambiguity explicit. Keep original conflicting statements separately. ' +
      'Read only the specific lines needed for a candidate or audit case. The transport keeps at most 128 exact original lines in a current working set; older transport copies are replaced by explicit receipts. All candidate text/context stays complete. Explicitly re-read any evicted line before using it in an update. ' +
      `Every source-backed update uses ${VISUAL_STATEMENT_POLICY_VERSION}: complete source_unit_ids when available, prose/caption primary descriptions, explicitly cited table numeric support only. Do not promote feature lists, experimental setup or pure statistical associations. General definitions and direct dimensions remain valid without a case/image; no label proves medical semantics. ` +
      (strategy === 'independent_context_review' ? 'This is an independent semantic review pass in a fresh session: review every candidate version for source fidelity, disease, modality, negation, uncertainty, condition, attribution and original numbers/units; return an entry for every record with issue_codes (empty if none detected). ' :
        'This baseline summarizes and proposes possible duplicate/conflict/context links; per-record independent semantic review is not required. ') +
      'If semantic_audit_cases are present, they are neutral development questions, not gold or predetermined exclusions. Read every required source/context block using read_document_blocks, then report_context_issue for each audit_case_id with an unapproved conclusion and reasons. ' +
      'Specifically distinguish acquisition/reconstruction conditions and standalone clinical associations from independently supported visual evidence; preserve ambiguity and do not apply a keyword-only rule. ' +
      'Call submit_candidate_records to save a short Chinese summary, reviews, possible links, validated source-backed updates if needed (otherwise updates=[]), and summary_complete=true. ' +
      'A submission is atomic: validation errors save no writes. A successful save may return complete=false with completion_blockers and current_versions; then refresh get_document_context or finish the listed reviews/audits before explicitly completing. Do not resubmit a saved update just to refresh visibility. ' +
      'Never mark medical/human approval, never overwrite human revisions. Finish after successful saving.', budget, signal,
      Math.max(1, documentTimeout - (performance.now() - started)));
    if (summaryRecovery.stopped) summaryResult.error = safeError(new ContractError('model_tool_protocol_diagnostic_pause'));
    finalSummaryReport = { strategy, attempt: summaryAttempt, audit: summarySession.audit,
      result: summaryResult, request_accounting: summarySession.entries, summary: summaryTools.summary, issues: summaryTools.issues,
      semantic_audit_reviews: [...summaryTools.auditCaseReviews.values()], semantic_audit_cases_required: (options.semanticAuditCases ?? []).map(c => c.case_id) };
    const summaryPath = resolve(directory, 'whole-document-summary-attempt-' + summaryAttempt + '.json');
    await writeFile(summaryPath, JSON.stringify(finalSummaryReport, null, 2) + '\n', { flag: 'wx' });
    summaryCompleted = !summaryResult.error && summaryTools.completed; documentSummary = summaryTools.summary;
    for (const id of summaryTools.readBlocks) { summaryRead.add(id); read.add(id); }
    summaryAttempts.push({ attempt: summaryAttempt, status: summaryCompleted ? 'completed' : 'failed', path: summaryPath,
      error: summaryResult.error, request_ids: summarySession.entries.map(entry => entry.id),
      candidate_versions_after_attempt: store.versions(input.run_id).length });
    if (summaryCompleted) break;
    if (signal.aborted) throw new ContractError(options.signal?.aborted ? 'run_cancelled' : 'document_time_limit');
    if (!summaryResult.transient_error || budget.ledger.halted || summaryAttempt === S4_LIMITS.transient_retries) break;
    store.event(input.run_id, 'summary_retry', { next_attempt: summaryAttempt + 1, max_retries: S4_LIMITS.transient_retries,
      reason: 'transient_provider_or_transport_error', fresh_session_reads_current_versions: true, human_versions_protected: true });
    await new Promise(resolve => setTimeout(resolve, 250 * (summaryAttempt + 1)));
    }
    await writeFile(resolve(directory, 'whole-document-summary.json'), JSON.stringify({ ...finalSummaryReport,
      recovery_policy: 'fresh_session_on_transient_error_maximum2_retries', attempts: summaryAttempts }, null, 2) + '\n', { flag: 'wx' });
    if (!summaryCompleted) throw new ContractError('whole_document_summary_incomplete');
    const complete = completed.size === article.included_block_ids.length && !failed.size && !article.quarantined_block_ids.length && document.parser.status === 'parsed';
    store.transition(input.run_id, complete ? 'completed' : 'partial');
  } catch (cause) {
    error = safeError(cause);
    const state = store.snapshot(input.run_id).state;
    if (!['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(state)) store.transition(input.run_id,
      options.signal?.aborted ? 'cancelled' : completed.size || store.current(input.run_id).length ? 'partial' : 'failed');
    store.event(input.run_id, 'extraction_error', { ...error, budget_halted: budget.ledger.halted, document_timeout: controller.signal.aborted });
  } finally { clearInterval(sampler); clearTimeout(timeout); }
  try { await assertLivePdfSource(document); }
  catch (sourceError) {
    const invalidation = { current_source_valid: false, historical_ir_file_sha256: document.file_sha256,
      error: safeError(sourceError), cached_candidates_are_historical: true, approved_export_blocked: true };
    store.event(input.run_id, 'source_invalidated', invalidation);
    await writeFile(resolve(directory, 'source-invalidated.json'), JSON.stringify(invalidation, null, 2)+'\n', { flag: 'wx' });
    throw sourceError;
  }
  const snapshot = store.snapshot(input.run_id), usage = process.cpuUsage(cpuStart);
  const result = { schema_version: 's4-extraction-run-1', run_id: input.run_id, document_id: input.document_id,
    model_id: profile.model_id, reasoning_effort: profile.reasoning_effort, strategy, source_selection_condition: selection.condition,
    source_selection_digest: selection.digest, state: snapshot.state,
    evidence_policy_version: VISUAL_STATEMENT_POLICY_VERSION, source_evidence_unit_version: SOURCE_EVIDENCE_UNIT_VERSION,
    medical_extraction_implemented: true, medical_quality_approved: false, human_gold_complete: false,
    full_gold_is_prerequisite: false, acceptance_method: 'automatic_source_checks_plus_human_output_sample',
    approved_export_requires_each_record_confirmation: true, figure_discovery: figureDiscovery,
    summary_is_diagnostic_not_delivered_description: true,
    formal_model_selected: false, actual_Pi_SDK: '1.4.0', original_pdf_uploads: 0,
    operation_limits: { document_timeout_ms: documentTimeout, batch_max_responses: batchMaxResponses,
      request_seconds: S4_LIMITS.request_seconds, original_ledger_limits_retained: true,
      transient_retries: S4_LIMITS.transient_retries, summary_fresh_session_retries: S4_LIMITS.transient_retries,
      call_and_token_caps_unchanged: true, effective_global_wall_clock_seconds: budget.wallClockSeconds },
    candidate_count: snapshot.candidates.length, candidate_versions: store.versions(input.run_id).length, summary_attempts: summaryAttempts,
    first_candidate_seconds: firstCandidate, total_seconds: (performance.now() - started) / 1000,
    timing_scope: 'cached_real_DocumentIR_to_Pi_candidates_and_summary_not_fresh_PDF_end_to_end',
    coverage: { physical_pages: document.pages.length, parser_status: document.parser.status,
      all_source_blocks: document.blocks.length, assigned_source_blocks: article.included_block_ids.length,
      dispatched_source_blocks: selection.kept_block_ids.length, deferred_source_block_ids: selection.deferred_block_ids,
      excluded_input_copy_source_block_ids: selection.excluded_block_ids,
      selected_source_block_processing_complete: selection.kept_block_ids.every(id => completed.has(id)),
      summary_reread_source_block_ids: [...summaryRead],
      unselected_reread_source_block_ids: [...summaryRead].filter(id => !selection.kept_block_ids.includes(id)),
      unselected_blocks_remain_not_explicitly_completed: true,
      source_blocks_read: read.size, explicitly_completed_source_blocks: completed.size,
      completed_source_block_ids: [...completed], failed_source_block_ids: [...failed],
      unprocessed_source_block_ids: article.included_block_ids.filter(id => !completed.has(id) && !failed.has(id)),
      quarantined_source_block_ids: article.quarantined_block_ids,
      context_block_exposures_including_overlap: contextExposures, context_unique_block_ids: [...new Set(batches.flatMap(b => b.context_block_ids))],
      source_block_processing_complete: completed.size === article.included_block_ids.length,
      whole_document_summary_complete: summaryCompleted, full_document_extraction_completed: snapshot.state === 'completed',
      parser_failed_pages: document.coverage.failed_pages, image_text_unverified_pages: document.coverage.image_text_unverified_pages,
      source_fidelity_human_verified: false, medical_recall_proven_by_coverage: false },
    summary: documentSummary, error, ledger_totals: budget.totals(), actual_cost: null, cost_status: 'unknown_gateway_billing',
    resources: { cpu_user_seconds: usage.user / 1e6, cpu_system_seconds: usage.system / 1e6, peak_sampled_rss_bytes: peakRss,
      rss_sampling_ms: 100, scope: 'current_Node_process_only_cached_parser_IR', parser_native_inference_repeated: false, gpu_used: false,
      matrix_concurrency: options.executionConcurrency ?? 1, measurements_shared_with_other_document_jobs: options.executionConcurrency === 2 },
    records: snapshot.candidates, versions: store.versions(input.run_id), events: store.events(input.run_id) };
  const delivery = buildEvidenceDelivery(document, snapshot.candidates, figureCatalog);
  await writeFile(resolve(directory, 'delivery.json'), JSON.stringify(delivery, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
