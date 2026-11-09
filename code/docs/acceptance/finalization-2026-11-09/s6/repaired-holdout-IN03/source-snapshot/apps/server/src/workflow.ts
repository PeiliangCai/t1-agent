import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ContractError, ScopeSchema, assertSchema, defaultScope, type DeliveryReview, type EvidenceCatalog,
  type EvidenceRecord, type EvidenceSubmission, type EvidenceValidationContext, type EvidenceVersion, type FigureAssetCatalog,
  type RunInput, type Scope } from '@t1/contracts';
import { ExtractionStore, assertParsedDocument, createConfiguredPdfParserAdapter, discoverPdfFigures, assertLivePdfSource,
  buildArticleScope, buildSourceEvidenceUnits, taskSourceBlockIds, evidenceScopeIssues, buildEvidenceDelivery,
  allDeliveredRecords, assertFigureCatalog, validateEvidenceSubmission, exportEvidenceDelivery, buildSameSourceReviewIndex, evidenceDigest, confirmWholeFigure,
  type ExtractionDocument, type StoredEvidenceVersion } from '@t1/agent';
import type { WorkbenchCapabilities, WorkbenchEvent, WorkbenchExportKind, WorkbenchLabels, WorkbenchOutput, WorkbenchPaper,
  WorkbenchPaperDetail, WorkbenchRecord, WorkbenchRevisionInput, WorkbenchReviewInput, WorkbenchRun, WorkbenchSourceUnit, WorkbenchFigureCheckInput } from '../../../packages/contracts/src/workbench.js';
import { WorkbenchSources, type Artifact } from './workbench.js';

const CODE = fileURLToPath(new URL('../../../', import.meta.url));
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const terminals = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
export const unavailableMedicalCatalog: EvidenceCatalog = { catalog_version: 'medical-unavailable-1', status: 'unavailable', fixture: false,
  cancers: [], image_types: [], features: [], bindings: [] };
interface SourceSnapshot { document: ExtractionDocument; ir: Artifact; catalog?: FigureAssetCatalog; catalog_artifact?: Artifact; figure_history?: Artifact[] }
interface PaperRow { id: string; title: string; filename: string; pdf: Artifact; uploaded: boolean; language: string; pages: number;
  note: string; latest_source?: SourceSnapshot }
interface RunRow { id: string; paper_id: string; created_at: string; origin: WorkbenchOutput['origin']; controlled: boolean;
  source?: SourceSnapshot; coverage?: unknown; error?: string; directory: string; strategy?: string; summary?: string;
  execution_started_at?: string; queue_wait_ms?: number; runtime_deadline?: string }
interface Annotation { labels: WorkbenchLabels; deleted: boolean; reviewer: string; reason: string }
export interface WorkflowExecution {
  input: RunInput; document: ExtractionDocument; catalog?: FigureAssetCatalog; directory: string;
  signal: AbortSignal; store: ExtractionStore; metadata: EvidenceValidationContext['metadata']; execution_started_at?: string;
}
export interface WorkflowRunner {
  /** Test dependency injection is server-owned. The HTTP client cannot select a runner or endpoint. */
  controlled: boolean; provider: string; model_id: string;
  available?(): boolean;
  /** Optional host admission hook, before parsing and outside any SQLite write transaction. */
  prepare?(input: RunInput, directory: string): void | Promise<void>;
  execute(context: WorkflowExecution): Promise<{ coverage?: unknown; summary?: string }>;
}
export interface WorkflowOptions {
  codeRoot?: string; directory?: string; sources?: WorkbenchSources | false; catalog?: EvidenceCatalog; runner?: WorkflowRunner;
  parse?: (input: RunInput, fileReference: string, directory: string, signal: AbortSignal) => Promise<ExtractionDocument>;
  /** Internal fixture may shorten the clock; production gets 30 min after taking an execution slot. */
  runTimeoutMs?: number;
  discover?: typeof discoverPdfFigures;
}
export class WorkflowConflict extends ContractError {
  constructor(readonly current_version: number) { super('evidence_version_conflict'); }
}
export class WorkflowCatalogConflict extends ContractError {
  constructor(readonly current_catalog_sha256: string | null) { super('figure_catalog_version_conflict'); }
}

/** One coordinator owns short SQLite transactions. Parsing/model waits never hold a write transaction. */
export class WorkbenchWorkflow {
  readonly codeRoot: string; readonly directory: string; readonly catalog: EvidenceCatalog;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  readonly maxConcurrentRuns = 2;
  private executing = 0;
  private readonly queue: Array<{ id: string; controller: AbortController; run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }> = [];
  private initialized?: Promise<void>; private shuttingDown = false;
  private readonly sourceUnitCache = new Map<string, WorkbenchSourceUnit[]>();
  private readonly outputCache = new Map<string, { key: string; value: WorkbenchOutput }>();
  constructor(readonly store: ExtractionStore, readonly options: WorkflowOptions = {}) {
    this.codeRoot = resolve(options.codeRoot ?? CODE); this.directory = resolve(this.codeRoot, options.directory ?? 'runtime-data/workbench');
    if (relative(this.codeRoot, this.directory).startsWith('..') || this.directory === this.codeRoot) throw new ContractError('workflow_directory_outside_code');
    this.catalog = structuredClone(options.catalog ?? unavailableMedicalCatalog);
    if (!Number.isSafeInteger(options.runTimeoutMs ?? 1800_000) || (options.runTimeoutMs ?? 1800_000) < 1 || (options.runTimeoutMs ?? 1800_000) > 1800_000) throw new ContractError('invalid_workflow_run_timeout');
    store.db.exec(`CREATE TABLE IF NOT EXISTS workbench_papers(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_runs(id TEXT PRIMARY KEY REFERENCES s4_runs(id),paper_id TEXT NOT NULL REFERENCES workbench_papers(id),payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_annotations(run_id TEXT NOT NULL,record_id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,record_id,version));
      CREATE TABLE IF NOT EXISTS workbench_reviews(run_id TEXT NOT NULL,record_id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,record_id,version));
      CREATE TABLE IF NOT EXISTS workbench_exports(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,payload_json TEXT NOT NULL);`);
    store.db.exec('CREATE TABLE IF NOT EXISTS workbench_deleted_sources(paper_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL)');
  }
  async initialize() { return this.initialized ??= this.initializeOnce(); }
  private async initializeOnce() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const row of this.runRows()) if (!terminals.has(this.store.snapshot(row.id).state)) {
      this.store.transition(row.id, 'interrupted'); this.store.event(row.id, 'interruption', { reason: 'server_restart', automatic_resume: false, saved_candidates_preserved: true });
    }
    if (this.options.sources !== false) {
      const sources = this.options.sources ?? new WorkbenchSources(this.codeRoot);
      for (const retained of await sources.retained(true)) {
        if (this.store.db.prepare('SELECT paper_id FROM workbench_deleted_sources WHERE paper_id=?').get(retained.row.id)) continue;
        const source: SourceSnapshot = { document: retained.document, ir: retained.row.ir, catalog: retained.catalog, catalog_artifact: retained.row.catalog };
        const paper: PaperRow = { id: retained.row.id, title: retained.row.metadata.title, filename: retained.row.id + '.pdf', pdf: retained.row.pdf,
          uploaded: false, language: retained.row.metadata.language, pages: retained.row.metadata.pages, note: retained.row.metadata.note, latest_source: source };
        const existing = this.store.db.prepare('SELECT id FROM workbench_papers WHERE id=?').get(paper.id);
        if (!existing) this.savePaper(paper);
        for (const output of retained.outputs) {
          const versions = output.result.versions ?? output.result.records;
          const first = versions[0]?.record;
          const id = first?.extraction_trace.run_id ?? output.result.run_id;
          if (!id) continue;
          if (this.store.db.prepare('SELECT id FROM workbench_runs WHERE id=?').get(id)) {
            const existingRun = this.run(id); if (!existingRun.strategy) this.saveRun({ ...existingRun, strategy: output.strategy });
            continue;
          }
          const input: RunInput = { schema_version: '1', run_id: id, document_id: paper.id, file_sha256: paper.pdf.sha256, fixture: retained.document.fixture,
            scope: first?.extraction_trace.scope ?? output.result.scope ?? defaultScope(this.catalog.catalog_version), rule_version: first?.extraction_trace.rule_version ?? 'visual-statements-2',
            runtime_profile: { provider: first?.extraction_trace.provider ?? 'retained', model_id: first?.extraction_trace.model_id ?? 'retained', endpoint: '', pi_version: '1.4.0', version: 'retained-workbench-import-1' } };
          this.store.atomic(() => {
            this.store.create(input, { historical: true, medical_quality_approved: false });
            this.store.retainVersions(id, versions);
            this.store.db.prepare('UPDATE s4_runs SET state=? WHERE id=?').run(terminals.has(output.result.state) ? output.result.state : 'interrupted', id);
            this.saveRun({ id, paper_id: paper.id, source, origin: 'historical_compatibility_replay', controlled: false, created_at: now(), directory: '', coverage: output.result.coverage, strategy: output.strategy, summary: output.result.summary });
            // Importing a newer retained source updates the paper view only when no workbench run has replaced it.
            if (!this.runRows().some(r => r.paper_id === paper.id && r.origin !== 'historical_compatibility_replay')) this.savePaper(paper);
          });
        }
      }
    }
  }
  capabilities(): WorkbenchCapabilities {
    return { schema_version: 't1-workbench-capabilities-1', read_only: false, paper_upload: true,
      extraction_start: Boolean(this.options.runner && (this.options.runner.available?.() ?? true)), persisted_review: true, approved_export: true,
      backend_pi_sdk: '1.4.0', controlled_fixture: this.options.runner?.controlled ?? false, max_concurrent_runs: this.maxConcurrentRuns,
      max_pdf_bytes: MAX_PDF_BYTES, ...(!this.options.runner ? { extraction_unavailable_reason: 'server_model_not_enabled' } : {}) };
  }
  scopeCatalog() { return { ...this.catalog, default_scope: { ...defaultScope(this.catalog.catalog_version), matching_policy_version: 'exact-explicit-synonyms-1' },
    restricted_available: this.catalog.status === 'approved' && !this.catalog.fixture,
    restricted_reason: this.catalog.status === 'approved' && !this.catalog.fixture ? null : 'medical_catalog_not_approved', development_only: this.catalog.status === 'development_only' || this.catalog.fixture }; }
  private paper(id: string): PaperRow {
    const row = this.store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(id);
    if (!row) throw new ContractError('workbench_paper_not_found'); return JSON.parse(row.payload_json as string);
  }
  private run(id: string): RunRow {
    const row = this.store.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(id);
    if (!row) throw new ContractError('workbench_run_not_found'); return JSON.parse(row.payload_json as string);
  }
  private runRows(): RunRow[] { return this.store.db.prepare('SELECT payload_json FROM workbench_runs ORDER BY rowid DESC').all().map(r => JSON.parse(r.payload_json as string)); }
  private savePaper(row: PaperRow) { this.store.db.prepare('INSERT INTO workbench_papers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(row.id, JSON.stringify(row)); }
  private saveRun(row: RunRow) { this.store.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(row.id, row.paper_id, JSON.stringify(row)); }
  private summary(row: PaperRow): WorkbenchPaper { return { id: row.id, title: row.title, sha256: row.pdf.sha256, uploaded: row.uploaded,
    language: row.language, pages: row.pages, note: row.note, output_ids: this.store.db.prepare('SELECT id FROM workbench_runs WHERE paper_id=? ORDER BY rowid DESC').all(row.id).map(r => r.id as string) }; }
  async papers() { await this.initialize(); return this.store.db.prepare('SELECT payload_json FROM workbench_papers ORDER BY rowid DESC').all().map(r => this.summary(JSON.parse(r.payload_json as string))); }
  async runs(filterId?: string): Promise<WorkbenchRun[]> { await this.initialize();
    return this.store.db.prepare(`SELECT w.id,w.paper_id,s.state,s.input_json,json_extract(w.payload_json,'$.origin','$.created_at','$.controlled','$.error','$.execution_started_at','$.queue_wait_ms','$.runtime_deadline') info
      FROM workbench_runs w JOIN s4_runs s ON w.id=s.id ${filterId ? 'WHERE w.id=?' : ''} ORDER BY w.rowid DESC`).all(...(filterId ? [filterId] : [])).map(row => {
      const [origin, created_at, controlled, error, execution_started_at, queue_wait_ms, runtime_deadline] = JSON.parse(row.info as string), input = JSON.parse(row.input_json as string) as RunInput;
      const count = this.store.db.prepare(`SELECT COUNT(*) n FROM s4_versions v JOIN
        (SELECT record_id,MAX(version) version FROM s4_versions WHERE run_id=? AND COALESCE(json_extract(envelope_json,'$.status'),'active')<>'proposed' GROUP BY record_id) current
        ON v.record_id=current.record_id AND v.version=current.version
        LEFT JOIN workbench_annotations a ON a.run_id=v.run_id AND a.record_id=v.record_id AND a.version=v.version
        WHERE v.run_id=? AND COALESCE(json_extract(a.payload_json,'$.deleted'),0)<>1`).get(row.id as string, row.id as string)!;
      return { run_id: row.id as string, document_id: row.paper_id as string, state: row.state as string, fixture: Boolean(controlled), candidate_count: Number(count.n),
        scope: input.scope, origin, created_at, ...(error ? { error } : {}), ...(execution_started_at ? { execution_started_at, queue_wait_ms, runtime_deadline } : {}) };
    });
  }
  private async readPinned(artifact: Artifact) {
    const root = await realpath(this.codeRoot), path = await realpath(resolve(root, artifact.path)).catch(() => { throw new ContractError('source_file_missing'); });
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('source_file_outside_code');
    const bytes = await readFile(path);
    if (digest(bytes) !== artifact.sha256) throw new ContractError('source_sha_mismatch'); return bytes;
  }
  private async sourceIssues(paper: PaperRow, source?: SourceSnapshot) {
    const issues: string[] = [];
    try { await this.readPinned(paper.pdf); } catch (e) { issues.push('pdf_' + (e instanceof ContractError ? e.code : 'unavailable')); }
    if (source) {
      try { await this.readPinned(source.ir); } catch (e) { issues.push('ir_' + (e instanceof ContractError ? e.code : 'unavailable')); }
      if (source.document.document_id !== paper.id || source.document.file_sha256 !== paper.pdf.sha256) issues.push('source_document_binding_mismatch');
      if (source.catalog && (source.catalog.document_id !== paper.id || source.catalog.file_sha256 !== paper.pdf.sha256 || source.catalog.text_version !== source.document.text_version)) issues.push('figure_source_binding_mismatch');
    }
    return issues;
  }
  private async requireSource(paper: PaperRow, source?: SourceSnapshot) { const issues = await this.sourceIssues(paper, source); if (issues.length) throw new ContractError('source_integrity_blocked:' + issues.join(',')); }
  async upload(bytes: Buffer, filename: string, title?: string) {
    await this.initialize();
    if (!filename || filename.length > 240 || /[\x00-\x1f/\\]/u.test(filename) || !/\.pdf$/iu.test(filename)) throw new ContractError('invalid_pdf_filename');
    if (!bytes.length || bytes.length > MAX_PDF_BYTES) throw new ContractError('pdf_size_out_of_bounds');
    if (!bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-') || !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from('%%EOF'))) throw new ContractError('invalid_pdf_bytes');
    if (title !== undefined && (title.length > 500 || /[\x00-\x1f]/u.test(title))) throw new ContractError('invalid_paper_title');
    const id = 'paper-' + randomUUID(), hash = digest(bytes), path = resolve(this.directory, 'pdf', hash + '.pdf');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || digest(await readFile(path)) !== hash) throw error; }
    const row: PaperRow = { id, title: title?.trim() || filename, filename, pdf: { path: relative(this.codeRoot, path), sha256: hash }, uploaded: true,
      language: 'und', pages: 0, note: 'Uploaded PDF; parsing and medical content remain unverified.' };
    this.savePaper(row); return { paper: this.summary(row) };
  }
  async restorePdf(id: string, bytes: Buffer) {
    await this.initialize(); const paper = this.paper(id);
    if (bytes.length > MAX_PDF_BYTES || digest(bytes) !== paper.pdf.sha256) throw new ContractError('restore_requires_identical_pdf');
    const path = resolve(this.codeRoot, paper.pdf.path), rel = relative(this.codeRoot, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('source_file_outside_code');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 });
    return { restored: true, sha256: paper.pdf.sha256 };
  }
  private units(document: ExtractionDocument): WorkbenchSourceUnit[] {
    const key = `${document.document_id}:${document.file_sha256}:${document.text_version}`;
    let units = this.sourceUnitCache.get(key);
    if (!units) { units = buildSourceEvidenceUnits(document).map(unit => ({ ...unit, text: unit.segments.map(s => s.exact_quote).join('\n') })); this.sourceUnitCache.set(key, units); }
    return units;
  }
  private annotation(runId: string, version: EvidenceVersion): Annotation {
    const row = this.store.db.prepare('SELECT payload_json FROM workbench_annotations WHERE run_id=? AND record_id=? AND version=?').get(runId, version.record.record_id, version.version);
    return row ? JSON.parse(row.payload_json as string) : { labels: {}, deleted: false, reviewer: '', reason: '' };
  }
  private review(runId: string, version: EvidenceVersion): DeliveryReview | undefined {
    const row = this.store.db.prepare('SELECT payload_json FROM workbench_reviews WHERE run_id=? AND record_id=? AND version=?').get(runId, version.record.record_id, version.version);
    return row ? JSON.parse(row.payload_json as string) : undefined;
  }
  private visibleVersions(id: string) { return this.store.current(id).filter(v => !this.annotation(id, v).deleted); }
  private async availableCatalog(source: SourceSnapshot) {
    if (!source.catalog) return undefined;
    const catalog = structuredClone(source.catalog);
    if (source.catalog_artifact) {
      try { await this.readPinned(source.catalog_artifact); }
      catch { for (const f of catalog.figures) { f.regions = []; f.verification.status = 'needs_review'; f.verification.notes += ' Figure catalog source unavailable or changed.'; } return catalog; }
    }
    for (const figure of catalog.figures) {
      const kept = [];
      for (const asset of figure.regions) { try { await this.readPinned(asset); kept.push(asset); } catch { /* text remains available */ } }
      if (kept.length !== figure.regions.length) { figure.regions = kept; figure.verification.status = 'needs_review'; figure.verification.notes += ' One or more original Figure assets unavailable or changed.'; }
    }
    return catalog;
  }
  private async output(row: RunRow): Promise<WorkbenchOutput> {
    const raw = this.store.db.prepare('SELECT input_json,state FROM s4_runs WHERE id=?').get(row.id)!;
    const snapshot = { input: JSON.parse(raw.input_json as string) as RunInput, state: raw.state as string }, source = row.source;
    if (!source) return { id: row.id, strategy: row.strategy ?? 'B0', state: snapshot.state, origin: row.origin, records: [], fixture: row.controlled,
      full_recall_claimed: false, medical_quality_approved: false, scope: snapshot.input.scope, error: row.error };
    const catalog = await this.availableCatalog(source), seq = Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM s4_events WHERE run_id=?').get(row.id)!.seq);
    const cacheKey = `${seq}:${source.ir.sha256}:${evidenceDigest(catalog)}`;
    const cached = this.outputCache.get(row.id); if (cached?.key === cacheKey) return cached.value;
    const versions = this.visibleVersions(row.id), delivery = buildEvidenceDelivery(source.document, versions, catalog), units = this.units(source.document);
    const records: WorkbenchRecord[] = allDeliveredRecords(delivery).map(value => {
      const version = versions.find(v => v.record.record_id === value.record_id)!, annotation = this.annotation(row.id, version), review = this.review(row.id, version);
      const textApproved = Boolean(review?.decision === 'approved' && review.record_version === value.record_version && review.text_fingerprint === value.text_fingerprint);
      const figuresApproved = textApproved && review?.review_scope === 'text_and_figures' && review.delivery_fingerprint === value.delivery_fingerprint;
      const unitIds = (fragments: typeof value.original_fragments) => units.filter(u => u.segments.every(s => fragments.some(f => f.block_id === s.block_id && f.start <= s.start && f.end >= s.end))).map(u => u.unit_id);
      return { id: value.record_id, version: value.record_version, run_id: row.id, actor: version.actor, fragments: value.original_fragments, context: value.context_fragments,
        association: value.figure_association.status, figure_ids: value.figure_association.figure_ids, proposed_figure_ids: value.figure_association.proposed_figure_ids,
        reasons: value.figure_association.reasons, review_status: review?.decision === 'rejected' ? 'rejected' : textApproved ? figuresApproved ? 'approved_text_and_figures' : 'approved_text_only' : 'pending',
        text_fingerprint: value.text_fingerprint, delivery_fingerprint: value.delivery_fingerprint, labels: annotation.labels,
        text_approved: textApproved, figures_approved: figuresApproved, review_reason: review?.reason ?? '', source_unit_ids: unitIds(value.original_fragments), context_unit_ids: unitIds(value.context_fragments),
        evidence_role: annotation.labels.evidence_role ?? value.primary_assessment?.effective_role ?? 'primary_candidate', model_primary_assessment: value.primary_assessment?.value ?? null };
    });
    const value: WorkbenchOutput = { id: row.id, strategy: row.strategy ?? 'B0', state: snapshot.state, origin: row.origin, records, fixture: row.controlled, scope: snapshot.input.scope,
      ...(row.summary ? { summary: row.summary, summary_is_diagnostic: true as const } : {}),
      full_recall_claimed: false, medical_quality_approved: false, coverage: row.coverage, same_source_review_index: buildSameSourceReviewIndex(versions), ...(row.error ? { error: row.error } : {}) };
    this.outputCache.set(row.id, { key: cacheKey, value }); return value;
  }
  async detail(id: string): Promise<WorkbenchPaperDetail> {
    await this.initialize(); const paper = this.paper(id), source = paper.latest_source, issues = await this.sourceIssues(paper, source);
    const catalog = source ? await this.availableCatalog(source) : undefined;
    return { paper: this.summary(paper), text_version: source?.document.text_version ?? '', pdf_url: `/api/t1/workbench/papers/${id}/pdf`, source_verified: issues.length === 0,
      source_status: issues.length ? issues.some(i => i.includes('missing')) ? 'missing' : 'mismatch' : source ? 'valid' : 'not_parsed', source_issues: issues,
      read_only: false, source_units: source ? this.units(source.document) : [],
      figures: (catalog?.figures ?? []).map(f => ({ id: f.figure_id, number: f.figure_number, verification: f.verification.status, caption: f.caption_segments, human_approved: false,
        assets: f.regions.map(a => ({ id: a.asset_id, url: `/api/t1/workbench/papers/${id}/figures/${a.asset_id}`, sha256: a.sha256, page: a.physical_page, width: a.width_px, height: a.height_px })) })),
      outputs: await Promise.all(this.runRows().filter(r => r.paper_id === id).map(r => this.output(r))) };
  }
  async runDetail(id: string) { await this.initialize(); const row = this.run(id), paper = this.paper(row.paper_id), source = row.source, issues = await this.sourceIssues(paper, source), catalog = source ? await this.availableCatalog(source) : undefined;
    return { run: (await this.runs(id))[0]!, output: await this.output(row), source_units: source ? this.units(source.document) : [], source_issues: issues,
      figures: (catalog?.figures ?? []).map(f => ({ id: f.figure_id, number: f.figure_number, verification: f.verification.status, caption: f.caption_segments, human_approved: false as const,
        assets: f.regions.map(a => ({ id: a.asset_id, url: `/api/t1/workbench/runs/${encodeURIComponent(id)}/figures/${a.asset_id}`, sha256: a.sha256, page: a.physical_page, width: a.width_px, height: a.height_px })) })),
      figure_catalog_sha256: source?.catalog_artifact?.sha256 ?? null,
      source_status: issues.length ? issues.some(i => i.includes('missing')) ? 'missing' : 'mismatch' : source ? 'valid' : 'not_parsed', paper: this.summary(paper), pdf_url: `/api/t1/workbench/papers/${paper.id}/pdf`, text_version: source?.document.text_version ?? '' }; }
  async pdf(id: string) { await this.initialize(); return this.readPinned(this.paper(id).pdf); }
  async figure(id: string, assetId: string) { await this.initialize(); this.paper(id);
    const sources = this.runRows().filter(r => r.paper_id === id).map(r => r.source).concat(this.paper(id).latest_source).filter((s): s is SourceSnapshot => Boolean(s));
    const asset = sources.flatMap(s => s.catalog?.figures.flatMap(f => f.regions) ?? []).find(a => a.asset_id === assetId);
    if (!asset) throw new ContractError('workbench_figure_not_found'); return this.readPinned(asset); }
  async runFigure(id: string, assetId: string) { await this.initialize(); const row = this.run(id);
    const asset = row.source?.catalog?.figures.flatMap(f => f.regions).find(a => a.asset_id === assetId);
    if (!asset) throw new ContractError('workbench_figure_not_found'); return this.readPinned(asset); }
  async verifyFigure(id: string, figureId: string, body: WorkbenchFigureCheckInput) {
    await this.initialize();
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['expected_catalog_sha256', 'reviewer', 'all_panels_included', 'caption_figure_identity_checked', 'notes'].includes(k))) throw new ContractError('invalid_figure_check');
    this.person(body.reviewer);
    if (body.all_panels_included !== true || body.caption_figure_identity_checked !== true || typeof body.notes !== 'string' || !body.notes.trim() || body.notes.length > 4000) throw new ContractError('explicit_whole_figure_checks_required');
    const row = this.run(id), source = row.source;
    if (!source?.catalog || !source.catalog_artifact) throw new ContractError('figure_catalog_required');
    if (body.expected_catalog_sha256 !== source.catalog_artifact.sha256) throw new WorkflowCatalogConflict(source.catalog_artifact.sha256);
    await this.requireSource(this.paper(row.paper_id), source); await this.readPinned(source.catalog_artifact);
    const figure = source.catalog.figures.find(f => f.figure_id === figureId);
    if (!figure || !figure.regions.length) throw new ContractError('workbench_figure_not_found');
    for (const asset of figure.regions) await this.readPinned(asset);
    const catalog = confirmWholeFigure(source.document, source.catalog, evidenceDigest(source.catalog), figureId, { actor: body.reviewer, checked_at: now(),
      all_panels_included: true, caption_figure_identity_checked: true, notes: body.notes });
    const directory = resolve(this.directory, 'figure-reviews', createHash('sha256').update(id).digest('hex')); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, randomUUID() + '.json'), bytes = Buffer.from(JSON.stringify(catalog) + '\n');
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    const next: Artifact = { path: relative(this.codeRoot, path), sha256: digest(bytes) };
    this.store.atomic(() => {
      const current = this.run(id);
      if (current.source?.catalog_artifact?.sha256 !== body.expected_catalog_sha256) throw new WorkflowCatalogConflict(current.source?.catalog_artifact?.sha256 ?? null);
      const previous = current.source.catalog_artifact;
      current.source = { ...current.source, catalog, catalog_artifact: next, figure_history: [...(current.source.figure_history ?? []), previous] };
      this.saveRun(current); this.store.event(id, 'figure_source_check', { figure_id: figureId, reviewer: body.reviewer, previous_catalog_sha256: previous.sha256,
        catalog_sha256: next.sha256, human_record_approval_added: false, explicit_record_figure_review_still_required: true });
    });
    return { verified: true, figure_id: figureId, verification: 'whole_figure_checked', figure_catalog_sha256: next.sha256,
      record_approval_added: false, run_detail: await this.runDetail(id) };
  }
  events(id: string, after = 0): WorkbenchEvent[] { this.run(id); return (this.store.events(id) as WorkbenchEvent[]).filter(e => e.seq > after); }
  async start(id: string, scope: Scope) {
    await this.initialize(); if (this.shuttingDown) throw new ContractError('server_shutting_down');
    const admittedAt = now();
    assertSchema(ScopeSchema, scope);
    const scopeErrors = evidenceScopeIssues(scope, this.catalog);
    if (scopeErrors.length) throw new ContractError(scopeErrors.join(','));
    const paper = this.paper(id); await this.requireSource(paper, paper.latest_source);
    const runner = this.options.runner; if (!runner) throw new ContractError('server_model_not_enabled');
    if (runner.available?.() === false) throw new ContractError('run_start_allowance_closed');
    const runId = 'run-' + randomUUID(), directory = resolve(this.directory, 'runs', runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const input: RunInput = { schema_version: '1', run_id: runId, document_id: id, file_sha256: paper.pdf.sha256, fixture: false, scope: structuredClone(scope),
      rule_version: 'visual-statements-2', runtime_profile: { provider: runner.provider, model_id: runner.model_id, endpoint: '', pi_version: '1.4.0', version: 's5-workbench-1' } };
    await runner.prepare?.(input, directory);
    const row: RunRow = { id: runId, paper_id: id, created_at: admittedAt, origin: runner.controlled ? 'controlled_fixture' : 'workbench_run', controlled: runner.controlled, directory, strategy: 'B0' };
    this.store.atomic(() => { this.store.create(input, { fixed_method: 'B0', controlled_fixture: runner.controlled }); this.saveRun(row); });
    const controller = new AbortController();
    const promise = this.schedule(runId, controller, () => this.execute(row, input, controller));
    this.active.set(runId, { controller, promise }); void promise.finally(() => this.active.delete(runId));
    return { run: (await this.runs(runId))[0]! };
  }
  private schedule(id: string, controller: AbortController, run: () => Promise<void>) {
    const promise = new Promise<void>((resolve, reject) => {
      const entry = { id, controller, run, resolve, reject }; this.queue.push(entry);
      controller.signal.addEventListener('abort', () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) { this.queue.splice(index, 1); resolve(); }
      }, { once: true });
    });
    if (this.executing >= this.maxConcurrentRuns) this.store.event(id, 'queue_wait', { max_concurrent_runs: this.maxConcurrentRuns });
    this.drainQueue(); return promise;
  }
  private drainQueue() {
    while (this.executing < this.maxConcurrentRuns && this.queue.length) {
      const entry = this.queue.shift()!;
      if (entry.controller.signal.aborted) { entry.resolve(); continue; }
      this.executing++;
      void entry.run().then(entry.resolve, entry.reject).finally(() => { this.executing--; this.drainQueue(); });
    }
  }
  private async execute(row: RunRow, input: RunInput, controller: AbortController) {
    const signal = controller.signal, executionStarted = Date.now(); let timedOut = false;
    row.execution_started_at = new Date(executionStarted).toISOString(); row.queue_wait_ms = Math.max(0, executionStarted - Date.parse(row.created_at));
    row.runtime_deadline = new Date(executionStarted + (this.options.runTimeoutMs ?? 1800_000)).toISOString();
    const timer = setTimeout(() => {
      if (!terminals.has(this.store.snapshot(row.id).state)) {
        timedOut = true; this.store.transition(row.id, this.store.current(row.id).length ? 'partial' : 'failed');
        this.store.event(row.id, 'run_deadline', { reason: 'document_time_limit', scope: 'execution_slot_including_parse_model_summary', queue_wait_excluded: true, saved_candidates_preserved: true, automatic_resume: false });
        controller.abort();
      }
    }, this.options.runTimeoutMs ?? 1800_000); timer.unref();
    try {
      this.saveRun(row); this.store.event(row.id, 'execution_slot_acquired', { execution_started_at: row.execution_started_at, queue_wait_ms: row.queue_wait_ms, runtime_deadline: row.runtime_deadline, max_concurrent_runs: this.maxConcurrentRuns });
      this.store.transition(row.id, 'parsing'); const paper = this.paper(row.paper_id);
      await this.requireSource(paper, paper.latest_source);
      const document = await (this.options.parse ? this.options.parse(input, paper.pdf.path, row.directory, signal) : createConfiguredPdfParserAdapter({ logDirectory: row.directory }).parse({ run_id: row.id, document_id: row.paper_id, file_reference: paper.pdf.path, file_sha256: paper.pdf.sha256, fixture: false }, signal));
      if (signal.aborted) throw new ContractError('run_cancelled'); assertParsedDocument(document);
      if (document.fixture || document.document_id !== row.paper_id || document.file_sha256 !== paper.pdf.sha256 || document.source.file_reference !== paper.pdf.path) throw new ContractError('parsed_source_binding_mismatch');
      await this.requireSource(paper); await assertLivePdfSource(document);
      const irPath = resolve(row.directory, 'document-ir.json'), irBytes = Buffer.from(JSON.stringify(document) + '\n');
      await writeFile(irPath, irBytes, { flag: 'wx', mode: 0o600 });
      const source: SourceSnapshot = { document, ir: { path: relative(this.codeRoot, irPath), sha256: digest(irBytes) } };
      try {
        source.catalog = await (this.options.discover ?? discoverPdfFigures)(document, row.directory, signal);
        assertFigureCatalog(document, source.catalog);
        const catalogPath = resolve(row.directory, 'figure-catalog.json'), bytes = Buffer.from(JSON.stringify(source.catalog) + '\n');
        await writeFile(catalogPath, bytes, { flag: 'wx', mode: 0o600 }); source.catalog_artifact = { path: relative(this.codeRoot, catalogPath), sha256: digest(bytes) };
      } catch (error) { if (signal.aborted) throw new ContractError('run_cancelled'); await this.requireSource(paper, source);
        this.store.event(row.id, 'figure_discovery_pending', { text_can_continue: true, error: error instanceof ContractError ? error.code : 'figure_discovery_failed' }); }
      row.source = source; paper.latest_source = source; paper.pages = document.pages.length;
      this.store.atomic(() => { this.saveRun(row); this.savePaper(paper); this.store.event(row.id, 'source_saved', { text_version: document.text_version, physical_pages: document.pages.length, parser_id: document.parser.id, controlled_fixture: row.controlled }); });
      const metadata: EvidenceValidationContext['metadata'] = { task_id: row.id, article_family_id: paper.id, created_at: row.created_at,
        source_version: { file_sha256: paper.pdf.sha256, source_kind: paper.uploaded ? 'user_uploaded_pdf' : 'retained_public_pdf', version: paper.pdf.sha256, obtained_at: row.created_at },
        bibliographic_identity: { title: paper.title, authors: [], venue: null, year: null, doi: null, pmid: null, identity_status: 'user_title_unverified' }, document_access: 'full_text' };
      const result = await this.options.runner!.execute({ input, document, catalog: source.catalog, directory: row.directory, signal, store: this.store, metadata, execution_started_at: row.execution_started_at });
      row.coverage = result.coverage; row.summary = result.summary; this.saveRun(row); this.store.event(row.id, 'run_result_saved', { coverage_saved: true, controlled_fixture: row.controlled });
      if (!terminals.has(this.store.snapshot(row.id).state)) throw new ContractError('runner_finished_without_terminal_state');
    } catch (error) {
      const current = this.store.snapshot(row.id).state;
      const code = timedOut ? 'document_time_limit' : error instanceof ContractError ? error.code : 'workflow_execution_failed';
      row.error = code; this.saveRun(row);
      if (!terminals.has(current)) this.store.transition(row.id, signal.aborted ? this.shuttingDown ? 'interrupted' : 'cancelled' : this.store.current(row.id).length ? 'partial' : 'failed');
      this.store.event(row.id, 'workflow_error', { error: code, saved_candidates_preserved: true, automatic_resume: false, controlled_fixture: row.controlled });
    } finally { clearTimeout(timer); }
  }
  async cancel(id: string) { await this.initialize(); this.run(id); const task = this.active.get(id), state = this.store.snapshot(id).state;
    if (!terminals.has(state)) { this.store.transition(id, 'cancelled'); task?.controller.abort(); }
    return { run: (await this.runs(id))[0]! }; }
  private current(id: string, recordId: string, expected?: number): StoredEvidenceVersion {
    this.run(id); const value = this.store.current(id).find(v => v.record.record_id === recordId);
    if (!value || this.annotation(id, value).deleted) throw new ContractError('workbench_record_not_found');
    if (!Number.isSafeInteger(expected) || expected !== value.version) throw new WorkflowConflict(value.version); return value;
  }
  private person(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new ContractError('reviewer_required'); }
  private labels(value: WorkbenchLabels | undefined): WorkbenchLabels {
    if (value === undefined) return {}; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('invalid_record_labels');
    const allowed = new Set(['feature_category', 'evidence_type', 'tags', 'comment', 'evidence_role']);
    if (Object.keys(value).some(k => !allowed.has(k)) || value.feature_category !== undefined && (typeof value.feature_category !== 'string' || !value.feature_category.trim() || value.feature_category.length > 160) ||
      value.comment !== undefined && (typeof value.comment !== 'string' || value.comment.length > 4000) || value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 20 || value.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 80)) ||
      value.evidence_type !== undefined && !['feature_mention', 'definition', 'imaging_observation', 'interpretive_condition', 'association_conclusion'].includes(value.evidence_type) ||
      value.evidence_role !== undefined && !['primary_candidate', 'background_suggestion'].includes(value.evidence_role)) throw new ContractError('invalid_record_labels');
    return structuredClone(value);
  }
  private annotationWrite(id: string, version: EvidenceVersion, annotation: Annotation) { this.store.db.prepare('INSERT INTO workbench_annotations VALUES(?,?,?,?)').run(id, version.record.record_id, version.version, JSON.stringify(annotation)); }
  private assertRevisionInput(body: WorkbenchRevisionInput) {
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['expected_version', 'source_unit_ids', 'context_unit_ids', 'labels', 'reviewer', 'reason'].includes(k))) throw new ContractError('source_reselection_only_no_free_text');
    this.person(body.reviewer); if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 4000)) throw new ContractError('invalid_review_reason');
  }
  private selectedFragments(source: SourceSnapshot, ids: string[], allowEmpty: boolean) {
    if (!Array.isArray(ids) || !allowEmpty && !ids.length || ids.length > 64 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new ContractError('invalid_source_unit_selection');
    const units = buildSourceEvidenceUnits(source.document), allowed = new Set(taskSourceBlockIds(source.document, buildArticleScope(source.document)));
    const selected = ids.map(id => { const unit = units.find(u => u.unit_id === id); if (!unit || unit.segments.some(s => !allowed.has(s.block_id))) throw new ContractError('source_unit_not_available_for_extraction'); return unit; });
    return selected.flatMap(u => u.segments).sort((a, b) => source.document.blocks.find(x => x.block_id === a.block_id)!.reading_order - source.document.blocks.find(x => x.block_id === b.block_id)!.reading_order || a.start - b.start)
      .filter((s, i, all) => all.findIndex(f => f.block_id === s.block_id && f.start === s.start && f.end === s.end) === i);
  }
  private buildManual(row: RunRow, body: WorkbenchRevisionInput, old?: StoredEvidenceVersion) {
    const source = row.source; if (!source) throw new ContractError('parsed_source_required');
    const input = this.store.snapshot(row.id).input, record = old?.record;
    const main = body.source_unit_ids ? this.selectedFragments(source, body.source_unit_ids, false) : record?.quote_span.segments;
    if (!main?.length) throw new ContractError('source_units_required_for_manual_record');
    const context = body.context_unit_ids ? this.selectedFragments(source, body.context_unit_ids, true) : body.source_unit_ids ? [] : record?.context.fragments ?? [];
    const labels = this.labels(body.labels), raw = (fragments: typeof main) => fragments.map(f => ({ block_id: f.block_id, exact_quote: f.exact_quote, occurrence: f.occurrence }));
    const unknown = { value: null, status: 'unknown' as const, evidence: [] };
    const metadata: EvidenceValidationContext['metadata'] = { task_id: record?.extraction_trace.task_id ?? row.id,
      source_version: record?.source_version ?? { file_sha256: input.file_sha256, source_kind: 'user_uploaded_pdf', version: input.file_sha256, obtained_at: row.created_at },
      article_family_id: record?.article_family_id ?? row.paper_id, bibliographic_identity: record?.bibliographic_identity, document_access: 'full_text', created_at: now() };
    const submission: EvidenceSubmission = { binding: { task_id: metadata.task_id, run_id: row.id, document_id: row.paper_id, file_sha256: input.file_sha256,
      source_version: metadata.source_version.version, text_version: source.document.text_version }, source_fragments: raw(main), context_fragments: raw(context), display_joiner: '\n',
      feature_binding_id: null, feature_name_raw: null, feature_category: labels.feature_category ?? record?.feature_category ?? 'unclassified',
      evidence_type: labels.evidence_type ?? record?.evidence_type ?? 'imaging_observation', disease_or_lesion: unknown, modality: unknown, sequence_or_phase: null,
      assertion: { value: 'unknown', original_wording: '', evidence: [] }, applicability: { status: 'unknown', original_wording: '', evidence: [] }, numeric_expressions: [],
      provenance: { origin: 'unclear', cited_references: [], evidence: [] }, translation_zh: null };
    const blocks = taskSourceBlockIds(source.document, buildArticleScope(source.document));
    const validated = validateEvidenceSubmission(submission, { input, document: source.document, catalog: this.catalog, metadata, toolCallId: 'human-' + randomUUID(),
      allowedBlockIds: blocks, readBlockIds: blocks, evidencePolicyVersion: 'visual-statements-2', primaryAssessmentPolicyVersion: 'model-primary-assessment-1' });
    if (!validated.accepted || !validated.record) throw new ContractError('manual_source_validation_failed:' + validated.issues.map(i => i.code).join(','));
    validated.record.record_id = record?.record_id ?? 'manual-' + randomUUID(); return validated.record;
  }
  async revise(id: string, recordId: string | undefined, body: WorkbenchRevisionInput) {
    await this.initialize(); this.assertRevisionInput(body); const row = this.run(id), old = recordId ? this.current(id, recordId, body.expected_version) : undefined;
    if (!old && body.expected_version !== undefined) throw new ContractError('manual_add_does_not_take_expected_version');
    if (!row.source) throw new ContractError('parsed_source_required'); await this.requireSource(this.paper(row.paper_id), row.source);
    const labels = this.labels(body.labels), previous = old ? this.annotation(id, old) : { labels: {}, deleted: false, reviewer: '', reason: '' };
    const record = body.source_unit_ids || body.context_unit_ids || !old ? this.buildManual(row, body, old) : structuredClone(old.record);
    if (labels.feature_category) record.feature_category = labels.feature_category; if (labels.evidence_type) record.evidence_type = labels.evidence_type;
    record.review_status = 'pending'; record.review_events = []; record.handoff_status = 'candidate_only';
    this.store.atomic(() => { const value = this.store.humanVersion(id, record, old?.version ?? null, body.reason ?? 'human_revision');
      this.annotationWrite(id, value, { labels: { ...previous.labels, ...labels }, deleted: false, reviewer: body.reviewer, reason: body.reason ?? '' }); });
    return { record: (await this.output(row)).records.find(r => r.id === record.record_id)! };
  }
  async reviewRecord(id: string, recordId: string, body: WorkbenchReviewInput) {
    await this.initialize(); if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['expected_version', 'action', 'reviewer', 'reason', 'source_text_checked', 'relevance_checked', 'context_checked', 'figure_pairing_checked'].includes(k))) throw new ContractError('invalid_review_input');
    this.person(body.reviewer); if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 4000)) throw new ContractError('invalid_review_reason');
    if (!['approve_text', 'approve_figures', 'reject', 'pending'].includes(body.action)) throw new ContractError('invalid_review_action');
    const row = this.run(id), old = this.current(id, recordId, body.expected_version); if (!row.source) throw new ContractError('parsed_source_required');
    await this.requireSource(this.paper(row.paper_id), row.source);
    const oldReview = this.review(id, old), availableCatalog = await this.availableCatalog(row.source);
    const oldDelivery = allDeliveredRecords(buildEvidenceDelivery(row.source.document, [old], availableCatalog))[0]!;
    if (body.action === 'approve_text' && (body.source_text_checked !== true || body.relevance_checked !== true || body.context_checked !== true)) throw new ContractError('explicit_text_checks_required');
    if (body.action === 'approve_figures' && (oldReview?.decision !== 'approved' || oldReview.text_fingerprint !== oldDelivery.text_fingerprint || body.figure_pairing_checked !== true || oldDelivery.figure_association.status !== 'paired' || !oldDelivery.figure_association.figure_ids.length)) throw new ContractError('current_text_and_explicit_figure_checks_required');
    const record = structuredClone(old.record); record.review_events = []; record.handoff_status = 'candidate_only'; record.review_status = body.action === 'reject' ? 'rejected' : body.action === 'pending' ? 'pending' : 'approved';
    this.store.atomic(() => {
      const value = this.store.humanVersion(id, record, old.version, body.reason ?? body.action), annotation = this.annotation(id, old); this.annotationWrite(id, value, { ...annotation, reviewer: body.reviewer });
      const delivered = allDeliveredRecords(buildEvidenceDelivery(row.source!.document, [value], availableCatalog))[0]!;
      const approved = body.action === 'approve_text' || body.action === 'approve_figures', figures = body.action === 'approve_figures';
      const review: DeliveryReview = { record_id: recordId, record_version: value.version, review_scope: figures ? 'text_and_figures' : 'text_only',
        text_fingerprint: delivered.text_fingerprint, delivery_fingerprint: figures ? delivered.delivery_fingerprint : null, decision: approved ? 'approved' : body.action === 'reject' ? 'rejected' : 'needs_context',
        actor: body.reviewer, reviewed_at: now(), source_text_checked: approved, relevance_checked: approved, context_checked: approved, figure_pairing_checked: figures, reason: body.reason ?? '' };
      this.store.db.prepare('INSERT INTO workbench_reviews VALUES(?,?,?,?)').run(id, recordId, value.version, JSON.stringify(review));
      this.store.event(id, 'human_review', { record_id: recordId, record_version: value.version, action: body.action, reviewer: body.reviewer, text_approved: approved, figures_approved: figures });
    });
    return { record: (await this.output(row)).records.find(r => r.id === recordId)! };
  }
  async deleteRecord(id: string, recordId: string, body: WorkbenchRevisionInput) {
    await this.initialize(); this.assertRevisionInput(body); const old = this.current(id, recordId, body.expected_version), record = structuredClone(old.record);
    record.review_status = 'rejected'; record.review_events = []; record.handoff_status = 'candidate_only';
    this.store.atomic(() => { const next = this.store.humanVersion(id, record, old.version, body.reason ?? 'human_delete');
      this.annotationWrite(id, next, { ...this.annotation(id, old), deleted: true, reviewer: body.reviewer, reason: body.reason ?? '' }); });
    return { deleted: true, record_id: recordId };
  }
  async export(id: string, kind: WorkbenchExportKind) {
    await this.initialize(); if (!['candidate_jsonl', 'candidate_csv', 'approved_jsonl', 'approved_csv', 'candidate_package', 'approved_package'].includes(kind)) throw new ContractError('export_kind_not_found');
    const row = this.run(id); if (!row.source) throw new ContractError('parsed_source_required');
    const source = row.source, approved = kind.startsWith('approved'), catalog = await this.availableCatalog(source), paper = this.paper(row.paper_id);
    if (approved) await this.requireSource(paper, source);
    const versions = this.visibleVersions(id), reviews: DeliveryReview[] = [];
    const currentDelivery = allDeliveredRecords(buildEvidenceDelivery(source.document, versions, catalog));
    const selected = approved ? versions.filter(v => { const review = this.review(id, v), delivered = currentDelivery.find(r => r.record_id === v.record.record_id);
      if (review?.decision !== 'approved' || !delivered || review.text_fingerprint !== delivered.text_fingerprint) return false;
      // A missing/changed image invalidates the image confirmation; the unchanged text confirmation remains usable.
      reviews.push(review.review_scope === 'text_and_figures' && review.delivery_fingerprint !== delivered.delivery_fingerprint ? {
        ...review, review_scope: 'text_only', delivery_fingerprint: null, figure_pairing_checked: false,
        reason: review.reason + '\nFigure assets/pairing changed or became unavailable; prior text confirmation only.' } : review); return true; }) : versions;
    if (approved && !selected.length) throw new ContractError('no_current_approved_records');
    const exportId = 'export-' + randomUUID(), parent = resolve(this.directory, 'exports'); await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = resolve(parent, exportId);
    // Historical candidate inspection remains possible without a live PDF. Candidate packages retain the same source guard as the core exporter.
    const issues = await this.sourceIssues(paper, source);
    if (issues.length && !approved && !kind.endsWith('package')) {
      const output = await this.output(row), text = kind.endsWith('jsonl') ? output.records.map(r => JSON.stringify({ ...r, historical_source_issues: issues })).join('\n') + '\n' : this.recordCsv(output.records);
      this.store.event(id, 'historical_candidate_export', { export_id: exportId, source_issues: issues, approved: false });
      return { bytes: Buffer.from(text), filename: id + '-' + kind + (kind.endsWith('jsonl') ? '.jsonl' : '.csv'), type: kind.endsWith('jsonl') ? 'application/x-ndjson' : 'text/csv; charset=utf-8' };
    }
    const humanRoles = selected.flatMap(v => { const annotation = this.annotation(id, v); return annotation.labels.evidence_role ? [{ record_id: v.record.record_id,
      record_version: v.version, role: annotation.labels.evidence_role, actor: annotation.reviewer }] : []; });
    await exportEvidenceDelivery(source.document, selected, { codeRoot: this.codeRoot, directory, catalog, mode: approved ? 'approved' : 'candidates', reviews, humanRoles,
      coverage: { ...(typeof row.coverage === 'object' && row.coverage ? row.coverage : {}), run_id: id, state: this.store.snapshot(id).state,
        controlled_fixture: row.controlled, medical_quality_approved: false, automatic_resume: false } });
    const annotations = selected.map(v => ({ record_id: v.record.record_id, record_version: v.version, ...this.annotation(id, v) }));
    await writeFile(resolve(directory, 'human-annotations.json'), JSON.stringify(annotations, null, 2) + '\n');
    await writeFile(resolve(directory, 'source-record-versions.jsonl'), selected.map(v => JSON.stringify(v)).join('\n') + (selected.length ? '\n' : ''));
    const manifestPath = resolve(directory, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    Object.assign(manifest, { controlled_fixture: row.controlled, origin: row.origin, run_id: id, source_ir_sha256: source.ir.sha256, figure_catalog_sha256: source.catalog_artifact?.sha256 ?? null,
      original_28_field_records: 'source-record-versions.jsonl; human-annotations.json is separate from paper text' });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    this.store.atomic(() => { this.store.db.prepare('INSERT INTO workbench_exports VALUES(?,?,?)').run(exportId, id, JSON.stringify({ kind, created_at: now(), versions: selected.map(v => [v.record.record_id, v.version]), directory: relative(this.codeRoot, directory) }));
      this.store.event(id, 'export_saved', { export_id: exportId, kind, record_count: selected.length, controlled_fixture: row.controlled }); });
    if (kind.endsWith('package')) {
      const archive = directory + '.tar.gz';
      await new Promise<void>((accept, reject) => { const child = spawn('tar', ['-czf', archive, '-C', directory, '.'], { stdio: 'ignore' }); child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new ContractError('archive_failed'))); });
      return { bytes: await readFile(archive), filename: id + '-' + kind + '.tar.gz', type: 'application/gzip' };
    }
    // Keep primary/background records together in single-file downloads; packages keep the established separate files too.
    const delivery = JSON.parse(await readFile(resolve(directory, 'delivery.json'), 'utf8')), records = [...delivery.records, ...(delivery.background_records ?? [])];
    if (kind.endsWith('jsonl')) return { bytes: Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')), filename: id + '-' + kind + '.jsonl', type: 'application/x-ndjson' };
    const csvs = await Promise.all(['records.csv', 'background-records.csv'].map(f => readFile(resolve(directory, f), 'utf8').catch(() => '')));
    return { bytes: Buffer.from(csvs[0]! + (csvs[1] ? csvs[1].split('\n').slice(1).join('\n') : '')), filename: id + '-' + kind + '.csv', type: 'text/csv; charset=utf-8' };
  }
  private recordCsv(records: WorkbenchRecord[]) { const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';
    return '\ufeffrecord_id,record_version,fragment_index,original_fragment,physical_page,block_id,start,end,figure_status\n' + records.flatMap(r => r.fragments.map((f, i) => [r.id, String(r.version), String(i), f.exact_quote, String(f.physical_page), f.block_id, String(f.start), String(f.end), r.association].map(quote).join(','))).join('\n') + '\n'; }
  async deletePaper(id: string) {
    await this.initialize(); const paper = this.paper(id), runs = this.runRows().filter(r => r.paper_id === id);
    if (runs.some(r => !terminals.has(this.store.snapshot(r.id).state))) throw new ContractError('cancel_active_runs_before_deleting_paper');
    const exportDirectories = runs.flatMap(row => this.store.db.prepare('SELECT payload_json FROM workbench_exports WHERE run_id=?').all(row.id)
      .map(value => (JSON.parse(value.payload_json as string) as { directory?: string }).directory).filter((d): d is string => Boolean(d)));
    this.store.atomic(() => {
      for (const row of runs) {
        for (const table of ['workbench_annotations', 'workbench_reviews', 'workbench_exports', 's4_batches', 's4_versions', 's4_events']) this.store.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(row.id);
        this.store.db.prepare('DELETE FROM workbench_runs WHERE id=?').run(row.id); this.store.db.prepare('DELETE FROM s4_runs WHERE id=?').run(row.id);
      }
      this.store.db.prepare('DELETE FROM workbench_papers WHERE id=?').run(id);
      this.store.db.prepare('INSERT INTO workbench_deleted_sources VALUES(?,?) ON CONFLICT(paper_id) DO NOTHING').run(id, now());
    });
    const otherPapers = this.store.db.prepare('SELECT payload_json FROM workbench_papers').all().map(r => JSON.parse(r.payload_json as string) as PaperRow);
    const pdfReferenced = otherPapers.some(p => p.pdf.path === paper.pdf.path);
    // Immutable retained evidence is never deleted. Uploaded content-addressed PDFs are removed only after their last reference.
    if (paper.uploaded && !pdfReferenced) await rm(resolve(this.codeRoot, paper.pdf.path), { force: true });
    const stillReferenced = JSON.stringify({ papers: otherPapers, runs: this.runRows() });
    for (const row of runs) if (row.directory && !stillReferenced.includes(row.directory) && !stillReferenced.includes(relative(this.codeRoot, row.directory))) await rm(row.directory, { recursive: true, force: true });
    for (const artifact of runs.flatMap(row => [row.source?.catalog_artifact, ...(row.source?.figure_history ?? [])]).filter((a): a is Artifact => Boolean(a))) {
      const path = resolve(this.codeRoot, artifact.path), rel = relative(resolve(this.directory, 'figure-reviews'), path);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel) && !stillReferenced.includes(artifact.path)) await rm(path, { force: true });
    }
    for (const path of exportDirectories) { const target = resolve(this.codeRoot, path), rel = relative(resolve(this.directory, 'exports'), target);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) { await rm(target, { recursive: true, force: true }); await rm(target + '.tar.gz', { force: true }); } }
    for (const row of runs) this.outputCache.delete(row.id);
    for (const key of this.sourceUnitCache.keys()) if (key.startsWith(id + ':')) this.sourceUnitCache.delete(key);
    return { deleted: true, paper_id: id, runs_deleted: runs.length, shared_pdf_retained: pdfReferenced, scope: 'paper_runs_candidates_reviews_and_unshared_uploaded_files' };
  }
  async waitForIdle() { await Promise.all([...this.active.values()].map(t => t.promise)); }
  async close() {
    this.shuttingDown = true;
    for (const [id, task] of this.active) { if (!terminals.has(this.store.snapshot(id).state)) this.store.transition(id, 'interrupted'); task.controller.abort(); }
    await this.waitForIdle();
  }
}
