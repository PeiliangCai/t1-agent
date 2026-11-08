import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createConfiguredPdfParserAdapter, loadPdfParserSelection, parsePdfParserSelection } from '@t1/agent';

const configPath = fileURLToPath(new URL('../../config/pdf-parser.json', import.meta.url));

test('formal parser configuration is bound to the recorded user decision and preserves quality pending', () => {
  const selection = loadPdfParserSelection();
  assert.equal(selection.default_candidate_id, 'docling-standard-cpu');
  assert.equal(selection.primary.parser_version, '2.145.0');
  assert.equal(selection.primary.source_anchor.version, '7.24.2');
  assert.equal(selection.comparison.candidate_id, 'mineru-basic-onnx-cpu');
  assert.equal(selection.comparison.parser_version, '4.1.4');
  assert.equal(selection.stage_passed, false);
  assert.equal(selection.quality_status, 'quality_pending');
  assert.equal(selection.model_can_change_selection, false);
});

test('trusted adapter factory uses formal Docling default and retains explicit MinerU comparison branch', async () => {
  const primary = createConfiguredPdfParserAdapter();
  const comparison = createConfiguredPdfParserAdapter({ candidateId: 'mineru-basic-onnx-cpu' });
  assert.equal(primary.options.candidateId, 'docling-standard-cpu');
  assert.equal(comparison.options.candidateId, 'mineru-basic-onnx-cpu');
  const request = { run_id: 'selection-preparse-check', document_id: 'L01', file_reference: 'evaluation/corpus/development-candidates/L01.pdf', file_sha256: '0'.repeat(64) };
  for (const adapter of [primary, comparison]) {
    const result = await adapter.parseResult(request);
    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'file_sha256_mismatch');
    assert.equal(result.document, null);
  }
  // Real local CLI validation, no model inference, baseline swap or synthetic PDF output.
});

test('selection configuration rejects unknown candidates, version drift, quality relabelling and unbound defaults', async () => {
  const value = JSON.parse(await readFile(configPath, 'utf8'));
  for (const mutate of [
    (v: typeof value) => { v.default_candidate_id = 'unknown'; },
    (v: typeof value) => { v.default_candidate_id = 'mineru-basic-onnx-cpu'; },
    (v: typeof value) => { v.primary.parser_version = 'latest'; },
    (v: typeof value) => { v.stage_passed = true; },
    (v: typeof value) => { v.model_can_change_selection = true; },
    (v: typeof value) => { v.decision_record = '../AGENTS.md'; },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    assert.throws(() => parsePdfParserSelection(JSON.stringify(changed)), /invalid_pdf_parser_selection/);
  }
});
