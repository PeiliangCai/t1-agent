import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { DocumentIRV2Schema } from './document-ir-v2.js';
export * from './document-ir-v2.js';
import { StructuredDocumentIRSchema } from './document-ir-v3.js';
export * from './document-ir-v3.js';
export * from './extraction-evidence.js';
export * from './figure-evidence.js';

const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 160 });
const nullableText = Type.Union([Type.String(), Type.Null()]);
const ids = Type.Array(id, { uniqueItems: true });
const selection = Type.Object({ mode: Type.Union([Type.Literal('all'), Type.Literal('selected')]), ids }, closed);

export const ScopeSchema = Type.Object({
  scope_version: Type.Literal('1'), cancers: selection, image_types: selection,
  features: Type.Object({ mode: Type.Union([Type.Literal('all'), Type.Literal('selected')]), binding_ids: ids }, closed),
  catalog_version: id, matching_policy_version: id,
}, closed);
export type Scope = Static<typeof ScopeSchema>;

export const FeatureBindingSchema = Type.Object({
  binding_id: id, feature_id: id, cancer_ids: ids, image_type_ids: ids,
  sequence_or_phase_conditions: Type.Array(Type.String()), source: id, version: id,
}, closed);
export type FeatureBinding = Static<typeof FeatureBindingSchema>;
export const CatalogSchema = Type.Object({
  catalog_version: id, fixture: Type.Boolean(),
  cancers: Type.Array(Type.Object({ id, name: id }, closed)),
  image_types: Type.Array(Type.Object({ id, name: id, cancer_ids: ids }, closed)),
  features: Type.Array(Type.Object({ feature_id: id, name: id, synonyms: ids, category: id, source: id, version: id }, closed)),
  bindings: Type.Array(FeatureBindingSchema),
}, closed);
export type Catalog = Static<typeof CatalogSchema>;

export const BlockSchema = Type.Object({
  block_id: id, document_id: id, text_version: id, text: Type.String(),
  page: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  type: Type.Union([Type.Literal('text'), Type.Literal('table'), Type.Literal('caption')]),
  reading_order: Type.Integer({ minimum: 0 }),
  bbox: Type.Union([Type.Array(Type.Number(), { minItems: 4, maxItems: 4 }), Type.Null()]),
}, closed);
export type Block = Static<typeof BlockSchema>;
export const DocumentIRV1Schema = Type.Object({
  schema_version: Type.Literal('1'), document_id: id, file_sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  fixture: Type.Boolean(), evidence_kind: Type.Union([Type.Literal('engineering_fixture'), Type.Literal('real_paper')]),
  title: nullableText, parser: Type.Object({ id, version: id, status: Type.Union([Type.Literal('fixture'), Type.Literal('parsed')]) }, closed),
  text_version: id,
  pages: Type.Array(Type.Object({ physical_page: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), printed_label: nullableText,
    width: Type.Union([Type.Number(), Type.Null()]), height: Type.Union([Type.Number(), Type.Null()]),
    rotation: Type.Number(), coordinate_unit: nullableText, ocr: Type.Boolean(), status: id }, closed)),
  blocks: Type.Array(BlockSchema),
  coverage: Type.Object({ expected_block_ids: ids, processed_block_ids: ids, failed_block_ids: ids,
    excluded: Type.Array(Type.Object({ block_id: id, reason: id }, closed)) }, closed),
}, closed);
export const DocumentIRSchema = Type.Union([DocumentIRV1Schema, DocumentIRV2Schema, StructuredDocumentIRSchema]);
export type DocumentIRV1 = Static<typeof DocumentIRV1Schema>;
export type DocumentIR = Static<typeof DocumentIRSchema>;

export const RunInputSchema = Type.Object({
  schema_version: Type.Literal('1'), run_id: id, document_id: id, file_sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  fixture: Type.Boolean(), scope: ScopeSchema, rule_version: id,
  runtime_profile: Type.Object({ provider: id, model_id: id, endpoint: Type.String(), pi_version: id, version: id }, closed),
}, closed);
export type RunInput = Static<typeof RunInputSchema>;
export const RunStateSchema = Type.Enum(['queued', 'parsing', 'extracting', 'reconciling', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']);
export type RunState = 'queued' | 'parsing' | 'extracting' | 'reconciling' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';

const spanSegment = Type.Object({ block_id: id, text_version: id, start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) }, closed);
const observation = Type.Object({ value: nullableText, status: Type.Union([Type.Literal('unknown'), Type.Literal('source_observed')]), evidence: Type.Array(Type.String()) }, closed);
export const CandidateRecordSchema = Type.Object({
  record_id: id, document_id: id, article_family_id: id,
  bibliographic_identity: Type.Object({ title: nullableText, authors: Type.Array(Type.String()), venue: nullableText,
    year: Type.Union([Type.Integer(), Type.Null()]), doi: nullableText, pmid: nullableText, identity_status: id }, closed),
  source_version: Type.Object({ file_sha256: id, source_kind: id, version: id, obtained_at: Type.String() }, closed),
  document_access: Type.Union([Type.Literal('full_text'), Type.Literal('abstract_only'), Type.Literal('unavailable')]),
  source_location: Type.Object({ kind: id, physical_page: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), block_id: id, bbox: Type.Union([Type.Array(Type.Number()), Type.Null()]) }, closed),
  text_version: id, original_quote: Type.String({ minLength: 1 }),
  quote_span: Type.Object({ unit: Type.Literal('unicode_code_point'), interval: Type.Literal('[start,end)'), segments: Type.Array(spanSegment, { minItems: 1 }) }, closed),
  context: Type.Object({ before: Type.String(), after: Type.String(), status: Type.Union([Type.Literal('provided'), Type.Literal('needs_context')]) }, closed),
  disease_or_lesion: observation, modality: observation, sequence_or_phase: Type.Union([observation, Type.Null()]),
  feature_name_raw: nullableText, feature_category: id, evidence_type: id,
  assertion: Type.Object({ value: Type.Literal('unknown'), original_wording: Type.String() }, closed),
  applicability: Type.Object({ status: Type.Literal('unknown'), original_wording: Type.String() }, closed),
  numeric_expressions: Type.Array(Type.Object({ original_text: Type.String(), unit_original: nullableText }, closed)),
  normalized_terms: Type.Array(Type.Object({ feature_id: id, binding_id: id, basis: Type.String() }, closed)),
  translation_zh: nullableText,
  evidence_validation: Type.Object({ quote_located: Type.Boolean(), method: id, medical_semantics_verified: Type.Literal(false), warnings: Type.Array(Type.String()) }, closed),
  duplicate_and_conflict_links: Type.Array(Type.Object({ record_id: id, relationship: id }, closed)),
  extraction_trace: Type.Object({ run_id: id, fixture: Type.Boolean(), evidence_kind: id, scope: ScopeSchema,
    catalog_version: id, matching_policy_version: id, rule_version: id, pi_version: id, provider: id, model_id: id,
    parser_id: id, parser_version: id, read_block_ids: ids, tool_call_ids: ids }, closed),
  review_status: Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected'), Type.Literal('needs_context')]),
  review_events: Type.Array(Type.Object({ action: id, actor: id, timestamp: id, reason: Type.String(), version: Type.Integer() }, closed)),
  handoff_status: Type.Union([Type.Literal('candidate_only'), Type.Literal('approved_for_T2')]),
}, closed);
export type CandidateRecord = Static<typeof CandidateRecordSchema>;

export const BusinessEventSchema = Type.Object({
  run_id: id, seq: Type.Integer({ minimum: 1 }), type: id, timestamp: Type.String(), stage: RunStateSchema,
  record_id: Type.Optional(id), record_version: Type.Optional(Type.Integer({ minimum: 1 })),
  summary: Type.String(), fixture: Type.Boolean(),
}, closed);
export type BusinessEvent = Static<typeof BusinessEventSchema>;

export const CandidateSubmissionSchema = Type.Object({
  block_id: id, original_quote: Type.String({ minLength: 1 }), feature_binding_id: Type.Union([id, Type.Null()]),
}, closed);
export type CandidateSubmission = Static<typeof CandidateSubmissionSchema>;

export class ContractError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ContractError'; }
}
export function assertSchema<S extends TSchema>(schema: S, value: unknown): asserts value is Static<S> {
  if (!Value.Check(schema, value)) throw new ContractError('schema_validation_failed');
}
export function bindingApplicable(binding: FeatureBinding, scope: Scope): boolean {
  return (scope.cancers.mode === 'all' || binding.cancer_ids.some(x => scope.cancers.ids.includes(x))) &&
    (scope.image_types.mode === 'all' || binding.image_type_ids.some(x => scope.image_types.ids.includes(x)));
}
export function scopeIssues(scope: Scope, catalog: Catalog): string[] {
  assertSchema(ScopeSchema, scope); assertSchema(CatalogSchema, catalog);
  const issues: string[] = [];
  if (scope.catalog_version !== catalog.catalog_version) issues.push('catalog_version_mismatch');
  for (const [name, part, choices] of [
    ['cancers', scope.cancers, catalog.cancers.map(x => x.id)],
    ['image_types', scope.image_types, catalog.image_types.map(x => x.id)],
    ['features', { mode: scope.features.mode, ids: scope.features.binding_ids }, catalog.bindings.map(x => x.binding_id)],
  ] as const) {
    if (part.mode === 'selected' && part.ids.length === 0) issues.push(`${name}_selected_empty`);
    if (part.mode === 'all' && part.ids.length !== 0) issues.push(`${name}_all_has_selections`);
    if (part.ids.some(x => !choices.includes(x))) issues.push(`${name}_unknown_selection`);
  }
  for (const image of catalog.image_types.filter(x => scope.image_types.ids.includes(x.id))) {
    if (scope.cancers.mode === 'selected' && !image.cancer_ids.some(x => scope.cancers.ids.includes(x))) issues.push(`invalid_image_type:${image.id}`);
  }
  for (const binding of catalog.bindings.filter(x => scope.features.binding_ids.includes(x.binding_id))) {
    if (!bindingApplicable(binding, scope)) issues.push(`invalid_binding:${binding.binding_id}`);
  }
  return issues;
}
export function assertScope(scope: Scope, catalog: Catalog): void {
  const problems = scopeIssues(scope, catalog);
  if (problems.length) throw new ContractError(problems.join(','));
}
export function reconcileScope(scope: Scope, catalog: Catalog) {
  const invalid = scopeIssues(scope, catalog);
  return { scope: structuredClone(scope), valid_binding_ids: scope.features.binding_ids.filter(id => catalog.bindings.some(x => x.binding_id === id && bindingApplicable(x, scope))),
    invalid_binding_ids: invalid.filter(x => x.startsWith('invalid_binding:')).map(x => x.slice('invalid_binding:'.length)), issues: invalid };
}
export function defaultScope(catalogVersion: string): Scope {
  return { scope_version: '1', cancers: { mode: 'all', ids: [] }, image_types: { mode: 'all', ids: [] },
    features: { mode: 'all', binding_ids: [] }, catalog_version: catalogVersion, matching_policy_version: 'engineering-demo-1' };
}
export function immutable<T>(value: T): Readonly<T> {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
  };
  freeze(copy); return copy;
}
export function locateQuote(block: Block, quote: string) {
  const start = block.text.indexOf(quote);
  if (start < 0) throw new ContractError('quote_not_in_source');
  if (block.text.indexOf(quote, start + 1) >= 0) throw new ContractError('ambiguous_quote_location');
  const cpStart = Array.from(block.text.slice(0, start)).length;
  return { block_id: block.block_id, text_version: block.text_version, start: cpStart, end: cpStart + Array.from(quote).length };
}
export function validateCandidate(record: CandidateRecord): void {
  assertSchema(CandidateRecordSchema, record);
  if (record.review_status === 'approved' && record.review_events.length === 0) throw new ContractError('approval_requires_real_review_event');
  if (record.handoff_status === 'approved_for_T2' && record.review_status !== 'approved') throw new ContractError('handoff_requires_approval');
  if (record.extraction_trace.fixture && (record.review_status === 'approved' || record.handoff_status !== 'candidate_only')) throw new ContractError('fixture_cannot_be_approved_evidence');
  if (record.quote_span.segments.some(s => s.end <= s.start)) throw new ContractError('invalid_quote_span');
}
export interface ParserAdapter {
  parse(input: { run_id: string; document_id: string; file_reference: string; file_sha256: string }, signal?: AbortSignal): Promise<DocumentIR>;
}
export class UnimplementedParserAdapter implements ParserAdapter {
  // Historical S1 compatibility stub. S3 implements LocalPythonParserAdapter.
  async parse(): Promise<DocumentIR> { throw new ContractError('real_pdf_parser_not_implemented_until_S3'); }
}
