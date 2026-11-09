/** Retain the sealed, single real L05 run for ordinary workbench viewing. No model or review operation exists here. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ContractError, type EvidenceVersion, type FigureAssetCatalog } from '@t1/contracts';
import { ExtractionStore, assertParsedDocument, assertFigureCatalog, buildEvidenceDelivery, type ExtractionDocument } from '@t1/agent';
import { WorkbenchWorkflow } from '../apps/server/src/workflow.js';
import { assertPins, type VerificationPlan } from './verify-s5-workbench.js';

const CODE = fileURLToPath(new URL('../', import.meta.url));
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
export function databaseFingerprints(db: DatabaseSync) {
  const result: Record<string, Array<{ key: Record<string, unknown>; sha256: string }>> = {};
  const tables = ['runs', 'records', 'events', 'workbench_papers', 'workbench_runs', 's4_runs', 's4_versions', 's4_events', 'workbench_reviews', 'workbench_annotations', 'workbench_exports', 'workbench_deleted_sources'];
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all(); if (!columns.length) continue;
    const keys = columns.filter(c => Number(c.pk)).sort((a, b) => Number(a.pk) - Number(b.pk)).map(c => c.name as string);
    result[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${keys.join(',') || 'rowid'}`).all().map(row => ({
      key: Object.fromEntries(keys.map(key => [key, row[key]])),
      sha256: digest(JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))),
    }));
  }
  return result;
}
function preserve(before: ReturnType<typeof databaseFingerprints>, after: ReturnType<typeof databaseFingerprints>) {
  for (const [table, rows] of Object.entries(before)) for (const row of rows) {
    const value = after[table]?.find(v => isDeepStrictEqual(v.key, row.key));
    if (!value || value.sha256 !== row.sha256) throw new ContractError('retention_changed_preexisting_production_row');
  }
}
async function pinned(path: string, expected: string) {
  const root = await realpath(CODE), real = await realpath(resolve(root, path)), rel = relative(root, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('retention_source_outside_code');
  const bytes = await readFile(real); if (digest(bytes) !== expected) throw new ContractError('retention_source_sha_mismatch'); return bytes;
}

export async function retainClosedL05(planPath: string, expectedPlanSha: string, targetPath = resolve(CODE, 'runtime-data/t1.sqlite')) {
  const planBytes = await readFile(planPath), plan = JSON.parse(planBytes.toString()) as VerificationPlan;
  if (digest(planBytes) !== expectedPlanSha || plan.input.sha256 !== 'bd60db7e7fe5c7950ac85264c653f48feeb9c503eca76147da26d297f830535f') throw new ContractError('retention_L05_plan_binding_mismatch');
  assertPins(plan.code_sha256);
  const root = resolve(CODE, plan.directory), rootRel = relative(resolve(CODE, 'runtime-data/s5-real-workbench'), root);
  if (!rootRel || rootRel.startsWith('..') || isAbsolute(rootRel)) throw new ContractError('retention_trial_directory_invalid');
  const report = JSON.parse(await readFile(resolve(root, 'verification-report.json'), 'utf8'));
  const allowance = JSON.parse(await readFile(resolve(root, 'allowance.json'), 'utf8'));
  if (report.plan_sha256 !== expectedPlanSha || report.phase !== 'finished' || report.dry_run || report.controlled_fixture || !report.actual_new_provider_run ||
    !allowance.closed || allowance.plan_sha256 !== expectedPlanSha || allowance.run_id !== report.run_id) throw new ContractError('retention_requires_closed_real_run');
  const sourcePath = resolve(root, 'workflow.sqlite'), sourceSha = digest(await readFile(sourcePath));
  const source = new DatabaseSync(sourcePath, { readOnly: true }), target = new ExtractionStore(targetPath);
  // Reuse the existing schema without invoking startup/recovery or source imports on the production connection.
  new WorkbenchWorkflow(target, { sources: false });
  try {
    const before = databaseFingerprints(target.db);
    if (target.db.prepare('SELECT id FROM s4_runs WHERE id=?').get(report.run_id)) {
      const a = target.db.prepare('SELECT input_json FROM s4_runs WHERE id=?').get(report.run_id)!;
      const b = source.prepare('SELECT input_json FROM s4_runs WHERE id=?').get(report.run_id)!;
      if (!b || a.input_json !== b.input_json) throw new ContractError('retention_existing_run_identity_conflict');
      return { status: 'already_retained', run_id: report.run_id, paper_id: report.paper_id, existing_versions_and_reviews_unchanged: true };
    }
    if (target.db.prepare('SELECT id FROM workbench_papers WHERE id=?').get(report.paper_id)) throw new ContractError('retention_existing_paper_identity_conflict');
    for (const table of ['workbench_reviews', 'workbench_annotations']) if (Number(source.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n)) throw new ContractError('retention_trial_contains_human_writes');
    const paper = source.prepare('SELECT * FROM workbench_papers WHERE id=?').get(report.paper_id)!;
    const run = source.prepare('SELECT * FROM workbench_runs WHERE id=?').get(report.run_id)!;
    const runPayload = JSON.parse(run.payload_json as string), paperPayload = JSON.parse(paper.payload_json as string);
    if (runPayload.origin !== 'workbench_run' || runPayload.controlled || runPayload.paper_id !== report.paper_id) throw new ContractError('retention_run_origin_mismatch');
    const evidence = runPayload.source as { document: ExtractionDocument; ir: { path: string; sha256: string }; catalog?: FigureAssetCatalog; catalog_artifact?: { path: string; sha256: string } };
    assertParsedDocument(evidence.document);
    if (evidence.document.document_id !== report.paper_id || evidence.document.file_sha256 !== plan.input.sha256 || evidence.document.fixture) throw new ContractError('retention_document_binding_mismatch');
    await pinned(paperPayload.pdf.path, plan.input.sha256); await pinned(evidence.ir.path, evidence.ir.sha256);
    if (evidence.catalog) {
      assertFigureCatalog(evidence.document, evidence.catalog);
      if (!evidence.catalog_artifact) throw new ContractError('retention_catalog_artifact_required');
      await pinned(evidence.catalog_artifact.path, evidence.catalog_artifact.sha256);
      for (const asset of evidence.catalog.figures.flatMap(f => f.regions)) await pinned(asset.path, asset.sha256);
    }
    const versions = source.prepare('SELECT envelope_json FROM s4_versions WHERE run_id=? ORDER BY record_id,version').all(report.run_id).map(v => JSON.parse(v.envelope_json as string) as EvidenceVersion);
    buildEvidenceDelivery(evidence.document, versions, evidence.catalog);
    // The immutable trial retains its files; future UI deletion removes this view, never the sealed evidence directory.
    paperPayload.uploaded = false;
    paperPayload.note += ' Retained real S5 model verification; no human approval imported. Original trial files remain sealed.';
    runPayload.directory = '';
    const tables = ['s4_runs', 's4_events', 's4_versions', 's4_batches', 'workbench_exports'];
    target.atomic(() => {
      target.db.prepare('INSERT INTO workbench_papers VALUES(?,?)').run(report.paper_id, JSON.stringify(paperPayload));
      for (const table of tables) {
        const key = table === 's4_runs' ? 'id' : 'run_id';
        for (const row of source.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).all(report.run_id)) {
          const columns = Object.keys(row); target.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(c => row[c] as string | number | null));
        }
      }
      target.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?)').run(report.run_id, report.paper_id, JSON.stringify(runPayload));
      target.event(report.run_id, 'sealed_real_run_retained', { source_plan_sha256: expectedPlanSha, source_database_sha256: sourceSha,
        original_run_and_record_versions_preserved: true, human_approval_added: false });
      preserve(before, databaseFingerprints(target.db));
    });
    const after = databaseFingerprints(target.db); preserve(before, after);
    if (digest(await readFile(sourcePath)) !== sourceSha) throw new ContractError('retention_modified_source_database');
    const base = 'http://127.0.0.1:30141';
    return { status: 'retained', paper_id: report.paper_id, run_id: report.run_id, origin: runPayload.origin, records: report.records,
      user_url: `${base}/?paper=${report.paper_id}&run=${encodeURIComponent(report.run_id)}&view=records`, pdf_url: `${base}/api/t1/workbench/papers/${report.paper_id}/pdf`,
      source_database_sha256: sourceSha, original_source_and_versions_preserved: true, preexisting_rows_preserved: true, human_review_or_annotation_rows_imported: 0,
      lifecycle_metadata_only_changes: ['paper uploaded=false marks retained source', 'run directory empty protects sealed files from later UI deletion'],
      before_counts: Object.fromEntries(Object.entries(before).map(([t, r]) => [t, r.length])), after_counts: Object.fromEntries(Object.entries(after).map(([t, r]) => [t, r.length])),
      before_fingerprint: digest(JSON.stringify(before)), after_fingerprint: digest(JSON.stringify(after)) };
  } finally { source.close(); target.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] ?? 'docs/acceptance/s5-workflow-2026-11-09/real-model-L05/plan.json'), expected = process.argv[3];
  if (!expected) throw new ContractError('retention_expected_plan_sha_required');
  const result = await retainClosedL05(path, expected);
  await writeFile(resolve(CODE, 'docs/acceptance/s5-workflow-2026-11-09/real-model-L05/production-retention.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
}
