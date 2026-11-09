import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContractError, EvidenceCatalogSchema, assertSchema, type EvidenceCatalog } from '@t1/contracts';
import { unavailableMedicalCatalog } from './workflow.js';

/** Trusted operator file only. No client path, implicit draft approval or fallback after bad configuration. */
export function configuredEvidenceCatalog(environment = process.env, root = process.cwd()): EvidenceCatalog {
  const path = environment.T1_WORKBENCH_CATALOG_FILE?.trim();
  if (!path) return structuredClone(unavailableMedicalCatalog);
  let value: unknown;
  try {
    const bytes = readFileSync(resolve(root, path));
    if (bytes.length > 4 * 1024 * 1024) throw new Error('size');
    value = JSON.parse(bytes.toString('utf8')); assertSchema(EvidenceCatalogSchema, value);
  } catch { throw new ContractError('configured_medical_catalog_invalid'); }
  const catalog = value as EvidenceCatalog;
  const entries = [...catalog.cancers, ...catalog.image_types, ...catalog.features, ...catalog.bindings];
  if (catalog.fixture || catalog.status !== 'approved' || entries.some(e => e.approval_status !== 'approved') ||
    [...catalog.cancers, ...catalog.image_types, ...catalog.features].some(e => e.synonyms.some(s => s.approval_status !== 'approved'))) {
    throw new ContractError('configured_medical_catalog_not_production_approved');
  }
  const cancers = new Set(catalog.cancers.map(e => e.id)), modalities = new Set(catalog.image_types.map(e => e.id)), features = new Set(catalog.features.map(e => e.feature_id));
  if (cancers.size !== catalog.cancers.length || modalities.size !== catalog.image_types.length || features.size !== catalog.features.length ||
    new Set(catalog.bindings.map(e => e.binding_id)).size !== catalog.bindings.length ||
    catalog.image_types.some(e => e.cancer_ids.some(id => !cancers.has(id))) ||
    catalog.bindings.some(e => !features.has(e.feature_id) || e.cancer_ids.some(id => !cancers.has(id)) || e.image_type_ids.some(id => !modalities.has(id)))) {
    throw new ContractError('configured_medical_catalog_invalid_relationships');
  }
  return structuredClone(catalog);
}
