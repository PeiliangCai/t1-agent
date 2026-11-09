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

export interface Artifact { path: string; sha256: string }
export interface RegisteredPaper {
  id: string; pdf: Artifact; ir: Artifact; catalog: Artifact;
  metadata: { title: string; language: string; pages: number; note: string };
  assets: Array<Artifact & { asset_id: string }>;
  outputs: Array<{ id: string; strategy: string; result: Artifact; delivery: Artifact }>;
}
interface Registry { schema_version: string; papers: RegisteredPaper[] }
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Three later, read-only group fields were absent from the pinned legacy delivery. All original bytes/fields still must match. */
function assertHistoricalDeliveryCompatible(current: ReturnType<typeof buildEvidenceDelivery>, recorded: Record<string, unknown>) {
  const comparable = { ...current } as Record<string, unknown>;
  for (const key of ['strict_source_groups', 'source_grouping_policy_version', 'unique_source_group_count']) {
    if (!Object.hasOwn(recorded, key)) delete comparable[key];
  }
  if (!isDeepStrictEqual(comparable, recorded)) throw new ContractError('workbench_delivery_changed');
}
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
  /** Import immutable retained evidence once into the workflow store. A missing PDF is reported separately. */
  async retained(includeCurrent = false) {
    const values = [];
    for (const row of (await this.registry()).papers) {
      const parsed = JSON.parse((await this.readPinned(row.ir)).toString()) as { document: ExtractionDocument };
      assertParsedDocument(parsed.document);
      if (parsed.document.document_id !== row.id || parsed.document.file_sha256 !== row.pdf.sha256) throw new ContractError('workbench_ir_binding_mismatch');
      const catalog = JSON.parse((await this.readPinned(row.catalog)).toString()) as FigureAssetCatalog;
      assertFigureCatalog(parsed.document, catalog);
      const outputs = [];
      for (const output of row.outputs) {
        const result = JSON.parse((await this.readPinned(output.result)).toString()) as { state: string; run_id?: string; records: EvidenceVersion[]; versions?: EvidenceVersion[]; coverage?: unknown; scope?: import('@t1/contracts').Scope; summary?: string };
        assertHistoricalDeliveryCompatible(buildEvidenceDelivery(parsed.document, result.records, catalog), JSON.parse((await this.readPinned(output.delivery)).toString()));
        outputs.push({ ...output, result });
      }
      values.push({ row, document: parsed.document, catalog, outputs });
    }
    if (includeCurrent && this.registryPath === 'config/pi-web-workbench.json') {
      const bindingPath = 'docs/acceptance/s4-b0-revalidation-2026-11-08/output-binding.json';
      const binding = JSON.parse((await this.readPinned({ path: bindingPath, sha256: '77571cdec58805e18ddfc7ec79e735310c1da50c34b3dfdb08fe0bfb21b43826' })).toString());
      if (binding.finalized !== true || binding.schema_version !== 'b0-finalized-output-binding-1') throw new ContractError('current_output_binding_invalid');
      const plan = JSON.parse((await this.readPinned({ path: binding.plan_path, sha256: binding.plan_sha256 })).toString());
      for (const job of binding.jobs) {
        const paper = plan.papers.find((p: { document_id: string }) => p.document_id === job.document_id);
        if (!paper) throw new ContractError('current_output_source_missing');
        const document = JSON.parse((await this.readPinned({ path: paper.ir_path, sha256: paper.ir_sha256 })).toString()).document as ExtractionDocument;
        assertParsedDocument(document);
        if (document.document_id !== paper.document_id || document.file_sha256 !== paper.pdf_sha256 || document.text_version !== paper.text_version) throw new ContractError('current_output_source_mismatch');
        const catalog = JSON.parse((await this.readPinned({ path: paper.figure_catalog_path, sha256: paper.figure_catalog_sha256 })).toString()) as FigureAssetCatalog;
        assertFigureCatalog(document, catalog);
        const result = JSON.parse((await this.readPinned({ path: job.result_path, sha256: job.result_sha256 })).toString());
        const exported = JSON.parse((await this.readPinned({ path: job.candidate_export.delivery_path, sha256: job.candidate_export.delivery_sha256 })).toString());
        for (const record of [...exported.records, ...(exported.background_records ?? [])]) {
          if (record.export_review_status !== 'candidate' || record.human_confirmation !== null || record.legacy_text_review_events?.length) throw new ContractError('current_output_unexpected_approval');
          delete record.export_review_status; delete record.human_confirmation; delete record.legacy_text_review_events;
        }
        for (const group of exported.strict_source_groups ?? []) for (const member of group.members) {
          if (member.human_confirmation !== null) throw new ContractError('current_output_unexpected_approval'); delete member.human_confirmation;
        }
        assertHistoricalDeliveryCompatible(buildEvidenceDelivery(document, result.records, catalog), exported);
        const output = { id: 'current-S4-' + job.job_id, strategy: 'B0', result: { path: job.result_path, sha256: job.result_sha256 },
          delivery: { path: job.candidate_export.delivery_path, sha256: job.candidate_export.delivery_sha256 } };
        const old = values.find(p => p.row.id === paper.document_id);
        const row: RegisteredPaper = { id: paper.document_id, pdf: { path: paper.pdf_path, sha256: paper.pdf_sha256 }, ir: { path: paper.ir_path, sha256: paper.ir_sha256 },
          catalog: { path: paper.figure_catalog_path, sha256: paper.figure_catalog_sha256 }, metadata: old?.row.metadata ?? { title: paper.document_id, language: paper.language, pages: document.pages.length, note: 'Retained current S4 output; no business approval inherited.' },
          assets: catalog.figures.flatMap(f => f.regions.map(a => ({ path: a.path, sha256: a.sha256, asset_id: a.asset_id }))), outputs: [output] };
        values.push({ row, document, catalog, outputs: [{ ...output, result: { ...result, scope: plan.config.scope } }] });
      }
    }
    return values;
  }

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
      assertHistoricalDeliveryCompatible(delivery, recorded);
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
