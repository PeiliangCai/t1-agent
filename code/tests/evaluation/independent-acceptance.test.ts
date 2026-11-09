import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceVersion } from '@t1/contracts';
import { makeEvidenceFixture } from '../extraction/fixtures/evidence-fixtures.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { buildEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';
import { auditIndependentDelivery, prepareIndependentReview, summarizeIndependentTiming } from '../../evaluation/src/independent-acceptance.js';

function fixture() {
  const f = makeEvidenceFixture(), checked = validateEvidenceSubmission(f.submission, f.context); assert.ok(checked.record);
  const versions: EvidenceVersion[] = [{ record: checked.record, version: 1, actor: 'automatic', status: 'active' }];
  return { ...f, delivery: buildEvidenceDelivery(f.document, versions) };
}
test('independent mechanical audit detects altered text, wrong page, old source version and cross-document anchors', () => {
  const f = fixture(); assert.equal(auditIndependentDelivery(f.document, f.delivery, f.document.file_sha256).passed, true);
  const variants = [
    { change: (d: typeof f.delivery) => { d.records[0]!.original_fragments[0]!.exact_quote += ' rewritten'; }, issue: 'verbatim_unicode_range_mismatch' },
    { change: (d: typeof f.delivery) => { d.records[0]!.original_fragments[0]!.physical_page = 3; }, issue: 'physical_page_mismatch' },
    { change: (d: typeof f.delivery) => { d.records[0]!.original_fragments[0]!.text_version = 'old'; }, issue: 'source_text_version_mismatch' },
    { change: (d: typeof f.delivery) => { d.records[0]!.original_fragments[0]!.block_id = 'other-paper-block'; }, issue: 'block_not_in_this_document' },
  ];
  for (const v of variants) { const d = structuredClone(f.delivery); v.change(d); assert.ok(auditIndependentDelivery(f.document, d, f.document.file_sha256).issues.some(i => i.issue === v.issue)); }
  assert.throws(() => auditIndependentDelivery(f.document, f.delivery, 'f'.repeat(64)), /identity_mismatch/);
});
test('empty independent output keeps a null denominator and cannot masquerade as reviewed or medically accepted', () => {
  const f = fixture(), empty = { ...f.delivery, records: [], background_records: [] };
  const sample = prepareIndependentReview(empty, 'IN-test'); assert.equal(sample.random_denominator, null); assert.equal(sample.random_sample_count, 0);
  assert.equal(sample.reviewer_kind, 'delegated_ai_operator'); assert.equal(sample.actual_human_reviewed_count, 0); assert.equal(sample.medical_quality_approved, false);
});
test('independent random sampling includes both delivered primary and background records and is version-bound', () => {
  const f = fixture(), bg = structuredClone(f.delivery.records[0]!); bg.record_id = 'background-separate-record';
  const d = { ...f.delivery, background_records: [bg] }; const a = prepareIndependentReview(d, 'IN-test');
  assert.equal(a.output_count, 2); assert.equal(a.random_sample_count, 2); assert.deepEqual(a, prepareIndependentReview(d, 'IN-test'));
  assert.ok(a.random_records.some(r => r.record_id === bg.record_id));
  const next = structuredClone(d); next.records[0]!.record_version++; assert.notDeepEqual(prepareIndependentReview(next, 'IN-test').random_selection_units, a.random_selection_units);
});
test('performance observations enforce the frozen boundary values without inventing empty-output candidate latency or population P95', () => {
  const pass = summarizeIndependentTiming({ admissionMs: 2000, firstProgressMs: 5000, firstCandidateMs: 600000, totalMs: 1800000, outputCount: 1 });
  assert.equal(pass.admission_pass, true); assert.equal(pass.first_progress_pass, true); assert.equal(pass.first_candidate_pass, true); assert.equal(pass.terminal_pass, true);
  const fail = summarizeIndependentTiming({ admissionMs: 2001, firstProgressMs: null, firstCandidateMs: 600001, totalMs: 1800001, outputCount: 1 });
  assert.equal(fail.admission_pass, false); assert.equal(fail.first_progress_pass, false); assert.equal(fail.first_candidate_pass, false); assert.equal(fail.terminal_pass, false);
  const empty = summarizeIndependentTiming({ admissionMs: 1, firstProgressMs: 1, firstCandidateMs: null, totalMs: 100, outputCount: 0 });
  assert.equal(empty.first_candidate_pass, null); assert.equal(empty.first_candidate_seconds, null); assert.equal(empty.population_p95, null);
});

test('two execution slots overlap and the third paper stays queued; a stop prevents later admission', async () => {
  const { runWithTwoSlots } = await import('../../evaluation/src/independent-acceptance.js');
  const entered: number[] = [], releases = new Map<number, () => void>(); let active = 0, peak = 0;
  const running = runWithTwoSlots([1, 2, 3], async id => { entered.push(id); active++; peak = Math.max(peak, active); await new Promise<void>(r => releases.set(id, r)); active--; });
  await new Promise<void>(r => setImmediate(r)); assert.deepEqual(entered, [1, 2]); assert.equal(peak, 2);
  releases.get(1)!(); await new Promise<void>(r => setImmediate(r)); assert.deepEqual(entered, [1, 2, 3]); assert.equal(peak, 2);
  releases.get(2)!(); releases.get(3)!(); await running;
  let stopped = false; const admitted: number[] = [];
  await runWithTwoSlots([1, 2, 3], async id => { admitted.push(id); stopped = true; }, () => stopped);
  assert.deepEqual(admitted, [1]);
});

test('independent execution binds its newly authorized model even when generic application settings select another model', async () => {
  const { authorizedConfig } = await import('../../scripts/accept-s6-independent.js');
  const config = authorizedConfig({ T1_MODEL_PROVIDER: 'generic', T1_MODEL_BASE_URL: 'https://example.invalid/v1',
    T1_MODEL_ID: 'different-generic-model', T1_MODEL_API_KEY: 'synthetic-not-a-secret' }, '/nonexistent-s6-fixture.env');
  assert.equal(config.provider, 'agicto'); assert.equal(config.baseUrl, 'https://api.agicto.cn/v1'); assert.equal(config.modelId, 'gpt-6-luna');
  assert.equal(config.apiKey(), 'synthetic-not-a-secret');
});

test('independent postprocessing creates the required package parent and preserves original fragments without overwriting', async () => {
  const { mkdtemp, rm, readFile, writeFile } = await import('node:fs/promises'); const { resolve, relative } = await import('node:path'); const { createHash } = await import('node:crypto');
  const { exportEvidenceDelivery } = await import('../../packages/agent/src/evidence-delivery.js');
  const { exportIndependentCandidatePackage } = await import('../../evaluation/src/independent-acceptance.js');
  const code = process.cwd(), directory = await mkdtemp(resolve(code, '.tools/s6-package-regression-'));
  try {
    const f = makeEvidenceFixture(), bytes = Buffer.from('Synthetic source bytes for package-export regression only; not a real PDF or medical evidence.');
    const pdfPath = resolve(directory, 'synthetic-source.bin'), digest = createHash('sha256').update(bytes).digest('hex'); await writeFile(pdfPath, bytes);
    f.document.file_sha256 = digest; f.document.source.file_reference = relative(code, pdfPath); f.document.source.bytes = bytes.length;
    f.input.file_sha256 = digest; f.context.metadata.source_version.file_sha256 = digest; f.context.metadata.source_version.version = 'sha256:' + digest;
    f.submission.binding.file_sha256 = digest; f.submission.binding.source_version = f.context.metadata.source_version.version;
    const checked = validateEvidenceSubmission(f.submission, f.context); assert.ok(checked.record);
    const versions: EvidenceVersion[] = [{ record: checked.record, version: 1, actor: 'automatic', status: 'active' }];
    const destination = resolve(directory, 'previously-missing-parent', 'candidate-package');
    await assert.rejects(exportEvidenceDelivery(f.document, versions, { codeRoot: code, directory: destination, mode: 'candidates', coverage: {} }), { code: 'ENOENT' });
    await exportIndependentCandidatePackage(f.document, versions, { codeRoot: code, directory: destination, coverage: {} });
    const saved = JSON.parse(await readFile(resolve(destination, 'delivery.json'), 'utf8'));
    assert.deepEqual(saved.records[0].original_fragments, buildEvidenceDelivery(f.document, versions).records[0]!.original_fragments);
    await assert.rejects(exportIndependentCandidatePackage(f.document, versions, { codeRoot: code, directory: destination, coverage: {} }), { code: 'EEXIST' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
