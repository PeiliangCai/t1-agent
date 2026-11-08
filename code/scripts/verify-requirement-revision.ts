/** Offline compatibility/association replay. Never imports API configuration or creates a model session. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { EvidenceVersion, FigureAssetCatalog } from '@t1/contracts';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { allDeliveredRecords, deliveryRecordCounts, assertFigureCatalog, buildEvidenceDelivery, exportEvidenceDelivery } from '../packages/agent/src/evidence-delivery.js';
import type { ExtractionDocument } from '../packages/agent/src/article-scope.js';

const root = resolve('docs/acceptance/requirement-revision-2026-11-04');
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
await mkdir(resolve(root, 'offline-replay'), { recursive: true });
await mkdir(resolve(root, 'offline-exports'), { recursive: true });
const documents = new Map<string, ExtractionDocument>(), catalogs = new Map<string, FigureAssetCatalog>();
const figures = [];
// Retained real development samples, not an automatic-pairing allowlist.
for (const source of ['MED03', 'L07', 'L05', 'L01', 'L02']) {
  const document = (await read(resolve('docs/acceptance/s3/comparison-2026-11-02/runs/guarded-v4/reuse/docling-standard-cpu', source+'.json'))).document as ExtractionDocument;
  assertParsedDocument(document);
  const catalog = await read(resolve(root, 'real-figures-final', source, 'catalog.json')) as FigureAssetCatalog;
  assertFigureCatalog(document, catalog);
  const bytes = await readFile(resolve(document.source.file_reference));
  if (sha(bytes) !== document.file_sha256) throw new Error('source_pdf_hash_mismatch');
  for (const figure of catalog.figures) for (const asset of figure.regions) if (sha(await readFile(resolve(asset.path))) !== asset.sha256) throw new Error('asset_hash_mismatch');
  documents.set(source, document); catalogs.set(source, catalog);
  figures.push({ source, numbered_figure_candidates: catalog.figures.filter(f => f.figure_number !== null).length,
    unnumbered_region_candidates: catalog.figures.filter(f => f.figure_number === null).length,
    png_assets: catalog.figures.reduce((n, f) => n+f.regions.length, 0),
    mechanically_checked_figures: catalog.figures.filter(f => f.verification.status === 'mechanically_checked').length,
    needs_review_numbered_figures: catalog.figures.filter(f => f.figure_number && f.verification.status === 'needs_review').length,
    catalog: resolve(root, 'real-figures-final', source, 'catalog.json'),
    figure_details: catalog.figures.map(f => ({ figure_id: f.figure_id, number: f.figure_number, verification: f.verification,
      regions: f.regions, caption_segments: f.caption_segments, panel_labels: f.panel_labels })) });
}
const oldReport = await read(resolve('docs/acceptance/s4/selection-optimization/continuation-2026-11-03/report.json'));
const unique = new Map<string, string>(), replay = [];
for (const row of oldReport.rows as Array<{ job_id: string; result_path: string; independent_measurement: boolean; reused_from: string | null }>) {
  const source = row.job_id.split('-')[0]!, document = documents.get(source)!, catalog = catalogs.get(source)!;
  const shared = unique.get(row.result_path);
  if (shared) { replay.push({ job_id: row.job_id, reused_from: shared, independently_retested: false }); continue; }
  unique.set(row.result_path, row.job_id);
  const result = await read(row.result_path), eligible: EvidenceVersion[] = [], rejected = [];
  for (const version of result.records as EvidenceVersion[]) {
    try { buildEvidenceDelivery(document, [version], catalog); eligible.push(version); }
    catch (error) { rejected.push({ record_id: version.record.record_id, version: version.version, reason: error instanceof Error ? error.message : 'invalid_legacy_record' }); }
  }
  const delivery = buildEvidenceDelivery(document, eligible, catalog);
  const out = resolve(root, 'offline-replay', row.job_id+'.delivery.json');
  await writeFile(out, JSON.stringify(delivery, null, 2)+'\n', { flag: 'wx' });
  const exported = await exportEvidenceDelivery(document, eligible, { codeRoot: process.cwd(), directory: resolve(root, 'offline-exports', row.job_id),
    mode: 'candidates', catalog, coverage: { historical_source_run: row.result_path, original_coverage: result.coverage,
      historical_records_not_rewritten: true, records_rejected_by_new_policy: rejected, new_paid_run: false } });
  const associations = allDeliveredRecords(delivery).reduce((counts, r) => { counts[r.figure_association.status] = (counts[r.figure_association.status] ?? 0)+1; return counts; }, {} as Record<string, number>);
  replay.push({ job_id: row.job_id, historical_result_path: row.result_path, independently_retested: false, offline_compatibility_replay_only: true,
    historical_candidate_count: result.records.length, new_policy_compatible_count: eligible.length, ...deliveryRecordCounts(delivery), incompatible_legacy_records: rejected,
    association_counts: associations, paired_records: allDeliveredRecords(delivery).filter(r => r.figure_association.status === 'paired'),
    pending_records: allDeliveredRecords(delivery).filter(r => r.figure_association.status === 'pending').map(r => ({ record_id: r.record_id, original_fragments: r.original_fragments, association: r.figure_association })),
    main_figure_files: exported.manifest.assets.filter(a => a.package_path.startsWith('figures/')).length,
    pending_material_files: exported.manifest.assets.filter(a => a.package_path.startsWith('review-materials/')).length,
    delivery: out, export_directory: resolve(root, 'offline-exports', row.job_id), sample_status: exported.sample.status });
}
const report = { schema_version: 'requirement-revision-offline-replay-1', paid_calls: 0, original_pdf_uploads: 0,
  existing_real_documents: figures.length, figures, previous_logical_conditions: oldReport.rows.length,
  unique_historical_outputs_replayed: unique.size, replay,
  formal_new_model_strategy_comparison_run: false, human_sample_performed: false,
  full_gold_required: false, recall: null, medical_precision: null, medical_quality_approved: false, stage_passed: false,
  limitation: 'Asset detection and explicit source-link checks are engineering observations. Historical outputs were generated under the old contract; this is not a new-model efficacy experiment or medical approval.' };
await writeFile(resolve(root, 'offline-replay-report.json'), JSON.stringify(report, null, 2)+'\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ real_documents: figures.length, figures, outputs: replay.map(r => ({ job_id: r.job_id,
  ...( 'association_counts' in r ? { associations: r.association_counts, rejected: r.incompatible_legacy_records?.length } : { reused_from: r.reused_from }) })), paid_calls: 0 })+'\n');
