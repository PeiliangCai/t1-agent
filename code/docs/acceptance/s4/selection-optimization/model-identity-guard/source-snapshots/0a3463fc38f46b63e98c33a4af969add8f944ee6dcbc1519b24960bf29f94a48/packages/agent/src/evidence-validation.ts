import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { RunInputSchema } from '../../contracts/src/index.js';
import { EvidenceRecordSchema, EvidenceSubmissionSchema, type EvidenceFragment, type EvidenceRecord,
  type EvidenceSubmission, type EvidenceValidationContext, type EvidenceValidationResult, type LocatedEvidenceFragment,
  type ScopeMatch, type ValidationIssue } from '../../contracts/src/extraction-evidence.js';
import { containsLiteral, matchEvidenceScope } from './scope-matching.js';

const initialScope = (): ScopeMatch => ({ status: 'blocked', matched_binding_id: null, feature_match: 'none',
  development_catalog_used: false, basis: [], issues: [] });
const clone = <T>(value: T): T => structuredClone(value);
const fragmentKey = (f: LocatedEvidenceFragment) => `${f.block_id}:${f.text_version}:${f.start}:${f.end}`;
const uniqueFragments = (fragments: LocatedEvidenceFragment[]) => [...new Map(fragments.map(f => [fragmentKey(f), f])).values()];
const wordingsContain = (fragments: LocatedEvidenceFragment[], value: string, joiner: string) =>
  fragments.some(f => f.exact_quote.includes(value)) || fragments.map(f => f.exact_quote).join(joiner) === value;

/** Exact code-point matching, including overlapping occurrences; UTF-16 offsets are never exposed. */
export function locateEvidenceFragment(document: EvidenceValidationContext['document'], fragment: EvidenceFragment): LocatedEvidenceFragment {
  const blocks = document.blocks.filter(b => b.block_id === fragment.block_id);
  if (blocks.length !== 1) throw new Error(blocks.length ? 'duplicate_source_block_id' : 'source_block_not_found');
  const block = blocks[0]!;
  if (block.document_id !== document.document_id || block.text_version !== document.text_version) throw new Error('source_block_version_mismatch');
  const source = Array.from(block.text), quote = Array.from(fragment.exact_quote), matches: number[] = [];
  if (!quote.length) throw new Error('empty_source_quote');
  for (let start = 0; start <= source.length - quote.length; start++) {
    if (quote.every((cp, offset) => source[start + offset] === cp)) matches.push(start);
  }
  if (!matches.length) throw new Error('quote_not_in_source');
  if (matches.length > 1 && fragment.occurrence === undefined) throw new Error('ambiguous_quote_requires_occurrence');
  const occurrence = fragment.occurrence ?? 0;
  const start = matches[occurrence];
  if (start === undefined) throw new Error('quote_occurrence_out_of_range');
  return { block_id: block.block_id, text_version: block.text_version, start, end: start + quote.length,
    exact_quote: fragment.exact_quote, occurrence, physical_page: block.page, bbox: [...block.bbox],
    location_precision: 'whole_textline_not_exact_glyph' };
}

/** This proves source identity and explicit consistency only. It never performs medical or human approval. */
export function validateEvidenceSubmission(value: unknown, context: EvidenceValidationContext): EvidenceValidationResult {
  const issues: ValidationIssue[] = [];
  let scopeMatch = initialScope();
  const add = (code: string, severity: ValidationIssue['severity'], path: string, detail = '') => {
    if (!issues.some(i => i.code === code && i.path === path)) issues.push({ code, severity, path, detail });
  };
  const rejected = (): EvidenceValidationResult => ({ accepted: false, record: null, issues, scope_match: scopeMatch });
  if (!Value.Check(EvidenceSubmissionSchema, value)) {
    add('submission_schema_invalid', 'reject', '', 'The submitted JSON does not satisfy EvidenceSubmissionSchema.'); return rejected();
  }
  const submission: EvidenceSubmission = value;
  if (!Value.Check(RunInputSchema, context.input)) {
    add('run_input_schema_invalid', 'reject', 'binding'); return rejected();
  }
  const { input, document, metadata } = context;
  const binding = submission.binding;
  const expected = { task_id: metadata.task_id, run_id: input.run_id, document_id: input.document_id,
    file_sha256: input.file_sha256, source_version: metadata.source_version.version, text_version: document.text_version };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (binding[key] !== expected[key]) add(`binding_${key}_mismatch`, 'reject', `binding.${key}`);
  }
  if (input.document_id !== document.document_id || input.file_sha256 !== document.file_sha256 ||
    input.file_sha256 !== metadata.source_version.file_sha256) add('bound_source_identity_mismatch', 'reject', 'binding');
  if (input.fixture !== document.fixture || (input.fixture ? 'engineering_fixture' : 'real_paper') !== document.evidence_kind) {
    add('source_evidence_kind_mismatch', 'reject', 'binding');
  }
  if (!['2', '3'].includes(document.schema_version)) add('authoritative_source_blocks_required', 'reject', 'binding');
  if (document.parser.status === 'unsupported') add('source_document_unsupported', 'reject', 'binding');
  if (new Set(document.blocks.map(b => b.block_id)).size !== document.blocks.length) add('duplicate_source_block_id', 'reject', 'binding');
  if (metadata.document_access === 'unavailable') add('source_document_unavailable', 'reject', 'binding');
  const provided = new Set(context.allowedBlockIds), read = new Set(context.readBlockIds), quarantined = new Set(context.quarantinedBlockIds ?? []);
  let uncertainArticleScope = false;
  const locate = (fragments: EvidenceFragment[], path: string): LocatedEvidenceFragment[] => fragments.flatMap((fragment, index) => {
    const fieldPath = `${path}[${index}]`;
    if (!provided.has(fragment.block_id)) { add('source_block_not_provided', 'reject', fieldPath); return []; }
    if (!read.has(fragment.block_id)) { add('source_block_not_read', 'reject', fieldPath); return []; }
    try {
      const located = locateEvidenceFragment(document, fragment);
      if (quarantined.has(fragment.block_id)) {
        uncertainArticleScope = true;
        add('article_scope_uncertain', 'requires_review', fieldPath, 'This region is quarantined; article membership is not approved.');
      }
      return [located];
    } catch (error) {
      add(error instanceof Error ? error.message : 'source_location_failed', 'reject', fieldPath); return [];
    }
  });
  const source = locate(submission.source_fragments, 'source_fragments');
  let previousOrder = -1, previousEnd = -1;
  for (const [index, segment] of source.entries()) {
    const order = document.blocks.find(b => b.block_id === segment.block_id)!.reading_order;
    if (order < previousOrder || order === previousOrder && segment.start < previousEnd) {
      add('source_segments_out_of_order_or_overlapping', 'reject', `source_fragments[${index}]`);
    }
    if (previousOrder >= 0 && (order > previousOrder + 1 || order === previousOrder && segment.start > previousEnd)) {
      add('nonadjacent_source_segments_require_context', 'requires_review', `source_fragments[${index}]`,
        'Nonadjacent source fragments form a display composite; omitted intervening text and semantic continuity require review.');
    }
    previousOrder = order; previousEnd = segment.end;
  }
  const suppliedContext = locate(submission.context_fragments, 'context_fragments');
  const observation = (field: 'disease_or_lesion' | 'modality' | 'sequence_or_phase') => {
    const inputObservation = submission[field];
    if (inputObservation === null) return null;
    const evidence = locate(inputObservation.evidence, `${field}.evidence`);
    const grounded = inputObservation.status === 'source_observed' && inputObservation.value !== null &&
      evidence.some(f => containsLiteral(f.exact_quote, inputObservation.value!));
    if (inputObservation.status === 'source_observed' && !grounded || inputObservation.status === 'unknown' && inputObservation.value !== null) {
      add(`${field}_not_grounded_in_source`, 'requires_review', field,
        `Submitted value ${JSON.stringify(inputObservation.value)} was not retained as a source fact.`);
    }
    return { value: grounded ? inputObservation.value : null, status: grounded ? 'source_observed' as const : 'unknown' as const, evidence };
  };
  const disease = observation('disease_or_lesion')!, modality = observation('modality')!, sequence = observation('sequence_or_phase');
  const assertionEvidence = locate(submission.assertion.evidence, 'assertion.evidence');
  const applicabilityEvidence = locate(submission.applicability.evidence, 'applicability.evidence');
  const provenanceEvidence = locate(submission.provenance.evidence, 'provenance.evidence');
  for (const [name, wording, evidence] of [
    ['assertion', submission.assertion.original_wording, assertionEvidence],
    ['applicability', submission.applicability.original_wording, applicabilityEvidence],
  ] as const) {
    if (wording && !wordingsContain(evidence, wording, submission.display_joiner)) add(`${name}_wording_not_literal`, 'reject', `${name}.original_wording`);
  }
  if (submission.assertion.value === 'unknown' || !assertionEvidence.length || !submission.assertion.original_wording) {
    add('assertion_requires_context', 'requires_review', 'assertion');
  }
  if (submission.applicability.status === 'specified' && (!applicabilityEvidence.length || !submission.applicability.original_wording)) {
    add('applicability_requires_context', 'requires_review', 'applicability');
  }
  if (submission.provenance.origin === 'unclear' || !provenanceEvidence.length) add('source_attribution_requires_review', 'requires_review', 'provenance');
  if (submission.provenance.origin === 'cited_research' && !submission.provenance.cited_references.length) {
    add('cited_research_reference_missing', 'requires_review', 'provenance.cited_references');
  }
  const numbers = submission.numeric_expressions.map((number, index) => {
    const evidence = locate(number.evidence, `numeric_expressions[${index}].evidence`);
    if (!evidence.length || !wordingsContain(evidence, number.original_text, submission.display_joiner)) {
      add('numeric_original_not_literal', 'reject', `numeric_expressions[${index}].original_text`);
    }
    const unitPattern = number.unit_original?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const literalUnit = unitPattern ? new RegExp(`(?<![\\p{L}_])${unitPattern}(?![\\p{L}\\p{N}_])`, 'u') : null;
    if (number.unit_original !== null && (!literalUnit || !evidence.some(f => literalUnit.test(f.exact_quote)))) {
      add('numeric_unit_not_literal', 'reject', `numeric_expressions[${index}].unit_original`);
    }
    if (number.unit_original === null && /\d\s*(?:mm|cm|µm|μm|nm|m[lL]|HU|%|毫米|厘米|毫升|秒)/u.test(number.original_text)) {
      add('numeric_unit_missing', 'requires_review', `numeric_expressions[${index}].unit_original`);
    }
    return { original_text: number.original_text, unit_original: number.unit_original, evidence };
  });
  const fieldEvidence = [...disease.evidence, ...modality.evidence, ...(sequence?.evidence ?? []), ...assertionEvidence,
    ...applicabilityEvidence, ...provenanceEvidence, ...numbers.flatMap(n => n.evidence)];
  const suppliedText = [...source, ...suppliedContext, ...fieldEvidence].map(f => f.exact_quote).join('\n');
  if (submission.feature_name_raw !== null && !containsLiteral(suppliedText, submission.feature_name_raw)) {
    add('feature_name_not_in_evidence', 'reject', 'feature_name_raw');
  }
  const allSourceLines = [...new Set(source.map(f => f.block_id))].map(blockId => document.blocks.find(b => b.block_id === blockId)!).filter(Boolean);
  const lineText = [...allSourceLines.map(b => b.text), ...suppliedContext.map(f => f.exact_quote), ...fieldEvidence.map(f => f.exact_quote)].join('\n');
  const sourceBlockIds = new Set(source.map(f => f.block_id));
  if ([...disease.evidence, ...modality.evidence, ...(sequence?.evidence ?? []), ...assertionEvidence, ...applicabilityEvidence]
    .some(f => !sourceBlockIds.has(f.block_id))) {
    add('cross_block_field_relationship_requires_review', 'requires_review', 'context_fragments',
      'Field text is located, but the semantic relationship between blocks is unverified.');
  }
  const assertionText = assertionEvidence.map(e => e.exact_quote).join('\n');
  const negative = /\b(?:no|not|without|neither|absence|absent|negative for)\b|未见|未发现|不存在|没有|不伴|无(?:明显|证据|强化|毛刺|浸润)/iu;
  const conditional = /\b(?:if|when|unless|only|provided that|in patients with|depending on)\b|如果|若|仅(?:在|当|适用)|当.+时|条件|前提/iu;
  const uncertainty = /\b(?:may|might|could|possible|possibly|suggests?|appears?|uncertain)\b|可能|可疑|不能排除|尚不确定/iu;
  if (negative.test(lineText)) {
    if (!negative.test(assertionText)) add('negation_cue_not_in_assertion_evidence', 'requires_review', 'assertion');
    if (submission.assertion.value === 'affirmed') add('assertion_negation_mismatch', 'requires_review', 'assertion.value');
  }
  if (conditional.test(lineText) && (submission.applicability.status === 'unknown' || !conditional.test(applicabilityEvidence.map(e => e.exact_quote).join('\n')))) {
    add('condition_requires_context', 'requires_review', 'applicability');
  }
  if (uncertainty.test(lineText) && ['affirmed', 'negated'].includes(submission.assertion.value)) {
    add('assertion_uncertainty_mismatch', 'requires_review', 'assertion.value');
  }
  if (/\b(?:it|they|these|those|such|this|that)\b|该|其|上述|此/iu.test(source.map(s => s.exact_quote).join('\n')) && !suppliedContext.length) {
    add('coreference_requires_context', 'requires_review', 'context_fragments');
  }
  if (submission.provenance.origin === 'study_authors' && /\b(?:et al\.?|according to|previous studies|reported by)\b|既往研究|据.+报道|等(?:报道|研究)/iu.test(lineText)) {
    add('possible_cited_source_requires_review', 'requires_review', 'provenance.origin');
  }
  if (submission.provenance.cited_references.some(reference => !provenanceEvidence.some(f => f.exact_quote.includes(reference)))) {
    add('cited_reference_not_in_provenance_evidence', 'requires_review', 'provenance.cited_references');
  }
  const numericTokens = source.flatMap(s => [...s.exact_quote.matchAll(/(?:[<>≤≥≈~±+]\s*)?\d+(?:\.\d+)?(?:\s*[–—-]\s*\d+(?:\.\d+)?)?(?:\s*(?:mm|cm|µm|μm|nm|mL|ml|HU|%|毫米|厘米|毫升|秒))?/gu)].map(m => m[0]));
  if (numericTokens.some(token => !numbers.some(n => n.original_text.includes(token)))) add('numeric_expression_missing', 'requires_review', 'numeric_expressions');
  for (const [index, reference] of (submission.structure_references ?? []).entries()) {
    if (document.schema_version !== '3') { add('structure_reference_unavailable', 'reject', `structure_references[${index}]`); continue; }
    const exists = reference.kind === 'unit' ? document.structure.units.some(u => u.unit_id === reference.id) :
      reference.kind === 'table' ? document.structure.tables.some(t => t.table_id === reference.id) : document.structure.pictures.some(p => p.picture_id === reference.id);
    if (!exists) add('structure_reference_not_found', 'reject', `structure_references[${index}]`);
    if (reference.relationship_used) add('unverified_structure_relationship', 'requires_review', `structure_references[${index}]`,
      'Native structure, table cells and figure associations are unverified interpretation hints.');
  }
  if (issues.some(i => i.severity === 'reject') || !source.length) return rejected();
  scopeMatch = matchEvidenceScope({ ...submission, disease_or_lesion: disease, modality, sequence_or_phase: sequence }, input.scope, context.catalog,
    { allowDevelopmentCatalog: context.allowDevelopmentCatalog, fixture: input.fixture });
  for (const code of scopeMatch.issues) {
    add(code, scopeMatch.status === 'blocked' || scopeMatch.status === 'out_of_scope' ? 'reject' :
      scopeMatch.status === 'needs_context' ? 'requires_review' : 'info', 'scope');
  }
  if (scopeMatch.status === 'blocked' || scopeMatch.status === 'out_of_scope') return rejected();
  const automaticContext = allSourceLines.filter(b => !source.some(s => s.block_id === b.block_id && s.start === 0 && s.end === Array.from(b.text).length))
    .map(b => locateEvidenceFragment(document, { block_id: b.block_id, exact_quote: b.text }));
  const contextFragments = uniqueFragments([...suppliedContext, ...fieldEvidence, ...automaticContext])
    .filter(f => !source.some(s => fragmentKey(s) === fragmentKey(f)));
  const first = source[0]!, last = source.at(-1)!;
  const firstBlock = document.blocks.find(b => b.block_id === first.block_id)!, lastBlock = document.blocks.find(b => b.block_id === last.block_id)!;
  const needsContext = issues.some(i => i.severity === 'requires_review');
  const normalized = scopeMatch.matched_binding_id ? context.catalog.bindings.find(b => b.binding_id === scopeMatch.matched_binding_id) : null;
  const record: EvidenceRecord = {
    record_id: `ev-${createHash('sha256').update(JSON.stringify({ binding, source, suppliedContext, disease, modality, sequence,
      feature_name_raw: submission.feature_name_raw, feature_binding_id: submission.feature_binding_id, evidence_type: submission.evidence_type,
      assertion: submission.assertion, applicability: submission.applicability, numbers, provenance: submission.provenance })).digest('hex').slice(0, 40)}`,
    document_id: document.document_id, article_family_id: metadata.article_family_id,
    bibliographic_identity: clone(metadata.bibliographic_identity ?? { title: document.title, authors: [], venue: null, year: null, doi: null, pmid: null, identity_status: 'unverified' }),
    source_version: clone(metadata.source_version), document_access: metadata.document_access ?? 'full_text',
    source_location: { kind: 'pdf_textline', physical_page: first.physical_page, block_id: first.block_id, bbox: clone(first.bbox),
      location_precision: 'whole_textline_not_exact_glyph', locations: uniqueFragments(source).map(f => ({ block_id: f.block_id, physical_page: f.physical_page,
        bbox: clone(f.bbox), location_precision: 'whole_textline_not_exact_glyph' })) },
    text_version: document.text_version, original_quote: source.map(f => f.exact_quote).join(submission.display_joiner),
    quote_span: { unit: 'unicode_code_point', interval: '[start,end)', segments: source, display_joiner: submission.display_joiner,
      quote_kind: source.length > 1 ? 'display_composite_of_source_segments' : 'single_source_segment', contiguous_source_quote: source.length === 1 },
    context: { before: Array.from(firstBlock.text).slice(0, first.start).join(''), after: Array.from(lastBlock.text).slice(last.end).join(''),
      status: needsContext ? 'needs_context' : 'provided', fragments: contextFragments,
      source_attribution: { origin: submission.provenance.origin, cited_references: clone(submission.provenance.cited_references), evidence: provenanceEvidence },
      structure_references: clone(submission.structure_references ?? []), article_scope_status: uncertainArticleScope ? 'uncertain' : 'within_provided_scope' },
    disease_or_lesion: disease, modality, sequence_or_phase: sequence,
    feature_name_raw: submission.feature_name_raw, feature_category: submission.feature_category, evidence_type: submission.evidence_type,
    assertion: { ...clone(submission.assertion), evidence: assertionEvidence }, applicability: { ...clone(submission.applicability), evidence: applicabilityEvidence },
    numeric_expressions: numbers, normalized_terms: normalized ? [{ feature_id: normalized.feature_id, binding_id: normalized.binding_id,
      basis: scopeMatch.basis.filter(b => b.dimension === 'feature').map(b => `${b.kind}:${b.matched_term}`).join(';'),
      source: normalized.source, approval_status: normalized.approval_status }] : [],
    translation_zh: submission.translation_zh,
    evidence_validation: { quote_located: true, method: 'exact_source_blocks_code_points_v1',
      automatic_checks: { status: needsContext ? 'requires_review' : 'passed',
        checks: ['bound_source_identity', 'provided_and_read_source_blocks', 'exact_code_point_spans', 'explicit_scope_and_synonym_match', 'limited_lexical_consistency'] },
      medical_semantics_verified: false, model_semantic_review: { status: 'not_performed', model_id: null, issue_codes: [] },
      human_approval: 'not_performed', warnings: issues.map(i => i.code), issues: clone(issues), scope_match: clone(scopeMatch) },
    duplicate_and_conflict_links: [],
    extraction_trace: { task_id: metadata.task_id, run_id: input.run_id, fixture: input.fixture, evidence_kind: document.evidence_kind,
      scope: clone(input.scope), catalog_version: context.catalog.catalog_version, catalog_status: context.catalog.status,
      development_catalog_used: scopeMatch.development_catalog_used, matching_policy_version: input.scope.matching_policy_version,
      rule_version: input.rule_version, pi_version: input.runtime_profile.pi_version, provider: input.runtime_profile.provider,
      model_id: input.runtime_profile.model_id, parser_id: document.parser.id, parser_version: document.parser.version,
      read_block_ids: [...read], provided_block_ids: [...provided], tool_call_ids: [context.toolCallId], source_binding: clone(binding),
      updates_record_id: submission.updates_record_id ?? null },
    review_status: needsContext ? 'needs_context' : 'pending', review_events: [], handoff_status: 'candidate_only',
  };
  if (!Value.Check(EvidenceRecordSchema, record)) { add('validated_record_schema_invalid', 'reject', ''); return rejected(); }
  return { accepted: true, record, issues, scope_match: scopeMatch };
}

export const validateExtractionSubmission = validateEvidenceSubmission;
