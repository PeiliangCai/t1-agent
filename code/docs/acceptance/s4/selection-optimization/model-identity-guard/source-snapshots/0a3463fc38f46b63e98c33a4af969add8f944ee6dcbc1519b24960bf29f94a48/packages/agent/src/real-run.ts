import { isDeepStrictEqual } from 'node:util';
import { assertSchema, ContractError, ParserRequestSchema, ParserResultSchema, StructuredParserResultSchema, RunInputSchema,
  type Catalog, type ParserRequest, type ParserResult, type RunInput, type StructuredParserResult } from '@t1/contracts';
import { safeError } from './config.js';
import { LocalParserError, assertParsedDocument } from './parser.js';
import { RealDocumentTools } from './real-tools.js';
import { RunStore } from './store.js';

export interface LocalDocumentResultParser {
  parseResult(input: ParserRequest, signal?: AbortSignal): Promise<ParserResult | StructuredParserResult>;
}

/** Called by trusted orchestration. fileReference and parser selection are never model tool arguments. */
export async function prepareRealDocumentRun(input: RunInput, fileReference: string, catalog: Catalog,
  parser: LocalDocumentResultParser, store: RunStore, signal?: AbortSignal) {
  assertSchema(RunInputSchema, input);
  if (input.fixture) throw new ContractError('real_document_required');
  const request: ParserRequest = { run_id: input.run_id, document_id: input.document_id, file_reference: fileReference,
    file_sha256: input.file_sha256, fixture: false };
  assertSchema(ParserRequestSchema, request);
  if (!isDeepStrictEqual(store.snapshot(input.run_id).input, input)) throw new ContractError('stored_run_input_mismatch');
  if (store.snapshot(input.run_id).state !== 'queued') throw new ContractError('real_parse_requires_queued_run');
  input = structuredClone(input);
  let parserResult: ParserResult | StructuredParserResult | undefined;
  try {
    if (signal?.aborted) throw new ContractError('run_cancelled');
    store.transition(input.run_id, 'parsing');
    store.event(input.run_id, 'parser', 'parsing', 'Real local PDF parser started; no model-controlled file access');
    parserResult = await parser.parseResult(request, signal);
    if (signal?.aborted) throw new ContractError('run_cancelled');
    if (parserResult.schema_version === 'parser-result-1') assertSchema(ParserResultSchema, parserResult);
    else assertSchema(StructuredParserResultSchema, parserResult);
    if (parserResult.run_id !== input.run_id) throw new ContractError('parser_run_mismatch');
    if ((parserResult.status === 'error') !== Boolean(parserResult.error) || (!parserResult.document && parserResult.status !== 'error')) throw new ContractError('parser_status_mismatch');
    if (parserResult.error || !parserResult.document) throw new LocalParserError(parserResult.error?.code ?? 'missing_parser_document');
    const document = parserResult.document;
    assertParsedDocument(document);
    if (parserResult.status !== (document.parser.status === 'parsed' ? 'ok' : document.parser.status)) throw new ContractError('parser_status_mismatch');
    if (document.document_id !== input.document_id || document.file_sha256 !== input.file_sha256 || document.fixture) throw new ContractError('parser_identity_mismatch');
    store.event(input.run_id, 'parser', 'parsing', `Real local parser ${document.parser.id}:${parserResult.status}; fidelity and medical semantics remain unverified`);
    if (parserResult.status === 'unsupported' || !document.blocks.length) {
      store.transition(input.run_id, 'partial');
      return { state: store.snapshot(input.run_id).state, tools: undefined, parser_result: parserResult,
        fixture: false as const, medical_extraction_implemented: false as const, error: undefined };
    }
    const tools = new RealDocumentTools(input, document, catalog, store);
    store.transition(input.run_id, 'extracting');
    store.event(input.run_id, 'engineering_read_probe', 'extracting', 'Real PDF source reading only; medical extraction and candidate submission unavailable');
    return { state: store.snapshot(input.run_id).state, tools, parser_result: parserResult,
      fixture: false as const, medical_extraction_implemented: false as const, error: undefined };
  } catch (cause) {
    store.terminateIfRunning(input.run_id, signal?.aborted ? 'cancelled' : 'failed');
    return { state: store.snapshot(input.run_id).state, tools: undefined, parser_result: parserResult,
      fixture: false as const, medical_extraction_implemented: false as const, error: safeError(cause) };
  }
}
