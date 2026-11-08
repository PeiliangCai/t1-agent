import { Type, type Static } from 'typebox';
import { EvidenceFragmentSchema, ContractError, type EvidenceSubmission, type SourceBinding } from '@t1/contracts';
import type { SourceEvidenceUnit } from './source-evidence-units.js';
const closed = { additionalProperties: false } as const;
export const FEATURE_NAME_RAW_CONTRACT_VERSION = 'feature-name-raw-exact-1';
export const FEATURE_NAME_RAW_RULE = 'feature_name_raw must be an exact literal term in the selected, actually read evidence, or null. Preserve case, whitespace, line breaks, hyphens and Unicode characters; never paraphrase, translate, combine names or normalize spelling. Put a grouping suggestion in feature_category.';
export const STATEMENT_SELECTOR_RULE = 'Choose exactly one nonempty source selector: source_unit_ids (prefer completeness=complete) or source_line_indices (whole original lines). For necessary context use at most one of context_unit_ids or context_line_indices. Omit the unused selectors; never send both alternatives.';
export const SOURCE_UNIT_BOUNDARY_RULE = 'Inspect each source_units entry kind, completeness and boundary_reasons: entries include unverified paragraph fragments and table cells, not just complete sentences. Known missing sentence spans are rejected; uncertain boundaries require review. Grouping never proves completeness, medical meaning or an actual source read.';
export const STRUCTURE_HINT_RULE = 'document_structure.headings[].native_title_display is processed display context, not read or citable original text. required_line_indices are references, not read receipts: explicitly read the needed originals. Native ordering and associations remain unverified.';
export const TABLE_SUPPORT_RULE = 'Table rows/cells/captions cannot be primary descriptions. supporting_table_evidence may attach exact numeric values only when the primary visual sentence explicitly cites that numbered table. A structure/caption conflict blocks semantic support; document_structure.tables[].support_semantics=blocked_due_to_structure_conflict must not be used as support.';
export const statementIndexRule = (stage: 'batch' | 'summary') => stage === 'batch' ?
  'ALL *_line_indices and medical/numeric line_indices use the SAME batch-local source_lines[].line_index returned by read_document_blocks; never renumber per record.' :
  'ALL update *_line_indices and medical/numeric line_indices use immutable whole-document blocks[].line_index returned by read_document_blocks; never use batch-local or per-record indices.';
export const FeatureNameRawSchema = Type.Union([Type.String(), Type.Null()], { description: FEATURE_NAME_RAW_RULE });
const indexes = Type.Array(Type.Integer({ minimum: 0, maximum: 63 }), { uniqueItems: true, maxItems: 64,
  description: 'Zero-based positions in this record selected source fragments, not batch or document line indices.' });
const observation = Type.Object({ value: Type.Union([Type.String(), Type.Null()]), source_indices: indexes }, closed);
const nullableObservation = Type.Union([observation, Type.Null()]);
/** Host-derived identity and indexed source evidence reduce transcription and repeated quote generation. */
export const CompactEvidenceSchema = Type.Object({
  source_fragments: Type.Array(EvidenceFragmentSchema, { minItems: 1, maxItems: 64 }),
  context_fragments: Type.Optional(Type.Array(EvidenceFragmentSchema, { maxItems: 64 })),
  feature_name_raw: FeatureNameRawSchema, feature_category: Type.String({ minLength: 1 }),
  evidence_type: Type.Enum(['feature_mention', 'definition', 'imaging_observation', 'interpretive_condition', 'association_conclusion']),
  disease_or_lesion: Type.Optional(nullableObservation), modality: Type.Optional(nullableObservation), sequence_or_phase: Type.Optional(nullableObservation),
  assertion: Type.Enum(['affirmed', 'negated', 'uncertain', 'conditional', 'comparative', 'unknown']),
  assertion_source_indices: Type.Optional(indexes), condition_source_indices: Type.Optional(indexes),
  numeric_expressions: Type.Optional(Type.Array(Type.Object({ original_text: Type.String(), unit_original: Type.Union([Type.String(), Type.Null()]),
    source_indices: indexes }, closed))),
  origin: Type.Enum(['study_authors', 'cited_research', 'background_definition', 'unclear']),
  cited_references: Type.Optional(Type.Array(Type.String())), provenance_source_indices: Type.Optional(indexes),
  feature_binding_id: Type.Optional(Type.Union([Type.String(), Type.Null()])), updates_record_id: Type.Optional(Type.String({
    description: 'Existing bound candidate identity. An explicit update never inserts a new identity or overwrites an active human revision.' })),
}, closed);
export type CompactEvidence = Static<typeof CompactEvidenceSchema>;
export const IndexedEvidenceSchema = Type.Object({ ...CompactEvidenceSchema.properties,
  source_fragments: Type.Optional(CompactEvidenceSchema.properties.source_fragments),
  source_line_indices: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), { minItems: 1, maxItems: 64, uniqueItems: true })),
  context_line_indices: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), { maxItems: 64, uniqueItems: true })),
}, closed);
export type IndexedEvidence = Static<typeof IndexedEvidenceSchema>;
const batchLineIndexes = Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), { maxItems: 64, uniqueItems: true,
  description: statementIndexRule('batch') });
const batchObservation = Type.Union([Type.Object({ value: Type.Union([Type.String(), Type.Null()]), line_indices: batchLineIndexes }, closed), Type.Null()]);
/** Every model-visible index in this protocol refers to the same returned source_lines table. */
export const BatchLineEvidenceSchema = Type.Object({
  source_line_indices: Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), { minItems: 1, maxItems: 64, uniqueItems: true,
    description: statementIndexRule('batch') }),
  context_line_indices: Type.Optional(batchLineIndexes), feature_name_raw: FeatureNameRawSchema,
  feature_category: Type.String({ minLength: 1, maxLength: 200 }), evidence_type: CompactEvidenceSchema.properties.evidence_type,
  disease_or_lesion: Type.Optional(batchObservation), modality: Type.Optional(batchObservation), sequence_or_phase: Type.Optional(batchObservation),
  assertion: CompactEvidenceSchema.properties.assertion, assertion_line_indices: Type.Optional(batchLineIndexes),
  condition_line_indices: Type.Optional(batchLineIndexes), provenance_line_indices: Type.Optional(batchLineIndexes),
  origin: CompactEvidenceSchema.properties.origin, cited_references: Type.Optional(Type.Array(Type.String())),
  numeric_expressions: Type.Optional(Type.Array(Type.Object({ original_text: Type.String(), unit_original: Type.Union([Type.String(), Type.Null()]),
    line_indices: batchLineIndexes }, closed))), feature_binding_id: CompactEvidenceSchema.properties.feature_binding_id,
  updates_record_id: CompactEvidenceSchema.properties.updates_record_id,
}, closed);
export type BatchLineEvidence = Static<typeof BatchLineEvidenceSchema>;
const supportingTableLines = (indexes: typeof batchLineIndexes) => Type.Array(Type.Object({ table_id: Type.String({ minLength: 1, maxLength: 200 }),
  reference_line_indices: indexes, line_indices: indexes }, closed), { maxItems: 16, description: TABLE_SUPPORT_RULE });
/** A separate version keeps historical tool schemas/replays unchanged. */
export const StatementEvidenceSchema = Type.Object({ ...BatchLineEvidenceSchema.properties,
  source_line_indices: Type.Optional(BatchLineEvidenceSchema.properties.source_line_indices),
  source_unit_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 64, uniqueItems: true,
    description: STATEMENT_SELECTOR_RULE + ' Use only source_units[].unit_id whose supporting lines are actually read. ' + SOURCE_UNIT_BOUNDARY_RULE })),
  context_unit_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 64, uniqueItems: true,
    description: STATEMENT_SELECTOR_RULE })),
  supporting_table_evidence: Type.Optional(supportingTableLines(batchLineIndexes)),
}, closed);
export type StatementEvidence = Static<typeof StatementEvidenceSchema>;
const documentLineIndexes = Type.Array(Type.Integer({ minimum: 0, maximum: 1000000 }), { maxItems: 64, uniqueItems: true,
  description: statementIndexRule('summary') });
const documentObservation = Type.Union([Type.Object({ value: Type.Union([Type.String(), Type.Null()]), line_indices: documentLineIndexes }, closed), Type.Null()]);
/** Whole-paper updates use one immutable document-line table, never per-record renumbering. */
export const DocumentLineEvidenceSchema = Type.Object({ ...BatchLineEvidenceSchema.properties,
  source_line_indices: Type.Array(Type.Integer({ minimum: 0, maximum: 1000000 }), { minItems: 1, maxItems: 64, uniqueItems: true,
    description: statementIndexRule('summary') }),
  context_line_indices: Type.Optional(documentLineIndexes), disease_or_lesion: Type.Optional(documentObservation),
  modality: Type.Optional(documentObservation), sequence_or_phase: Type.Optional(documentObservation),
  assertion_line_indices: Type.Optional(documentLineIndexes), condition_line_indices: Type.Optional(documentLineIndexes),
  provenance_line_indices: Type.Optional(documentLineIndexes),
  numeric_expressions: Type.Optional(Type.Array(Type.Object({ original_text: Type.String(), unit_original: Type.Union([Type.String(), Type.Null()]),
    line_indices: documentLineIndexes }, closed))),
}, closed);
export type DocumentLineEvidence = Static<typeof DocumentLineEvidenceSchema>;
export const StatementDocumentEvidenceSchema = Type.Object({ ...DocumentLineEvidenceSchema.properties,
  source_line_indices: Type.Optional(DocumentLineEvidenceSchema.properties.source_line_indices),
  source_unit_ids: StatementEvidenceSchema.properties.source_unit_ids,
  context_unit_ids: StatementEvidenceSchema.properties.context_unit_ids,
  supporting_table_evidence: Type.Optional(supportingTableLines(documentLineIndexes)),
}, closed);
export type StatementDocumentEvidence = Static<typeof StatementDocumentEvidenceSchema>;
export function expandBatchLineEvidence(value: BatchLineEvidence | StatementEvidence | StatementDocumentEvidence,
  lines: ReadonlyArray<{ block_id: string; text: string }>, binding: SourceBinding, units?: readonly SourceEvidenceUnit[]): EvidenceSubmission {
  const select = (indexes: readonly number[]) => indexes.map(index => {
    const line = lines[index]; if (!Number.isInteger(index) || index < 0 || !line) throw new ContractError('source_line_index_out_of_range');
    return { block_id: line.block_id, exact_quote: line.text };
  });
  const observed = (input?: Static<typeof batchObservation>) => ({ value: input?.value ?? null,
    status: input?.value ? 'source_observed' as const : 'unknown' as const, evidence: input ? select(input.line_indices) : [] });
  const unitIds = 'source_unit_ids' in value ? value.source_unit_ids : undefined;
  if (Boolean(unitIds?.length) === Boolean(value.source_line_indices?.length)) throw new ContractError('choose_source_units_or_source_lines');
  const fromUnits = (ids: readonly string[]) => ids.flatMap(id => {
    const unit = units?.find(u => u.unit_id === id);
    if (!unit || unit.segments.some(s => !lines.some(l => l.block_id === s.block_id))) throw new ContractError('source_unit_not_available');
    return unit.segments.map(s => ({ block_id: s.block_id, exact_quote: s.exact_quote, occurrence: s.occurrence }));
  });
  const source = unitIds?.length ? fromUnits(unitIds) : select(value.source_line_indices!);
  const contextUnitIds = 'context_unit_ids' in value ? value.context_unit_ids : undefined;
  if (contextUnitIds?.length && value.context_line_indices?.length) throw new ContractError('choose_context_units_or_context_lines');
  const context = contextUnitIds?.length ? fromUnits(contextUnitIds) : select(value.context_line_indices ?? []);
  const primaryOnly = (indexes: readonly number[]) => select(indexes).flatMap(line => source.filter(s => s.block_id === line.block_id));
  const narrowed = (indexes: readonly number[]) => select(indexes).flatMap(line => {
    const selected = [...source, ...context].filter(s => s.block_id === line.block_id);
    return selected.length ? selected : [line];
  });
  const observedPrimary = (input?: Static<typeof batchObservation>) => ({ value: input?.value ?? null,
    status: input?.value ? 'source_observed' as const : 'unknown' as const, evidence: input ? narrowed(input.line_indices) : [] });
  const assertion = value.assertion_line_indices ? (unitIds?.length ? primaryOnly(value.assertion_line_indices) : select(value.assertion_line_indices)) : source;
  const conditions = unitIds?.length ? primaryOnly(value.condition_line_indices ?? []) : select(value.condition_line_indices ?? []);
  const support = 'supporting_table_evidence' in value ? value.supporting_table_evidence : undefined;
  return { binding, source_fragments: source, context_fragments: context, display_joiner: '\n',
    feature_binding_id: value.feature_binding_id ?? null, feature_name_raw: value.feature_name_raw, feature_category: value.feature_category,
    evidence_type: value.evidence_type, disease_or_lesion: unitIds?.length ? observedPrimary(value.disease_or_lesion) : observed(value.disease_or_lesion),
    modality: unitIds?.length ? observedPrimary(value.modality) : observed(value.modality),
    sequence_or_phase: value.sequence_or_phase ? (unitIds?.length ? observedPrimary(value.sequence_or_phase) : observed(value.sequence_or_phase)) : null,
    assertion: { value: value.assertion, original_wording: assertion.map(f => f.exact_quote).join('\n'), evidence: assertion },
    applicability: { status: conditions.length ? 'specified' : 'unknown', original_wording: conditions.map(f => f.exact_quote).join('\n'), evidence: conditions },
    numeric_expressions: (value.numeric_expressions ?? []).map(n => ({ original_text: n.original_text, unit_original: n.unit_original,
      evidence: unitIds?.length ? narrowed(n.line_indices) : select(n.line_indices) })),
    provenance: { origin: value.origin, cited_references: value.cited_references ?? [], evidence: value.provenance_line_indices ?
      (unitIds?.length ? primaryOnly(value.provenance_line_indices) : select(value.provenance_line_indices)) : source },
    translation_zh: null, ...(support ? { supporting_table_evidence: support.map(s => ({ table_id: s.table_id,
      reference_fragments: primaryOnly(s.reference_line_indices), value_fragments: select(s.line_indices) })) } : {}),
    ...(value.updates_record_id ? { updates_record_id: value.updates_record_id } : {}) };
}
export function expandIndexedEvidence(value: IndexedEvidence, lines: ReadonlyArray<{ block_id: string; text: string }>, binding: SourceBinding) {
  if (Boolean(value.source_fragments?.length) === Boolean(value.source_line_indices?.length)) throw new ContractError('choose_exact_fragments_or_whole_source_lines');
  const fragments = (indexes: number[]) => indexes.map(index => {
    const line = lines[index]; if (!line) throw new ContractError('source_line_index_out_of_range');
    return { block_id: line.block_id, exact_quote: line.text };
  });
  const { source_line_indices, context_line_indices, ...rest } = value;
  return expandCompactEvidence({ ...rest, source_fragments: value.source_fragments ?? fragments(source_line_indices!),
    context_fragments: [...(value.context_fragments ?? []), ...fragments(context_line_indices ?? [])] }, binding);
}
export function expandCompactEvidence(compact: CompactEvidence, binding: SourceBinding): EvidenceSubmission {
  const select = (ids?: number[]) => {
    if (!ids) return compact.source_fragments;
    if (ids.some(index => !Number.isInteger(index) || index < 0 || index >= compact.source_fragments.length)) throw new ContractError('source_evidence_index_out_of_range');
    return ids.map(index => compact.source_fragments[index]!);
  };
  const observed = (input?: Static<typeof observation> | null) => ({ value: input?.value ?? null,
    status: input?.value ? 'source_observed' as const : 'unknown' as const, evidence: input ? select(input.source_indices) : [] });
  const assertionEvidence = select(compact.assertion_source_indices);
  const conditions = compact.condition_source_indices?.length ? select(compact.condition_source_indices) : [];
  return { binding, source_fragments: compact.source_fragments, context_fragments: compact.context_fragments ?? [], display_joiner: '\n',
    feature_binding_id: compact.feature_binding_id ?? null, feature_name_raw: compact.feature_name_raw, feature_category: compact.feature_category,
    evidence_type: compact.evidence_type, disease_or_lesion: observed(compact.disease_or_lesion), modality: observed(compact.modality),
    sequence_or_phase: compact.sequence_or_phase ? observed(compact.sequence_or_phase) : null,
    assertion: { value: compact.assertion, original_wording: assertionEvidence.map(f => f.exact_quote).join('\n'), evidence: assertionEvidence },
    applicability: { status: conditions.length ? 'specified' : 'unknown', original_wording: conditions.map(f => f.exact_quote).join('\n'), evidence: conditions },
    numeric_expressions: (compact.numeric_expressions ?? []).map(n => ({ original_text: n.original_text, unit_original: n.unit_original, evidence: select(n.source_indices) })),
    provenance: { origin: compact.origin, cited_references: compact.cited_references ?? [], evidence: select(compact.provenance_source_indices) },
    translation_zh: null, ...(compact.updates_record_id ? { updates_record_id: compact.updates_record_id } : {}) };
}
