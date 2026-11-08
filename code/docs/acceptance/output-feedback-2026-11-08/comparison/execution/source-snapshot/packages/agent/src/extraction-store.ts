import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertSchema, EvidenceRecordSchema, ContractError, type EvidenceRecord, type EvidenceVersion,
  type ReconciliationResult, type RunInput, type RunState } from '@t1/contracts';

export interface StoredEvidenceVersion extends EvidenceVersion { created_at: string; reason: string; }
export class ExtractionStore {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS s4_runs(id TEXT PRIMARY KEY,input_json TEXT NOT NULL,state TEXT NOT NULL,metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS s4_events(run_id TEXT NOT NULL REFERENCES s4_runs(id),seq INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,seq));
      CREATE TABLE IF NOT EXISTS s4_versions(run_id TEXT NOT NULL REFERENCES s4_runs(id),record_id TEXT NOT NULL,version INTEGER NOT NULL,envelope_json TEXT NOT NULL,PRIMARY KEY(run_id,record_id,version));
      CREATE TABLE IF NOT EXISTS s4_batches(run_id TEXT NOT NULL REFERENCES s4_runs(id),batch_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,batch_id));`);
  }
  create(input: RunInput, metadata: unknown) {
    this.db.prepare('INSERT INTO s4_runs VALUES(?,?,?,?)').run(input.run_id, JSON.stringify(input), 'queued', JSON.stringify(metadata));
    this.event(input.run_id, 'state', { state: 'queued', medical_quality_approved: false });
  }
  /** Synchronous nested savepoints let one tool submission commit all writes or none. No model wait holds a transaction. */
  atomic<T>(body: () => T): T {
    const depth = this.transactionDepth++, savepoint = `s4_atomic_${depth}`;
    let started = false;
    try {
      this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`); started = true;
      const result = body();
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      if (started) {
        this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
        if (depth) this.db.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    } finally { this.transactionDepth--; }
  }
  snapshot(runId: string) {
    const row = this.db.prepare('SELECT * FROM s4_runs WHERE id=?').get(runId);
    if (!row) throw new ContractError('s4_run_not_found');
    return { input: JSON.parse(row.input_json as string) as RunInput, state: row.state as RunState,
      metadata: JSON.parse(row.metadata_json as string) as Record<string, unknown>, candidates: this.current(runId), batches: this.batches(runId) };
  }
  private insertEvent(runId: string, type: string, detail: unknown) {
    const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 seq FROM s4_events WHERE run_id=?').get(runId)!.seq);
    const event = { run_id: runId, seq, type, timestamp: new Date().toISOString(), detail };
    this.db.prepare('INSERT INTO s4_events VALUES(?,?,?)').run(runId, seq, JSON.stringify(event)); return event;
  }
  event(runId: string, type: string, detail: unknown) {
    return this.atomic(() => this.insertEvent(runId, type, detail));
  }
  events(runId: string) { return this.db.prepare('SELECT payload_json FROM s4_events WHERE run_id=? ORDER BY seq').all(runId).map(r => JSON.parse(r.payload_json as string)); }
  transition(runId: string, next: RunState) {
    const current = this.snapshot(runId).state;
    const allowed: Record<RunState, RunState[]> = { queued: ['parsing', 'extracting', 'failed', 'cancelled', 'interrupted'],
      parsing: ['extracting', 'partial', 'failed', 'cancelled', 'interrupted'], extracting: ['reconciling', 'partial', 'failed', 'cancelled', 'interrupted'],
      reconciling: ['completed', 'partial', 'failed', 'cancelled', 'interrupted'], completed: [], partial: [], failed: [], cancelled: [], interrupted: [] };
    if (!allowed[current].includes(next)) throw new ContractError('s4_illegal_transition');
    this.atomic(() => { this.db.prepare('UPDATE s4_runs SET state=? WHERE id=?').run(next, runId); this.insertEvent(runId, 'state', { state: next }); });
  }
  versions(runId: string): StoredEvidenceVersion[] {
    return this.db.prepare('SELECT envelope_json FROM s4_versions WHERE run_id=? ORDER BY record_id,version').all(runId).map(r => JSON.parse(r.envelope_json as string));
  }
  current(runId: string): StoredEvidenceVersion[] {
    const records = new Map<string, StoredEvidenceVersion>();
    for (const value of this.versions(runId)) if (value.status !== 'proposed') records.set(value.record.record_id, value);
    return [...records.values()];
  }
  batches(runId: string): Array<Record<string, unknown>> { return this.db.prepare('SELECT payload_json FROM s4_batches WHERE run_id=? ORDER BY batch_id').all(runId).map(r => JSON.parse(r.payload_json as string)); }
  batch(runId: string, batchId: string, detail: Record<string, unknown>) {
    this.atomic(() => { this.db.prepare('INSERT INTO s4_batches VALUES(?,?,?) ON CONFLICT(run_id,batch_id) DO UPDATE SET payload_json=excluded.payload_json')
      .run(runId, batchId, JSON.stringify(detail)); this.insertEvent(runId, 'batch', { batch_id: batchId, ...detail }); });
  }
  private validateBound(runId: string, record: EvidenceRecord) {
    assertSchema(EvidenceRecordSchema, record);
    const run = this.snapshot(runId);
    if (record.extraction_trace.run_id !== runId || record.document_id !== run.input.document_id ||
      record.source_version.file_sha256 !== run.input.file_sha256 || !isDeepStrictEqual(record.extraction_trace.scope, run.input.scope)) throw new ContractError('s4_cross_run_evidence');
    if (record.evidence_validation.medical_semantics_verified || record.handoff_status !== 'candidate_only' ||
      record.review_status === 'approved' || record.review_events.length) throw new ContractError('automatic_path_cannot_approve_evidence');
  }
  private append(runId: string, record: EvidenceRecord, expected: number | null, status: 'active' | 'proposed', reason: string) {
    this.validateBound(runId, record);
    const all = this.versions(runId).filter(v => v.record.record_id === record.record_id);
    const active = all.filter(v => v.status !== 'proposed').at(-1);
    if ((active?.version ?? null) !== expected) throw new ContractError('evidence_version_conflict');
    if (status === 'active' && active?.actor === 'human') throw new ContractError('automatic_update_would_overwrite_human_version');
    const next: StoredEvidenceVersion = { record, version: (all.at(-1)?.version ?? 0) + 1, actor: 'automatic', status, created_at: new Date().toISOString(), reason };
    this.db.prepare('INSERT INTO s4_versions VALUES(?,?,?,?)').run(runId, record.record_id, next.version, JSON.stringify(next));
    this.insertEvent(runId, status === 'proposed' ? 'candidate_proposal' : 'candidate', { record_id: record.record_id, record_version: next.version, review_status: record.review_status, reason });
    return next;
  }
  apply(runId: string, result: ReconciliationResult) {
    if (!['extracting', 'reconciling'].includes(this.snapshot(runId).state)) throw new ContractError('candidate_write_requires_active_extraction');
    if (result.action === 'idempotent') return [];
    return this.atomic(() => {
      const saved: StoredEvidenceVersion[] = [];
      for (const change of result.changes) {
        if (change.kind === 'link') {
          const old = this.current(runId).find(v => v.record.record_id === change.record_id);
          if (!old || !change.related_record_id || !change.relationship) throw new ContractError('invalid_reconciliation_link');
          if (old.record.duplicate_and_conflict_links.some(l => l.record_id === change.related_record_id && l.relationship === change.relationship)) continue;
          const record = structuredClone(old.record);
          record.duplicate_and_conflict_links.push({ record_id: change.related_record_id, relationship: change.relationship });
          if (old.actor === 'human') {
            record.review_status = 'pending'; record.review_events = []; record.handoff_status = 'candidate_only';
          }
          saved.push(this.append(runId, record, change.expected_version, old.actor === 'human' ? 'proposed' : 'active', 'reconciliation_link'));
        } else {
          if (!change.record || change.record.record_id !== change.record_id) throw new ContractError('invalid_reconciliation_record');
          saved.push(this.append(runId, change.record, change.expected_version, change.kind === 'append_proposal' ? 'proposed' : 'active', result.action));
        }
      }
      this.insertEvent(runId, 'reconciliation', { action: result.action, issues: result.issues });
      return saved;
    });
  }
  modelReview(runId: string, id: string, expected: number, modelId: string, issueCodes: string[],
    primaryAssessment?: import('@t1/contracts').PrimaryAssessment) {
    const old = this.current(runId).find(v => v.record.record_id === id);
    if (!old || old.version !== expected) throw new ContractError('evidence_version_conflict');
    const record = structuredClone(old.record);
    if (old.actor === 'human') { record.review_status = 'pending'; record.review_events = []; record.handoff_status = 'candidate_only'; }
    record.evidence_validation.model_semantic_review = { status: 'reviewed_unapproved', model_id: modelId, issue_codes: issueCodes,
      ...(primaryAssessment ? { primary_assessment: primaryAssessment, assessment_policy_version: 'model-primary-assessment-1' as const } : {}) };
    if (issueCodes.length) { record.review_status = 'needs_context'; record.evidence_validation.warnings.push(...issueCodes); }
    return this.atomic(() => this.append(runId, record, expected, old.actor === 'human' ? 'proposed' : 'active', 'model_semantic_review_not_human_approval'));
  }
  close() { this.db.close(); }
}
