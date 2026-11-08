import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError, type EvidenceVersion, type FigureAssetCatalog } from '@t1/contracts';
import { assertParsedDocument } from '../../../packages/agent/src/parser.js';
import { allDeliveredRecords, assertFigureCatalog, buildEvidenceDelivery } from '../../../packages/agent/src/evidence-delivery.js';
import type { ExtractionDocument } from '../../../packages/agent/src/article-scope.js';
import type { WorkbenchCapabilities, WorkbenchFigure, WorkbenchPaper, WorkbenchPaperDetail } from '../../../packages/contracts/src/workbench.js';

interface Artifact { path: string; sha256: string }
interface RegisteredPaper {
  id: string; pdf: Artifact; ir: Artifact; catalog: Artifact;
  metadata: { title: string; language: string; pages: number; note: string };
  assets: Array<Artifact & { asset_id: string }>;
  outputs: Array<{ id: string; strategy: string; result: Artifact; delivery: Artifact }>;
}
interface Registry { schema_version: string; papers: RegisteredPaper[] }
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const WORKBENCH_CAPABILITIES: WorkbenchCapabilities = {
  schema_version: 't1-workbench-capabilities-1', read_only: true, paper_upload: false,
  extraction_start: false, persisted_review: false, approved_export: false,
  backend_pi_sdk: '1.4.0', full_S5_complete: false,
};

/** Fixed retained sources, not an arbitrary file API. Every read rechecks the pinned bytes. */
export class WorkbenchSources {
  constructor(readonly codeRoot = fileURLToPath(new URL('../../../', import.meta.url)),
    readonly registryPath = 'config/pi-web-workbench.json') {}

  private async readPinned(artifact: Artifact): Promise<Buffer> {
    const root = await realpath(this.codeRoot);
    const path = await realpath(resolve(root, artifact.path)).catch(() => { throw new ContractError('workbench_source_unavailable'); });
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || rel.startsWith('/')) throw new ContractError('workbench_source_outside_code');
    const bytes = await readFile(path);
    if (sha256(bytes) !== artifact.sha256) throw new ContractError('workbench_source_changed');
    return bytes;
  }
  private async registry(): Promise<Registry> {
    const value = JSON.parse(await readFile(resolve(this.codeRoot, this.registryPath), 'utf8')) as Registry;
    if (value.schema_version !== 't1-workbench-source-registry-1' || !Array.isArray(value.papers)) throw new ContractError('workbench_registry_invalid');
    return value;
  }
  private async registered(id: string) {
    const row = (await this.registry()).papers.find(p => p.id === id);
    if (!row) throw new ContractError('workbench_paper_not_found');
    return row;
  }
  private summary(row: RegisteredPaper): WorkbenchPaper {
    return { id: row.id, ...row.metadata, sha256: row.pdf.sha256, output_ids: row.outputs.map(o => o.id) };
  }
  async papers() { return (await this.registry()).papers.map(row => this.summary(row)); }

  private async source(row: RegisteredPaper) {
    await this.readPinned(row.pdf);
    const parsed = JSON.parse((await this.readPinned(row.ir)).toString()) as { document: ExtractionDocument };
    const document = parsed.document;
    assertParsedDocument(document);
    if (document.document_id !== row.id || document.file_sha256 !== row.pdf.sha256 || document.fixture) throw new ContractError('workbench_ir_binding_mismatch');
    const catalog = JSON.parse((await this.readPinned(row.catalog)).toString()) as FigureAssetCatalog;
    assertFigureCatalog(document, catalog);
    for (const figure of catalog.figures) for (const asset of figure.regions) {
      const pinned = row.assets.find(a => a.asset_id === asset.asset_id);
      if (!pinned || pinned.path !== asset.path || pinned.sha256 !== asset.sha256) throw new ContractError('workbench_asset_registry_mismatch');
      await this.readPinned(pinned);
    }
    return { document, catalog };
  }

  async detail(id: string): Promise<WorkbenchPaperDetail> {
    const row = await this.registered(id), { document, catalog } = await this.source(row);
    const figures: WorkbenchFigure[] = catalog.figures.map(figure => ({ id: figure.figure_id, number: figure.figure_number,
      verification: figure.verification.status, caption: figure.caption_segments, human_approved: false,
      assets: figure.verification.status === 'needs_review' ? [] : figure.regions.map(asset => ({ id: asset.asset_id,
        url: `/api/t1/workbench/papers/${id}/figures/${asset.asset_id}`, sha256: asset.sha256,
        page: asset.physical_page, width: asset.width_px, height: asset.height_px })) }));
    const outputs = [];
    for (const output of row.outputs) {
      const result = JSON.parse((await this.readPinned(output.result)).toString()) as { document_id: string; state: string; records: EvidenceVersion[] };
      if (result.document_id !== id) throw new ContractError('workbench_output_binding_mismatch');
      const delivery = buildEvidenceDelivery(document, result.records, catalog);
      const recorded = JSON.parse((await this.readPinned(output.delivery)).toString());
      if (!isDeepStrictEqual(delivery, recorded)) throw new ContractError('workbench_delivery_changed');
      outputs.push({ id: output.id, strategy: output.strategy, state: result.state, origin: 'historical_compatibility_replay' as const,
        full_recall_claimed: false as const, medical_quality_approved: false as const,
        records: allDeliveredRecords(delivery).map(record => ({ id: record.record_id, version: record.record_version, run_id: record.run_id,
          fragments: record.original_fragments, context: record.context_fragments,
          association: record.figure_association.status, figure_ids: record.figure_association.figure_ids,
          proposed_figure_ids: record.figure_association.proposed_figure_ids,
          reasons: record.figure_association.reasons, review_status: record.review_status,
          text_fingerprint: record.text_fingerprint, delivery_fingerprint: record.delivery_fingerprint,
          ...(record.primary_assessment ? { evidence_role: record.primary_assessment.effective_role,
            model_primary_assessment: record.primary_assessment.value } : {}) })) });
    }
    return { paper: this.summary(row), text_version: document.text_version, pdf_url: `/api/t1/workbench/papers/${id}/pdf`,
      source_verified: true, figures, outputs, read_only: true };
  }
  async pdf(id: string) { const row = await this.registered(id); return this.readPinned(row.pdf); }
  async figure(id: string, assetId: string) {
    const row = await this.registered(id), { catalog } = await this.source(row);
    const figure = catalog.figures.find(f => f.regions.some(a => a.asset_id === assetId));
    if (!figure || figure.verification.status === 'needs_review') throw new ContractError('workbench_figure_not_available');
    const asset = row.assets.find(a => a.asset_id === assetId);
    if (!asset) throw new ContractError('workbench_figure_not_available');
    return this.readPinned(asset);
  }
}
