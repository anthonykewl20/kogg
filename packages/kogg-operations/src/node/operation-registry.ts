import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { injectable, unmanaged } from '@theia/core/shared/inversify';
import type {
  CleanupState,
  KoggOperationsClient,
  OperationDiagnostics,
  OperationLease,
  OperationRegistryApi,
  OperationSafeCode,
  OperationsSnapshot,
  OperationState,
  ProcessLease,
  ProcessState,
  StartOperation,
  StartProcess
} from '../common/operations-protocol';

// diagnostic-coverage: operations.registry, operations.recovery, operations.processes, operations.cleanup, operations.admission

type SqlRow = Record<string, SQLOutputValue>;
const TERMINAL = new Set<OperationState>(['refused', 'completed', 'failed', 'timed-out', 'cancelled', 'recovered']);
const TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  requested: ['refused', 'starting'], refused: [],
  starting: ['active', 'waiting', 'cancelling', 'completed', 'failed', 'timed-out'],
  active: ['waiting', 'stalled', 'cancelling', 'completed', 'failed', 'timed-out'],
  waiting: ['active', 'stalled', 'cancelling', 'completed', 'failed', 'timed-out'],
  stalled: ['active', 'cancelling', 'failed', 'timed-out'], cancelling: ['cancelled', 'failed'],
  completed: [], failed: [], 'timed-out': [], cancelled: [],
  'recovery-required': ['recovering'], recovering: ['recovered', 'failed'], recovered: []
};
const PROCESS_TRANSITIONS: Readonly<Record<ProcessState, readonly ProcessState[]>> = {
  registered: ['spawning', 'spawn-failed'], spawning: ['started', 'spawn-failed', 'exited', 'signalled'],
  started: ['ready', 'exited', 'signalled', 'spawn-failed'], ready: ['exited', 'signalled'],
  'spawn-failed': ['exited', 'signalled'], exited: [], signalled: [], 'possible-residual': []
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const OPERATION_KINDS = new Set([
  'application-start', 'application-stop', 'recovery', 'diagnostics', 'support-export', 'project-mutation',
  'repository-probe', 'project-switch', 'worktree', 'marketplace', 'provider-connection', 'provider-session',
  'ranex-bridge', 'ranex-request', 'task', 'agent-dispatch', 'check', 'build', 'test', 'debug', 'evidence', 'verdict', 'merge'
]);
const PROCESS_KINDS = new Set(['git', 'ranex-kernel', 'provider-cli', 'governed-command', 'check', 'build', 'test', 'debug-adapter', 'delegated-theia']);
const PROCESS_OWNERS = new Set(['kogg-supervisor', 'theia-task', 'theia-terminal', 'theia-debug', 'theia-plugin-host', 'ranex']);
const SAFE_CODES = new Set<OperationSafeCode>([
  'OPERATIONS_OK', 'OPERATIONS_REFUSED', 'OPERATIONS_ADMISSION_BLOCKED', 'OPERATIONS_REGISTRY_UNAVAILABLE',
  'OPERATIONS_SCHEMA_INCOMPATIBLE', 'OPERATIONS_INTEGRITY_FAILED', 'OPERATIONS_TRANSITION_INVALID',
  'OPERATIONS_REQUEST_REPLAY_MISMATCH', 'OPERATION_IDLE_TIMEOUT', 'OPERATION_ABSOLUTE_TIMEOUT',
  'OPERATION_CANCELLED', 'PROCESS_SPAWN_FAILED', 'PROCESS_READINESS_FAILED', 'PROCESS_EXIT_NONZERO',
  'PROCESS_SIGNALLED', 'PROCESS_IDENTITY_UNVERIFIED', 'PROCESS_RESIDUAL', 'CLEANUP_TIMEOUT', 'CLEANUP_FAILED',
  'RECOVERY_FAILED', 'OWNER_UNAVAILABLE'
]);

@injectable()
export class OperationRegistry implements OperationRegistryApi, BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private startup: Promise<void> | undefined;
  private client: KoggOperationsClient | undefined;
  private readonly leases = new Map<string, DurableOperationLease>();
  private readonly activityState = new Map<string, { lastPersisted: number; pending: number }>();
  private readonly instanceId = randomUUID();
  private readonly databasePath = path.join(stateRoot(), 'operations', 'registry.sqlite3');

  constructor(@unmanaged() private readonly cleanupTimeoutMs = 10_000) {}

  onStart(): Promise<void> { return this.ensureStarted(); }

  async onStop(): Promise<void> {
    if (!this.database) return;
    console.info('[kogg:operations:supervisor] supervisor.shutdown.started', { operationCount: this.leases.size });
    const active = [...this.leases.values()].reverse();
    const shutdown = await this.startOperation({ kind: 'application-stop', cancellable: false }); shutdown.start(); shutdown.active();
    this.requireDatabase().prepare(`UPDATE operation_meta SET admission='blocked',revision=revision+1 WHERE singleton=1`).run();
    let shutdownFailed = false;
    for (const lease of active) await lease.cancel().catch(error => {
      shutdownFailed = true;
      console.error('[kogg:operations:supervisor] operation.shutdown.failed', { operationId: lease.id, errorType: errorType(error) });
    });
    await shutdown.cleanup();
    if (shutdownFailed) {
      shutdown.fail('CLEANUP_FAILED', 'Error');
      console.error('[kogg:operations:supervisor] supervisor.shutdown.failed', { safeCode: 'CLEANUP_FAILED' });
    } else {
      shutdown.complete('OPERATIONS_OK');
      console.info('[kogg:operations:supervisor] supervisor.shutdown.completed', { unresolvedProcessCount: 0 });
    }
    this.database?.close();
    this.database = undefined;
    this.startup = undefined;
  }

  async startOperation(request: StartOperation): Promise<OperationLease> {
    await this.ensureStarted();
    validateStartOperation(request);
    const id = request.id ?? randomUUID();
    if (!UUID.test(id)) throw new Error('Operation ID must be UUID v4');
    if (this.admission() !== 'enabled' && !['application-start', 'application-stop', 'recovery', 'diagnostics'].includes(request.kind)) {
      console.warn('[kogg:operations:registry] operation.refused', { operationId: id, safeCode: 'OPERATIONS_ADMISSION_BLOCKED' });
      throw new Error('Kogg is reconciling operations; new work is blocked');
    }
    const now = new Date().toISOString();
    this.transaction(database => {
      database.prepare(`INSERT INTO operations(
        id,kind,state,cleanup_state,project_id,task_id,run_id,attempt_id,session_id,worktree_id,
        owner_instance_id,requested_at,updated_at,activity_count,revision
      ) VALUES(?,?,'requested','not-required',?,?,?,?,?,?,?, ?,?,0,1)`).run(
        id, request.kind, request.correlations?.projectId ?? null, request.correlations?.taskId ?? null,
        request.correlations?.runId ?? null, request.correlations?.attemptId ?? null,
        request.correlations?.sessionId ?? null, request.correlations?.worktreeId ?? null,
        this.instanceId, now, now
      );
      this.appendEvent(database, id, null, 'operation.requested');
      this.bump(database);
    });
    const lease = new DurableOperationLease(this, id, request.cancellable ?? true, request.absoluteTimeoutMs, request.idleTimeoutMs);
    this.leases.set(id, lease);
    console.info('[kogg:operations:registry] operation.requested', { operationId: id, operationKind: request.kind });
    this.changed();
    return lease;
  }

  async snapshot(): Promise<OperationsSnapshot> {
    await this.ensureStarted();
    return this.readSnapshot();
  }

  async recoveryResult(operationId: string): Promise<{ readonly status: 'cleaned' | 'unverified' | 'active' | 'missing'; readonly safeCode?: OperationSafeCode }> {
    await this.ensureStarted();
    if (!UUID.test(operationId)) return { status: 'missing' };
    const row = this.requireDatabase().prepare(`SELECT o.state,o.cleanup_state,o.safe_code,
      EXISTS(SELECT 1 FROM processes p WHERE p.operation_id=o.id AND (p.cleanup_state='failed' OR p.state='possible-residual')) AS unverified,
      EXISTS(SELECT 1 FROM processes p WHERE p.operation_id=o.id AND p.cleanup_state!='cleaned') AS dirty
      FROM operations o WHERE o.id=?`).get(operationId) as SqlRow | undefined;
    if (!row) return { status: 'missing' };
    const safeCode = row.safe_code ? String(row.safe_code) as OperationSafeCode : undefined;
    if (Number(row.unverified) || row.cleanup_state === 'failed') return { status: 'unverified', ...(safeCode ? { safeCode } : {}) };
    if (row.cleanup_state === 'cleaned' && !Number(row.dirty)) return { status: 'cleaned', ...(safeCode ? { safeCode } : {}) };
    return { status: 'active', ...(safeCode ? { safeCode } : {}) };
  }

  async cancel(request: { readonly requestId: string; readonly operationId: string }): Promise<OperationsSnapshot> {
    await this.ensureStarted();
    if (Object.keys(request).sort().join(',') !== 'operationId,requestId') throw new Error('Cancel request contains unknown fields');
    if (!UUID.test(request.requestId) || !UUID.test(request.operationId)) throw new Error('Cancel request identifiers are invalid');
    const replay = this.requireDatabase().prepare('SELECT operation_id FROM request_results WHERE request_id=?').get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.operation_id) !== request.operationId) throw new Error('OPERATIONS_REQUEST_REPLAY_MISMATCH');
      return this.readSnapshot();
    }
    console.info('[kogg:operations:registry] operation.cancel.requested', { operationId: request.operationId, requestId: request.requestId });
    const lease = this.leases.get(request.operationId);
    if (!lease) throw new Error('The operation is not active in this application instance');
    if (!lease.cancellable) throw new Error('This application lifecycle operation cannot be cancelled from the UI');
    await lease.cancel();
    this.transaction(database => {
      database.prepare(`INSERT INTO request_results(request_id,request_digest,operation_id,safe_code,created_at) VALUES(?,?,?,?,?)`)
        .run(request.requestId, request.operationId, request.operationId, 'OPERATION_CANCELLED', new Date().toISOString());
      this.bump(database);
    });
    return this.readSnapshot();
  }

  setClient(client?: KoggOperationsClient): void { this.client = client; }

  diagnostics(): OperationDiagnostics {
    const database = this.requireDatabase();
    const integrity = String((database.prepare('PRAGMA integrity_check').get() as SqlRow | undefined)?.integrity_check) === 'ok';
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all().length === 0;
    const count = (sql: string): number => Number((database.prepare(sql).get() as SqlRow).count);
    return {
      integrity, foreignKeys, permissions: process.platform === 'win32' || (statSync(this.databasePath).mode & 0o077) === 0,
      recoveryComplete: this.admission() !== 'recovering',
      activeCount: count(`SELECT count(*) AS count FROM operations WHERE state NOT IN ('refused','completed','failed','timed-out','cancelled','recovered')`),
      stalledCount: count(`SELECT count(*) AS count FROM operations WHERE state='stalled'`),
      residualCount: count(`SELECT count(*) AS count FROM processes WHERE state='possible-residual'`),
      cleanupFailureCount: count(`SELECT count(*) AS count FROM operations WHERE cleanup_state='failed' OR EXISTS(SELECT 1 FROM processes p WHERE p.operation_id=operations.id AND p.cleanup_state='failed')`),
      admission: this.admission()
    };
  }

  transitionOperation(id: string, state: OperationState, eventName: string, safeCode?: OperationSafeCode, error?: string): void {
    if (safeCode && !SAFE_CODES.has(safeCode)) throw new Error('Operation safe code is invalid');
    if (TERMINAL.has(state)) this.flushActivity(id);
    const current = this.operationRow(id);
    if (TERMINAL.has(String(current.state) as OperationState)) {
      if (String(current.state) === state) return;
      throw new Error('Operation already has a conflicting terminal state');
    }
    const currentState = String(current.state) as OperationState;
    if (!TRANSITIONS[currentState]?.includes(state)) throw new Error(`Invalid operation transition from ${currentState} to ${state}`);
    this.transaction(database => {
      database.prepare(`UPDATE operations SET state=?, safe_code=?, error_type=?, updated_at=?, revision=revision+1 WHERE id=?`)
        .run(state, safeCode ?? null, error ?? null, new Date().toISOString(), id);
      this.appendEvent(database, id, null, eventName);
      if (TERMINAL.has(state)) this.prune(database);
      this.bump(database);
    });
    logOperation(eventName, id, safeCode, error);
    if (TERMINAL.has(state)) { this.leases.delete(id); this.activityState.delete(id); }
    this.changed();
  }

  activity(id: string, processId?: string): void {
    const now = Date.now();
    const activity = this.activityState.get(id) ?? { lastPersisted: 0, pending: 0 };
    activity.pending += 1;
    this.activityState.set(id, activity);
    if (activity.lastPersisted && now - activity.lastPersisted < 1_000 && activity.pending < 100) return;
    this.persistActivity(id, activity.pending, processId);
    activity.lastPersisted = now; activity.pending = 0;
  }

  private persistActivity(id: string, count: number, processId?: string): void {
    this.transaction(database => {
      database.prepare('UPDATE operations SET activity_count=activity_count+?,last_activity_at=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(count, new Date().toISOString(), new Date().toISOString(), id);
      this.appendEvent(database, id, processId ?? null, 'process.activity');
      this.bump(database);
    });
    console.debug('[kogg:operations:registry] process.activity', { operationId: id, ...(processId ? { processId } : {}), activityCount: count });
    this.changed();
  }

  private flushActivity(id: string): void {
    const activity = this.activityState.get(id);
    if (!activity?.pending) return;
    this.persistActivity(id, activity.pending);
    activity.lastPersisted = Date.now(); activity.pending = 0;
  }

  registerProcess(operationId: string, request: StartProcess): DurableProcessLease {
    if (Object.keys(request).some(key => !['kind', 'owner', 'cancel'].includes(key)) || !PROCESS_KINDS.has(request.kind) || !PROCESS_OWNERS.has(request.owner)) {
      throw new Error('Process registration request is invalid');
    }
    const id = randomUUID();
    this.transaction(database => {
      database.prepare(`INSERT INTO processes(id,operation_id,kind,owner,state,cleanup_state,owner_instance_id)
        VALUES(?,?,?,?,'registered','required',?)`).run(id, operationId, request.kind, request.owner, this.instanceId);
      database.prepare(`UPDATE operations SET cleanup_state='required',updated_at=?,revision=revision+1 WHERE id=?`).run(new Date().toISOString(), operationId);
      this.appendEvent(database, operationId, id, 'process.registered');
      this.bump(database);
    });
    console.info('[kogg:operations:process] process.registered', { operationId, processId: id, processKind: request.kind, processOwner: request.owner });
    this.changed();
    return new DurableProcessLease(this, operationId, id, request.cancel);
  }

  transitionProcess(operationId: string, id: string, state: ProcessState, eventName: string, values: {
    readonly pid?: number; readonly safeCode?: OperationSafeCode; readonly errorType?: string; readonly exitClass?: string;
  } = {}): void {
    if (values.safeCode && !SAFE_CODES.has(values.safeCode)) throw new Error('Process safe code is invalid');
    const current = this.requireDatabase().prepare('SELECT state FROM processes WHERE id=? AND operation_id=?').get(id, operationId) as SqlRow | undefined;
    if (!current) throw new Error('Registered process does not exist');
    const currentState = String(current.state) as ProcessState;
    if (currentState === state) return;
    if (!PROCESS_TRANSITIONS[currentState]?.includes(state)) throw new Error(`Invalid process transition from ${currentState} to ${state}`);
    const fingerprint = values.pid ? fingerprintFor(values.pid) : undefined;
    this.transaction(database => {
      database.prepare(`UPDATE processes SET state=?,pid=COALESCE(?,pid),identity_fingerprint=COALESCE(?,identity_fingerprint),
        safe_code=?,error_type=?,exit_class=?,updated_at=? WHERE id=? AND operation_id=?`).run(
        state, values.pid ?? null, fingerprint ?? null, values.safeCode ?? null, values.errorType ?? null,
        values.exitClass ?? null, new Date().toISOString(), id, operationId
      );
      this.appendEvent(database, operationId, id, eventName);
      this.bump(database);
    });
    logProcess(eventName, operationId, id, state, values);
    this.changed();
  }

  cleanupProcess(operationId: string, id: string): void {
    this.transaction(database => {
      database.prepare(`UPDATE processes SET cleanup_state='cleaned',updated_at=? WHERE id=? AND operation_id=?`).run(new Date().toISOString(), id, operationId);
      this.appendEvent(database, operationId, id, 'cleanup.completed');
      this.bump(database);
    });
    console.info('[kogg:operations:process] cleanup.completed', { operationId, processId: id });
    this.changed();
  }

  async cleanupOperation(id: string, run?: () => Promise<void>): Promise<void> {
    console.info('[kogg:operations:registry] cleanup.started', { operationId: id });
    this.transaction(database => {
      database.prepare(`UPDATE operations SET cleanup_state='cleaning',updated_at=?,revision=revision+1 WHERE id=?`).run(new Date().toISOString(), id);
      this.appendEvent(database, id, null, 'cleanup.started');
      this.bump(database);
    });
    try {
      let cleanupTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          run?.() ?? Promise.resolve(),
          new Promise<never>((_resolve, reject) => {
            cleanupTimer = setTimeout(() => reject(new CleanupTimeoutError()), this.cleanupTimeoutMs);
          })
        ]);
      } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      const dirty = Number((this.requireDatabase().prepare(`SELECT count(*) AS count FROM processes WHERE operation_id=? AND cleanup_state!='cleaned'`).get(id) as SqlRow).count);
      if (dirty) throw new Error('Operation cleanup left a registered process');
      this.transaction(database => {
        database.prepare(`UPDATE operations SET cleanup_state='cleaned',updated_at=?,revision=revision+1 WHERE id=?`).run(new Date().toISOString(), id);
        this.appendEvent(database, id, null, 'cleanup.completed');
        this.bump(database);
      });
      console.info('[kogg:operations:registry] cleanup.completed', { operationId: id });
    } catch (error) {
      this.transaction(database => {
        database.prepare(`UPDATE operations SET cleanup_state='failed',safe_code=?,updated_at=?,revision=revision+1 WHERE id=?`)
          .run(error instanceof CleanupTimeoutError ? 'CLEANUP_TIMEOUT' : 'CLEANUP_FAILED', new Date().toISOString(), id);
        this.appendEvent(database, id, null, 'cleanup.failed');
        database.prepare(`UPDATE operation_meta SET admission='blocked',revision=revision+1 WHERE singleton=1`).run();
      });
      console.error('[kogg:operations:registry] cleanup.failed', {
        operationId: id, safeCode: error instanceof CleanupTimeoutError ? 'CLEANUP_TIMEOUT' : 'CLEANUP_FAILED', errorType: errorType(error)
      });
      throw error;
    } finally {
      this.changed();
    }
  }

  operationRow(id: string): SqlRow {
    const row = this.requireDatabase().prepare('SELECT * FROM operations WHERE id=?').get(id) as SqlRow | undefined;
    if (!row) throw new Error('Operation does not exist');
    return row;
  }

  private async ensureStarted(): Promise<void> {
    if (this.database) return;
    this.startup ??= this.startDatabase();
    return this.startup;
  }

  private async startDatabase(): Promise<void> {
    console.info('[kogg:operations:registry] registry.start.requested');
    try {
      mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.migrate();
      if (process.platform !== 'win32') chmodSync(this.databasePath, 0o600);
      this.assertIntegrity();
      await this.recover();
      const startup = await this.startOperation({ kind: 'application-start', cancellable: false });
      startup.start(); startup.active(); await startup.cleanup(); startup.complete('OPERATIONS_OK');
      console.info('[kogg:operations:registry] registry.start.completed', { schemaVersion: 1, admission: this.admission() });
    } catch (error) {
      const safeCode: OperationSafeCode = error instanceof Error && /schema/iu.test(error.message)
        ? 'OPERATIONS_SCHEMA_INCOMPATIBLE' : 'OPERATIONS_INTEGRITY_FAILED';
      console.error('[kogg:operations:registry] registry.start.failed', { errorType: errorType(error), safeCode });
      this.database?.close(); this.database = undefined; this.startup = undefined;
      throw error;
    }
  }

  private migrate(): void {
    console.info('[kogg:operations:registry] registry.migration.started', { schemaVersion: 1 });
    this.requireDatabase().exec(`
      CREATE TABLE IF NOT EXISTS operation_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),revision INTEGER NOT NULL CHECK(revision>=1),instance_id TEXT NOT NULL,admission TEXT NOT NULL CHECK(admission IN ('enabled','recovering','blocked')));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('application-start','application-stop','recovery','diagnostics','support-export','project-mutation','repository-probe','project-switch','worktree','marketplace','provider-connection','provider-session','ranex-bridge','ranex-request','task','agent-dispatch','check','build','test','debug','evidence','verdict','merge')),state TEXT NOT NULL CHECK(state IN ('requested','refused','starting','active','waiting','stalled','cancelling','completed','failed','timed-out','cancelled','recovery-required','recovering','recovered')),cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('not-required','required','cleaning','cleaned','failed')),safe_code TEXT,project_id TEXT,task_id TEXT,run_id TEXT,attempt_id TEXT,session_id TEXT,worktree_id TEXT,owner_instance_id TEXT NOT NULL,requested_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_activity_at TEXT,activity_count INTEGER NOT NULL CHECK(activity_count>=0),error_type TEXT,revision INTEGER NOT NULL CHECK(revision>=1));
      CREATE TABLE IF NOT EXISTS processes(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id),kind TEXT NOT NULL CHECK(kind IN ('git','ranex-kernel','provider-cli','governed-command','check','build','test','debug-adapter','delegated-theia')),owner TEXT NOT NULL CHECK(owner IN ('kogg-supervisor','theia-task','theia-terminal','theia-debug','theia-plugin-host','ranex')),state TEXT NOT NULL CHECK(state IN ('registered','spawning','started','ready','spawn-failed','exited','signalled','possible-residual')),cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('required','cleaning','cleaned','failed')),owner_instance_id TEXT NOT NULL,pid INTEGER CHECK(pid IS NULL OR pid>0),identity_fingerprint TEXT,safe_code TEXT,error_type TEXT,exit_class TEXT,updated_at TEXT);
      CREATE TABLE IF NOT EXISTS operation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES operations(id),process_id TEXT,event_name TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,operation_id TEXT NOT NULL,safe_code TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operation_active_idx ON operations(state,cleanup_state);
      CREATE INDEX IF NOT EXISTS process_operation_idx ON processes(operation_id);
      INSERT OR IGNORE INTO operation_meta(singleton,schema_version,revision,instance_id,admission) VALUES(1,1,1,'bootstrap','recovering');
    `);
    const meta = this.requireDatabase().prepare('SELECT schema_version FROM operation_meta WHERE singleton=1').get() as SqlRow;
    if (Number(meta.schema_version) !== 1) throw new Error('Unsupported operation registry schema');
    console.info('[kogg:operations:registry] registry.migration.completed', { schemaVersion: 1 });
  }

  private assertIntegrity(): void {
    console.info('[kogg:operations:registry] registry.integrity.started');
    const database = this.requireDatabase();
    const integrity = String((database.prepare('PRAGMA integrity_check').get() as SqlRow | undefined)?.integrity_check) === 'ok';
    const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all().length;
    if (!integrity || foreignKeyFailures) {
      console.error('[kogg:operations:registry] registry.integrity.failed', { foreignKeyFailureCount: foreignKeyFailures });
      throw new Error('Operation registry integrity failed');
    }
    console.info('[kogg:operations:registry] registry.integrity.completed');
  }

  private async recover(): Promise<void> {
    const database = this.requireDatabase();
    database.prepare(`UPDATE operation_meta SET admission='recovering',instance_id=?,revision=revision+1 WHERE singleton=1`).run(this.instanceId);
    const incomplete = database.prepare(`SELECT id FROM operations WHERE state NOT IN ('refused','completed','failed','timed-out','cancelled','recovered') OR cleanup_state IN ('required','cleaning','failed')`).all() as SqlRow[];
    for (const row of incomplete) {
      const operationId = String(row.id);
      database.prepare(`UPDATE operations SET state='recovery-required',updated_at=?,revision=revision+1 WHERE id=?`).run(new Date().toISOString(), operationId);
      this.appendEvent(database, operationId, null, 'recovery.started');
      database.prepare(`UPDATE operations SET state='recovering',updated_at=?,revision=revision+1 WHERE id=?`).run(new Date().toISOString(), operationId);
    }
    const rows = database.prepare(`SELECT * FROM processes WHERE cleanup_state!='cleaned' AND state IN ('started','ready','spawning','registered')`).all() as SqlRow[];
    let blocked = false;
    const blockedOperations = new Set<string>();
    console.info('[kogg:operations:recovery] recovery.started', { processCount: rows.length });
    for (const row of rows) {
      const operationId = String(row.operation_id); const processId = String(row.id);
      const pid = typeof row.pid === 'number' ? row.pid : undefined;
      this.appendEvent(database, operationId, processId, 'recovery.process.observed');
      console.info('[kogg:operations:recovery] recovery.process.observed', { operationId, processId, processState: String(row.state) });
      if (pid && isAlive(pid)) {
        const current = fingerprintFor(pid);
        if (!current || current !== String(row.identity_fingerprint ?? '')) {
          database.prepare(`UPDATE processes SET state='possible-residual',cleanup_state='failed',safe_code='PROCESS_IDENTITY_UNVERIFIED' WHERE id=?`).run(processId);
          console.error('[kogg:operations:recovery] process.possible-residual', { operationId, processId, safeCode: 'PROCESS_IDENTITY_UNVERIFIED' });
          blocked = true; blockedOperations.add(operationId);
          continue;
        }
        try { await terminate(pid); }
        catch (error) {
          database.prepare(`UPDATE processes SET state='possible-residual',cleanup_state='failed',safe_code='PROCESS_RESIDUAL' WHERE id=?`).run(processId);
          console.error('[kogg:operations:recovery] process.possible-residual', { operationId, processId, safeCode: 'PROCESS_RESIDUAL', errorType: errorType(error) });
          blocked = true; blockedOperations.add(operationId);
          continue;
        }
      }
      database.prepare(`UPDATE processes SET state='exited',cleanup_state='cleaned',exit_class='recovered' WHERE id=?`).run(processId);
      this.appendEvent(database, operationId, processId, 'recovery.completed');
    }
    const unresolved = database.prepare(`SELECT id FROM operations o WHERE
      (o.cleanup_state='failed' AND NOT EXISTS(SELECT 1 FROM processes p WHERE p.operation_id=o.id))
      OR EXISTS(SELECT 1 FROM processes p WHERE p.operation_id=o.id AND (p.cleanup_state='failed' OR p.state='possible-residual'))`).all() as SqlRow[];
    for (const row of unresolved) blockedOperations.add(String(row.id));
    if (blockedOperations.size) blocked = true;
    for (const row of incomplete) {
      const operationId = String(row.id);
      if (blockedOperations.has(operationId)) {
        database.prepare(`UPDATE operations SET state='failed',cleanup_state='failed',safe_code=COALESCE((SELECT safe_code FROM processes WHERE operation_id=? AND cleanup_state='failed' LIMIT 1),'RECOVERY_FAILED') WHERE id=?`).run(operationId, operationId);
        this.appendEvent(database, operationId, null, 'recovery.failed');
        console.error('[kogg:operations:recovery] recovery.failed', { operationId, safeCode: 'RECOVERY_FAILED' });
      } else {
        database.prepare(`UPDATE operations SET state='recovered',cleanup_state='cleaned',safe_code='OPERATIONS_OK' WHERE id=?`).run(operationId);
        this.appendEvent(database, operationId, null, 'recovery.completed');
      }
    }
    database.prepare(`UPDATE operation_meta SET admission=?,revision=revision+1 WHERE singleton=1`).run(blocked ? 'blocked' : 'enabled');
    this.prune(database);
    console.info('[kogg:operations:recovery] recovery.completed', { processCount: rows.length, admission: blocked ? 'blocked' : 'enabled' });
  }

  private readSnapshot(): OperationsSnapshot {
    const database = this.requireDatabase();
    const revision = Number((database.prepare('SELECT revision FROM operation_meta WHERE singleton=1').get() as SqlRow).revision);
    const rows = database.prepare(`SELECT o.*,(SELECT count(*) FROM processes p WHERE p.operation_id=o.id) AS process_count FROM operations o ORDER BY o.updated_at DESC,o.rowid DESC LIMIT 200`).all() as SqlRow[];
    const summaries = rows.map(row => ({
      id: String(row.id), kind: String(row.kind) as OperationsSnapshot['active'][number]['kind'],
      state: String(row.state) as OperationState, cleanup: String(row.cleanup_state) as CleanupState,
      ...(row.safe_code ? { safeCode: String(row.safe_code) as OperationSafeCode } : {}),
      correlations: {
        ...(row.project_id ? { projectId: String(row.project_id) } : {}), ...(row.task_id ? { taskId: String(row.task_id) } : {}),
        ...(row.run_id ? { runId: String(row.run_id) } : {}), ...(row.attempt_id ? { attemptId: String(row.attempt_id) } : {}),
        ...(row.session_id ? { sessionId: String(row.session_id) } : {}), ...(row.worktree_id ? { worktreeId: String(row.worktree_id) } : {})
      },
      processCount: Number(row.process_count), activityCount: Number(row.activity_count),
      canCancel: this.leases.get(String(row.id))?.cancellable === true && !TERMINAL.has(String(row.state) as OperationState),
      blocksAdmission: row.state === 'recovery-required' || row.cleanup_state === 'failed'
    }));
    return { schemaVersion: 1, revision, admission: this.admission(), active: summaries.filter(item => !TERMINAL.has(item.state)), recent: summaries.filter(item => TERMINAL.has(item.state)).slice(0, 100) };
  }

  private admission(): 'enabled' | 'recovering' | 'blocked' {
    return String((this.requireDatabase().prepare('SELECT admission FROM operation_meta WHERE singleton=1').get() as SqlRow).admission) as 'enabled' | 'recovering' | 'blocked';
  }

  private changed(): void {
    if (!this.client) return;
    try {
      const update = this.client.changed(this.readSnapshot());
      if (update) void update.catch(error => console.warn('[kogg:operations:registry] client.update.failed', { errorType: errorType(error) }));
    }
    catch (error) { console.warn('[kogg:operations:registry] client.update.failed', { errorType: errorType(error) }); }
  }
  private appendEvent(database: DatabaseSync, operationId: string, processId: string | null, eventName: string): void {
    database.prepare('INSERT INTO operation_events(operation_id,process_id,event_name,created_at) VALUES(?,?,?,?)').run(operationId, processId, eventName, new Date().toISOString());
  }
  private bump(database: DatabaseSync): void { database.prepare('UPDATE operation_meta SET revision=revision+1 WHERE singleton=1').run(); }
  private prune(database: DatabaseSync): void {
    const old = `SELECT id FROM operations o WHERE state IN ('refused','completed','failed','timed-out','cancelled','recovered')
      AND cleanup_state IN ('not-required','cleaned') AND NOT EXISTS(
        SELECT 1 FROM processes p WHERE p.operation_id=o.id AND (p.cleanup_state!='cleaned' OR p.state='possible-residual')
      ) ORDER BY updated_at DESC LIMIT -1 OFFSET 100`;
    database.exec(`DELETE FROM operation_events WHERE operation_id IN (${old}); DELETE FROM processes WHERE operation_id IN (${old}); DELETE FROM operations WHERE id IN (${old});`);
  }
  private transaction(run: (database: DatabaseSync) => void): void {
    const database = this.requireDatabase(); database.exec('BEGIN IMMEDIATE');
    try { run(database); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  private requireDatabase(): DatabaseSync { if (!this.database) throw new Error('Operation registry is not started'); return this.database; }
}

class DurableOperationLease implements OperationLease {
  private readonly processes = new Map<string, DurableProcessLease>();
  private absoluteTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  constructor(private readonly registry: OperationRegistry, readonly id: string, readonly cancellable: boolean, private readonly absolute?: number, private readonly idle?: number) {}
  start(): void { this.registry.transitionOperation(this.id, 'starting', 'operation.started'); this.arm(); }
  active(): void { this.registry.transitionOperation(this.id, 'active', 'operation.active'); this.armIdle(); }
  waiting(): void { this.registry.transitionOperation(this.id, 'waiting', 'operation.waiting'); this.armIdle(); }
  activity(): void { this.registry.activity(this.id); this.armIdle(); }
  refuse(code: OperationSafeCode): void { this.clear(); this.registry.transitionOperation(this.id, 'refused', 'operation.refused', code); }
  complete(code?: OperationSafeCode): void { this.clear(); this.registry.transitionOperation(this.id, 'completed', 'operation.completed', code); }
  fail(code: OperationSafeCode, error: string): void { this.clear(); this.registry.transitionOperation(this.id, 'failed', 'operation.failed', code, error); }
  timeout(code: OperationSafeCode): void { this.clear(); this.registry.transitionOperation(this.id, 'timed-out', 'operation.timeout', code); }
  registerProcess(request: StartProcess): ProcessLease { const lease = this.registry.registerProcess(this.id, request); this.processes.set(lease.id, lease); return lease; }
  async cancel(): Promise<void> {
    this.registry.transitionOperation(this.id, 'cancelling', 'operation.cancelling');
    await this.cleanup(async () => Promise.all([...this.processes.values()].map(process => process.cancel())).then(() => undefined));
    this.registry.transitionOperation(this.id, 'cancelled', 'operation.cancelled');
  }
  async cleanup(run?: () => Promise<void>): Promise<void> { await this.registry.cleanupOperation(this.id, run); }
  private arm(): void { if (this.absolute) this.absoluteTimer = setTimeout(() => void this.cancelAfterTimeout('OPERATION_ABSOLUTE_TIMEOUT'), this.absolute); this.armIdle(); }
  private armIdle(): void { if (this.idleTimer) clearTimeout(this.idleTimer); if (this.idle) this.idleTimer = setTimeout(() => void this.cancelAfterTimeout('OPERATION_IDLE_TIMEOUT'), this.idle); }
  private async cancelAfterTimeout(code: 'OPERATION_ABSOLUTE_TIMEOUT' | 'OPERATION_IDLE_TIMEOUT'): Promise<void> {
    try {
      if (code === 'OPERATION_IDLE_TIMEOUT') this.registry.transitionOperation(this.id, 'stalled', 'operation.stalled', code);
      this.timeout(code);
      await this.cleanup(async () => Promise.all([...this.processes.values()].map(process => process.cancel())).then(() => undefined));
    } catch (error) { console.error('[kogg:operations:registry] operation.timeout.cleanup.failed', { operationId: this.id, errorType: errorType(error) }); }
  }
  private clear(): void { if (this.absoluteTimer) clearTimeout(this.absoluteTimer); if (this.idleTimer) clearTimeout(this.idleTimer); }
}

class DurableProcessLease implements ProcessLease {
  constructor(private readonly registry: OperationRegistry, private readonly operationId: string, readonly id: string, private readonly cancelRun?: () => Promise<void>) {}
  spawning(): void { this.registry.transitionProcess(this.operationId, this.id, 'spawning', 'process.spawn.started'); }
  started(pid: number): void { this.registry.transitionProcess(this.operationId, this.id, 'started', 'process.started', { pid }); }
  ready(): void { this.registry.transitionProcess(this.operationId, this.id, 'ready', 'process.ready'); }
  activity(): void { this.registry.activity(this.operationId, this.id); }
  failed(code: OperationSafeCode, error: string): void { this.registry.transitionProcess(this.operationId, this.id, 'spawn-failed', 'process.failed', { safeCode: code, errorType: error }); }
  exited(exitClass: 'zero' | 'nonzero' | 'signal'): void { this.registry.transitionProcess(this.operationId, this.id, exitClass === 'signal' ? 'signalled' : 'exited', 'process.exit', { exitClass }); }
  cleanup(): void { this.registry.cleanupProcess(this.operationId, this.id); }
  async cancel(): Promise<void> { await this.cancelRun?.(); this.cleanup(); }
}

function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state')); }
function validateStartOperation(request: StartOperation): void {
  const allowed = new Set(['id', 'kind', 'correlations', 'absoluteTimeoutMs', 'idleTimeoutMs', 'cancellable']);
  if (Object.keys(request).some(key => !allowed.has(key))) throw new Error('Operation request contains unknown fields');
  if (!OPERATION_KINDS.has(request.kind)) throw new Error('Operation kind is invalid');
  for (const timeout of [request.absoluteTimeoutMs, request.idleTimeoutMs]) {
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 86_400_000)) throw new Error('Operation timeout is invalid');
  }
  if (request.correlations) {
    const correlationKeys = new Set(['projectId', 'taskId', 'runId', 'attemptId', 'sessionId', 'worktreeId']);
    if (Object.keys(request.correlations).some(key => !correlationKeys.has(key))) throw new Error('Operation correlations contain unknown fields');
    for (const value of Object.values(request.correlations)) if (value !== undefined && !SAFE_ID.test(value)) throw new Error('Operation correlation is invalid');
  }
}
function errorType(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
class CleanupTimeoutError extends Error { constructor() { super('Operation cleanup exceeded its bound'); this.name = 'CleanupTimeoutError'; } }
function logOperation(eventName: string, operationId: string, safeCode?: OperationSafeCode, error?: string): void {
  const fields = { operationId, ...(safeCode ? { safeCode } : {}), ...(error ? { errorType: error } : {}) };
  if (eventName.endsWith('failed')) console.error('[kogg:operations:registry] operation.failed', fields);
  else if (eventName.includes('timeout')) console.warn('[kogg:operations:registry] operation.timeout', fields);
  else if (eventName.includes('refused')) console.warn('[kogg:operations:registry] operation.refused', fields);
  else if (eventName.endsWith('cancelling')) console.info('[kogg:operations:registry] operation.cancelling', fields);
  else if (eventName.endsWith('cancelled')) console.info('[kogg:operations:registry] operation.cancelled', fields);
  else if (eventName.endsWith('stalled')) console.warn('[kogg:operations:registry] operation.stalled', fields);
  else if (eventName.endsWith('completed')) console.info('[kogg:operations:registry] operation.completed', fields);
  else if (eventName.endsWith('active')) console.info('[kogg:operations:registry] operation.active', fields);
  else if (eventName.endsWith('waiting')) console.info('[kogg:operations:registry] operation.waiting', fields);
  else console.info('[kogg:operations:registry] operation.started', fields);
}
function logProcess(eventName: string, operationId: string, processId: string, state: ProcessState, values: {
  readonly safeCode?: OperationSafeCode; readonly errorType?: string; readonly exitClass?: string;
}): void {
  const fields = { operationId, processId, processState: state, ...(values.safeCode ? { safeCode: values.safeCode } : {}), ...(values.exitClass ? { exitClass: values.exitClass } : {}), ...(values.errorType ? { errorType: values.errorType } : {}) };
  if (eventName.endsWith('failed')) console.error('[kogg:operations:process] process.failed', fields);
  else if (eventName.endsWith('exit')) console.info('[kogg:operations:process] process.exit', fields);
  else if (eventName.endsWith('ready')) console.info('[kogg:operations:process] process.ready', fields);
  else if (eventName.includes('spawn')) console.info('[kogg:operations:process] process.spawn.started', fields);
  else console.info('[kogg:operations:process] process.started', fields);
}
function fingerprintFor(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = linuxStat(pid);
      return `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.startTime}:${stat.processGroup}:${stat.session}`;
    }
    // macOS and Windows deliberately remain unqualified for restart identity.
    // A live durable PID on either platform is classified unverified and is never signalled.
    return undefined;
  } catch {
    // observability-exempt: Unreadable or exited process identity is returned as unverified and recovery logs the resulting decision.
    return undefined;
  }
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && existsSync(`/proc/${pid}/stat`)) return linuxStat(pid).state !== 'Z';
    return true;
  } catch {
    // observability-exempt: ESRCH and unreadable proc state both mean this observation found no live owned process.
    return false;
  }
}
async function terminate(pid: number): Promise<void> {
  try { if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM'); else process.kill(pid, 'SIGTERM'); } catch {
    // observability-exempt: ESRCH proves the reconciled process is already absent; recovery emits the terminal lifecycle result.
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && isAlive(pid)) await new Promise(resolve => setTimeout(resolve, 25));
  if (isAlive(pid)) {
    try { if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL'); else process.kill(pid, 'SIGKILL'); } catch {
      // observability-exempt: ESRCH after the grace period means the owned process exited before escalation.
      return;
    }
    const forcedDeadline = Date.now() + 2_000;
    while (Date.now() < forcedDeadline && isAlive(pid)) await new Promise(resolve => setTimeout(resolve, 25));
    if (isAlive(pid)) throw new Error('Owned process remained after forced cleanup');
  }
}

function linuxStat(pid: number): { state: string; processGroup: string; session: string; startTime: string } {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
  const commandEnd = raw.lastIndexOf(')');
  if (commandEnd < 0) throw new Error('Linux process identity is malformed');
  const fields = raw.slice(commandEnd + 2).split(' ');
  if (!fields[0] || !fields[2] || !fields[3] || !fields[19]) throw new Error('Linux process identity is incomplete');
  return { state: fields[0], processGroup: fields[2], session: fields[3], startTime: fields[19] };
}
