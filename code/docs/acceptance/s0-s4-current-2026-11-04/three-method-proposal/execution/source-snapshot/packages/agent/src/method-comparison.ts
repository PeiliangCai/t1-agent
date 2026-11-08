import { createHash } from 'node:crypto';
import { ContractError } from '@t1/contracts';
import { buildArticleScope, planExtractionBatches, type ExtractionDocument } from './article-scope.js';
import { selectSourceBlocks, SOURCE_SELECTION_VERSION } from './source-selection.js';
import type { SourceManifest } from '../../../evaluation/src/contracts.js';
import { assertIndependentCorpus, normalizeDoi, type IndependentCorpus } from '../../../evaluation/src/corpus-isolation.js';

export const COMPARISON_METHODS = [
  { id: 'agent_only', label: '单独智能体', condition: 'B0', behavior: 'all eligible source blocks; no topic filter' },
  { id: 'positive_rules_agent', label: '规则正向预抽取＋智能体', condition: 'F', behavior: 'broad visual/modality and structure seeds plus neighbor context; qualifiers/numbers/unknowns retained; explicit nonvisual blocks may be deferred' },
  { id: 'remove_irrelevant_agent', label: '仅删除明确无关＋智能体', condition: 'R', behavior: 'exclude only complete confirmed bibliography or explicit boilerplate in input copy; unknowns retained' },
] as const;
export const comparisonDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Invoked by BOTH preparation and execution, before the paper's PDF or IR contents are loaded. */
export function assertComparisonSourceUse(source: { source_id: string; article_family_id: string; doi: string | null; file_sha256: string },
  historical: SourceManifest, independent: IndependentCorpus) {
  assertIndependentCorpus(independent, historical);
  const doi = normalizeDoi(source.doi);
  if (independent.papers.some(p => p.source_id === source.source_id || p.article_family_id === source.article_family_id ||
    p.file.sha256 === source.file_sha256 || doi !== null && normalizeDoi(p.doi) === doi)) {
    throw new ContractError('independent_corpus_forbidden_for_development_or_selection');
  }
  const registered = historical.sources.find(p => p.source_id === source.source_id);
  if (!registered || registered.article_family_id !== source.article_family_id || registered.access.sha256 !== source.file_sha256 ||
    normalizeDoi(registered.doi) !== doi || !registered.access.file_verified || !registered.exposure.used_in_prior_research ||
    registered.exposure.independent_acceptance_eligible !== false) throw new ContractError('comparison_source_status_unknown_or_identity_changed');
  return { use: 'development_selection', independent_acceptance: false, source_status: 'registered_already_exposed',
    source_id: source.source_id, article_family_id: source.article_family_id };
}

/** Only original block IDs/text are selected. Equal masks are disclosed, never counted as method gains. */
export function planPaperMethods(document: ExtractionDocument, common: unknown,
  batchOptions: { maxCodePoints: number; maxBlocks: number; contextBlocks: number }) {
  const article = buildArticleScope(document);
  const seen = new Map<string, string>();
  const jobs = COMPARISON_METHODS.map(method => {
    const selection = selectSourceBlocks(document, article, method.condition);
    const batches = planExtractionBatches(document, { ...article, included_block_ids: selection.kept_block_ids }, batchOptions);
    const sourceInput = { common, document_id: document.document_id, file_sha256: document.file_sha256, text_version: document.text_version,
      provided_source: selection.kept_block_ids.map(id => { const b = document.blocks.find(b => b.block_id === id)!; return { id, text: b.text }; }),
      batches, authorized_indices: selection.entries.filter(e => e.article_eligible).map(e => e.document_line_index),
      omitted_indices: selection.entries.filter(e => e.article_eligible && e.state !== 'kept').map(e => e.document_line_index) };
    const digest = comparisonDigest(sourceInput), jobId = document.document_id + '-' + method.condition, representative = seen.get(digest) ?? null;
    if (!representative) seen.set(digest, jobId);
    const rules = Object.fromEntries([...new Set(selection.entries.flatMap(e => e.rule_ids))].sort()
      .map(rule => [rule, selection.entries.filter(e => e.rule_ids.includes(rule)).length]));
    return { job_id: jobId, method: method.id, label: method.label, condition: method.condition, behavior: method.behavior,
      document_id: document.document_id, common_sha256: comparisonDigest(common), model_source_input_sha256: digest,
      source_selection_digest: selection.digest, rule_version: SOURCE_SELECTION_VERSION, selected_block_count: selection.kept_block_ids.length,
      original_block_count: document.blocks.length, code_points: selection.code_points, counts: selection.counts, rule_counts: rules,
      batch_count: batches.length, representative_job_id: representative, independent_model_run: representative === null,
      equal_source_inputs_are_not_independent_evidence: representative !== null, status: 'prepared_no_model_call',
      reuse_basis: representative ? 'identical source text, batches/context, scope, model/system/tool implementation and neutral dispatch/omission model view; method labels/reasons are not sent' : null,
      selection, batches };
  });
  return { article, jobs, unique_inputs: seen.size, logical_methods: COMPARISON_METHODS.length,
    all_three_inputs_identical: seen.size === 1, original_source_modified: false, medical_quality_approved: false };
}

/** A follow-up optimization keeps the model and all other experiment variables frozen. */
export function assertSingleOptimization(before: Record<string, unknown>, after: Record<string, unknown>, declaredKey: string) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => comparisonDigest(before[k] ?? null) !== comparisonDigest(after[k] ?? null));
  if (changed.length !== 1 || changed[0] !== declaredKey || ['model', 'papers', 'scope', 'parser', 'figure_pairing'].includes(declaredKey)) {
    throw new ContractError('comparison_requires_one_declared_optimization_with_frozen_model_and_sources');
  }
}
