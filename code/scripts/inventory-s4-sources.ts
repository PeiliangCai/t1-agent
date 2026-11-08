import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { StructuredParserResult } from '@t1/contracts';
import { loadPdfParserSelection } from '../packages/agent/src/parser-selection.js';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { buildArticleScope, planExtractionBatches } from '../packages/agent/src/article-scope.js';

const selection = loadPdfParserSelection(), directory = resolve('docs/acceptance/s4/source-inventory');
await mkdir(directory, { recursive: true });
const documents = [];
for (const id of ['L01', 'MED03', 'L02', 'L05', 'L07']) {
  const path = 'docs/acceptance/s3/comparison-2026-11-02/runs/guarded-v4/reuse/' + selection.default_candidate_id + '/' + id + '.json';
  const bytes = await readFile(path), parsed = JSON.parse(bytes.toString('utf8')) as StructuredParserResult;
  if (!parsed.document) throw new Error('missing_source_document');
  const document = parsed.document; assertParsedDocument(document);
  const articleScope = buildArticleScope(document), batches = planExtractionBatches(document, articleScope);
  const summary = { document_id: id, file_sha256: document.file_sha256, text_version: document.text_version,
    cached_IR_path: path, cached_IR_sha256: createHash('sha256').update(bytes).digest('hex'), parser: document.parser,
    physical_pages: document.pages.length, original_source_blocks: document.blocks.length,
    original_source_code_points: document.blocks.reduce((n, b) => n + Array.from(b.text).length, 0),
    assigned_blocks: articleScope.included_block_ids.length, quarantined_blocks: articleScope.quarantined_block_ids.length,
    batches: batches.length, planned_context_exposures_including_overlap: batches.reduce((n, b) => n + b.context_block_ids.length, 0),
    source_processing_completed_by_inventory: false, medical_quality_approved: false, human_source_fidelity_approved: false };
  await writeFile(resolve(directory, id + '.json'), JSON.stringify({ summary, article_scope: articleScope, batch_plan: batches }, null, 2) + '\n');
  documents.push(summary);
}
await writeFile(resolve(directory, 'summary.json'), JSON.stringify({ created_at: new Date().toISOString(),
  purpose: 'actual_cached_source_inventory_not_extraction_or_independent_acceptance', original_PDFs_modified: false,
  model_calls: 0, documents }, null, 2) + '\n');
process.stdout.write(JSON.stringify(documents.map(d => ({ document: d.document_id, blocks: d.original_source_blocks,
  assigned: d.assigned_blocks, quarantined: d.quarantined_blocks, batches: d.batches, code_points: d.original_source_code_points }))) + '\n');
