/** Offline per-version host association, preserving unapproved Figure status. No model call or inherited approval. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { associateFigures } from '../../../../packages/agent/src/evidence-delivery.js';
const base = resolve('docs/acceptance/s4-reliability-2026-11-05/live-revalidation');
const manifest = JSON.parse(await readFile(join(base, 'reader-manifest.json'), 'utf8'));
const paper = manifest.papers[0], document = JSON.parse(await readFile(resolve(paper.ir_path), 'utf8')).document;
const catalog = JSON.parse(await readFile(resolve(paper.figure_catalog_path), 'utf8'));
const associations: any[] = [];
for (const entry of manifest.records) for (const version of entry.versions) {
  const association = associateFigures(document, version.record, catalog);
  if (association.human_approved !== false) throw new Error('unexpected_human_approval');
  associations.push({ entry_id: entry.entry_id, job_id: entry.job_id, record_id: entry.record_id, version: version.version,
    version_role: version.version_role, figure_ids: association.figure_ids, proposed_figure_ids: association.proposed_figure_ids,
    figure_association: association, human_approval_inherited: false,
    provenance: 'Offline host recomputation for this exact retained version, same frozen association rules and source catalog. No medical/human approval or new model inference.' });
}
await writeFile(join(base, 'version-figure-associations.json'), JSON.stringify({ schema_version: 'version-figure-host-association-audit-1',
  new_model_API_requests: 0, associations }, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ versions: associations.length, new_model_API_requests: 0, human_approval_inherited: false }) + '\n');
