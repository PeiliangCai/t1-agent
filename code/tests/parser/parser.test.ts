import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalPythonParserAdapter, LocalParserError } from '@t1/agent';
import { DocumentIRSchema, DocumentIRV2Schema, ParserResultSchema, assertSchema, documentIRV2Issues, resolveDocumentSegments, applyAffine,
  type DocumentIRV2, type ExactSegment, type ParserResult } from '@t1/contracts';

const CODE = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const artifactRoot = join(CODE, 'docs/acceptance/s3');
async function constructed(name: string): Promise<DocumentIRV2> {
  const directories = (await readdir(join(artifactRoot, 'constructed'))).sort().reverse();
  for (const directory of directories) {
    try { return JSON.parse(await readFile(join(artifactRoot, 'constructed', directory, name), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error('Run the Python constructed-PDF suite before these parser integration tests');
}

test('legacy v1 engineering fixture stays valid while v2 raw source contracts reject quality relabelling', async () => {
  const old = JSON.parse(await readFile(join(CODE, 'evaluation/fixtures/engineering-example.json'), 'utf8'));
  assertSchema(DocumentIRSchema, old.document); assert.equal(old.document.schema_version, '1');
  const document = await constructed('unicode-text-ir.json');
  assertSchema(DocumentIRV2Schema, document); assert.deepEqual(documentIRV2Issues(document), []);
  assert.throws(() => assertSchema(DocumentIRV2Schema, { ...document, coverage: { ...document.coverage, fidelity_human_verified: true } }), /schema/);
  const wrong = structuredClone(document); wrong.blocks[0]!.text_version = 'another-version';
  assert.ok(documentIRV2Issues(wrong).includes('block_binding_mismatch'));
  const changed = structuredClone(document); changed.blocks[0]!.normalization_map[0]!.raw_end++;
  assert.ok(documentIRV2Issues(changed).includes('normalization_map_mismatch'));
});

test('TS and Python resolve the same actual PDF Unicode/code-point and cross-block segments', async () => {
  const document = await constructed('unicode-text-ir.json');
  const emoji = document.blocks.find(b => b.text.includes('😀'))!;
  const beta = Array.from(emoji.text).indexOf('β');
  assert.equal(beta, 2); assert.notEqual(beta, emoji.text.indexOf('β'));
  const inline = resolveDocumentSegments(document, { document_id: document.document_id, text_version: document.text_version,
    segments: [{ block_id: emoji.block_id, text_version: document.text_version, start: beta, end: beta + 1 }], joiner: '' });
  assert.equal(inline.quote, 'β');
  const reference = { document_id: document.document_id, text_version: document.text_version, joiner: ' ',
    segments: document.blocks.map(b => ({ block_id: b.block_id, text_version: document.text_version, start: 0, end: Array.from(b.text).length })) };
  const located = resolveDocumentSegments(document, reference);
  assert.equal(located.quote, '😀 β e\u0301 7 mm²'); assert.equal(located.raw_quote, located.quote);
  const out = await mkdtemp(join(artifactRoot, 'ts-python-parity-'));
  const payload: ParserResult = { schema_version: 'parser-result-1', run_id: 'parity', status: 'ok', document, error: null };
  await writeFile(join(out, 'document.json'), JSON.stringify(payload)); await writeFile(join(out, 'reference.json'), JSON.stringify(reference));
  const { stdout } = await execute(join(CODE, '.venv/bin/python'), ['services/pdf-parser/cli.py', 'locate', '--document', join(out, 'document.json'), '--reference', join(out, 'reference.json')], { cwd: CODE });
  assert.deepEqual(JSON.parse(stdout), located);
  await writeFile(join(out, 'location.json'), stdout);
});

test('exact repeated source references cross pages and reject wrong document/version, overlap and invalid spans', async () => {
  const document = await constructed('cropped-rotated-ir.json');
  const blocks = document.blocks.filter(b => b.text === 'Repeated marker').slice(0, 2);
  const segments: ExactSegment[] = blocks.map(b => ({ block_id: b.block_id, text_version: document.text_version, start: 0, end: Array.from(b.text).length }));
  const reference = { document_id: document.document_id, text_version: document.text_version, segments, joiner: '\n' };
  const located = resolveDocumentSegments(document, reference);
  assert.equal(located.quote, 'Repeated marker\nRepeated marker'); assert.deepEqual(located.segments.map(s => s.physical_page), [1, 2]);
  assert.throws(() => resolveDocumentSegments(document, { ...reference, document_id: 'wrong' }), /document_id_mismatch/);
  assert.throws(() => resolveDocumentSegments(document, { ...reference, text_version: 'wrong' }), /text_version_mismatch/);
  assert.throws(() => resolveDocumentSegments(document, { ...reference, segments: [...segments].reverse() }), /segments_out_of_order/);
  assert.throws(() => resolveDocumentSegments(document, { ...reference, segments: [{ ...segments[0]!, end: 9999 }] }), /invalid_span/);
  assert.throws(() => resolveDocumentSegments(document, { ...reference, segments: [{ ...segments[0]!, block_id: 'unknown' }] }), /unknown_block/);
});

test('TS canonical-to-PDF matrices match actual constructed glyph boxes for all rotations and UserUnit=2', async () => {
  const document = await constructed('cropped-rotated-ir.json');
  for (const page of document.pages) {
    const block = document.blocks.find(b => b.page === page.physical_page && b.text.startsWith('TOP WORD'))!;
    const [x0, y0, x1, y1] = block.bbox as [number, number, number, number];
    const a = applyAffine(page.geometry!.canonical_to_pdf, x0, y0), b = applyAffine(page.geometry!.canonical_to_pdf, x1, y1);
    const actual = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    actual.forEach((value, i) => assert.ok(Math.abs(value - block.source_geometry.pdf_bbox[i]!) < 1e-4));
    assert.ok(Math.abs(actual[0]! - 30) < 1e-3); assert.ok(actual[1]! < 170 && actual[3]! > 170);
  }
});

test('real local parser bridge returns actual L01 SHA/pages, partial image coverage and false human fidelity', async () => {
  const file = 'evaluation/corpus/development-candidates/L01.pdf';
  const digest = createHash('sha256').update(await readFile(join(CODE, file))).digest('hex');
  const adapter = new LocalPythonParserAdapter();
  const input = { run_id: 'ts-real-parser', document_id: 'L01', file_reference: file, file_sha256: digest };
  const payload = await adapter.parseResult(input);
  assertSchema(ParserResultSchema, payload); assert.equal(payload.status, 'partial');
  const document = payload.document!; assertSchema(DocumentIRSchema, document);
  assert.equal(document.fixture, false); assert.equal(document.evidence_kind, 'real_paper');
  assert.equal(document.file_sha256, digest); assert.equal(document.pages.length, 4);
  assert.deepEqual(documentIRV2Issues(document), []); assert.equal(document.coverage.fidelity_human_verified, false);
  assert.equal(document.coverage.table_structure, 'not_reconstructed'); assert.ok(document.coverage.image_text_unverified_pages.includes(2));
  const error = await adapter.parseResult({ ...input, file_sha256: '0'.repeat(64) });
  assert.equal(error.status, 'error'); assert.equal(error.error?.code, 'file_sha256_mismatch'); assert.equal(error.document, null);
});

test('local subprocess abort/timeout and output caps terminate through structured bridge errors', async () => {
  const input = { run_id: 'bounded', document_id: 'L01', file_reference: 'evaluation/corpus/development-candidates/L01.pdf', file_sha256: '0'.repeat(64) };
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(new LocalPythonParserAdapter().parse(input, aborted.signal), (e: unknown) => e instanceof LocalParserError && e.code === 'parser_aborted');
  await assert.rejects(new LocalPythonParserAdapter({ timeoutMs: 1 }).parse(input), (e: unknown) => e instanceof LocalParserError && e.code === 'parser_timeout');
  await assert.rejects(new LocalPythonParserAdapter({ maxOutputBytes: 1 }).parse(input), (e: unknown) => e instanceof LocalParserError && e.code === 'parser_output_limit');
});
