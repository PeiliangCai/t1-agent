import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError, ParserCandidateSchema, assertSchema, type ParserCandidateId } from '@t1/contracts';
import { LocalStructuredPythonParserAdapter } from './parser.js';

const CODE = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG = resolve(CODE, 'config/pdf-parser.json');
type Candidate = { candidate_id: ParserCandidateId; parser_version: string; native_configuration: Record<string, unknown>;
  source_anchor: { id: 'docling-parse-text'; version: '7.24.2'; coordinate_precision: 'whole_textline' } };
export interface PdfParserSelection {
  schema_version: 'pdf-parser-selection-1'; selection_id: string; formal_parser_selected: true;
  default_candidate_id: ParserCandidateId; primary: Candidate; comparison: Candidate;
  quality_status: 'quality_pending'; stage_passed: false; decision_record: string; decision_sha256: string;
  model_can_change_selection: false;
}

/** Parse trusted project configuration. Never accept it as a model tool argument. */
export function parsePdfParserSelection(text: string): PdfParserSelection {
  try {
    const value = JSON.parse(text) as PdfParserSelection;
    if (value.schema_version !== 'pdf-parser-selection-1' || !value.selection_id || value.formal_parser_selected !== true ||
      value.quality_status !== 'quality_pending' || value.stage_passed !== false || value.model_can_change_selection !== false ||
      !value.decision_record?.startsWith('docs/acceptance/s3/') || !/^[a-f0-9]{64}$/.test(value.decision_sha256)) throw new Error();
    assertSchema(ParserCandidateSchema, value.default_candidate_id);
    for (const candidate of [value.primary, value.comparison]) {
      assertSchema(ParserCandidateSchema, candidate.candidate_id);
      const expectedVersion = candidate.candidate_id === 'docling-standard-cpu' ? '2.145.0' : '4.1.4';
      if (candidate.parser_version !== expectedVersion || candidate.source_anchor.id !== 'docling-parse-text' ||
        candidate.source_anchor.version !== '7.24.2' || candidate.source_anchor.coordinate_precision !== 'whole_textline' ||
        candidate.native_configuration.device !== 'cpu') throw new Error();
    }
    if (value.default_candidate_id !== value.primary.candidate_id || value.primary.candidate_id === value.comparison.candidate_id) throw new Error();
    return value;
  } catch { throw new ContractError('invalid_pdf_parser_selection'); }
}

/** Fixed server-side path, bound to the recorded user decision; no env/model override. */
export function loadPdfParserSelection(): PdfParserSelection {
  try {
    const selection = parsePdfParserSelection(readFileSync(CONFIG, 'utf8'));
    const decisionPath = realpathSync(resolve(CODE, selection.decision_record));
    if (!decisionPath.startsWith(CODE)) throw new Error();
    const bytes = readFileSync(decisionPath);
    if (createHash('sha256').update(bytes).digest('hex') !== selection.decision_sha256) throw new Error();
    const decision = JSON.parse(bytes.toString('utf8'));
    if (decision.formal_parser_selected !== true || decision.default_candidate_id !== selection.default_candidate_id ||
      !isDeepStrictEqual(decision.primary, selection.primary) || !isDeepStrictEqual(decision.comparison_candidate, selection.comparison)) throw new Error();
    return selection;
  } catch { throw new ContractError('pdf_parser_selection_unavailable_or_unbound'); }
}

type Options = Omit<ConstructorParameters<typeof LocalStructuredPythonParserAdapter>[0], 'candidateId'> & { candidateId?: ParserCandidateId };
/** Trusted caller default: formal primary; explicit comparison override remains available. */
export function createConfiguredPdfParserAdapter(options: Options = {}): LocalStructuredPythonParserAdapter {
  const selection = loadPdfParserSelection();
  return new LocalStructuredPythonParserAdapter({ ...options, candidateId: options.candidateId ?? selection.default_candidate_id });
}
