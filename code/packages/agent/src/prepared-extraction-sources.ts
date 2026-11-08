import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { ContractError, type FigureAssetCatalog } from '@t1/contracts';
import { loadPdfParserSelection } from './parser-selection.js';
import { assertParsedDocument } from './parser.js';
import { assertLivePdfSource } from './figure-assets.js';
import { assertFigureCatalog } from './evidence-delivery.js';
import { assertComparisonSourceUse, comparisonDigest } from './method-comparison.js';
import type { ExtractionDocument } from './article-scope.js';
import type { ResponseModelAliasPolicy } from './extraction-budget.js';
import type { SourceManifest } from '../../../evaluation/src/contracts.js';
import type { IndependentCorpus } from '../../../evaluation/src/corpus-isolation.js';

export const PDF_AUXILIARY_MODULES = ['source_geometry.py', 'source_tables.py', 'source_continuations.py'] as const;
export const sourceBytesDigest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
export async function insideCode(path: string): Promise<string> {
  const code = await realpath(process.cwd()), actual = await realpath(resolve(code, path)), rel = relative(code, actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('comparison_source_outside_code');
  return actual;
}
export interface PreparedExtractionSourceSpec { source_id: string; prepared_directory: string; figure_catalog?: string }

/** Shared by comparison and B0 regression preparation/execution. Corpus-use checks precede PDF/IR reads. */
export async function readPreparedExtractionSources(papers: readonly PreparedExtractionSourceSpec[]) {
  const code = await realpath(process.cwd());
  const historical = await json('evaluation/manifests/source-register.json') as SourceManifest;
  const independent = await json('evaluation/manifests/independent-intake.json') as IndependentCorpus;
  const selected = loadPdfParserSelection(), values = [];
  let auxiliaryHashes: Record<string, string> | undefined;
  for (const paper of papers) {
    const source = historical.sources.find(s => s.source_id === paper.source_id), sealed = independent.papers.find(s => s.source_id === paper.source_id);
    const identity = source ? { source_id: source.source_id, article_family_id: source.article_family_id, doi: source.doi, file_sha256: source.access.sha256 ?? '' } :
      sealed ? { source_id: sealed.source_id, article_family_id: sealed.article_family_id, doi: sealed.doi, file_sha256: sealed.file.sha256 } : null;
    if (!identity) throw new ContractError('comparison_source_status_unknown_or_identity_changed');
    const use = assertComparisonSourceUse(identity, historical, independent);
    if (!source) throw new ContractError('comparison_source_not_in_development_register');
    const currentAuxiliaryHashes = auxiliaryHashes ??= Object.fromEntries(await Promise.all(PDF_AUXILIARY_MODULES.map(async name =>
      [name, sourceBytesDigest(await readFile('services/pdf-parser/' + name))])));
    const folder = await insideCode(paper.prepared_directory), irPath = resolve(folder, 'parser-result.json'), irBytes = await readFile(irPath);
    const parsed = JSON.parse(irBytes.toString('utf8')), document = parsed.document as ExtractionDocument; assertParsedDocument(document);
    const auxiliary = document.schema_version === '3' ?
      document.parser.config.auxiliary_module_sha256 as Record<string, unknown> | undefined : undefined;
    if (document.document_id !== source.source_id || document.file_sha256 !== source.access.sha256 || document.fixture || document.schema_version !== '3' ||
      document.parser.id !== selected.default_candidate_id || document.parser.version !== selected.primary.parser_version ||
      document.parser.config.adapter_sha256 !== sourceBytesDigest(await readFile('services/pdf-parser/structured.py')) ||
      !auxiliary || typeof auxiliary !== 'object' || Array.isArray(auxiliary) || Object.keys(auxiliary).length !== PDF_AUXILIARY_MODULES.length ||
      PDF_AUXILIARY_MODULES.some(name => auxiliary[name] !== currentAuxiliaryHashes[name]) ||
      document.source_extraction.parser_id !== selected.primary.source_anchor.id || document.source_extraction.parser_version !== selected.primary.source_anchor.version ||
      comparisonDigest(document.parser.config.native_config) !== comparisonDigest(selected.primary.native_configuration)) throw new ContractError('comparison_requires_same_current_formal_parser');
    await assertLivePdfSource(document);
    const catalogPath = paper.figure_catalog ? await insideCode(paper.figure_catalog) : resolve(folder, 'figure-assets/catalog.json');
    const figureBytes = await readFile(catalogPath), figures = JSON.parse(figureBytes.toString('utf8')) as FigureAssetCatalog;
    assertFigureCatalog(document, figures);
    const assets: Record<string, string> = {};
    for (const figure of figures.figures) for (const asset of figure.regions) {
      const path = await insideCode(asset.path), bytes = await readFile(path);
      if (sourceBytesDigest(bytes) !== asset.sha256) throw new ContractError('comparison_figure_asset_changed');
      assets[relative(code, path)] = asset.sha256;
    }
    values.push({ source, document, figures, use, source_binding: { document_id: document.document_id, article_family_id: source.article_family_id,
      pdf_path: source.access.local_path, pdf_sha256: document.file_sha256, ir_path: relative(code, irPath), ir_sha256: sourceBytesDigest(irBytes),
      text_version: document.text_version, parser_config_digest: document.parser.config_digest,
      figure_catalog_path: relative(code, catalogPath), figure_catalog_sha256: sourceBytesDigest(figureBytes), assets } });
  }
  if (new Set(values.map(v => v.document.parser.config_digest)).size !== 1) throw new ContractError('comparison_parser_settings_not_common_across_papers');
  return values;
}

export async function confirmedAliasEvidencePath(policy?: ResponseModelAliasPolicy): Promise<string | null> {
  if (!policy) return null;
  if (!policy.source.startsWith('code/')) throw new ContractError('comparison_alias_confirmation_source_invalid');
  const code = await realpath(process.cwd()), path = relative(code, await insideCode(policy.source.slice(5))), evidence = await json(path);
  if (evidence.schema_version !== 's4-supplier-exact-alias-confirmation-1' || policy.policy_id !== evidence.confirmation_id ||
    policy.recorded_at !== evidence.recorded_at || comparisonDigest(policy.exact_pairs) !== comparisonDigest(evidence.exact_pairs) ||
    evidence.wildcard_or_prefix_stripping_allowed !== false || evidence.other_names_must_halt !== true) throw new ContractError('comparison_alias_not_exactly_user_confirmed');
  return path;
}

/** Every runtime TS module is included automatically; callers add their actual CLI/config/observation inputs. */
export async function extractionRuntimeSourceHashes(options: {
  scripts: string[]; extraPaths?: string[]; responseModelAliasPolicy?: ResponseModelAliasPolicy;
}) {
  const files = (await Promise.all(['packages/agent/src', 'packages/contracts/src', 'evaluation/src'].map(async folder =>
    (await readdir(folder)).filter(name => name.endsWith('.ts')).map(name => folder + '/' + name)))).flat();
  files.push(...options.scripts, 'services/pdf-parser/structured.py', 'services/pdf-parser/adapter.py',
    'services/pdf-parser/native_worker.py', 'services/pdf-parser/figure_assets.py', 'config/pdf-parser.json', 'package.json', 'package-lock.json', 'evaluation/rules/output-sampling.json');
  files.push(...PDF_AUXILIARY_MODULES.map(name => 'services/pdf-parser/' + name), ...(options.extraPaths ?? []));
  const aliasPath = await confirmedAliasEvidencePath(options.responseModelAliasPolicy); if (aliasPath) files.push(aliasPath);
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async path => [path, sourceBytesDigest(await readFile(await insideCode(path)))])));
}

export async function assertFrozenRuntimeSources(hashes: Readonly<Record<string, string>>, snapshotDirectory?: string) {
  for (const [path, expected] of Object.entries(hashes)) {
    if (sourceBytesDigest(await readFile(await insideCode(path))) !== expected) throw new ContractError('comparison_runtime_source_changed_reprepare_required');
    if (snapshotDirectory && sourceBytesDigest(await readFile(resolve(snapshotDirectory, path))) !== expected)
      throw new ContractError('prepared_runtime_source_snapshot_changed');
  }
}
