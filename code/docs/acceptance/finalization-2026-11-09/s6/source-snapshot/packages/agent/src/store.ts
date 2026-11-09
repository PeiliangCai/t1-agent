import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { assertSchema, BusinessEventSchema, ContractError, validateCandidate, type BusinessEvent, type CandidateRecord, type RunInput, type RunState } from '@t1/contracts';

export class RunStore {
  readonly db: DatabaseSync;
  private readonly updates = new EventEmitter();
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,input_json TEXT NOT NULL,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records(run_id TEXT NOT NULL REFERENCES runs(id),id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(run_id,id)); CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL REFERENCES runs(id),seq INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(run_id,seq));');
  }
  create(input: RunInput): void {
    this.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(input.run_id, JSON.stringify(input), 'queued');
    this.event(input.run_id, 'state', 'queued', input.fixture ? 'Engineering fixture queued' : 'Real PDF engineering probe queued; medical extraction unavailable');
  }
  snapshot(runId: string) {
    const row = this.db.prepare('SELECT input_json,state FROM runs WHERE id=?').get(runId);
    if (!row) throw new ContractError('run_not_found');
    const input = JSON.parse(row.input_json as string) as RunInput;
    return { input, state: row.state as RunState, candidate_count: this.records(runId).length, fixture: input.fixture };
  }
  records(runId: string): CandidateRecord[] {
    return this.db.prepare('SELECT record_json FROM records WHERE run_id=? ORDER BY id').all(runId).map(row => JSON.parse(row.record_json as string) as CandidateRecord);
  }
  events(runId: string, after = 0): BusinessEvent[] {
    return this.db.prepare('SELECT event_json FROM events WHERE run_id=? AND seq>? ORDER BY seq').all(runId, after).map(row => JSON.parse(row.event_json as string) as BusinessEvent);
  }
  onEvent(runId: string, callback: (event: BusinessEvent) => void): () => void {
    this.updates.on(runId, callback); return () => this.updates.off(runId, callback);
  }
  private insertEvent(runId: string, type: string, state: RunState, summary: string, recordId?: string): BusinessEvent {
    const row = this.db.prepare('SELECT input_json FROM runs WHERE id=?').get(runId);
    if (!row) throw new ContractError('run_not_found');
    const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE run_id=?').get(runId)!.seq);
    const event: BusinessEvent = { run_id: runId, seq, type, stage: state, summary, timestamp: new Date().toISOString(),
      fixture: (JSON.parse(row.input_json as string) as RunInput).fixture, ...(recordId ? { record_id: recordId, record_version: 1 } : {}) };
    assertSchema(BusinessEventSchema, event);
    this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(runId, seq, JSON.stringify(event));
    return event;
  }
  event(runId: string, type: string, state: RunState, summary: string): BusinessEvent {
    this.db.exec('BEGIN IMMEDIATE');
    let event: BusinessEvent;
    try { event = this.insertEvent(runId, type, state, summary); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.updates.emit(runId, event); return event;
  }
  transition(runId: string, state: RunState): void {
    const previous = this.snapshot(runId).state;
    const allowed: Record<RunState, RunState[]> = { queued: ['parsing', 'extracting', 'cancelled', 'failed', 'interrupted'], parsing: ['extracting', 'partial', 'failed', 'cancelled', 'interrupted'],
      extracting: ['reconciling', 'partial', 'failed', 'cancelled', 'interrupted'], reconciling: ['completed', 'partial', 'failed', 'cancelled', 'interrupted'],
      completed: [], partial: [], failed: [], cancelled: [], interrupted: [] };
    if (!allowed[previous].includes(state)) throw new ContractError('illegal_run_transition');
    this.db.exec('BEGIN IMMEDIATE');
    let event: BusinessEvent;
    try { this.db.prepare('UPDATE runs SET state=? WHERE id=?').run(state, runId); event = this.insertEvent(runId, 'state', state, `${this.snapshot(runId).fixture ? 'Engineering fixture' : 'Real PDF engineering probe'} state: ${state}`); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.updates.emit(runId, event);
  }
  terminateIfRunning(runId: string, state: 'failed' | 'cancelled' = 'failed'): RunState {
    const current = this.snapshot(runId).state;
    if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(current)) return current;
    this.transition(runId, state);
    return state;
  }
  saveCandidate(runId: string, record: CandidateRecord): boolean {
    validateCandidate(record);
    const snapshot = this.snapshot(runId);
    if (snapshot.state !== 'extracting') throw new ContractError('candidate_write_requires_extracting');
    if (record.extraction_trace.run_id !== runId || record.document_id !== snapshot.input.document_id) throw new ContractError('cross_run_candidate');
    this.db.exec('BEGIN IMMEDIATE');
    let event: BusinessEvent | undefined;
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?)').run(runId, record.record_id, JSON.stringify(record));
      if (Number(result.changes)) event = this.insertEvent(runId, 'candidate', snapshot.state, 'Located engineering fixture candidate saved; human review pending', record.record_id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (event) this.updates.emit(runId, event);
    return Boolean(event);
  }
  exportRecords(runId: string, approvedOnly: boolean): CandidateRecord[] {
    if (this.snapshot(runId).fixture) throw new ContractError('engineering_fixture_is_not_exportable_paper_evidence');
    return this.records(runId).filter(r => !approvedOnly || (r.review_status === 'approved' && r.handoff_status === 'approved_for_T2'));
  }
  close(): void { this.updates.removeAllListeners(); this.db.close(); }
}
