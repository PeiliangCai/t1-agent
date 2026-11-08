import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { StructuredDocumentIR } from '@t1/contracts';
import { assertLivePdfSource, discoverPdfFigures } from '../../packages/agent/src/figure-assets.js';

test('actual CPU Figure subprocess binds the retained real PDF/IR, returns whole Fig4 and honors abort before writing', async () => {
  const code = process.cwd(), directory = await mkdtemp(resolve(code, '.tools/figure-bridge-'));
  try {
    const payload = JSON.parse(await readFile(resolve(code, 'docs/acceptance/s3/comparison-2026-11-02/runs/guarded-v4/reuse/docling-standard-cpu/L05.json'), 'utf8'));
    const document = payload.document as StructuredDocumentIR;
    const sourceBytes = await readFile(resolve(code, document.source.file_reference));
    const catalog = await discoverPdfFigures(document, directory);
    const figure = catalog.figures.find(f => f.figure_number === '4');
    assert.ok(figure); assert.equal(figure.verification.status, 'mechanically_checked');
    assert.deepEqual(figure.panel_labels, ['A-C', 'D-F', 'G-I']); assert.equal(figure.regions.length, 1);
    const asset = figure.regions[0]!, bytes = await readFile(resolve(code, asset.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    assert.equal(bytes.readUInt32BE(16), asset.width_px); assert.equal(bytes.readUInt32BE(20), asset.height_px);
    assert.equal(catalog.inventory_complete, false); assert.equal(catalog.generated_images_used, false);
    assert.equal(createHash('sha256').update(await readFile(resolve(code, document.source.file_reference))).digest('hex'),
      createHash('sha256').update(sourceBytes).digest('hex'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(discoverPdfFigures(document, resolve(directory, 'aborted'), controller.signal), /cancelled/);
    const copied = structuredClone(document); copied.source.file_reference = resolve(directory, 'changed.pdf');
    await writeFile(copied.source.file_reference, sourceBytes);
    await assertLivePdfSource(copied);
    await writeFile(copied.source.file_reference, Buffer.from('%PDF wrong current version'));
    await assert.rejects(assertLivePdfSource(copied), /source_pdf_changed_since_ir/);
    await assert.rejects(discoverPdfFigures(copied, directory), /source_pdf_changed_since_ir/);
    await rm(copied.source.file_reference);
    await assert.rejects(assertLivePdfSource(copied), /source_pdf_unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
