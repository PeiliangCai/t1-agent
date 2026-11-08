import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { DeliveryReview, EvidenceVersion, FigureAssetCatalog, OutputSampleReview } from '@t1/contracts';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { locateEvidenceFragment, validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { assertFigureCatalog, associateFigures, auditOutputSample, buildEvidenceDelivery, confirmWholeFigure,
  evidenceDigest, explicitFigureMentions, exportEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';

const CODE = fileURLToPath(new URL('../../', import.meta.url));
function setup(source = 'CT showed spiculation (Fig. 1A).', caption = 'Fig. 1 CT shows spiculation; panels (A) and (B).') {
  const fixture = makeEvidenceFixture([source, caption]);
  const result = validateEvidenceSubmission(fixture.submission, fixture.context);
  assert.ok(result.record, JSON.stringify(result.issues));
  const record = result.record, versions: EvidenceVersion[] = [{ record, version: 1, actor: 'automatic', status: 'active' }];
  const catalog: FigureAssetCatalog = { schema_version: 'figure-asset-catalog-1', document_id: fixture.document.document_id,
    file_sha256: fixture.document.file_sha256, text_version: fixture.document.text_version,
    inventory_complete: false, original_pdf_modified: false, generated_images_used: false,
    figures: [{ figure_id: 'figure-1', figure_number: '1', caption_segments: [locateEvidenceFragment(fixture.document,
      { block_id: fixture.document.blocks[1]!.block_id, exact_quote: caption })], panel_labels: ['(A)', '(B)'], native_picture_ids: [],
      regions: [{ asset_id: 'asset-1', path: 'synthetic.png', sha256: 'a'.repeat(64), mime_type: 'image/png', physical_page: 1,
        bbox: [20, 100, 300, 300], coordinate_system: 'crop_rotated_top_left_pt', width_px: 560, height_px: 400,
        render_scale: 2, extraction_method: 'original_pdf_region_render', source_pdf_sha256: fixture.document.file_sha256, visual_modification: 'none' }],
      verification: { status: 'needs_review', method: 'native_candidate_only', actor: null, checked_at: null, notes: 'synthetic geometry only',
        all_panels_included: false, caption_figure_identity_checked: false, human_approved: false } }] };
  return { ...fixture, record, versions, catalog };
}
function checked(f: ReturnType<typeof setup>) {
  return confirmWholeFigure(f.document, f.catalog, evidenceDigest(f.catalog), 'figure-1', { actor: 'synthetic-engineering-check',
    checked_at: '2026-11-04T01:00:00Z', all_panels_included: true, caption_figure_identity_checked: true, notes: 'Synthetic check, not a doctor review.' });
}

test('fresh candidates reject translation, inserted joining prose and qualifier/number deletion', () => {
  for (const mutation of ['translation', 'joiner', 'negation', 'number'] as const) {
    const f = makeEvidenceFixture(['No spiculation on CT was seen when diameter was 7 mm.']);
    if (mutation === 'translation') f.submission.translation_zh = '未见毛刺';
    if (mutation === 'joiner') f.submission.display_joiner = ' means ';
    if (mutation === 'negation' || mutation === 'number') f.submission.source_fragments[0]!.exact_quote = 'spiculation';
    const result = validateEvidenceSubmission(f.submission, f.context);
    assert.equal(result.accepted, false, mutation);
  }
});
test('text delivery keeps exact independent source fragments and never emits translation/category prose as its description', () => {
  const f = setup(); f.record.translation_zh = 'Legacy derived text';
  const delivery = buildEvidenceDelivery(f.document, f.versions);
  assert.deepEqual(delivery.records[0]!.original_fragments, f.record.quote_span.segments);
  assert.equal(delivery.records[0]!.figure_association.status, 'not_checked');
  assert.ok(!JSON.stringify(delivery).includes('Legacy derived text'));
  const altered = structuredClone(f.versions); altered[0]!.record.original_quote = 'An invented description.';
  assert.throws(() => buildEvidenceDelivery(f.document, altered), /delivery_quote_rewritten/);
});
test('native/same-page candidates remain pending; an explicitly referenced verified whole Figure is paired', () => {
  const f = setup(); const pending = associateFigures(f.document, f.record, f.catalog);
  assert.equal(pending.status, 'pending'); assert.deepEqual(pending.figure_ids, []); assert.deepEqual(pending.proposed_figure_ids, ['figure-1']);
  const link = associateFigures(f.document, f.record, checked(f));
  assert.equal(link.status, 'paired'); assert.deepEqual(link.figure_ids, ['figure-1']); assert.equal(link.exact_markers[0]!.panel, 'A');
  const unrelated = setup('CT showed spiculation without an illustration reference.');
  assert.equal(associateFigures(unrelated.document, unrelated.record, checked(unrelated)).status, 'no_explicit_reference');
});
test('explicit original-caption description also pairs; paper labels remain untouched', () => {
  const f = setup(); f.submission.source_fragments = [{ block_id: f.document.blocks[1]!.block_id, exact_quote: f.document.blocks[1]!.text }];
  const validation = validateEvidenceSubmission(f.submission, f.context); assert.ok(validation.record);
  const pair = associateFigures(f.document, validation.record, checked(f));
  assert.equal(pair.status, 'paired'); assert.deepEqual(checked(f).figures[0]!.panel_labels, ['(A)', '(B)']);
});
test('source/caption case and modality conflicts, repeated Figure numbers, list references stay pending', () => {
  for (const [source, caption] of [
    ['Case 1 CT showed spiculation (Fig. 1).', 'Fig. 1 Case 2 CT shows spiculation.'],
    ['CT showed spiculation (Fig. 1).', 'Fig. 1 MRI shows spiculation.'],
    ['CT showed spiculation (Fig. 1C).', 'Fig. 1 CT shows spiculation; panels (A) and (B).'],
    ['CT showed spiculation (Figs. 1 and 2).', 'Fig. 1 CT shows spiculation.'],
  ]) {
    const f = setup(source, caption), link = associateFigures(f.document, f.record, checked(f));
    assert.equal(link.status, 'pending'); assert.equal(link.figure_ids.length, 0);
  }
  const f = setup(), catalog = checked(f), another = structuredClone(catalog.figures[0]!);
  another.figure_id = 'same-number'; another.regions[0]!.asset_id = 'another-asset'; catalog.figures.push(another);
  assert.equal(associateFigures(f.document, f.record, catalog).status, 'pending');
  assert.equal(explicitFigureMentions('Fig. 10 shows CT and 图2B shows MRI.')[0]!.panel, null);
});
test('catalog bindings, exact caption offsets, complete-region provenance and CAS cannot be spoofed by IDs', () => {
  const f = setup();
  const wrong = structuredClone(f.catalog); wrong.text_version = 'other-version';
  assert.throws(() => assertFigureCatalog(f.document, wrong), /source_binding/);
  const broken = structuredClone(f.catalog); broken.figures[0]!.caption_segments[0]!.start++;
  assert.throws(() => assertFigureCatalog(f.document, broken), /fragment_source_mismatch/);
  assert.throws(() => confirmWholeFigure(f.document, f.catalog, '0'.repeat(64), 'figure-1', { actor: 'a', checked_at: new Date().toISOString(),
    all_panels_included: true, caption_figure_identity_checked: true, notes: 'check' }), /version_conflict/);
  const forged = checked(f); forged.figures[0]!.verification.status = 'mechanically_checked';
  assert.throws(() => assertFigureCatalog(f.document, forged), /mechanical_evidence/);
});
test('sampling requires no gold, binds the exact current output, and claims no full recall or zero errors', () => {
  const f = setup(), delivery = buildEvidenceDelivery(f.document, f.versions, checked(f)), record = delivery.records[0]!;
  const pending = auditOutputSample(delivery); assert.equal(pending.status, 'human_sample_pending'); assert.equal(pending.full_gold_required, false);
  const reviews: OutputSampleReview = { schema_version: 'output-sample-review-1', sample_id: 'sample-1', selection_method: 'Synthetic fixture only',
    reviewer: 'fixture-reviewer', reviewed_at: '2026-11-04T01:00:00Z', entries: [{ record_id: record.record_id, record_version: record.record_version,
      delivery_fingerprint: record.delivery_fingerprint, relevance: 'pass', context: 'pass', figure_pairing: 'pass', notes: 'Synthetic, not a real medical review.' }] };
  const report = auditOutputSample(delivery, reviews); assert.equal(report.sampled_count, 1); assert.equal(report.recall, null); assert.equal(report.zero_errors_proven, false);
  reviews.entries[0]!.record_version++; assert.throws(() => auditOutputSample(delivery, reviews), /version_conflict/);
});
test('exclusive exports verify source/asset hashes and each output confirmation; a changed Figure invalidates approval', async () => {
  const directory = await mkdtemp(resolve(CODE, '.tools/verbatim-export-test-'));
  try {
    const f = setup(), pdfPath = resolve(directory, 'source.pdf'), assetPath = resolve(directory, 'source.png');
    const pdfBytes = Buffer.from('%PDF synthetic bytes for export identity test only');
    await writeFile(pdfPath, pdfBytes); await writeFile(assetPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'));
    const sha = createHash('sha256').update(pdfBytes).digest('hex');
    f.document.file_sha256 = sha; f.document.source.file_reference = pdfPath; f.record.source_version.file_sha256 = sha;
    f.record.extraction_trace.source_binding.file_sha256 = sha;
    f.catalog.file_sha256 = sha; f.catalog.figures[0]!.regions[0]!.source_pdf_sha256 = sha;
    f.catalog.figures[0]!.regions[0]!.path = assetPath;
    f.catalog.figures[0]!.regions[0]!.width_px = 1; f.catalog.figures[0]!.regions[0]!.height_px = 1;
    f.catalog.figures[0]!.regions[0]!.bbox = [20, 100, 20.5, 100.5];
    f.catalog.figures[0]!.regions[0]!.sha256 = createHash('sha256').update(await readFile(assetPath)).digest('hex');
    const catalog = checked(f), delivery = buildEvidenceDelivery(f.document, f.versions, catalog), record = delivery.records[0]!;
    const options = { codeRoot: CODE, directory: resolve(directory, 'approved'), mode: 'approved' as const, catalog, coverage: { complete: false } };
    await assert.rejects(exportEvidenceDelivery(f.document, f.versions, options), /each_record_confirmation/);
    const review: DeliveryReview = { record_id: record.record_id, record_version: record.record_version, review_scope: 'text_and_figures',
      text_fingerprint: record.text_fingerprint, delivery_fingerprint: record.delivery_fingerprint,
      decision: 'approved', actor: 'fixture-human', reviewed_at: '2026-11-04T01:00:00Z', source_text_checked: true, relevance_checked: true,
      context_checked: true, figure_pairing_checked: true, reason: 'Synthetic approval gate test; not a medical approval.' };
    const output = await exportEvidenceDelivery(f.document, f.versions, { ...options, reviews: [review] });
    assert.equal(output.manifest.record_level_human_confirmation, true);
    assert.equal((await readFile(resolve(directory, 'approved/records.csv'), 'utf8')).includes(f.record.original_quote), true);
    await assert.rejects(exportEvidenceDelivery(f.document, f.versions, { ...options, reviews: [review] }), /EEXIST/);
    const changed = structuredClone(catalog); changed.figures[0]!.panel_labels.push('(C)');
    await assert.rejects(exportEvidenceDelivery(f.document, f.versions, { ...options, directory: resolve(directory, 'changed'), catalog: changed, reviews: [review] }), /version_conflict/);
    const textReview: DeliveryReview = { ...review, review_scope: 'text_only', delivery_fingerprint: null, figure_pairing_checked: false };
    const textOutput = await exportEvidenceDelivery(f.document, f.versions, { ...options, directory: resolve(directory, 'text-only'), catalog: changed, reviews: [textReview] });
    assert.equal(textOutput.delivery.records[0]!.figure_association.status, 'pending');
    assert.deepEqual(textOutput.delivery.records[0]!.figure_association.figure_ids, []);
    assert.ok(textOutput.manifest.assets.every(a => a.package_path.startsWith('review-materials/')));
    const humanVersions = structuredClone(f.versions);
    humanVersions[0]!.actor = 'human'; humanVersions[0]!.record.review_status = 'approved'; humanVersions[0]!.record.handoff_status = 'approved_for_T2';
    humanVersions[0]!.record.review_events.push({ action: 'approve', actor: 'synthetic-human', timestamp: '2026-11-04T02:00:00Z', reason: 'Text only fixture', version: 1 });
    const legacyOutput = await exportEvidenceDelivery(f.document, humanVersions, { ...options, directory: resolve(directory, 'legacy-text'), catalog: changed });
    assert.equal(legacyOutput.delivery.records[0]!.figure_association.status, 'pending');
    assert.deepEqual(legacyOutput.delivery.records[0]!.figure_association.figure_ids, []);
    await writeFile(pdfPath, Buffer.from('%PDF changed source'));
    await assert.rejects(exportEvidenceDelivery(f.document, humanVersions, { ...options, directory: resolve(directory, 'stale-approved') }), /pdf_hash_mismatch/);
    await writeFile(pdfPath, pdfBytes);
    await writeFile(assetPath, Buffer.from('tampered'));
    await assert.rejects(exportEvidenceDelivery(f.document, f.versions, { ...options, directory: resolve(directory, 'tampered'), mode: 'candidates' }), /asset_hash_mismatch/);
    await rm(assetPath);
    await assert.rejects(exportEvidenceDelivery(f.document, f.versions, { ...options, directory: resolve(directory, 'missing-image'), mode: 'candidates' }), /ENOENT/);
    const noImages = await exportEvidenceDelivery(f.document, humanVersions, { ...options, catalog: undefined, directory: resolve(directory, 'approved-text-without-images') });
    assert.equal(noImages.manifest.assets.length, 0);
    assert.equal(noImages.delivery.records[0]!.figure_association.status, 'not_checked');
    assert.equal(f.record.review_status === 'approved', false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
