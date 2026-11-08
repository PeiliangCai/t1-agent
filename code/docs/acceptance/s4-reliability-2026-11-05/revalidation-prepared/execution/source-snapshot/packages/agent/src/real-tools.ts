import { isDeepStrictEqual } from 'node:util';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { assertSchema, assertScope, bindingApplicable, CandidateSubmissionSchema, ContractError, DocumentIRSchema,
  immutable, locateQuote, resolveDocumentSegments, RunInputSchema,
  type CandidateSubmission, type Catalog, type DocumentIR, type ExactSegment, type RunInput } from '@t1/contracts';
import { RunStore } from './store.js';
import { TOOL_NAMES, type RestrictedTools } from './tools.js';
import { assertParsedDocument } from './parser.js';

export type ParsedDocumentIR = Exclude<DocumentIR, { schema_version: '1' }>;
const closed = { additionalProperties: false } as const;
const bound = { run_id: Type.String(), document_id: Type.String() };
const versioned = { ...bound, file_sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), text_version: Type.String({ minLength: 1 }) };
const ContextParams = Type.Object(bound, closed);
const SegmentSchema = Type.Object({ block_id: Type.String(), text_version: Type.String(), start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }) }, closed);
const ReadParams = Type.Object({ ...versioned,
  block_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 8, uniqueItems: true }),
  source_reference: Type.Optional(Type.Object({ document_id: Type.String(), text_version: Type.String(),
    segments: Type.Array(SegmentSchema, { minItems: 1, maxItems: 64 }), joiner: Type.String({ maxLength: 8 }) }, closed)),
}, closed);
const SubmitParams = Type.Object({ ...versioned, records: Type.Array(CandidateSubmissionSchema, { minItems: 1, maxItems: 8 }) }, closed);
const IssueParams = Type.Object({ ...bound, reason: Type.Enum(['needs_context', 'scope_ambiguity', 'processing_failure']) }, closed);
const schemas = [ContextParams, ReadParams, ContextParams, SubmitParams, IssueParams];

type Params = { run_id: string; document_id: string; file_sha256?: string; text_version?: string; block_ids?: string[];
  source_reference?: { document_id: string; text_version: string; segments: ExactSegment[]; joiner: string };
  records?: CandidateSubmission[]; reason?: string };
export interface RealToolCall { call_id: string; name: string; status: 'ok' | 'rejected'; error_code?: string; block_ids?: string[] }

/** Bound local IR only. There is deliberately no filesystem, upload, shell or real medical write tool. */
export class RealDocumentTools implements RestrictedTools {
  readonly input: Readonly<RunInput>;
  readonly document: Readonly<ParsedDocumentIR>;
  readonly catalog: Readonly<Catalog>;
  readonly readBlocks = new Set<string>();
  readonly successfulCalls: Array<{ id: string; name: string }> = [];
  readonly calls: RealToolCall[] = [];
  readonly issues: string[] = [];
  constructor(input: RunInput, document: ParsedDocumentIR, catalog: Catalog, readonly store: RunStore) {
    assertSchema(RunInputSchema, input); assertSchema(DocumentIRSchema, document); assertScope(input.scope, catalog);
    if (input.fixture || document.fixture || document.evidence_kind !== 'real_paper') throw new ContractError('real_document_required');
    if (document.parser.status === 'unsupported' || !document.blocks.length) throw new ContractError('real_document_not_readable');
    if (input.document_id !== document.document_id || input.file_sha256 !== document.file_sha256) throw new ContractError('document_identity_mismatch');
    if (!isDeepStrictEqual(store.snapshot(input.run_id).input, input)) throw new ContractError('stored_run_input_mismatch');
    assertParsedDocument(document);
    this.input = immutable(input); this.document = immutable(document); this.catalog = immutable(catalog);
  }
  private authorize(params: Params, signal?: AbortSignal): void {
    if (signal?.aborted) throw new ContractError('run_cancelled');
    if (params.run_id !== this.input.run_id || params.document_id !== this.input.document_id) throw new ContractError('cross_task_access_denied');
    if (this.store.snapshot(this.input.run_id).state !== 'extracting') throw new ContractError('tool_run_not_extracting');
    if (params.file_sha256 !== undefined && params.file_sha256 !== this.document.file_sha256) throw new ContractError('file_sha256_mismatch');
    if (params.text_version !== undefined && params.text_version !== this.document.text_version) throw new ContractError('text_version_mismatch');
  }
  async invoke(name: string, params: unknown, callId: string, signal?: AbortSignal): Promise<unknown> {
    const index = TOOL_NAMES.indexOf(name as typeof TOOL_NAMES[number]);
    try {
      if (index < 0) throw new ContractError('tool_not_allowed');
      assertSchema(schemas[index]!, params);
      const p = params as Params;
      this.authorize(p, signal);
      let result: unknown;
      const identity = { fixture: false, evidence_kind: 'real_paper', purpose: 'real_pdf_read_only_engineering_probe',
        medical_extraction_implemented: false, medical_semantics_verified: false };
      if (name === 'get_document_context') {
        result = { ...identity, run_id: this.input.run_id, document_id: this.document.document_id, file_sha256: this.document.file_sha256,
          schema_version: this.document.schema_version, text_version: this.document.text_version, title: this.document.title,
          parser: { id: this.document.parser.id, version: this.document.parser.version, status: this.document.parser.status },
          physical_pdf: true, scope: this.input.scope, catalog_version: this.catalog.catalog_version, feature_catalog_fixture: this.catalog.fixture,
          blocks: this.document.blocks.map(b => ({ block_id: b.block_id, type: b.type, physical_page: b.page, reading_order: b.reading_order })),
          coverage: this.document.coverage,
          structure: this.document.schema_version === '3' ? {
            native_processed_text_is_authoritative_quote: false, human_fidelity_verified: false,
            reading_order: this.document.structure.reading_order,
            units: this.document.structure.units.map(u => ({ unit_id: u.unit_id, kind: u.kind, mapping_status: u.mapping.status,
              source_block_ids: [...new Set(u.source_segments.map(s => s.block_id))] })),
            tables: this.document.structure.tables.map(({ native_html, ...table }) => table), pictures: this.document.structure.pictures,
          } : null,
          source_policy: { authoritative_text: 'decoded_pdf_source_blocks',
            native_processed_text_is_literal_quote: false, location_precision: 'whole_textline_not_exact_glyph',
            cross_segment_quotes: 'display_composite_only_preserve_segment_boundaries',
            native_relationship_policy: 'unverified_native_relationships_only_rejected_conflicts_never_establish_semantic_associations',
            candidate_submission: 'blocked_until_medical_extraction_implemented' } };
      } else if (name === 'read_document_blocks') {
        const blocks = p.block_ids!.map(id => this.document.blocks.find(b => b.block_id === id));
        if (blocks.some(b => !b)) throw new ContractError('block_not_authorized');
        let source: ReturnType<typeof resolveDocumentSegments> | undefined;
        if (p.source_reference) {
          if (p.source_reference.segments.some(s => !p.block_ids!.includes(s.block_id))) throw new ContractError('source_segment_outside_requested_blocks');
          try { source = resolveDocumentSegments(this.document, p.source_reference); }
          catch (error) { throw new ContractError(error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'invalid_source_reference'); }
        }
        blocks.forEach(b => this.readBlocks.add(b!.block_id));
        result = { ...identity, document_id: this.document.document_id, file_sha256: this.document.file_sha256, text_version: this.document.text_version,
          blocks,
          structure_units: this.document.schema_version === '3' ? this.document.structure.units.filter(u => u.source_segments.some(s => p.block_ids!.includes(s.block_id)))
            .map(u => ({ ...u, native_original_text_is_literal_quote: false,
              all_source_blocks_in_response: u.source_segments.every(s => p.block_ids!.includes(s.block_id)), source_segment_order: 'explicit_anchor_order_not_a_contiguous_quote' })) : [],
          source_reference: source ? { ...source, quote_kind: source.segments.length > 1 ? 'display_composite_of_source_segments' : 'single_source_segment',
            location_precision: 'whole_textline_not_exact_glyph', contiguous_source_quote: source.segments.length === 1 } : null };
      } else if (name === 'lookup_feature_bindings') {
        result = { ...identity, feature_catalog_fixture: this.catalog.fixture, catalog_version: this.catalog.catalog_version, features: this.catalog.features,
          bindings: this.catalog.bindings.filter(b => bindingApplicable(b, this.input.scope) && (this.input.scope.features.mode === 'all' || this.input.scope.features.binding_ids.includes(b.binding_id))) };
      } else if (name === 'submit_candidate_records') {
        for (const suggestion of p.records!) {
          const block = this.document.blocks.find(b => b.block_id === suggestion.block_id);
          if (!block || !this.readBlocks.has(block.block_id)) throw new ContractError('candidate_source_must_be_read_first');
          locateQuote(block, suggestion.original_quote);
        }
        throw new ContractError('medical_candidate_submission_not_implemented');
      } else {
        this.issues.push(p.reason!);
        this.store.event(this.input.run_id, 'context_issue', 'extracting', p.reason!);
        result = { ...identity, recorded: true };
      }
      this.successfulCalls.push({ id: callId, name });
      this.calls.push({ call_id: callId, name, status: 'ok', ...(p.block_ids ? { block_ids: [...p.block_ids] } : {}) });
      this.store.event(this.input.run_id, 'tool', 'extracting', `${name}:ok; real_pdf_read_only; medical_extraction_unavailable`);
      return result;
    } catch (error) {
      const code = error instanceof ContractError ? error.code : 'real_tool_failed';
      this.calls.push({ call_id: callId, name: index < 0 ? 'unregistered_tool' : name, status: 'rejected', error_code: code });
      const state = this.store.snapshot(this.input.run_id).state;
      if (state === 'extracting') this.store.event(this.input.run_id, 'tool_rejected', state, `${index < 0 ? 'unregistered_tool' : name}:${code}`);
      throw error;
    }
  }
  definitions(): ToolDefinition[] {
    const descriptions = [
      'Get the bound real PDF identity, immutable scope, version, source block list and parsing limitations. This is an engineering reading probe; medical extraction is unavailable.',
      'Read up to 8 bound source blocks using the exact SHA and text_version. Optional source_reference locates Unicode code-point segments and preserves their boundaries. Processed native text is never a literal quote; boxes enclose whole lines.',
      'Read the bound versioned feature catalog. feature_catalog_fixture identifies demo catalogs; medical interpretation is unavailable.',
      'Unavailable for real medical extraction in S3. Enforces matching document/SHA/version, read-before-submit and exact source text, then rejects without saving any medical candidate.',
      'Report a context problem. This does not approve evidence, submit a candidate or complete extraction.',
    ];
    return TOOL_NAMES.map((name, index) => defineTool({ name, label: name, description: descriptions[index]!, parameters: schemas[index]!, executionMode: 'sequential',
      execute: async (callId, params, signal) => {
        const result = await this.invoke(name, params, callId, signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: { fixture: false, medical_extraction_implemented: false } };
      } }));
  }
}
