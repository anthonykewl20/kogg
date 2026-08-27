import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { injectable, unmanaged } from '@theia/core/shared/inversify';
import {
  OWNER_EVENT_KINDS, OWNER_KINDS, type OperationsProjectionDiagnosticsV1,
  type OperationsMetricsSnapshotV1, type OperationsMetricValueV1, type OperationsProjectionRunV1, type OperationsProjectionSnapshotV1, type OperationsRunPageV1, type OperationsRunQueryV1,
  type OperationsActionReceiptV1, type OperationsActionRequestV1,
  type OperationsTimelinePageV1,
  type KoggOperationsReadModelClient, type OperationsProjectionChangeV1,
  type OperationsStreamSubscriptionV1, type OperationsTimelineEntryV1, type OwnerEventV1, type OwnerKind, type ProjectionLifecycle,
  type RunLifecycle, type SafeOwnerPayloadV1
} from '../common/operations-read-model-protocol';

// diagnostic-coverage: operations.projection, operations.owners, operations.correlations, operations.timeline, operations.processes, operations.metrics

type Row = Record<string, SQLOutputValue>;
const ZERO_DIGEST = '0'.repeat(64);
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SEQUENCE = /^(0|[1-9][0-9]{0,19})$/u;
const CLOSED_PAYLOAD_KEYS = new Set(['lifecycle', 'safeCode', 'processKind', 'processState', 'cleanupState', 'terminalClass', 'abnormalClass', 'resultClass', 'decisionClass', 'freshness', 'knownState', 'count', 'retryOrdinal', 'durationMs', 'value', 'unit']);
const CLOSED_STRING_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  lifecycle: new Set(['draft', 'frozen', 'active', 'archived', 'queued', 'waiting', 'retrying', 'blocked', 'failed', 'stalled', 'cancelling', 'cleaning', 'cancelled', 'timed-out', 'recovered', 'completed', 'unknown', 'requested', 'started', 'refused', 'admitted', 'quarantined', 'available', 'unavailable']),
  processKind: new Set(['git', 'ranex-kernel', 'provider-cli', 'governed-command', 'check', 'build', 'test', 'debug-adapter', 'delegated-theia', 'unknown']),
  processState: new Set(['reserved', 'spawning', 'started', 'ready', 'exited', 'cancelling', 'cleaning', 'cleaned', 'spawn-failed', 'timed-out', 'residual', 'lost', 'quarantined', 'inventory-unknown']),
  cleanupState: new Set(['required', 'cleaning', 'cleaned', 'failed', 'unknown']),
  terminalClass: new Set(['none', 'completed', 'failed', 'cancelled', 'refused', 'recovered', 'committed', 'quarantined', 'unknown']),
  abnormalClass: new Set(['none', 'stalled', 'identity-mismatch', 'unregistered-child', 'timeout', 'exit-without-cleanup', 'escalated', 'residual', 'owner-lost', 'recovery-active', 'quarantined', 'inventory-unknown']),
  resultClass: new Set(['unknown', 'pending', 'passed', 'failed', 'refused', 'cancelled', 'not-applicable']),
  decisionClass: new Set(['unknown', 'pending', 'accepted', 'rejected', 'refused', 'committed', 'quarantined']),
  freshness: new Set(['current', 'stale', 'unknown']), knownState: new Set(['known', 'partial', 'unknown']), unit: new Set(['tokens', 'milliseconds', 'bytes', 'items'])
};
const ABNORMAL_PROCESS_EVENTS = new Set(['process.spawn-failed', 'process.timed-out', 'process.residual', 'process.lost', 'process.quarantined', 'process.inventory-unknown']);
const LIVE_PROCESS_EVENTS = new Set(['process.reserved', 'process.spawning', 'process.started', 'process.ready', 'process.activity', 'process.cancelling', 'process.cleaning']);
const TERMINAL_RUN_EVENTS: Readonly<Record<string, RunLifecycle>> = {
  'run.failed': 'failed', 'run.cancelled': 'failed', 'run.recovered': 'recovered', 'run.completed': 'completed'
};
const RUN_LIFECYCLES = new Set<RunLifecycle>(['queued', 'active', 'waiting', 'retrying', 'blocked', 'failed', 'cancelling', 'cleaning', 'recovered', 'completed', 'unknown']);
const HISTOGRAM_BUCKETS = [10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 15_000, 60_000, 300_000] as const;
const METRIC_VALUE_LIMIT = 4_096;
const METRIC_LABEL_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  owner_kind: new Set(OWNER_KINDS), operation_kind: new Set(['workflow-run']), node_kind: new Set(['agent']),
  terminal_class: new Set(['completed', 'failed', 'cancelled', 'recovered', 'passed', 'refused', 'committed', 'quarantined']),
  safe_code_class: new Set(['none', 'timeout', 'authority', 'process', 'integrity', 'other']),
  lifecycle_class: RUN_LIFECYCLES, process_kind: CLOSED_STRING_VALUES.processKind!,
  abnormal_class: new Set(['none', 'exited', 'spawn-failed', 'timed-out', 'residual', 'lost', 'quarantined', 'inventory-unknown'])
};
const METRIC_CONTRACTS: Readonly<Record<string, { readonly kind: OperationsMetricValueV1['kind']; readonly labels: readonly string[] }>> = {
  kogg_operations_total: { kind: 'counter', labels: ['operation_kind', 'owner_kind', 'terminal_class'] },
  kogg_attempts_total: { kind: 'counter', labels: ['node_kind', 'owner_kind', 'terminal_class'] },
  kogg_retries_total: { kind: 'counter', labels: ['node_kind', 'safe_code_class'] },
  kogg_refusals_total: { kind: 'counter', labels: ['owner_kind', 'safe_code_class'] },
  kogg_recoveries_total: { kind: 'counter', labels: ['owner_kind', 'terminal_class'] },
  kogg_quarantines_total: { kind: 'counter', labels: ['owner_kind', 'safe_code_class'] },
  kogg_runs_active: { kind: 'gauge', labels: ['lifecycle_class'] },
  kogg_processes_active: { kind: 'gauge', labels: ['abnormal_class', 'process_kind'] },
  kogg_queue_wait_ms: { kind: 'histogram', labels: ['owner_kind', 'terminal_class'] },
  kogg_run_duration_ms: { kind: 'histogram', labels: ['owner_kind', 'terminal_class'] },
  kogg_process_cleanup_ms: { kind: 'histogram', labels: ['process_kind', 'terminal_class'] },
  kogg_recovery_duration_ms: { kind: 'histogram', labels: ['owner_kind', 'terminal_class'] }
};
const STREAM_CHANGE_LIMIT = 1_000;
const STREAM_BYTE_LIMIT = 1_048_576;

export class ProjectionFault extends Error {
  constructor(readonly safeCode: string) { super(safeCode); this.name = 'ProjectionFault'; }
}

@injectable()
export class OperationsReadModel implements BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private readonly databasePath: string;
  private readonly clients = new Set<KoggOperationsReadModelClient>();

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
      this.reevaluateLifecycle();
      if (this.meta().lifecycle === 'degraded') console.warn('[kogg:operations:projection] degraded', { ownerCount: this.ownerCount(), faultCount: this.faultCount() });
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
    if (this.clients.size) console.info('[kogg:operations:stream] clients.closed', { clientCount: this.clients.size });
    this.clients.clear();
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
      db.prepare("UPDATE configured_owners SET status='available' WHERE owner_kind=?").run(validated.ownerKind);
      this.projectEvent(db, validated);
      this.projectMetrics(db, validated);
      this.appendChange(db, 'owner-event', validated.correlations.runId, protectedEvent(validated.eventKind));
    });
    console.info('[kogg:operations:owners] cursor.advanced', { ownerKind: validated.ownerKind, ownerSequence: validated.sequence });
    this.reevaluateLifecycle();
    console.debug('[kogg:operations:timeline] projection.updated', { ownerKind: validated.ownerKind, eventKind: validated.eventKind, runId: validated.correlations.runId });
    this.notifyLatestChange();
    return 'accepted';
  }

  setClient(client?: KoggOperationsReadModelClient): void { this.clients.clear(); if (client) this.addClient(client); }

  addClient(client: KoggOperationsReadModelClient): () => void {
    this.clients.add(client); console.info('[kogg:operations:stream] client.opened', { clientCount: this.clients.size });
    let disposed = false;
    return () => { if (disposed) return; disposed = true; if (this.clients.delete(client)) console.info('[kogg:operations:stream] client.closed', { clientCount: this.clients.size }); };
  }

  registerOwner(ownerKind: OwnerKind): void {
    this.start(); console.info('[kogg:operations:owners] owner.verify.started', { ownerKind, ownerSchemaVersion: 1 });
    const known = this.db().prepare('SELECT 1 FROM owner_cursors WHERE owner_kind=? LIMIT 1').get(ownerKind);
    this.db().prepare(`INSERT INTO configured_owners(owner_kind,schema_version,status) VALUES(?,1,?) ON CONFLICT(owner_kind) DO UPDATE SET schema_version=1,status=excluded.status`).run(ownerKind, known ? 'available' : 'unavailable');
    this.reevaluateLifecycle();
    if (known) console.info('[kogg:operations:owners] available', { ownerKind, ownerSchemaVersion: 1 });
    else console.warn('[kogg:operations:owners] unavailable', { ownerKind, ownerSchemaVersion: 1, safeCode: 'OWNER_NOT_YET_OBSERVED' });
  }

  subscribe(resumeCursor?: string): OperationsStreamSubscriptionV1 {
    this.start(); const queryDigest = createHash('sha256').update('operations-stream-v1').digest('hex');
    let after = '0';
    if (resumeCursor) {
      try { after = this.decodeCursor(resumeCursor, 'stream', queryDigest).lastKey; }
      catch (error) {
        if (error instanceof ProjectionFault && (error.safeCode === 'PROJECTION_CURSOR_RESYNC_REQUIRED' || error.safeCode === 'PROJECTION_CURSOR_INVALID')) {
          console.warn('[kogg:operations:stream] resync-required', { safeCode: error.safeCode });
          return { state: 'resync-required', cursor: this.encodeCursor('stream', queryDigest, String(this.meta().change_sequence), ''), changes: [] };
        }
        throw error;
      }
    }
    const earliest = this.db().prepare('SELECT sequence FROM projection_changes ORDER BY CAST(sequence AS INTEGER) LIMIT 1').get() as Row | undefined;
    if (resumeCursor && earliest && BigInt(after) + 1n < BigInt(String(earliest.sequence))) {
      console.warn('[kogg:operations:stream] resync-required', { safeCode: 'STREAM_HISTORY_EXPIRED' });
      return { state: 'resync-required', cursor: this.encodeCursor('stream', queryDigest, String(this.meta().change_sequence), ''), changes: [] };
    }
    const rows = this.db().prepare('SELECT sequence,change_kind,run_id,protected,approximate_bytes FROM projection_changes WHERE CAST(sequence AS INTEGER)>CAST(? AS INTEGER) ORDER BY CAST(sequence AS INTEGER) LIMIT 1001').all(after) as Row[];
    let bytes = 0; const changes: OperationsProjectionChangeV1[] = [];
    for (const row of rows) {
      bytes += Number(row.approximate_bytes);
      if (changes.length >= STREAM_CHANGE_LIMIT || bytes > STREAM_BYTE_LIMIT) {
        console.warn('[kogg:operations:stream] backpressure', { bufferedCount: changes.length, bufferedBytes: Math.min(bytes, 1_048_577) });
        console.warn('[kogg:operations:stream] resync-required', { safeCode: 'STREAM_BUFFER_EXCEEDED' });
        return { state: 'resync-required', cursor: this.encodeCursor('stream', queryDigest, String(this.meta().change_sequence), ''), changes: [] };
      }
      changes.push(this.changeFromRow(row));
    }
    const sequence = changes.at(-1)?.sequence ?? after;
    if (resumeCursor) console.info('[kogg:operations:stream] resumed', { changeCount: changes.length });
    else console.info('[kogg:operations:stream] connected', { changeCount: changes.length });
    return { state: 'current', cursor: this.encodeCursor('stream', queryDigest, sequence, ''), changes };
  }

  snapshot(): OperationsProjectionSnapshotV1 {
    this.start();
    const meta = this.meta();
    return { schemaVersion: 1, projectionEpoch: String(meta.projection_epoch), changeSequence: String(meta.change_sequence), lifecycle: String(meta.lifecycle) as ProjectionLifecycle, runs: this.runs(), faultCount: this.faultCount() };
  }
  async projectionSnapshot(): Promise<OperationsProjectionSnapshotV1> { return this.snapshot(); }
  async metricsSnapshot(): Promise<OperationsMetricsSnapshotV1> { return this.metrics(); }

  timeline(runId: string, limit = 200): readonly OperationsTimelineEntryV1[] {
    if (!SAFE_ID.test(runId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ProjectionFault('PROJECTION_QUERY_INVALID');
    this.start();
    return (this.db().prepare(`SELECT entry_id,run_id,owner_kind,owner_sequence,event_kind,safe_code,attempt_id,process_id,display_time FROM timeline WHERE run_id=? ORDER BY timeline_sequence LIMIT ?`).all(runId, limit) as Row[]).map(row => ({
      entryId: String(row.entry_id), runId: String(row.run_id), ownerKind: String(row.owner_kind) as OwnerKind, ownerSequence: String(row.owner_sequence), eventKind: String(row.event_kind),
      ...(row.safe_code ? { safeCode: String(row.safe_code) } : {}), ...(row.attempt_id ? { attemptId: String(row.attempt_id) } : {}), ...(row.process_id ? { processId: String(row.process_id) } : {}), displayTime: String(row.display_time)
    }));
  }

  listRuns(query: OperationsRunQueryV1): OperationsRunPageV1 {
    validateRunQuery(query); this.start();
    const filter = { lifecycle: query.lifecycle ?? null, abnormalOnly: query.abnormalOnly ?? false, sort: query.sort };
    const queryDigest = createHash('sha256').update(canonical(filter)).digest('hex');
    const cursor = query.pageCursor ? this.decodeCursor(query.pageCursor, 'runs', queryDigest) : undefined;
    const order = query.sort === 'lifecycle-asc' ? 'lifecycle,run_id' : 'run_id';
    const conditions: string[] = []; const values: (string | number)[] = [];
    if (query.lifecycle) { conditions.push('lifecycle=?'); values.push(query.lifecycle); }
    if (query.abnormalOnly) conditions.push('abnormal_process_count>0');
    if (cursor) {
      if (query.sort === 'lifecycle-asc') { conditions.push('(lifecycle>? OR (lifecycle=? AND run_id>?))'); values.push(cursor.sortKey, cursor.sortKey, cursor.lastKey); }
      else { conditions.push('run_id>?'); values.push(cursor.lastKey); }
    }
    const rows = this.db().prepare(`SELECT * FROM run_projection ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`).all(...values, query.pageSize + 1) as Row[];
    const hasMore = rows.length > query.pageSize; const selected = hasMore ? rows.slice(0, query.pageSize) : rows;
    const items = selected.map(row => this.runFromRow(row)); const last = selected.at(-1);
    return { projectionEpoch: String(this.meta().projection_epoch), items, ...(hasMore && last ? { nextCursor: this.encodeCursor('runs', queryDigest, String(last.run_id), query.sort === 'lifecycle-asc' ? String(last.lifecycle) : '') } : {}) };
  }

  timelinePage(runId: string, pageCursor?: string, limit = 200): OperationsTimelinePageV1 {
    if (!SAFE_ID.test(runId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ProjectionFault('PROJECTION_QUERY_INVALID');
    this.start(); const queryDigest = createHash('sha256').update(canonical({ runId })).digest('hex');
    const cursor = pageCursor ? this.decodeCursor(pageCursor, 'timeline', queryDigest) : undefined;
    const rows = this.db().prepare('SELECT timeline_sequence,entry_id,run_id,owner_kind,owner_sequence,event_kind,safe_code,attempt_id,process_id,display_time FROM timeline WHERE run_id=? AND timeline_sequence>? ORDER BY timeline_sequence LIMIT ?').all(runId, cursor ? Number(cursor.lastKey) : 0, limit + 1) as Row[];
    const hasMore = rows.length > limit; const selected = hasMore ? rows.slice(0, limit) : rows; const items = selected.map(timelineFromRow); const last = selected.at(-1);
    return { projectionEpoch: String(this.meta().projection_epoch), items, ...(hasMore && last ? { nextCursor: this.encodeCursor('timeline', queryDigest, String(last.timeline_sequence), '') } : {}) };
  }

  metrics(): OperationsMetricsSnapshotV1 {
    this.start();
    const projectionEpoch = String(this.meta().projection_epoch);
    const rows = this.metricRows(projectionEpoch); const violationCount = metricViolationCount(rows);
    if (violationCount) { console.error('[kogg:operations:metrics] validation.failed', { safeCode: 'METRIC_CONTRACT_INVALID', violationCount }); throw new ProjectionFault('METRIC_CONTRACT_INVALID'); }
    const values = rows.map(row => ({
      name: String(row.metric_name) as OperationsMetricValueV1['name'], kind: String(row.metric_kind) as OperationsMetricValueV1['kind'], labels: JSON.parse(String(row.labels_json)) as Record<string, string>, ...(Number(row.bucket_upper_bound) < 0 ? {} : { bucketUpperBound: Number(row.bucket_upper_bound) }), value: Number(row.value)
    }));
    return { schemaVersion: 1, projectionEpoch, values };
  }

  rebuild(): void {
    this.start();
    console.info('[kogg:operations:projection] rebuild.started', { ownerCount: this.ownerCount() });
    this.setLifecycle('rebuilding');
    this.rebuildDerived(true);
    this.transaction(db => this.appendChange(db, 'rebuild', undefined, true));
    this.reevaluateLifecycle();
    console.info('[kogg:operations:projection] completed', { ownerCount: this.ownerCount(), faultCount: this.faultCount() });
    this.notifyLatestChange();
  }

  diagnostics(): OperationsProjectionDiagnosticsV1 {
    this.start();
    const db = this.db();
    return {
      integrity: String((db.prepare('PRAGMA integrity_check').get() as Row).integrity_check) === 'ok',
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length === 0,
      lifecycle: String(this.meta().lifecycle) as ProjectionLifecycle,
      ownerCount: this.ownerCount(), acceptedEventCount: this.count('SELECT count(*) AS count FROM accepted_events'), faultCount: this.faultCount(),
      causalGapCount: this.count("SELECT count(*) AS count FROM projection_faults WHERE safe_code LIKE 'CAUSAL_%'"),
      processAbnormalCount: this.count('SELECT count(*) AS count FROM process_projection WHERE abnormal=1'),
      metricViolationCount: metricViolationCount(this.metricRows(String(this.meta().projection_epoch)))
    };
  }

  streamDiagnostics(): { clientCount: number; cursorRoundTrip: boolean; resyncRecovery: boolean; bounded: boolean } {
    const initial = this.subscribe(); const resumed = this.subscribe(initial.cursor); const recovered = this.subscribe('diagnostic-invalid-cursor');
    const history = this.db().prepare('SELECT count(*) AS count,COALESCE(sum(approximate_bytes),0) AS bytes FROM projection_changes').get() as Row;
    return { clientCount: this.clients.size, cursorRoundTrip: initial.state === 'current' && resumed.state === 'current', resyncRecovery: recovered.state === 'resync-required', bounded: initial.changes.length <= STREAM_CHANGE_LIMIT && resumed.changes.length <= STREAM_CHANGE_LIMIT && Number(history.count) <= STREAM_CHANGE_LIMIT && Number(history.bytes) <= STREAM_BYTE_LIMIT };
  }

  storagePermissionsValid(): boolean { return process.platform === 'win32' || (statSync(this.databasePath).mode & 0o077) === 0; }

  operationBelongsToRun(runId: string, operationId: string): boolean {
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(operationId)) return false; this.start();
    return Boolean(this.db().prepare('SELECT 1 FROM process_projection WHERE run_id=? AND operation_id=? LIMIT 1').get(runId, operationId));
  }

  actionReceipt(requestId: string): OperationsActionReceiptV1 | undefined {
    this.start(); const row = this.db().prepare('SELECT * FROM action_requests WHERE request_id=?').get(requestId) as Row | undefined;
    return row ? { requestId: String(row.request_id), action: String(row.action_kind) as OperationsActionReceiptV1['action'], runId: String(row.run_id), status: String(row.status) as OperationsActionReceiptV1['status'], safeCode: String(row.safe_code) } : undefined;
  }

  actionDiagnostics(): { readonly unsynchronizedOutcomeCount: number } {
    this.start();
    return { unsynchronizedOutcomeCount: this.count("SELECT count(*) AS count FROM action_requests WHERE status='unknown'") };
  }

  recordAction(request: OperationsActionRequestV1, requestDigest: string, status: OperationsActionReceiptV1['status'], safeCode: string): OperationsActionReceiptV1 {
    this.start(); const prior = this.db().prepare('SELECT request_digest FROM action_requests WHERE request_id=?').get(request.requestId) as Row | undefined;
    if (prior && String(prior.request_digest) !== requestDigest) throw new ProjectionFault('ACTION_REQUEST_REPLAY_MISMATCH');
    if (!prior) this.db().prepare('INSERT INTO action_requests(request_id,request_digest,action_kind,run_id,operation_id,projection_sequence,status,safe_code,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(request.requestId, requestDigest, request.action, request.runId, request.operationId ?? null, request.expectedProjectionSequence, status, safeCode, new Date().toISOString());
    else this.db().prepare('UPDATE action_requests SET status=?,safe_code=? WHERE request_id=?').run(status, safeCode, request.requestId);
    return { requestId: request.requestId, action: request.action, runId: request.runId, status, safeCode };
  }

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

  private projectMetrics(db: DatabaseSync, event: OwnerEventV1): void {
    const terminal = terminalClass(event.eventKind);
    if (terminal && event.eventKind.startsWith('run.')) this.incrementMetric(db, 'kogg_operations_total', { owner_kind: event.ownerKind, operation_kind: 'workflow-run', terminal_class: terminal });
    if (terminal && event.eventKind.startsWith('attempt.')) this.incrementMetric(db, 'kogg_attempts_total', { owner_kind: event.ownerKind, node_kind: 'agent', terminal_class: terminal });
    if (event.eventKind === 'attempt.requested' && (event.safePayload.retryOrdinal ?? 0) > 0) this.incrementMetric(db, 'kogg_retries_total', { node_kind: 'agent', safe_code_class: safeCodeClass(event.safePayload.safeCode) });
    if (event.eventKind.endsWith('.refused')) this.incrementMetric(db, 'kogg_refusals_total', { owner_kind: event.ownerKind, safe_code_class: safeCodeClass(event.safePayload.safeCode) });
    if (event.eventKind.endsWith('.recovered')) this.incrementMetric(db, 'kogg_recoveries_total', { owner_kind: event.ownerKind, terminal_class: terminal ?? 'recovered' });
    if (event.eventKind.endsWith('.quarantined')) this.incrementMetric(db, 'kogg_quarantines_total', { owner_kind: event.ownerKind, safe_code_class: safeCodeClass(event.safePayload.safeCode) });
    if (event.safePayload.durationMs !== undefined) {
      const metric = event.eventKind === 'process.cleaned' ? 'kogg_process_cleanup_ms' : event.eventKind === 'run.recovered' ? 'kogg_recovery_duration_ms' : event.eventKind.startsWith('run.') ? 'kogg_run_duration_ms' : undefined;
      if (metric) this.observeHistogram(db, metric, metric === 'kogg_process_cleanup_ms' ? { process_kind: event.safePayload.processKind ?? 'unknown', terminal_class: terminal ?? 'completed' } : { owner_kind: event.ownerKind, terminal_class: terminal ?? 'completed' }, event.safePayload.durationMs);
    }
    this.refreshGauges(db);
    console.debug('[kogg:operations:metrics] update.completed', { ownerKind: event.ownerKind, eventKind: event.eventKind });
  }

  private incrementMetric(db: DatabaseSync, name: string, labels: Record<string, string>): void { this.upsertMetric(db, name, 'counter', labels, null, 1); }
  private observeHistogram(db: DatabaseSync, name: string, labels: Record<string, string>, value: number): void { for (const bucket of HISTOGRAM_BUCKETS) if (value <= bucket) this.upsertMetric(db, name, 'histogram', labels, bucket, 1); }
  private upsertMetric(db: DatabaseSync, name: string, kind: string, labels: Record<string, string>, bucket: number | null, delta: number): void {
    const epoch = String((db.prepare('SELECT projection_epoch FROM projection_meta WHERE singleton=1').get() as Row).projection_epoch); const encoded = canonical(labels);
    db.prepare(`INSERT INTO metric_values(projection_epoch,metric_name,metric_kind,labels_json,bucket_upper_bound,value) VALUES(?,?,?,?,?,?)
      ON CONFLICT(projection_epoch,metric_name,labels_json,bucket_upper_bound) DO UPDATE SET value=value+excluded.value`).run(epoch, name, kind, encoded, bucket ?? -1, delta);
  }
  private refreshGauges(db: DatabaseSync): void {
    const epoch = String((db.prepare('SELECT projection_epoch FROM projection_meta WHERE singleton=1').get() as Row).projection_epoch);
    db.prepare("DELETE FROM metric_values WHERE projection_epoch=? AND metric_kind='gauge'").run(epoch);
    for (const row of db.prepare('SELECT lifecycle,count(*) AS count FROM run_projection GROUP BY lifecycle').all() as Row[]) this.upsertMetric(db, 'kogg_runs_active', 'gauge', { lifecycle_class: String(row.lifecycle) }, null, Number(row.count));
    for (const row of db.prepare('SELECT process_kind,CASE WHEN abnormal=1 THEN state ELSE \'none\' END AS abnormal_class,count(*) AS count FROM process_projection WHERE live=1 OR abnormal=1 GROUP BY process_kind,abnormal_class').all() as Row[]) this.upsertMetric(db, 'kogg_processes_active', 'gauge', { process_kind: String(row.process_kind), abnormal_class: String(row.abnormal_class) }, null, Number(row.count));
  }

  private rebuildDerived(changeEpoch: boolean): void {
    this.transaction(database => {
      database.exec('DELETE FROM timeline; DELETE FROM process_projection; DELETE FROM run_projection; DELETE FROM projection_changes; DELETE FROM metric_values;');
      if (changeEpoch) database.prepare('UPDATE projection_meta SET projection_epoch=?,change_sequence=0 WHERE singleton=1').run(randomUUID());
      else database.prepare('UPDATE projection_meta SET change_sequence=0 WHERE singleton=1').run();
      for (const row of database.prepare('SELECT * FROM accepted_events ORDER BY rowid').all() as Row[]) { const event = rowToEvent(database, row); this.projectEvent(database, event); this.projectMetrics(database, event); }
    });
  }

  private runs(): readonly OperationsProjectionRunV1[] {
    return (this.db().prepare('SELECT * FROM run_projection ORDER BY run_id').all() as Row[]).map(row => this.runFromRow(row));
  }

  private metricRows(projectionEpoch: string): Row[] { return this.db().prepare('SELECT metric_name,metric_kind,labels_json,bucket_upper_bound,value FROM metric_values WHERE projection_epoch=? ORDER BY metric_name,labels_json,bucket_upper_bound').all(projectionEpoch) as Row[]; }

  private runFromRow(row: Row): OperationsProjectionRunV1 {
    return {
      runId: String(row.run_id), ...(row.task_id ? { taskId: String(row.task_id) } : {}), ...(row.project_id ? { projectId: String(row.project_id) } : {}), lifecycle: String(row.lifecycle) as RunLifecycle,
      ...(row.lifecycle_code ? { lifecycleCode: String(row.lifecycle_code) } : {}), attemptCount: Number(row.attempt_count), retryCount: Number(row.retry_count), liveProcessCount: Number(row.live_process_count), abnormalProcessCount: Number(row.abnormal_process_count),
      checkSummary: String(row.check_summary), evidenceSummary: String(row.evidence_summary), verdictSummary: String(row.verdict_summary), mergeSummary: String(row.merge_summary), freshness: String(row.freshness) as 'current', degradedOwners: JSON.parse(String(row.degraded_owners_json)) as OwnerKind[]
    };
  }

  private encodeCursor(kind: 'runs' | 'timeline' | 'stream', queryDigest: string, lastKey: string, sortKey: string): string {
    const payload = Buffer.from(canonical({ kind, projectionEpoch: String(this.meta().projection_epoch), queryDigest, lastKey, sortKey, expiresAt: Date.now() + 15 * 60_000 }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', String(this.meta().cursor_key)).update(payload).digest('base64url'); return `${payload}.${signature}`;
  }
  private decodeCursor(encoded: string, kind: 'runs' | 'timeline' | 'stream', queryDigest: string): { lastKey: string; sortKey: string } {
    if (encoded.length > 2_048) throw new ProjectionFault('PROJECTION_CURSOR_INVALID');
    const [payload, signature, extra] = encoded.split('.'); if (!payload || !signature || extra) throw new ProjectionFault('PROJECTION_CURSOR_INVALID');
    const expected = createHmac('sha256', String(this.meta().cursor_key)).update(payload).digest(); let supplied: Buffer;
    try { supplied = Buffer.from(signature, 'base64url'); } catch { throw new ProjectionFault('PROJECTION_CURSOR_INVALID'); }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ProjectionFault('PROJECTION_CURSOR_INVALID');
    let value: unknown; try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new ProjectionFault('PROJECTION_CURSOR_INVALID'); }
    if (!isCursor(value) || value.kind !== kind || value.queryDigest !== queryDigest || value.projectionEpoch !== String(this.meta().projection_epoch) || value.expiresAt < Date.now()) throw new ProjectionFault('PROJECTION_CURSOR_RESYNC_REQUIRED');
    return { lastKey: value.lastKey, sortKey: value.sortKey };
  }

  private migrate(): void {
    this.db().exec(`
      CREATE TABLE IF NOT EXISTS projection_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),projection_epoch TEXT NOT NULL,cursor_key TEXT NOT NULL,lifecycle TEXT NOT NULL CHECK(lifecycle IN ('stopped','verifying','replaying','current','degraded','rebuilding','failed')),change_sequence TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS owner_cursors(owner_kind TEXT NOT NULL,owner_instance_id TEXT PRIMARY KEY,epoch_id TEXT NOT NULL,sequence TEXT NOT NULL,event_digest TEXT NOT NULL,schema_version INTEGER NOT NULL,status TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS configured_owners(owner_kind TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('available','unavailable'))) STRICT;
      CREATE TABLE IF NOT EXISTS accepted_events(owner_kind TEXT NOT NULL,owner_instance_id TEXT NOT NULL,owner_schema_version INTEGER NOT NULL,epoch_id TEXT NOT NULL,sequence TEXT NOT NULL,event_id TEXT NOT NULL UNIQUE,event_kind TEXT NOT NULL,fact_id TEXT NOT NULL,fact_digest TEXT NOT NULL,previous_event_digest TEXT NOT NULL,correlations_json TEXT NOT NULL,observed_at TEXT NOT NULL,safe_payload_json TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE,UNIQUE(owner_instance_id,epoch_id,sequence)) STRICT;
      CREATE TABLE IF NOT EXISTS causal_edges(event_digest TEXT NOT NULL REFERENCES accepted_events(event_digest),parent_digest TEXT NOT NULL REFERENCES accepted_events(event_digest),PRIMARY KEY(event_digest,parent_digest)) STRICT;
      CREATE TABLE IF NOT EXISTS run_projection(run_id TEXT PRIMARY KEY,task_id TEXT,project_id TEXT,lifecycle TEXT NOT NULL,owner_lifecycle TEXT NOT NULL,lifecycle_code TEXT,attempt_count INTEGER NOT NULL,retry_count INTEGER NOT NULL,live_process_count INTEGER NOT NULL,abnormal_process_count INTEGER NOT NULL,check_summary TEXT NOT NULL,evidence_summary TEXT NOT NULL,verdict_summary TEXT NOT NULL,merge_summary TEXT NOT NULL,freshness TEXT NOT NULL,degraded_owners_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS process_projection(process_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES run_projection(run_id),operation_id TEXT,attempt_id TEXT,process_kind TEXT NOT NULL,state TEXT NOT NULL,cleanup_state TEXT NOT NULL,abnormal INTEGER NOT NULL CHECK(abnormal IN (0,1)),live INTEGER NOT NULL CHECK(live IN (0,1)),safe_code TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS timeline(timeline_sequence INTEGER PRIMARY KEY AUTOINCREMENT,entry_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES run_projection(run_id),owner_kind TEXT NOT NULL,owner_sequence TEXT NOT NULL,event_kind TEXT NOT NULL,safe_code TEXT,attempt_id TEXT,process_id TEXT,display_time TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS projection_changes(sequence TEXT PRIMARY KEY,change_kind TEXT NOT NULL,run_id TEXT,protected INTEGER NOT NULL CHECK(protected IN (0,1)),approximate_bytes INTEGER NOT NULL CHECK(approximate_bytes>0)) STRICT;
      CREATE TABLE IF NOT EXISTS metric_values(projection_epoch TEXT NOT NULL,metric_name TEXT NOT NULL,metric_kind TEXT NOT NULL,labels_json TEXT NOT NULL,bucket_upper_bound INTEGER NOT NULL CHECK(bucket_upper_bound>=-1),value INTEGER NOT NULL CHECK(value>=0),PRIMARY KEY(projection_epoch,metric_name,labels_json,bucket_upper_bound)) STRICT;
      CREATE TABLE IF NOT EXISTS projection_faults(fault_sequence INTEGER PRIMARY KEY AUTOINCREMENT,fault_id TEXT NOT NULL UNIQUE,owner_kind TEXT NOT NULL,owner_instance_id TEXT NOT NULL,epoch_id TEXT NOT NULL,owner_sequence TEXT NOT NULL,safe_code TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS action_requests(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,action_kind TEXT NOT NULL,run_id TEXT NOT NULL,operation_id TEXT,projection_sequence TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('forwarded','refused','unknown')),safe_code TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
      INSERT OR IGNORE INTO projection_meta(singleton,schema_version,projection_epoch,cursor_key,lifecycle,change_sequence) VALUES(1,1,'${randomUUID()}','${randomBytes(32).toString('hex')}','stopped','0');
    `);
    const meta = this.meta(); if (Number(meta.schema_version) !== 1) throw new ProjectionFault('PROJECTION_SCHEMA_INCOMPATIBLE');
  }

  private assertIntegrity(): void {
    const db = this.db();
    if (String((db.prepare('PRAGMA integrity_check').get() as Row).integrity_check) !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new ProjectionFault('PROJECTION_INTEGRITY_FAILED');
    if (!this.storagePermissionsValid()) throw new ProjectionFault('PROJECTION_PERMISSIONS_INVALID');
  }
  private setLifecycle(lifecycle: ProjectionLifecycle): void { this.db().prepare('UPDATE projection_meta SET lifecycle=? WHERE singleton=1').run(lifecycle); }
  private reevaluateLifecycle(): void { const unavailable = this.count("SELECT count(*) AS count FROM configured_owners WHERE status='unavailable'"); this.setLifecycle(this.faultCount() || unavailable ? 'degraded' : 'current'); }
  private appendChange(db: DatabaseSync, kind: 'owner-event' | 'rebuild', runId: string | undefined, isProtected: boolean): void {
    const next = String(BigInt(String((db.prepare('SELECT change_sequence FROM projection_meta WHERE singleton=1').get() as Row).change_sequence)) + 1n); const size = 96 + (runId?.length ?? 0);
    db.prepare('INSERT INTO projection_changes(sequence,change_kind,run_id,protected,approximate_bytes) VALUES(?,?,?,?,?)').run(next, kind, runId ?? null, isProtected ? 1 : 0, size); db.prepare('UPDATE projection_meta SET change_sequence=? WHERE singleton=1').run(next);
    const excess = this.countRows(db, 'SELECT max(count(*)-?,0) AS count FROM projection_changes', STREAM_CHANGE_LIMIT);
    if (excess) db.prepare('DELETE FROM projection_changes WHERE sequence IN (SELECT sequence FROM projection_changes ORDER BY CAST(sequence AS INTEGER) LIMIT ?)').run(excess);
    let retainedBytes = this.countRows(db, 'SELECT COALESCE(sum(approximate_bytes),0) AS count FROM projection_changes');
    while (retainedBytes > STREAM_BYTE_LIMIT) {
      const oldest = db.prepare('SELECT sequence,approximate_bytes FROM projection_changes ORDER BY CAST(sequence AS INTEGER) LIMIT 1').get() as Row | undefined;
      if (!oldest) break;
      db.prepare('DELETE FROM projection_changes WHERE sequence=?').run(String(oldest.sequence)); retainedBytes -= Number(oldest.approximate_bytes);
    }
  }
  private changeFromRow(row: Row): OperationsProjectionChangeV1 { return { projectionEpoch: String(this.meta().projection_epoch), sequence: String(row.sequence), kind: String(row.change_kind) as 'owner-event' | 'rebuild', ...(row.run_id ? { runId: String(row.run_id) } : {}), protected: Number(row.protected) === 1 }; }
  private notifyLatestChange(): void {
    if (!this.clients.size) return; const row = this.db().prepare('SELECT * FROM projection_changes ORDER BY CAST(sequence AS INTEGER) DESC LIMIT 1').get() as Row | undefined; if (!row) return;
    const change = this.changeFromRow(row);
    for (const client of [...this.clients]) {
      try {
        const result = client.projectionChanged(change);
        if (result && typeof result.then === 'function') void result.catch(error => this.dropClient(client, error));
      } catch (error) {
        // observability-exempt: dropClient emits the bounded client.failed event and removes the failed delivery target.
        this.dropClient(client, error);
      }
    }
  }
  private dropClient(client: KoggOperationsReadModelClient, error: unknown): void { if (!this.clients.delete(client)) return; console.warn('[kogg:operations:stream] client.failed', { clientCount: this.clients.size, safeCode: 'STREAM_DELIVERY_FAILED', errorType: errorType(error) }); }
  private meta(): Row { return this.db().prepare('SELECT * FROM projection_meta WHERE singleton=1').get() as Row; }
  private ownerCount(): number { return this.count('SELECT count(DISTINCT owner_kind) AS count FROM owner_cursors'); }
  private faultCount(): number { return this.count('SELECT count(*) AS count FROM projection_faults'); }
  private count(sql: string): number { return Number((this.db().prepare(sql).get() as Row).count); }
  private countRows(db: DatabaseSync, sql: string, ...values: readonly (string | number)[]): number { return Number((db.prepare(sql).get(...values) as Row).count); }
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
  validatePayload(event.eventKind, event.safePayload);
  if (!Number.isFinite(Date.parse(event.observedAt)) || canonical(event).length > 65_536) throw new ProjectionFault('OWNER_EVENT_INVALID');
  const { eventDigest: _eventDigest, ...unsigned } = event;
  if (OperationsReadModel.digest(unsigned) !== event.eventDigest) throw new ProjectionFault('OWNER_EVENT_DIGEST_MISMATCH');
  return event;
}

function validatePayload(eventKind: string, payload: SafeOwnerPayloadV1): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !CLOSED_PAYLOAD_KEYS.has(key))) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
  const allowed = payloadKeys(eventKind); if (Object.keys(payload).some(key => !allowed.has(key))) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && (!value.length || value.length > 64 || !/^[A-Za-z0-9._:-]+$/u.test(value))) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
    if (typeof value === 'string' && key === 'safeCode' && !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
    if (typeof value === 'string' && key !== 'safeCode' && (!CLOSED_STRING_VALUES[key] || !CLOSED_STRING_VALUES[key].has(value))) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000)) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
    if (key === 'retryOrdinal' && Number(value) > 1_000) throw new ProjectionFault('OWNER_PAYLOAD_INVALID');
  }
}
function payloadKeys(eventKind: string): ReadonlySet<string> {
  if (eventKind === 'usage.observed') return new Set(['knownState', 'value', 'unit']);
  if (eventKind.startsWith('process.')) return new Set(['processKind', 'processState', 'cleanupState', 'terminalClass', 'abnormalClass', 'safeCode', 'count', 'durationMs', 'freshness']);
  if (eventKind.startsWith('attempt.')) return new Set(['lifecycle', 'terminalClass', 'safeCode', 'retryOrdinal', 'durationMs', 'freshness']);
  if (eventKind.startsWith('run.')) return new Set(['lifecycle', 'terminalClass', 'safeCode', 'count', 'durationMs', 'freshness']);
  if (eventKind.startsWith('check.')) return new Set(['lifecycle', 'resultClass', 'safeCode', 'count', 'durationMs', 'freshness']);
  if (eventKind.startsWith('verdict.') || eventKind.startsWith('gate.') || eventKind.startsWith('merge.')) return new Set(['lifecycle', 'decisionClass', 'terminalClass', 'safeCode', 'count', 'durationMs', 'freshness']);
  return new Set(['lifecycle', 'resultClass', 'decisionClass', 'terminalClass', 'safeCode', 'count', 'durationMs', 'freshness']);
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
function terminalClass(eventKind: string): string | undefined { const suffix = eventKind.slice(eventKind.lastIndexOf('.') + 1); return ['failed', 'cancelled', 'completed', 'recovered', 'passed', 'refused', 'committed', 'quarantined'].includes(suffix) ? suffix : undefined; }
function safeCodeClass(value?: string): string { if (!value) return 'none'; if (value.includes('TIMEOUT')) return 'timeout'; if (value.includes('AUTH')) return 'authority'; if (value.includes('CLEANUP') || value.includes('PROCESS')) return 'process'; if (value.includes('INTEGRITY') || value.includes('DIGEST')) return 'integrity'; return 'other'; }
function metricViolationCount(rows: readonly Row[]): number {
  let violations = Math.max(0, rows.length - METRIC_VALUE_LIMIT);
  for (const row of rows) {
    const contract = METRIC_CONTRACTS[String(row.metric_name)]; const kind = String(row.metric_kind); const bound = Number(row.bucket_upper_bound); const value = Number(row.value); let labels: unknown;
    try { labels = JSON.parse(String(row.labels_json)); } catch { // observability-exempt: The aggregate validation.failed event reports the closed violation count without emitting persisted label bytes.
      violations++; continue;
    }
    const validLabels = labels !== null && typeof labels === 'object' && !Array.isArray(labels)
      && canonical(labels) === String(row.labels_json) && Object.keys(labels).sort().join(',') === contract?.labels.join(',')
      && Object.entries(labels).every(([key, label]) => typeof label === 'string' && METRIC_LABEL_VALUES[key]?.has(label));
    const validBucket = contract?.kind === 'histogram' ? HISTOGRAM_BUCKETS.includes(bound as typeof HISTOGRAM_BUCKETS[number]) : bound === -1;
    if (!contract || kind !== contract.kind || !validLabels || !validBucket || !Number.isSafeInteger(value) || value < 0) violations++;
  }
  return violations;
}
function errorType(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function validateRunQuery(query: OperationsRunQueryV1): void { if (!query || typeof query !== 'object' || Object.keys(query).some(key => !['lifecycle', 'abnormalOnly', 'sort', 'pageCursor', 'pageSize'].includes(key)) || !['run-id-asc', 'lifecycle-asc'].includes(query.sort) || !Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100 || (query.lifecycle !== undefined && !RUN_LIFECYCLES.has(query.lifecycle)) || (query.abnormalOnly !== undefined && typeof query.abnormalOnly !== 'boolean')) throw new ProjectionFault('PROJECTION_QUERY_INVALID'); }
function isCursor(value: unknown): value is { kind: string; projectionEpoch: string; queryDigest: string; lastKey: string; sortKey: string; expiresAt: number } { if (!value || typeof value !== 'object') return false; const row = value as Record<string, unknown>; return Object.keys(row).sort().join(',') === ['kind', 'projectionEpoch', 'queryDigest', 'lastKey', 'sortKey', 'expiresAt'].sort().join(',') && ['runs', 'timeline', 'stream'].includes(String(row.kind)) && typeof row.projectionEpoch === 'string' && DIGEST.test(String(row.queryDigest)) && typeof row.lastKey === 'string' && typeof row.sortKey === 'string' && typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt); }
function timelineFromRow(row: Row): OperationsTimelineEntryV1 { return { entryId: String(row.entry_id), runId: String(row.run_id), ownerKind: String(row.owner_kind) as OwnerKind, ownerSequence: String(row.owner_sequence), eventKind: String(row.event_kind), ...(row.safe_code ? { safeCode: String(row.safe_code) } : {}), ...(row.attempt_id ? { attemptId: String(row.attempt_id) } : {}), ...(row.process_id ? { processId: String(row.process_id) } : {}), displayTime: String(row.display_time) }; }
function protectedEvent(eventKind: string): boolean { return !eventKind.endsWith('.activity') && !eventKind.endsWith('.updated') && !eventKind.endsWith('.observed'); }
