import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { TaskProjectionAuthority, type TaskProjection, type TaskProjectionAuthority as TaskAuthority } from '@kogg/tasks/lib/common/tasks-protocol';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  InteractionModeV1, KoggInteractionModesService, ModeCapabilityV1, ModeOperationRequestV1, ModeOperationResultV1,
  ModeOperationV1, ModeProjectionV1, ModeReadRequestV1, ModeSafeCodeV1
} from '../common/interaction-modes-protocol';
import { modeLog, modeLoggingDiagnostics } from './interaction-modes-logger';

// Durable task-mode authority defaults to Plan, verifies exact task bindings before every operation, and exposes no transition shortcut.
// modeLog routes every registry lifecycle event through [kogg:interaction-modes:service].
// diagnostic-coverage: interaction-modes.registry, interaction-modes.authority, interaction-modes.operations, interaction-modes.restoration
type Row = Record<string, SQLOutputValue>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPERATION_CAPABILITY: Readonly<Record<ModeOperationV1, ModeCapabilityV1>> = {
  research: 'research.read', 'plan-save': 'plan.write', 'plan-approval-request': 'plan.approval-request',
  'worktree-create': 'worktree.create', 'private-mutate': 'repository.mutate-private', 'build-tool': 'tool.execute-build',
  'governed-entry': 'workflow.compile-governed', 'evidence-request': 'evidence.request',
  'verdict-observe-current': 'verdict.observe', 'merge-controlled': 'merge.request-controlled'
};
const CEILINGS: Readonly<Record<InteractionModeV1, readonly ModeCapabilityV1[]>> = {
  plan: ['research.read', 'plan.write', 'plan.approval-request', 'provider.invoke-advisory'],
  build: ['research.read', 'plan.write', 'plan.approval-request', 'worktree.create', 'repository.mutate-private', 'tool.execute-build', 'provider.invoke-advisory', 'provider.invoke-mutating', 'check.run-untrusted'],
  kogg: ['research.read', 'plan.write', 'plan.approval-request', 'worktree.create', 'repository.mutate-private', 'tool.execute-build', 'provider.invoke-advisory', 'provider.invoke-mutating', 'check.run-untrusted', 'workflow.compile-governed', 'workflow.run-governed', 'approval.consume', 'check.run-independent', 'evidence.request', 'verdict.observe', 'merge.request-controlled']
};

export interface InteractionModeDiagnostics {
  readonly integrity: boolean; readonly eventChain: boolean; readonly admission: 'enabled' | 'blocked';
  readonly modeCount: number; readonly degradedCount: number; readonly requestCount: number; readonly loggingViolationCount: number;
}

@injectable()
export class InteractionModeRegistry implements KoggInteractionModesService, BackendApplicationContribution {
  private database: DatabaseSync | undefined; private startup: Promise<void> | undefined;
  private readonly databasePath = path.join(stateRoot(), 'interaction-modes', 'registry.sqlite3');
  constructor(@inject(TaskProjectionAuthority) private readonly tasks: TaskAuthority) {}

  onStart(): Promise<void> { return this.ensureStarted(); }
  onStop(): void { this.database?.close(); this.database = undefined; this.startup = undefined; }

  async get(request: ModeReadRequestV1): Promise<ModeProjectionV1> {
    validateRead(request); await this.ensureStarted(); const task = await this.resolveTask(request.taskId);
    const existing = this.row(request.taskId); const projection = existing ? this.project(existing, task) : this.createPlan(task);
    modeLog(existing && projection.state === 'ready' ? 'mode.restored' : 'mode.selected', { requestId: request.requestId, taskId: request.taskId, selectedMode: projection.selectedMode, safeCode: projection.safeCode });
    return projection;
  }

  async authorizeOperation(request: ModeOperationRequestV1): Promise<ModeOperationResultV1> {
    validateOperation(request); await this.ensureStarted();
    const digest = requestDigest(request); const replay = this.db().prepare('SELECT request_digest,result_json FROM requests WHERE request_id=?').get(request.requestId) as Row | undefined;
    if (replay) {
      if (String(replay.request_digest) !== digest) throw new InteractionModeError('MODE_REQUEST_CONFLICT');
      const prior = JSON.parse(String(replay.result_json)) as ModeOperationResultV1; const task = await this.resolveTask(request.taskId); const row = this.row(request.taskId);
      const current = row ? this.project(row, task) : this.createPlan(task);
      if (prior.allowed && (current.state !== 'ready' || current.taskRevision !== prior.projection.taskRevision || current.sequence !== prior.projection.sequence)) {
        const refused: ModeOperationResultV1 = { schemaVersion: 1, allowed: false, safeCode: current.safeCode === 'MODE_OK' ? 'MODE_TASK_STALE' : current.safeCode, projection: current };
        modeLog('mode.operation.refused', { requestId: request.requestId, taskId: request.taskId, selectedMode: current.selectedMode, operation: request.operation, safeCode: refused.safeCode }); return refused;
      }
      return prior;
    }
    const task = await this.resolveTask(request.taskId); const row = this.row(request.taskId); const projection = row ? this.project(row, task) : this.createPlan(task);
    modeLog('mode.operation.requested', { requestId: request.requestId, taskId: request.taskId, selectedMode: projection.selectedMode, operation: request.operation });
    const capability = OPERATION_CAPABILITY[request.operation]; const allowed = projection.state === 'ready' && projection.effectiveCapabilities.includes(capability);
    const safeCode = allowed ? 'MODE_OK' : operationRefusal(projection.selectedMode, request.operation, projection.safeCode);
    const result: ModeOperationResultV1 = { schemaVersion: 1, allowed, safeCode, projection };
    this.transaction(database => database.prepare('INSERT INTO requests(request_id,request_digest,result_json,created_at) VALUES(?,?,?,?)').run(request.requestId, digest, JSON.stringify(result), new Date().toISOString()));
    modeLog(allowed ? 'mode.operation.approved' : 'mode.operation.refused', { requestId: request.requestId, taskId: request.taskId, selectedMode: projection.selectedMode, operation: request.operation, safeCode });
    return result;
  }

  diagnostics(): InteractionModeDiagnostics {
    const db = this.db(); const count = (sql: string): number => Number((db.prepare(sql).get() as Row).count);
    return { integrity: String((db.prepare('PRAGMA integrity_check').get() as Row).integrity_check) === 'ok', eventChain: verifyEvents(db), admission: metaAdmission(db),
      modeCount: count('SELECT count(*) AS count FROM task_modes'), degradedCount: count("SELECT count(*) AS count FROM task_modes WHERE state!='ready'"),
      requestCount: count('SELECT count(*) AS count FROM requests'), loggingViolationCount: modeLoggingDiagnostics().violationCount };
  }

  private async ensureStarted(): Promise<void> { if (this.database) return; this.startup ??= this.startDatabase(); return this.startup; }
  private async startDatabase(): Promise<void> {
    modeLog('registry.start.requested', {});
    try {
      await mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;'); this.migrate();
      if (process.platform !== 'win32') await chmod(this.databasePath, 0o600);
      if (String((this.db().prepare('PRAGMA integrity_check').get() as Row).integrity_check) !== 'ok' || !verifyEvents(this.db())) throw new InteractionModeError('MODE_REGISTRY_INTEGRITY_FAILED');
      this.db().prepare("UPDATE mode_meta SET admission='enabled' WHERE singleton=1").run();
      modeLog('registry.start.completed', { restoredCount: Number((this.db().prepare('SELECT count(*) AS count FROM task_modes').get() as Row).count) });
    } catch (error) {
      modeLog('registry.start.failed', { safeCode: error instanceof InteractionModeError ? error.code : 'MODE_REGISTRY_UNAVAILABLE', errorType: error instanceof Error ? error.name : 'UnknownError' });
      this.database?.close(); this.database = undefined; this.startup = undefined; throw error;
    }
  }
  private migrate(): void { this.db().exec(`
    CREATE TABLE IF NOT EXISTS mode_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),admission TEXT NOT NULL CHECK(admission IN ('enabled','blocked')));
    CREATE TABLE IF NOT EXISTS task_modes(task_id TEXT PRIMARY KEY,task_revision TEXT NOT NULL,project_id TEXT NOT NULL,repository_id TEXT NOT NULL,selected_mode TEXT NOT NULL CHECK(selected_mode IN ('plan','build','kogg')),effective_digest TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=0),state TEXT NOT NULL CHECK(state IN ('ready','restore-degraded','quarantined')),active_stage TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mode_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,event_name TEXT NOT NULL,safe_code TEXT NOT NULL,previous_digest TEXT NOT NULL,event_digest TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS mode_events_no_update BEFORE UPDATE ON mode_events BEGIN SELECT RAISE(ABORT,'immutable mode event'); END;
    CREATE TRIGGER IF NOT EXISTS mode_events_no_delete BEFORE DELETE ON mode_events BEGIN SELECT RAISE(ABORT,'immutable mode event'); END;
    INSERT OR IGNORE INTO mode_meta VALUES(1,1,'blocked');
  `); }
  private async resolveTask(taskId: string): Promise<TaskProjection> {
    try { const task = await this.tasks.get(taskId); if (task.lifecycle !== 'active') throw new InteractionModeError('MODE_TASK_UNAVAILABLE'); return task; }
    catch (error) { if (error instanceof InteractionModeError) throw error; throw new InteractionModeError('MODE_TASK_UNAVAILABLE'); }
  }
  private row(taskId: string): Row | undefined { return this.db().prepare('SELECT * FROM task_modes WHERE task_id=?').get(taskId) as Row | undefined; }
  private createPlan(task: TaskProjection): ModeProjectionV1 {
    const now = new Date().toISOString(); const capabilities = CEILINGS.plan; const effectiveDigest = capabilityDigest(capabilities);
    this.transaction(database => { database.prepare("INSERT INTO task_modes VALUES(?,?,?,?, 'plan',?,0,'ready','research',?)").run(task.taskId, task.taskRevision, task.projectId, task.repositoryId, effectiveDigest, now); appendEvent(database, task.taskId, 'mode.selected', 'MODE_OK'); });
    return { schemaVersion: 1, taskId: task.taskId, projectId: task.projectId, repositoryId: task.repositoryId, taskRevision: task.taskRevision, selectedMode: 'plan', effectiveCapabilities: capabilities, sequence: '0', state: 'ready', activeStage: 'research', safeCode: 'MODE_OK' };
  }
  private project(row: Row, task: TaskProjection): ModeProjectionV1 {
    const selectedMode = String(row.selected_mode) as InteractionModeV1; const current = String(row.task_revision) === task.taskRevision && String(row.project_id) === task.projectId && String(row.repository_id) === task.repositoryId;
    return { schemaVersion: 1, taskId: task.taskId, projectId: task.projectId, repositoryId: task.repositoryId, taskRevision: task.taskRevision, selectedMode,
      effectiveCapabilities: current ? CEILINGS[selectedMode] : [], sequence: String(row.sequence), state: current ? String(row.state) as ModeProjectionV1['state'] : 'restore-degraded',
      activeStage: String(row.active_stage), safeCode: current ? 'MODE_OK' : 'MODE_RESTORE_DEGRADED' };
  }
  private transaction<T>(run: (database: DatabaseSync) => T): T { const database = this.db(); database.exec('BEGIN IMMEDIATE'); try { const result = run(database); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } }
  private db(): DatabaseSync { if (!this.database) throw new InteractionModeError('MODE_REGISTRY_UNAVAILABLE'); return this.database; }
}

export class InteractionModeError extends Error { constructor(readonly code: ModeSafeCodeV1) { super(code); this.name = 'InteractionModeError'; } }
function validateRead(request: ModeReadRequestV1): void { if (!request || Object.keys(request).sort().join(',') !== 'requestId,taskId' || !UUID.test(request.requestId) || !UUID.test(request.taskId)) throw new InteractionModeError('MODE_PROTOCOL_INVALID'); }
function validateOperation(request: ModeOperationRequestV1): void { if (!request || Object.keys(request).sort().join(',') !== 'operation,requestId,taskId' || !UUID.test(request.requestId) || !UUID.test(request.taskId) || !Object.hasOwn(OPERATION_CAPABILITY, request.operation)) throw new InteractionModeError('MODE_PROTOCOL_INVALID'); }
function requestDigest(request: ModeOperationRequestV1): string { return digest('kogg:interaction-modes:operation-request:v1', JSON.stringify({ operation: request.operation, requestId: request.requestId, taskId: request.taskId })); }
function capabilityDigest(capabilities: readonly ModeCapabilityV1[]): string { return digest('kogg:interaction-modes:effective-capabilities:v1', JSON.stringify([...capabilities].sort())); }
function operationRefusal(mode: InteractionModeV1, operation: ModeOperationV1, projectionCode: ModeSafeCodeV1): ModeSafeCodeV1 {
  if (projectionCode !== 'MODE_OK') return projectionCode; if (mode === 'plan') return 'PLAN_MUTATION_REFUSED';
  if (operation === 'evidence-request') return 'BUILD_EVIDENCE_REFUSED'; if (operation === 'verdict-observe-current') return 'BUILD_VERDICT_REFUSED';
  if (operation === 'merge-controlled') return 'BUILD_MERGE_REFUSED'; return 'MODE_AUTHORITY_REFUSED';
}
function appendEvent(database: DatabaseSync, taskId: string, eventName: string, safeCode: ModeSafeCodeV1): void {
  const previous = database.prepare('SELECT event_digest FROM mode_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousDigest = previous ? String(previous.event_digest) : `sha256:${'0'.repeat(64)}`; const createdAt = new Date().toISOString();
  const eventDigest = digest('kogg:interaction-modes:event:v1', JSON.stringify({ createdAt, eventName, previousDigest, safeCode, taskId }));
  database.prepare('INSERT INTO mode_events(task_id,event_name,safe_code,previous_digest,event_digest,created_at) VALUES(?,?,?,?,?,?)').run(taskId, eventName, safeCode, previousDigest, eventDigest, createdAt);
}
function verifyEvents(database: DatabaseSync): boolean { let previous = `sha256:${'0'.repeat(64)}`; for (const row of database.prepare('SELECT * FROM mode_events ORDER BY sequence').all() as Row[]) { const expected = digest('kogg:interaction-modes:event:v1', JSON.stringify({ createdAt: String(row.created_at), eventName: String(row.event_name), previousDigest: previous, safeCode: String(row.safe_code), taskId: String(row.task_id) })); if (String(row.previous_digest) !== previous || String(row.event_digest) !== expected) return false; previous = expected; } return true; }
function metaAdmission(database: DatabaseSync): InteractionModeDiagnostics['admission'] { return String((database.prepare('SELECT admission FROM mode_meta WHERE singleton=1').get() as Row).admission) as InteractionModeDiagnostics['admission']; }
function digest(domain: string, value: string): string { return `sha256:${createHash('sha256').update(`${domain}\0${value}`).digest('hex')}`; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state')); }
