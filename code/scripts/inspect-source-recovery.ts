/** Actual tool/validator diagnostics against final source grids. No model/provider. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { StructuredDocumentIR, EvidenceValidationContext } from '@t1/contracts';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { buildArticleScope } from '../packages/agent/src/article-scope.js';
import { buildSourceEvidenceUnits, SOURCE_EVIDENCE_UNIT_VERSION, classifySourceSpan } from '../packages/agent/src/source-evidence-units.js';
import { ExtractionTools } from '../packages/agent/src/extraction-tools.js';
import { ExtractionStore } from '../packages/agent/src/extraction-store.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../packages/agent/src/visual-evidence-policy.js';
import { makeEvidenceFixture } from '../tests/extraction/fixtures/evidence-fixtures.js';

const root = 'docs/acceptance/pdf-structure-review-2026-11-07';
const writeNew = (name: string, value: unknown) => writeFile(`${root}/${name}`, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const load = async (id: string): Promise<StructuredDocumentIR> => {
  const doc = JSON.parse(await readFile(`${root}/derived/${id}/parser-result.json`, 'utf8')).document;
  assertParsedDocument(doc); return doc;
};
const doc = await load('L05'), primary = doc.structure.units.find(u => u.native_ref === '#/texts/84')!, table = doc.structure.tables[3]!;
const f = makeEvidenceFixture(), input = { ...f.input, document_id: doc.document_id, file_sha256: doc.file_sha256, fixture: false };
const metadata = { ...f.context.metadata, source_version: { ...f.context.metadata.source_version, file_sha256: doc.file_sha256, version: 'sha256:' + doc.file_sha256 } };
const context: EvidenceValidationContext = { ...f.context, input, document: doc, metadata, allowedBlockIds: doc.blocks.map(b => b.block_id),
  readBlockIds: [], evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
const store = new ExtractionStore(':memory:');
try {
  store.create(input, metadata); store.transition(input.run_id, 'extracting');
  const paragraph = [...new Set(primary.source_segments.map(s => s.block_id))], support = doc.blocks.find(b => b.block_id.endsWith('p0007-l000136'))!;
  const ids = [...paragraph, ...new Set(table.caption_unit_ids.flatMap(id => doc.structure.units.find(u => u.unit_id === id)!.source_segments.map(s => s.block_id))), support.block_id];
  const tools = new ExtractionTools(context, { batch_id: 'local-checked-source-grid', assigned_block_ids: ids, context_block_ids: [], physical_pages: [6, 7],
    source_code_points: 5000, order_basis: 'native_mapped_then_source_fallback', warnings: [] }, buildArticleScope(doc), store, 'batch_lines');
  const read = tools.definitions().find(t => t.name === 'read_document_blocks')!, submit = tools.definitions().find(t => t.name === 'submit_candidate_records')!;
  const invoke = async (definition: typeof read, id: string, params: unknown) => {
    const output = await definition.execute(id, params, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
    return JSON.parse((output.content[0] as { text: string }).text);
  };
  const packet = await invoke(read, 'local-source-grid-read', {});
  const record = { source_line_indices: paragraph.map(id => ids.indexOf(id)), feature_name_raw: null, feature_category: 'mechanical source/citation test only',
    evidence_type: 'association_conclusion', assertion: 'affirmed', origin: 'study_authors', supporting_table_evidence: [{ table_id: table.table_id,
      reference_line_indices: paragraph.map(id => ids.indexOf(id)).filter(i => doc.blocks.find(b => b.block_id === ids[i])!.text.includes('Table 4')),
      line_indices: [ids.indexOf(support.block_id)] }] };
  const accepted = await invoke(submit, 'valid-checked-source-support', { records: [record], batch_complete: false });
  if (accepted.rejected.length || store.current(input.run_id).length !== 1) throw new Error('real_whole_line_support_not_accepted');
  const negatives = [];
  for (const mode of ['wrong_table', 'body_instead_of_table_row']) {
    const changed = structuredClone(record);
    if (mode === 'wrong_table') changed.supporting_table_evidence[0]!.table_id = doc.structure.tables[1]!.table_id;
    else changed.supporting_table_evidence[0]!.line_indices = [0];
    const result = await invoke(submit, mode, { records: [changed], batch_complete: false });
    if (!result.rejected.length) throw new Error('bad_support_source_accepted');
    negatives.push({ mode, result });
  }
  const saved = store.current(input.run_id)[0]!.record;
  const table3 = doc.structure.tables[2]!, grid3 = table3.source_grid!;
  if (grid3.status !== 'geometry_checked') throw new Error('Table3_not_checked');
  const primary3 = doc.structure.units.find(u => u.native_ref === '#/texts/75')!, figure3 = doc.structure.units.find(u => u.unit_id === table3.caption_unit_ids[0])!;
  const value3 = doc.blocks.find(b => b.page === 6 && b.text.includes('12.78') && b.text.includes('4.71'))!, figureId = figure3.source_segments[0]!.block_id;
  const paragraph3 = [...new Set(primary3.source_segments.map(s => s.block_id))], ids3 = [...new Set([...paragraph3, ...grid3.caption_segments.map(s => s.block_id), value3.block_id, figureId])];
  const store3 = new ExtractionStore(':memory:');
  let table3Check: unknown;
  try {
    store3.create(input, metadata); store3.transition(input.run_id, 'extracting');
    const tools3 = new ExtractionTools(context, { batch_id: 'local-checked-table3-title', assigned_block_ids: ids3, context_block_ids: [], physical_pages: [5, 6],
      source_code_points: 6000, order_basis: 'native_mapped_then_source_fallback', warnings: [] }, buildArticleScope(doc), store3, 'batch_lines');
    const read3 = tools3.definitions().find(t => t.name === 'read_document_blocks')!, submit3 = tools3.definitions().find(t => t.name === 'submit_candidate_records')!;
    const packet3 = await invoke(read3, 'read-recovered-Table3', {});
    const record3 = { source_line_indices: paragraph3.map(id => ids3.indexOf(id)), feature_name_raw: null, feature_category: 'mechanical Table3 source/citation test only',
      evidence_type: 'association_conclusion', assertion: 'affirmed', origin: 'study_authors', supporting_table_evidence: [{ table_id: table3.table_id,
        reference_line_indices: paragraph3.map(id => ids3.indexOf(id)).filter(i => doc.blocks.find(b => b.block_id === ids3[i])!.text.includes('Table 3')),
        line_indices: [ids3.indexOf(value3.block_id)] }] };
    const valid3 = await invoke(submit3, 'accept-recovered-Table3', { records: [record3], batch_complete: false });
    if (valid3.rejected.length) throw new Error('Table3_source_title_support_rejected');
    const rejected3 = [];
    for (const mode of ['neighboring_Fig3_as_Table3_reference', 'neighboring_Fig3_as_Table3_values']) {
      const wrong = structuredClone(record3);
      if (mode.endsWith('reference')) { wrong.source_line_indices = [ids3.indexOf(figureId)]; wrong.supporting_table_evidence[0]!.reference_line_indices = [ids3.indexOf(figureId)]; }
      else wrong.supporting_table_evidence[0]!.line_indices = [ids3.indexOf(figureId)];
      const result = await invoke(submit3, mode, { records: [wrong], batch_complete: false });
      if (!result.rejected.length) throw new Error('neighboring_Figure_accepted_as_Table3');
      rejected3.push({ mode, result });
    }
    const saved3 = store3.current(input.run_id)[0]!.record;
    table3Check = { source_binding: packet3.document_structure.source_binding, active_grid: packet3.document_structure.tables.find((t: any) => t.table_id === table3.table_id),
      supporting_table_read_metadata: packet3.supporting_tables.find((t: any) => t.table_id === table3.table_id), accepted: valid3,
      exact_whole_line_numeric_support: value3.text, recovered_title_lines: grid3.caption_segments.map(s => doc.blocks.find(b => b.block_id === s.block_id)!.text),
      old_native_caption_still_rejected: table3.caption_relationships, neighboring_caption_source_role: classifySourceSpan(doc, figure3.source_segments[0]!),
      negative_cases: rejected3, saved_review_status: saved3.review_status, saved_medical_semantics_verified: saved3.evidence_validation.medical_semantics_verified };
    await writeNew('actual-tool-L05-Table3.json', packet3);
  } finally { store3.close(); }
  const continuations = [];
  for (const id of ['L01', 'L07']) {
    const document = await load(id), units = buildSourceEvidenceUnits(document);
    for (const [tail, head] of (id === 'L01' ? [['药物过', '敏']] : [['pos-', 'teriorly'], ['moni-', 'tored']])) {
      const unit = units.find(u => u.segments.some(s => s.exact_quote.endsWith(tail!)) && u.segments.some(s => s.exact_quote.startsWith(head!)));
      if (!unit || unit.completeness !== 'complete') throw new Error('source_continuation_not_complete:' + id);
      continuations.push({ source_id: id, file_sha256: document.file_sha256, text_version: document.text_version, source_unit_id: unit.unit_id,
        completeness: unit.completeness, source_type: unit.source_type, structure_unit_ids: unit.structure_unit_ids,
        original_segments: unit.segments, physical_pages: [...new Set(unit.segments.map(s => s.physical_page))],
        original_characters_and_hyphens_preserved: true, medical_or_user_approved: false });
    }
  }
  await writeNew('actual-tool-L05-Table4.json', packet);
  await writeNew('source-recovery-tool-check.json', { schema_version: 'source-recovery-tool-check-1', source_unit_version: SOURCE_EVIDENCE_UNIT_VERSION,
    LLM_calls: 0, provider_calls: 0, source_binding: packet.document_structure.source_binding,
    tool_packet_sha256: createHash('sha256').update(JSON.stringify(packet)).digest('hex'),
    model_active_grid: packet.document_structure.tables.find((t: any) => t.table_id === table.table_id).active_grid,
    exact_whole_line_numeric_support: support.text, accepted, negative_cases: negatives,
    saved_review_status: saved.review_status, saved_medical_semantics_verified: saved.evidence_validation.medical_semantics_verified,
    saved_semantic_issues: saved.evidence_validation.issues, source_continuations: continuations,
    Table3: table3Check,
    limits: ['The original statistical paragraph is a mechanical citation test and remains needs_context; it is not approved visual evidence.',
      'Only an in-memory engineering store was used; no product record, human review, model output or API call was created.'] });
} finally { store.close(); }
console.log(JSON.stringify({ real_source_read_submit_checked: true, wrong_source_negatives: 2, LLM_calls: 0 }));
