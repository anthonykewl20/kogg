import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { injectable, unmanaged } from '@theia/core/shared/inversify';
import {
  OWNER_EVENT_KINDS, OWNER_KINDS, type OperationsProjectionDiagnosticsV1,
  type OperationsProjectionRunV1, type OperationsProjectionSnapshotV1,
  type OperationsTimelineEntryV1, type OwnerEventV1, type OwnerKind, type ProjectionLifecycle,
  type RunLifecycle, type SafeOwnerPayloadV1
} from '../common/operations-read-model-protocol';

// diagnostic-coverage: operations.projection, operations.owners, operations.correlations, operations.timeline, operations.processes, operations.metrics

type Row = Record<string, SQLOutputValue>;
const ZERO_DIGEST = '0'.repeat(64);
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SEQUENCE = /^(0|[1-9][0-9]{0,19})$/u;
const CLOSED_PAYLOAD_KEYS = new Set(['lifecycle', 'safeCode', 'processKind', 'processState', 'cleanupState', 'terminalClass', 'abnormalClass', 'resultClass', 'decisionClass', 'freshness', 'knownState', 'count', 'retryOrdinal', 'durationMs', 'value', 'unit']);
const ABNORMAL_PROCESS_EVENTS = new Set(['process.spawn-failed', 'process.timed-out', 'process.residual', 'process.lost', 'process.quarantined', 'process.inventory-unknown']);
const LIVE_PROCESS_EVENTS = new Set(['process.reserved', 'process.spawning', 'process.started', 'process.ready', 'process.activity', 'process.cancelling', 'process.cleaning']);
const TERMINAL_RUN_EVENTS: Readonly<Record<string, RunLifecycle>> = {
  'run.failed': 'failed', 'run.cancelled': 'failed', 'run.recovered': 'recovered', 'run.completed': 'completed'
};

export class ProjectionFault extends Error {
  constructor(readonly safeCode: string) { super(safeCode); this.name = 'ProjectionFault'; }
}

@injectable()
export class OperationsReadModel implements BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private readonly databasePath: string;

  constructor(@unmanaged() databasePath = path.join(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg-state'), 'operations', 'projection.sqlite3')) {
    this.databasePath = databasePath;
  }

  onStart(): void { this.start(); }
  onStop(): void { this.stop(); }

  start(): void {
    if (this.database) return;
    console.info('[kogg:operations:projection] start.requested');
    try {
      mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      if (process.platform !== 'win32') chmodSync(this.databasePath, 0o600);
      this.migrate();
      this.setLifecycle('verifying');
      console.info('[kogg:operations:projection] verify.started', { schemaVersion: 1 });
      this.assertIntegrity();
      this.setLifecycle('replaying');
      console.info('[kogg:operations:projection] replay.started', { ownerCount: this.ownerCount() });
      this.rebuildDerived(false);
      this.setLifecycle(this.faultCount() ? 'degraded' : 'current');
      if (this.faultCount()) console.warn('[kogg:operations:projection] degraded', { ownerCount: this.ownerCount(), faultCount: this.faultCount() });
      else console.info('[kogg:operations:projection] current', { ownerCount: this.ownerCount(), faultCount: 0 });
    } catch (error) {
      console.error('[kogg:operations:projection] failed', { safeCode: 'PROJECTION_STORE_FAILED', errorType: errorType(error) });
      try { this.setLifecycle('failed'); } catch (lifecycleError) { console.error('[kogg:operations:projection] failed', { safeCode: 'PROJECTION_FAILED_STATE_UNAVAILABLE', errorType: errorType(lifecycleError) }); }
      this.database?.close(); this.database = undefined;
      throw error;
    }
  }

  stop(): void {
    if (!this.database) return;
    this.setLifecycle('stopped');
    this.database.close(); this.database = undefined;
  }

  static digest(event: Omit<OwnerEventV1, 'eventDigest'>): string {
    return createHash('sha256').update(`kogg:operations:owner-event:v1\0${canonical(event)}`, 'utf8').digest('hex');
  }

  ingest(event: OwnerEventV1): 'accepted' | 'duplicate' {
    this.start();
    let validated: OwnerEventV1;
    try { validated = validateEvent(event); }
    catch (error) {
      const fault = error instanceof ProjectionFault ? error : new ProjectionFault('OWNER_EVENT_INVALID');
      this.persistFault(event.ownerKind, event.ownerInstanceId, event.epochId, event.sequence, fault.safeCode);
      console.warn('[kogg:operations:owners] conflict', { ownerKind: safeOwner(event.ownerKind), safeCode: fault.safeCode });
      throw fault;
    }
    const database = this.db();
    const existing = database.prepare('SELECT event_digest FROM accepted_events WHERE owner_instance_id=? AND epoch_id=? AND sequence=?').get(validated.ownerInstanceId, validated.epochId, validated.sequence) as Row | undefined;
    if (existing) {
      if (String(existing.event_digest) === validated.eventDigest) return 'duplicate';
      return this.reject(validated, 'OWNER_SEQUENCE_CONFLICT', 'conflict');
    }
    const cursor = database.prepare('SELECT * FROM owner_cursors WHERE owner_instance_id=?').get(validated.ownerInstanceId) as Row | undefined;
    if (cursor) {
      if (String(cursor.epoch_id) !== validated.epochId) return this.reject(validated, 'OWNER_EPOCH_UNKNOWN', 'conflict');
      const expected = BigInt(String(cursor.sequence)) + 1n;
      const supplied = BigInt(validated.sequence);
      if (supplied < expected) return this.reject(validated, 'OWNER_CURSOR_REWIND', 'rewind');
      if (supplied > expected) return this.reject(validated, 'OWNER_CURSOR_GAP', 'gap');
      if (String(cursor.event_digest) !== validated.previousEventDigest) return this.reject(validated, 'OWNER_PREVIOUS_DIGEST_MISMATCH', 'conflict');
    } else if (validated.sequence !== '1' || validated.previousEventDigest !== ZERO_DIGEST) {
      return this.reject(validated, 'OWNER_CURSOR_GAP', 'gap');
    }
    for (const parent of validated.causalParents) {
      const found = database.prepare('SELECT 1 FROM accepted_events WHERE owner_instance_id=? AND epoch_id=? AND sequence=? AND event_digest=?')
        .get(parent.ownerInstanceId, parent.epochId, parent.sequence, parent.eventDigest);
      if (!found) return this.reject(validated, 'CAUSAL_PARENT_MISSING', 'gap');
    }
    this.transaction(db => {
      db.prepare(`INSERT INTO accepted_events(owner_kind,owner_instance_id,owner_schema_version,epoch_id,sequence,event_id,event_kind,fact_id,fact_digest,previous_event_digest,correlations_json,observed_at,safe_payload_json,event_digest)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(validated.ownerKind, validated.ownerInstanceId, 1, validated.epochId, validated.sequence, validated.eventId, validated.eventKind, validated.factId, validated.factDigest, validated.previousEventDigest, canonical(validated.correlations), validated.observedAt, canonical(validated.safePayload), validated.eventDigest);
      for (const parent of validated.causalParents) db.prepare('INSERT INTO causal_edges(event_digest,parent_digest) VALUES(?,?)').run(validated.eventDigest, parent.eventDigest);
      db.prepare(`INSERT INTO owner_cursors(owner_kind,owner_instance_id,epoch_id,sequence,event_digest,schema_version,status)
        VALUES(?,?,?,?,?,1,'available') ON CONFLICT(owner_instance_id) DO UPDATE SET sequence=excluded.sequence,event_digest=excluded.event_digest,status='available'`)
        .run(validated.ownerKind, validated.ownerInstanceId, validated.epochId, validated.sequence, validated.eventDigest);
      this.projectEvent(db, validated);
      this.appendChange(db, 'owner-event', validated.correlations.runId);
    });
    console.info('[kogg:operations:owners] cursor.advanced', { ownerKind: validated.ownerKind, ownerSequence: validated.sequence });
    console.debug('[kogg:operations:timeline] projection.updated', { ownerKind: validated.ownerKind, eventKind: validated.eventKind, runId: validated.correlations.runId });
    return 'accepted';
  }

  snapshot(): OperationsProjectionSnapshotV1 {
    this.start();
    const meta = this.meta();
    return { schemaVersion: 1, projectionEpoch: String(meta.projection_epoch), changeSequence: String(meta.change_sequence), lifecycle: String(meta.lifecycle) as ProjectionLifecycle, runs: this.runs(), faultCount: this.faultCount() };
  }

  timeline(runId: string, limit = 200): readonly OperationsTimelineEntryV1[] {
    if (!SAFE_ID.test(runId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ProjectionFault('PROJECTION_QUERY_INVALID');
    this.start();
    return (this.db().prepare(`SELECT entry_id,run_id,owner_kind,owner_sequence,event_kind,safe_code,attempt_id,process_id,display_time FROM timeline WHERE run_id=? ORDER BY timeline_sequence LIMIT ?`).all(runId, limit) as Row[]).map(row => ({
      entryId: String(row.entry_id), runId: String(row.run_id), ownerKind: String(row.owner_kind) as OwnerKind, ownerSequence: String(row.owner_sequence), eventKind: String(row.event_kind),
      ...(row.safe_code ? { safeCode: String(row.safe_code) } : {}), ...(row.attempt_id ? { attemptId: String(row.attempt_id) } : {}), ...(row.process_id ? { processId: String(row.process_id) } : {}), displayTime: String(row.display_time)
    }));
  }

  rebuild(): void {
    this.start();
    console.info('[kogg:operations:projection] rebuild.started', { ownerCount: this.ownerCount() });
    this.setLifecycle('rebuilding');
    this.rebuildDerived(true);
    this.setLifecycle(this.faultCount() ? 'degraded' : 'current');
    console.info('[kogg:operations:projection] completed', { ownerCount: this.ownerCount(), faultCount: this.faultCount() });
  }

  diagnostics(): OperationsProjectionDiagnosticsV1 {
    this.start();
    const db = this.db();
    return {
      integrity: String((db.prepare('PRAGMA integrity_check').get() as Row).integrity_check) === 'ok',
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length === 0,
      lifecycle: String(this.meta().lifecycle) as ProjectionLifecycle,
      ownerCount: this.ownerCount(), faultCount: this.faultCount(),
      causalGapCount: this.count("SELECT count(*) AS count FROM projection_faults WHERE safe_code LIKE 'CAUSAL_%'"),
      processAbnormalCount: this.count('SELECT count(*) AS count FROM process_projection WHERE abnormal=1'),
      metricViolationCount: 0
    };
  }

  storagePermissionsValid(): boolean { return process.platform === 'win32' || (statSync(this.databasePath).mode & 0o077) === 0; }

  private reject(event: OwnerEventV1, safeCode: string, logEvent: 'gap' | 'rewind' | 'conflict'): never {
    this.persistFault(event.ownerKind, event.ownerInstanceId, event.epochId, event.sequence, safeCode);
    if (logEvent === 'gap') console.warn('[kogg:operations:owners] gap', { ownerKind: event.ownerKind, ownerSequence: event.sequence, safeCode });
    else if (logEvent === 'rewind') console.warn('[kogg:operations:owners] rewind', { ownerKind: event.ownerKind, ownerSequence: event.sequence, safeCode });
    else console.warn('[kogg:operations:owners] conflict', { ownerKind: event.ownerKind, ownerSequence: event.sequence, safeCode });
    throw new ProjectionFault(safeCode);
  }

  private persistFault(ownerKind: unknown, ownerInstanceId: unknown, epochId: unknown, sequence: unknown, safeCode: string): void {
    try {
      this.start();
      this.db().prepare('INSERT INTO projection_faults(fault_id,owner_kind,owner_instance_id,epoch_id,owner_sequence,safe_code,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), safeOwner(ownerKind), safeId(ownerInstanceId), safeId(epochId), safeSequence(sequence), safeCode, new Date().toISOString());
      this.setLifecycle('degraded');
    } catch (error) {
      console.error('[kogg:operations:projection] failed', { safeCode: 'PROJECTION_FAULT_PERSIST_FAILED', errorType: errorType(error) });
      throw error;
    }
  }

  private projectEvent(db: DatabaseSync, event: OwnerEventV1): void {
    const runId = event.correlations.runId;
    if (!runId) return;
    db.prepare(`INSERT OR IGNORE INTO run_projection(run_id,task_id,project_id,lifecycle,owner_lifecycle,attempt_count,retry_count,live_process_count,abnormal_process_count,check_summary,evidence_summary,verdict_summary,merge_summary,freshness,degraded_owners_json)
      VALUES(?,?,?,'unknown','unknown',0,0,0,0,'unknown','unknown','unknown','unknown','current','[]')`).run(runId, event.correlations.taskId ?? null, event.correlations.projectId ?? null);
    let lifecycle: RunLifecycle | undefined;
    if (event.eventKind === 'run.queued') lifecycle = 'queued';
    else if (event.eventKind === 'run.started') lifecycle = 'active';
    else if (event.eventKind === 'run.waiting') lifecycle = 'waiting';
    else if (event.eventKind === 'run.retrying') lifecycle = 'retrying';
    else if (event.eventKind === 'run.blocked') lifecycle = 'blocked';
    else if (event.eventKind === 'run.cancelling') lifecycle = 'cancelling';
    else if (event.eventKind === 'run.cleaning') lifecycle = 'cleaning';
    else lifecycle = TERMINAL_RUN_EVENTS[event.eventKind];
    if (lifecycle) db.prepare('UPDATE run_projection SET lifecycle=?,owner_lifecycle=?,lifecycle_code=?,task_id=COALESCE(?,task_id),project_id=COALESCE(?,project_id) WHERE run_id=?').run(lifecycle, lifecycle, event.safePayload.safeCode ?? null, event.correlations.taskId ?? null, event.correlations.projectId ?? null, runId);
    if (event.eventKind === 'attempt.requested') db.prepare('UPDATE run_projection SET attempt_count=attempt_count+1,retry_count=retry_count+? WHERE run_id=?').run((event.safePayload.retryOrdinal ?? 0) > 0 ? 1 : 0, runId);
    if (event.ownerKind === 'operation' && event.correlations.processId) this.projectProcess(db, event);
    if (event.ownerKind === 'check') db.prepare('UPDATE run_projection SET check_summary=? WHERE run_id=?').run(summary(event.eventKind), runId);
    if (event.ownerKind === 'ranex') db.prepare('UPDATE run_projection SET evidence_summary=? WHERE run_id=?').run(summary(event.eventKind), runId);
    if (event.ownerKind === 'verdict') db.prepare('UPDATE run_projection SET verdict_summary=? WHERE run_id=?').run(summary(event.eventKind), runId);
    if (event.ownerKind === 'merge') db.prepare('UPDATE run_projection SET merge_summary=? WHERE run_id=?').run(summary(event.eventKind), runId);
    this.deriveRunLifecycle(db, runId);
    db.prepare(`INSERT INTO timeline(entry_id,run_id,owner_kind,owner_sequence,event_kind,safe_code,attempt_id,process_id,display_time,event_digest)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(event.eventId, runId, event.ownerKind, event.sequence, event.eventKind, event.safePayload.safeCode ?? null, event.correlations.attemptId ?? null, event.correlations.processId ?? null, event.observedAt, event.eventDigest);
  }

  private projectProcess(db: DatabaseSync, event: OwnerEventV1): void {
    const processId = event.correlations.processId!; const runId = event.correlations.runId!;
    const state = event.eventKind.slice('process.'.length);
    const abnormal = ABNORMAL_PROCESS_EVENTS.has(event.eventKind) || event.eventKind === 'process.exited' ? 1 : 0;
    const live = LIVE_PROCESS_EVENTS.has(event.eventKind) ? 1 : 0;
    db.prepare(`INSERT INTO process_projection(process_id,run_id,operation_id,attempt_id,process_kind,state,cleanup_state,abnormal,live,safe_code)
      VALUES(?,?,?,?,?,?,?, ?,?,?) ON CONFLICT(process_id) DO UPDATE SET state=excluded.state,cleanup_state=excluded.cleanup_state,abnormal=excluded.abnormal,live=excluded.live,safe_code=excluded.safe_code`)
      .run(processId, runId, event.correlations.operationId ?? null, event.correlations.attemptId ?? null, event.safePayload.processKind ?? 'governed-command', state, event.safePayload.cleanupState ?? (event.eventKind === 'process.cleaned' ? 'cleaned' : 'required'), abnormal, live, event.safePayload.safeCode ?? null);
    const counts = db.prepare('SELECT COALESCE(sum(live),0) AS live,COALESCE(sum(abnormal),0) AS abnormal FROM process_projection WHERE run_id=?').get(runId) as Row;
    db.prepare('UPDATE run_projection SET live_process_count=?,abnormal_process_count=? WHERE run_id=?').run(Number(counts.live), Number(counts.abnormal), runId);
    this.deriveRunLifecycle(db, runId);
  }

  private deriveRunLifecycle(db: DatabaseSync, runId: string): void {
    const row = db.prepare('SELECT owner_lifecycle,live_process_count,abnormal_process_count FROM run_projection WHERE run_id=?').get(runId) as Row;
    const ownerLifecycle = String(row.owner_lifecycle) as RunLifecycle;
    const effective = ['failed', 'recovered', 'completed'].includes(ownerLifecycle) && (Number(row.live_process_count) > 0 || Number(row.abnormal_process_count) > 0) ? 'cleaning' : ownerLifecycle;
    db.prepare('UPDATE run_projection SET lifecycle=? WHERE run_id=?').run(effective, runId);
  }

  private rebuildDerived(changeEpoch: boolean): void {
    this.transaction(database => {
      database.exec('DELETE FROM timeline; DELETE FROM process_projection; DELETE FROM run_projection; DELETE FROM projection_changes;');
      for (const row of database.prepare('SELECT * FROM accepted_events ORDER BY rowid').all() as Row[]) this.projectEvent(database, rowToEvent(database, row));
      database.prepare('UPDATE projection_meta SET projection_epoch=CASE WHEN ? THEN ? ELSE projection_epoch END,change_sequence=0 WHERE singleton=1').run(changeEpoch ? 1 : 0, randomUUID());
    });
  }

  private runs(): readonly OperationsProjectionRunV1[] {
    return (this.db().prepare('SELECT * FROM run_projection ORDER BY run_id').all() as Row[]).map(row => ({
      runId: String(row.run_id), ...(row.task_id ? { taskId: String(row.task_id) } : {}), ...(row.project_id ? { projectId: String(row.project_id) } : {}), lifecycle: String(row.lifecycle) as RunLifecycle,
      ...(row.lifecycle_code ? { lifecycleCode: String(row.lifecycle_code) } : {}), attemptCount: Number(row.attempt_count), retryCount: Number(row.retry_count), liveProcessCount: Number(row.live_process_count), abnormalProcessCount: Number(row.abnormal_process_count),
      checkSummary: String(row.check_summary), evidenceSummary: String(row.evidence_summary), verdictSummary: String(row.verdict_summary), mergeSummary: String(row.merge_summary), freshness: String(row.freshness) as 'current', degradedOwners: JSON.parse(String(row.degraded_owners_json)) as OwnerKind[]
    }));
  }

  private migrate(): void {
    this.db().exec(`
      CREATE TABLE IF NOT EXISTS projection_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),projection_epoch TEXT NOT NULL,lifecycle TEXT NOT NULL CHECK(lifecycle IN ('stopped','verifying','replaying','current','degraded','rebuilding','failed')),change_sequence TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS owner_cursors(owner_kind TEXT NOT NULL,owner_instance_id TEXT PRIMARY KEY,epoch_id TEXT NOT NULL,sequence TEXT NOT NULL,event_digest TEXT NOT NULL,schema_version INTEGER NOT NULL,status TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS accepted_events(owner_kind TEXT NOT NULL,owner_instance_id TEXT NOT NULL,owner_schema_version INTEGER NOT NULL,epoch_id TEXT NOT NULL,sequence TEXT NOT NULL,event_id TEXT NOT NULL UNIQUE,event_kind TEXT NOT NULL,fact_id TEXT NOT NULL,fact_digest TEXT NOT NULL,previous_event_digest TEXT NOT NULL,correlations_json TEXT NOT NULL,observed_at TEXT NOT NULL,safe_payload_json TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE,UNIQUE(owner_instance_id,epoch_id,sequence)) STRICT;
      CREATE TABLE IF NOT EXISTS causal_edges(event_digest TEXT NOT NULL REFERENCES accepted_events(event_digest),parent_digest TEXT NOT NULL REFERENCES accepted_events(event_digest),PRIMARY KEY(event_digest,parent_digest)) STRICT;
      CREATE TABLE IF NOT EXISTS run_projection(run_id TEXT PRIMARY KEY,task_id TEXT,project_id TEXT,lifecycle TEXT NOT NULL,owner_lifecycle TEXT NOT NULL,lifecycle_code TEXT,attempt_count INTEGER NOT NULL,retry_count INTEGER NOT NULL,live_process_count INTEGER NOT NULL,abnormal_process_count INTEGER NOT NULL,check_summary TEXT NOT NULL,evidence_summary TEXT NOT NULL,verdict_summary TEXT NOT NULL,merge_summary TEXT NOT NULL,freshness TEXT NOT NULL,degraded_owners_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS process_projection(process_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES run_projection(run_id),operation_id TEXT,attempt_id TEXT,process_kind TEXT NOT NULL,state TEXT NOT NULL,cleanup_state TEXT NOT NULL,abnormal INTEGER NOT NULL CHECK(abnormal IN (0,1)),live INTEGER NOT NULL CHECK(live IN (0,1)),safe_code TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS timeline(timeline_sequence INTEGER PRIMARY KEY AUTOINCREMENT,entry_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES run_projection(run_id),owner_kind TEXT NOT NULL,owner_sequence TEXT NOT NULL,event_kind TEXT NOT NULL,safe_code TEXT,attempt_id TEXT,process_id TEXT,display_time TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS projection_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,change_kind TEXT NOT NULL,run_id TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS projection_faults(fault_sequence INTEGER PRIMARY KEY AUTOINCREMENT,fault_id TEXT NOT NULL UNIQUE,owner_kind TEXT NOT NULL,owner_instance_id TEXT NOT NULL,epoch_id TEXT NOT NULL,owner_sequence TEXT NOT NULL,safe_code TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
      INSERT OR IGNORE INTO projection_meta(singleton,schema_version,projection_epoch,lifecycle,change_sequence) VALUES(1,1,'${randomUUID()}','stopped','0');
    `);
    const meta = this.meta(); if (Number(meta.schema_version) !== 1) throw new ProjectionFault('PROJECTION_SCHEMA_INCOMPATIBLE');
  }

  private assertIntegrity(): void {
    const db = this.db();
    if (String((db.prepare('PRAGMA integrity_check').get() as Row).integrity_check) !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new ProjectionFault('PROJECTION_INTEGRITY_FAILED');
    if (!this.storagePermissionsValid()) throw new ProjectionFault('PROJECTION_PERMISSIONS_INVALID');
  }
  private setLifecycle(lifecycle: ProjectionLifecycle): void { this.db().prepare('UPDATE projection_meta SET lifecycle=? WHERE singleton=1').run(lifecycle); }
  private appendChange(db: DatabaseSync, kind: string, runId?: string): void { db.prepare('INSERT INTO projection_changes(change_kind,run_id) VALUES(?,?)').run(kind, runId ?? null); db.prepare("UPDATE projection_meta SET change_sequence=CAST(CAST(change_sequence AS INTEGER)+1 AS TEXT) WHERE singleton=1").run(); }
  private meta(): Row { return this.db().prepare('SELECT * FROM projection_meta WHERE singleton=1').get() as Row; }
  private ownerCount(): number { return this.count('SELECT count(*) AS count FROM owner_cursors'); }
  private faultCount(): number { return this.count('SELECT count(*) AS count FROM projection_faults'); }
  private count(sql: string): number { return Number((this.db().prepare(sql).get() as Row).count); }
  private db(): DatabaseSync { if (!this.database) throw new ProjectionFault('PROJECTION_STORE_UNAVAILABLE'); return this.database; }
  private transaction(run: (database: DatabaseSync) => void): void { const db = this.db(); db.exec('BEGIN IMMEDIATE'); try { run(db); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
}

function validateEvent(event: OwnerEventV1): OwnerEventV1 {
  if (!event || typeof event !== 'object' || Object.keys(event).sort().join(',') !== ['causalParents', 'correlations', 'epochId', 'eventDigest', 'eventId', 'eventKind', 'factDigest', 'factId', 'observedAt', 'ownerInstanceId', 'ownerKind', 'ownerSchemaVersion', 'previousEventDigest', 'safePayload', 'sequence'].sort().join(',')) throw new ProjectionFault('OWNER_EVENT_INVALID');
  if (!OWNER_KINDS.includes(event.ownerKind) || event.ownerSchemaVersion !== 1 || !OWNER_EVENT_KINDS[event.ownerKind].includes(event.eventKind as never)) throw new ProjectionFault('OWNER_SCHEMA_UNKNOWN');
  for (const id of [event.ownerInstanceId, event.epochId, event.eventId, event.factId, ...Object.values(event.correlations)]) if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new ProjectionFault('OWNER_EVENT_INVALID');
  if (!SEQUENCE.test(event.sequence) || event.sequence === '0' || !DIGEST.test(event.factDigest) || !DIGEST.test(event.previousEventDigest) || !DIGEST.test(event.eventDigest)) throw new ProjectionFault('OWNER_EVENT_INVALID');
  if (!Array.isArray(event.causalParents) || event.causalParents.length > 16 || Object.keys(event.correlations).some(key => !['taskId', 'projectId', 'runId', 'nodeId', 'attemptId', 'operationId', 'processId', 'checkId', 'evidenceId', 'verdictId', 'mergeId'].includes(key))) throw new ProjectionFault('OWNER_EVENT_INVALID');
  for (const parent of event.causalParents) if (!SAFE_ID.test(parent.ownerInstanceId) || !SAFE_ID.test(parent.epochId) || !SEQUENCE.test(parent.sequence) || !DIGEST.test(parent.eventDigest)) throw new ProjectionFault('OWNER_EVENT_INVALID');
  validatePayload(event.safePayload);
  if (!Number.isFinite(Date.parse(event.observedAt)) || canonical(event).length > 65_536) throw new ProjectionFault('OWNER_EVENT_INVALID');
  const { eventDigest: _eventDigest, ...unsigned } = event;
  if (OperationsReadModel.digest(unsigned) !== event.eventDigest) throw new ProjectionFault('OWNER_EVENT_DIGEST_MISMATCH');
  return event;
}

function validatePayload(payload: SafeOwnerPayloadV1): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !CLOSED_PAYLOAD_KEYS.has(key))) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && (!value.length || value.length > 64 || !/^[A-Za-z0-9._:-]+$/u.test(value))) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000)) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
    if (key === 'retryOrdinal' && Number(value) > 1_000) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
  }
}

function rowToEvent(db: DatabaseSync, row: Row): OwnerEventV1 {
  const parents = db.prepare('SELECT parent_digest FROM causal_edges WHERE event_digest=? ORDER BY parent_digest').all(String(row.event_digest)) as Row[];
  return { ownerKind: String(row.owner_kind) as OwnerKind, ownerInstanceId: String(row.owner_instance_id), ownerSchemaVersion: 1, epochId: String(row.epoch_id), sequence: String(row.sequence), eventId: String(row.event_id), eventKind: String(row.event_kind), factId: String(row.fact_id), factDigest: String(row.fact_digest), previousEventDigest: String(row.previous_event_digest), causalParents: parents.map(parent => { const source = db.prepare('SELECT owner_instance_id,epoch_id,sequence FROM accepted_events WHERE event_digest=?').get(String(parent.parent_digest)) as Row; return { ownerInstanceId: String(source.owner_instance_id), epochId: String(source.epoch_id), sequence: String(source.sequence), eventDigest: String(parent.parent_digest) }; }), correlations: JSON.parse(String(row.correlations_json)) as OwnerEventV1['correlations'], observedAt: String(row.observed_at), safePayload: JSON.parse(String(row.safe_payload_json)) as SafeOwnerPayloadV1, eventDigest: String(row.event_digest) };
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
function safeOwner(value: unknown): OwnerKind | 'unknown' { return typeof value === 'string' && OWNER_KINDS.includes(value as OwnerKind) ? value as OwnerKind : 'unknown'; }
function safeId(value: unknown): string { return typeof value === 'string' && SAFE_ID.test(value) ? value : 'unknown'; }
function safeSequence(value: unknown): string { return typeof value === 'string' && SEQUENCE.test(value) ? value : '0'; }
function summary(eventKind: string): string { return eventKind.slice(eventKind.indexOf('.') + 1); }
function errorType(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
