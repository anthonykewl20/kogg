import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { TaskProjectionAuthority, type TaskProjection, type TaskProjectionAuthority as TaskAuthority } from '@kogg/tasks/lib/common/tasks-protocol';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import type {
  InteractionModeV1, ModeCapabilityV1, ModeOperationRequestV1, ModeOperationResultV1,
  ModeOperationV1, ModeProjectionV1, ModeReadRequestV1, ModeSafeCodeV1, ModeTransitionCancelRequestV1,
  ModeTransitionProjectionV1, ModeTransitionRequestV1, ModeTransitionStateV1
} from '../common/interaction-modes-protocol';
import { modeLog, modeLoggingDiagnostics } from './interaction-modes-logger';
import { ModeTransitionAuthority, type ModeTransitionContextV1, transitionScopeDigest } from './mode-transition-authority';

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
  readonly modeCount: number; readonly degradedCount: number; readonly requestCount: number; readonly transitionCount: number;
  readonly pendingTransitionCount: number; readonly loggingViolationCount: number;
}

@injectable()
export class InteractionModeRegistry implements BackendApplicationContribution {
  private database: DatabaseSync | undefined; private startup: Promise<void> | undefined;
  private readonly databasePath = path.join(stateRoot(), 'interaction-modes', 'registry.sqlite3');
  constructor(
    @inject(TaskProjectionAuthority) private readonly tasks: TaskAuthority,
    @inject(ModeTransitionAuthority) private readonly transitionAuthority: ModeTransitionAuthority,
    @unmanaged() private readonly now: () => Date = () => new Date()
  ) {}

  onStart(): Promise<void> { return this.ensureStarted(); }
  onStop(): void { this.database?.close(); this.database = undefined; this.startup = undefined; }

  async get(request: ModeReadRequestV1): Promise<ModeProjectionV1> {
    validateRead(request); await this.ensureStarted(); this.expireChallenges(); const task = await this.resolveTask(request.taskId);
    const existing = this.row(request.taskId); const projection = existing ? this.project(existing, task) : this.createPlan(task);
    modeLog(existing && projection.state === 'ready' ? 'mode.restored' : 'mode.selected', { requestId: request.requestId, taskId: request.taskId, selectedMode: projection.selectedMode, safeCode: projection.safeCode });
    return projection;
  }

  async getPendingTransition(request: ModeReadRequestV1): Promise<ModeTransitionProjectionV1 | undefined> {
    validateRead(request); await this.ensureStarted(); this.expireChallenges(); const task = await this.resolveTask(request.taskId);
    const row = this.db().prepare("SELECT transition_id FROM mode_transitions WHERE task_id=? AND state IN ('awaiting-confirmation','cleanup-pending') ORDER BY created_at DESC LIMIT 1").get(request.taskId) as Row | undefined;
    if (!row) return undefined;
    const projection = this.transitionProjection(String(row.transition_id), task);
    modeLog('mode.transition.restored', { requestId: request.requestId, taskId: request.taskId, fromMode: projection.fromMode, toMode: projection.toMode, safeCode: projection.safeCode });
    return projection;
  }

  async authorizeOperation(request: ModeOperationRequestV1): Promise<ModeOperationResultV1> {
    validateOperation(request); await this.ensureStarted(); this.expireChallenges();
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

  async requestTransition(request: ModeTransitionRequestV1, context: ModeTransitionContextV1): Promise<ModeTransitionProjectionV1> {
    validateTransitionRequest(request); const requestDigest = transitionScopeDigest('request', request);
    const actor = this.transitionAuthority.verify(context, requestDigest);
    if (!actor) {
      modeLog('mode.transition.refused', { requestId: request.requestId, taskId: request.taskId, fromMode: request.fromMode, toMode: request.toMode, safeCode: 'MODE_AUTHORITY_REFUSED' });
      throw new InteractionModeError('MODE_AUTHORITY_REFUSED');
    }
    await this.ensureStarted(); this.expireChallenges();
    const replay = this.transitionReplay(request.requestId, requestDigest); if (replay) return replay;
    const task = await this.resolveTask(request.taskId); let row = this.row(request.taskId); if (!row) { this.createPlan(task); row = this.row(request.taskId); }
    if (!row) throw new InteractionModeError('MODE_REGISTRY_UNAVAILABLE');
    const current = this.project(row, task); modeLog('mode.transition.requested', { requestId: request.requestId, taskId: request.taskId, fromMode: request.fromMode, toMode: request.toMode });
    if (current.state !== 'ready' || current.sequence !== request.expectedSequence || current.selectedMode !== request.fromMode) {
      modeLog('mode.transition.refused', { requestId: request.requestId, taskId: request.taskId, fromMode: request.fromMode, toMode: request.toMode, safeCode: 'MODE_TRANSITION_CONFLICT' });
      throw new InteractionModeError('MODE_TRANSITION_CONFLICT');
    }
    const direction = transitionDirection(request.fromMode, request.toMode); const createdAt = this.now();
    const expiresAt = direction === 'expand' ? new Date(createdAt.getTime() + 120_000).toISOString() : undefined;
    const challengeDigest = direction === 'expand' ? digest('kogg:interaction-modes:expansion-challenge:v1', JSON.stringify({
      actorAuthorityDigest: actor.actorAuthorityDigest, expiresAt, fromMode: request.fromMode, requestedConfigurationDigest: request.requestedConfigurationDigest,
      sessionId: actor.sessionId, taskId: request.taskId, toMode: request.toMode, transitionId: request.transitionId
    })) : undefined;
    const state: ModeTransitionStateV1 = direction === 'preserve' ? 'committed' : direction === 'expand' ? 'awaiting-confirmation' : 'cleanup-pending';
    const safeCode: ModeSafeCodeV1 = direction === 'preserve' ? 'MODE_OK' : direction === 'expand' ? 'MODE_EXPANSION_CONFIRMATION_REQUIRED' : 'MODE_ACTIVE_OPERATION';
    const transitionDigest = transitionIntentDigest({ transition_id: request.transitionId, request_id: request.requestId, task_id: request.taskId,
      expected_sequence: Number(request.expectedSequence), from_mode: request.fromMode, to_mode: request.toMode, direction,
      configuration_digest: request.requestedConfigurationDigest, actor_authority_digest: actor.actorAuthorityDigest, session_id: actor.sessionId,
      challenge_digest: challengeDigest ?? null, created_at: createdAt.toISOString(), expires_at: expiresAt ?? null });
    let projection: ModeTransitionProjectionV1 | undefined;
    this.transaction(database => {
      database.prepare('INSERT INTO mode_transitions(transition_id,request_id,task_id,expected_sequence,from_mode,to_mode,direction,configuration_digest,actor_authority_digest,session_id,state,safe_code,challenge_digest,created_at,expires_at,transition_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(request.transitionId, request.requestId, request.taskId, Number(request.expectedSequence), request.fromMode, request.toMode, direction, request.requestedConfigurationDigest, actor.actorAuthorityDigest, actor.sessionId, state, safeCode, challengeDigest ?? null, createdAt.toISOString(), expiresAt ?? null, transitionDigest);
      appendEvent(database, request.taskId, `mode.transition.${state}`, safeCode, request.transitionId, transitionDigest);
      projection = this.transitionProjection(request.transitionId, task);
      database.prepare('INSERT INTO transition_requests VALUES(?,?,?,?)').run(request.requestId, requestDigest, JSON.stringify(projection), createdAt.toISOString());
    });
    if (!projection) throw new InteractionModeError('MODE_REGISTRY_UNAVAILABLE');
    modeLog(direction === 'expand' ? 'mode.transition.awaiting-confirmation' : direction === 'reduce' ? 'mode.transition.cleanup-pending' : 'mode.transition.committed', {
      requestId: request.requestId, taskId: request.taskId, fromMode: request.fromMode, toMode: request.toMode, safeCode
    });
    return projection;
  }

  async cancelTransition(request: ModeTransitionCancelRequestV1, context: ModeTransitionContextV1): Promise<ModeTransitionProjectionV1> {
    validateTransitionCancel(request); const requestDigest = transitionScopeDigest('cancel', request);
    if (!this.transitionAuthority.verify(context, requestDigest)) throw new InteractionModeError('MODE_AUTHORITY_REFUSED');
    await this.ensureStarted(); this.expireChallenges(); const replay = this.transitionReplay(request.requestId, requestDigest); if (replay) return replay;
    const transition = this.db().prepare('SELECT * FROM mode_transitions WHERE transition_id=? AND task_id=?').get(request.transitionId, request.taskId) as Row | undefined;
    if (!transition) throw new InteractionModeError('MODE_TRANSITION_CONFLICT');
    const state = String(transition.state) as ModeTransitionStateV1;
    if (state !== 'awaiting-confirmation' && state !== 'cleanup-pending') throw new InteractionModeError('MODE_TRANSITION_CONFLICT');
    const task = await this.resolveTask(request.taskId);
    let projection: ModeTransitionProjectionV1 | undefined;
    this.transaction(database => { database.prepare("UPDATE mode_transitions SET state='cancelled',safe_code='MODE_OK' WHERE transition_id=?").run(request.transitionId); appendEvent(database, request.taskId, 'mode.transition.cancelled', 'MODE_OK', request.transitionId, String(transition.transition_digest)); projection = this.transitionProjection(request.transitionId, task); database.prepare('INSERT INTO transition_requests VALUES(?,?,?,?)').run(request.requestId, requestDigest, JSON.stringify(projection), new Date().toISOString()); });
    if (!projection) throw new InteractionModeError('MODE_REGISTRY_UNAVAILABLE');
    modeLog('mode.transition.cancelled', { requestId: request.requestId, taskId: request.taskId, fromMode: String(transition.from_mode) as InteractionModeV1, toMode: String(transition.to_mode) as InteractionModeV1, safeCode: 'MODE_OK' });
    return projection;
  }

  diagnostics(): InteractionModeDiagnostics {
    this.expireChallenges(); const db = this.db(); const count = (sql: string): number => Number((db.prepare(sql).get() as Row).count);
    return { integrity: String((db.prepare('PRAGMA integrity_check').get() as Row).integrity_check) === 'ok', eventChain: verifyEvents(db) && verifyTransitions(db), admission: metaAdmission(db),
      modeCount: count('SELECT count(*) AS count FROM task_modes'), degradedCount: count("SELECT count(*) AS count FROM task_modes WHERE state!='ready'"),
      requestCount: count('SELECT count(*) AS count FROM requests'), transitionCount: count('SELECT count(*) AS count FROM mode_transitions'),
      pendingTransitionCount: count("SELECT count(*) AS count FROM mode_transitions WHERE state IN ('awaiting-confirmation','cleanup-pending')"), loggingViolationCount: modeLoggingDiagnostics().violationCount };
  }

  private async ensureStarted(): Promise<void> { if (this.database) return; this.startup ??= this.startDatabase(); return this.startup; }
  private async startDatabase(): Promise<void> {
    modeLog('registry.start.requested', {});
    try {
      await mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;'); this.migrate();
      if (process.platform !== 'win32') await chmod(this.databasePath, 0o600);
      if (String((this.db().prepare('PRAGMA integrity_check').get() as Row).integrity_check) !== 'ok' || !verifyEvents(this.db()) || !verifyTransitions(this.db())) throw new InteractionModeError('MODE_REGISTRY_INTEGRITY_FAILED');
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
    CREATE TABLE IF NOT EXISTS mode_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,event_name TEXT NOT NULL,safe_code TEXT NOT NULL,subject_id TEXT NOT NULL,subject_digest TEXT NOT NULL,previous_digest TEXT NOT NULL,event_digest TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mode_transitions(transition_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,expected_sequence INTEGER NOT NULL CHECK(expected_sequence>=0),from_mode TEXT NOT NULL CHECK(from_mode IN ('plan','build','kogg')),to_mode TEXT NOT NULL CHECK(to_mode IN ('plan','build','kogg')),direction TEXT NOT NULL CHECK(direction IN ('preserve','reduce','expand')),configuration_digest TEXT NOT NULL,actor_authority_digest TEXT NOT NULL,session_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('committed','awaiting-confirmation','cleanup-pending','cancelled','expired')),safe_code TEXT NOT NULL,challenge_digest TEXT,created_at TEXT NOT NULL,expires_at TEXT,transition_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transition_requests(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
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
    const pending = current && !!this.db().prepare("SELECT 1 FROM mode_transitions WHERE task_id=? AND state IN ('awaiting-confirmation','cleanup-pending') LIMIT 1").get(task.taskId);
    return { schemaVersion: 1, taskId: task.taskId, projectId: task.projectId, repositoryId: task.repositoryId, taskRevision: task.taskRevision, selectedMode,
      effectiveCapabilities: current && !pending ? CEILINGS[selectedMode] : [], sequence: String(row.sequence), state: !current ? 'restore-degraded' : pending ? 'transition-pending' : String(row.state) as ModeProjectionV1['state'],
      activeStage: String(row.active_stage), safeCode: !current ? 'MODE_RESTORE_DEGRADED' : pending ? 'MODE_ACTIVE_OPERATION' : 'MODE_OK' };
  }
  private transitionReplay(requestId: string, requestDigest: string): ModeTransitionProjectionV1 | undefined { const row = this.db().prepare('SELECT request_digest,result_json FROM transition_requests WHERE request_id=?').get(requestId) as Row | undefined; if (!row) return undefined; if (String(row.request_digest) !== requestDigest) throw new InteractionModeError('MODE_REQUEST_CONFLICT'); return JSON.parse(String(row.result_json)) as ModeTransitionProjectionV1; }
  private transitionProjection(transitionId: string, task: TaskProjection): ModeTransitionProjectionV1 { const row = this.db().prepare('SELECT * FROM mode_transitions WHERE transition_id=?').get(transitionId) as Row | undefined; if (!row) throw new InteractionModeError('MODE_TRANSITION_CONFLICT'); const modeRow = this.row(task.taskId); if (!modeRow) throw new InteractionModeError('MODE_TRANSITION_CONFLICT'); const result: ModeTransitionProjectionV1 = { schemaVersion: 1, transitionId, taskId: task.taskId, fromMode: String(row.from_mode) as InteractionModeV1, toMode: String(row.to_mode) as InteractionModeV1, direction: String(row.direction) as ModeTransitionProjectionV1['direction'], state: String(row.state) as ModeTransitionStateV1, safeCode: String(row.safe_code) as ModeSafeCodeV1, mode: this.project(modeRow, task) }; if (row.challenge_digest) Object.assign(result, { challengeDigest: String(row.challenge_digest), expiresAt: String(row.expires_at) }); return result; }
  private expireChallenges(): void { const rows = this.db().prepare("SELECT transition_id,task_id,from_mode,to_mode,transition_digest FROM mode_transitions WHERE state='awaiting-confirmation' AND expires_at<=?").all(this.now().toISOString()) as Row[]; if (!rows.length) return; this.transaction(database => { for (const row of rows) { database.prepare("UPDATE mode_transitions SET state='expired',safe_code='MODE_TRANSITION_EXPIRED' WHERE transition_id=? AND state='awaiting-confirmation'").run(String(row.transition_id)); appendEvent(database, String(row.task_id), 'mode.transition.expired', 'MODE_TRANSITION_EXPIRED', String(row.transition_id), String(row.transition_digest)); } }); for (const row of rows) modeLog('mode.transition.expired', { taskId: String(row.task_id), fromMode: String(row.from_mode) as InteractionModeV1, toMode: String(row.to_mode) as InteractionModeV1, safeCode: 'MODE_TRANSITION_EXPIRED' }); }
  private transaction<T>(run: (database: DatabaseSync) => T): T { const database = this.db(); database.exec('BEGIN IMMEDIATE'); try { const result = run(database); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } }
  private db(): DatabaseSync { if (!this.database) throw new InteractionModeError('MODE_REGISTRY_UNAVAILABLE'); return this.database; }
}

export class InteractionModeError extends Error { constructor(readonly code: ModeSafeCodeV1) { super(code); this.name = 'InteractionModeError'; } }
function validateRead(request: ModeReadRequestV1): void { if (!request || Object.keys(request).sort().join(',') !== 'requestId,taskId' || !UUID.test(request.requestId) || !UUID.test(request.taskId)) throw new InteractionModeError('MODE_PROTOCOL_INVALID'); }
function validateOperation(request: ModeOperationRequestV1): void { if (!request || Object.keys(request).sort().join(',') !== 'operation,requestId,taskId' || !UUID.test(request.requestId) || !UUID.test(request.taskId) || !Object.hasOwn(OPERATION_CAPABILITY, request.operation)) throw new InteractionModeError('MODE_PROTOCOL_INVALID'); }
function validateTransitionRequest(request: ModeTransitionRequestV1): void { if (!request || Object.keys(request).sort().join(',') !== 'expectedSequence,fromMode,requestId,requestedConfigurationDigest,taskId,toMode,transitionId' || !UUID.test(request.transitionId) || !UUID.test(request.requestId) || !UUID.test(request.taskId) || !/^(0|[1-9][0-9]*)$/u.test(request.expectedSequence) || !Object.hasOwn(CEILINGS, request.fromMode) || !Object.hasOwn(CEILINGS, request.toMode) || !/^sha256:[0-9a-f]{64}$/u.test(request.requestedConfigurationDigest)) throw new InteractionModeError('MODE_PROTOCOL_INVALID'); }
function validateTransitionCancel(request: ModeTransitionCancelRequestV1): void { if (!request || Object.keys(request).sort().join(',') !== 'requestId,taskId,transitionId' || !UUID.test(request.requestId) || !UUID.test(request.taskId) || !UUID.test(request.transitionId)) throw new InteractionModeError('MODE_PROTOCOL_INVALID'); }
function transitionDirection(fromMode: InteractionModeV1, toMode: InteractionModeV1): ModeTransitionProjectionV1['direction'] { if (fromMode === toMode) return 'preserve'; const from = new Set(CEILINGS[fromMode]); return CEILINGS[toMode].every(capability => from.has(capability)) ? 'reduce' : 'expand'; }
function requestDigest(request: ModeOperationRequestV1): string { return digest('kogg:interaction-modes:operation-request:v1', JSON.stringify({ operation: request.operation, requestId: request.requestId, taskId: request.taskId })); }
function capabilityDigest(capabilities: readonly ModeCapabilityV1[]): string { return digest('kogg:interaction-modes:effective-capabilities:v1', JSON.stringify([...capabilities].sort())); }
function operationRefusal(mode: InteractionModeV1, operation: ModeOperationV1, projectionCode: ModeSafeCodeV1): ModeSafeCodeV1 {
  if (projectionCode !== 'MODE_OK') return projectionCode; if (mode === 'plan') return 'PLAN_MUTATION_REFUSED';
  if (operation === 'evidence-request') return 'BUILD_EVIDENCE_REFUSED'; if (operation === 'verdict-observe-current') return 'BUILD_VERDICT_REFUSED';
  if (operation === 'merge-controlled') return 'BUILD_MERGE_REFUSED'; return 'MODE_AUTHORITY_REFUSED';
}
function appendEvent(database: DatabaseSync, taskId: string, eventName: string, safeCode: ModeSafeCodeV1, subjectId = '', subjectDigest = `sha256:${'0'.repeat(64)}`): void {
  const previous = database.prepare('SELECT event_digest FROM mode_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousDigest = previous ? String(previous.event_digest) : `sha256:${'0'.repeat(64)}`; const createdAt = new Date().toISOString();
  const eventDigest = digest('kogg:interaction-modes:event:v1', JSON.stringify({ createdAt, eventName, previousDigest, safeCode, subjectDigest, subjectId, taskId }));
  database.prepare('INSERT INTO mode_events(task_id,event_name,safe_code,subject_id,subject_digest,previous_digest,event_digest,created_at) VALUES(?,?,?,?,?,?,?,?)').run(taskId, eventName, safeCode, subjectId, subjectDigest, previousDigest, eventDigest, createdAt);
}
function verifyEvents(database: DatabaseSync): boolean { let previous = `sha256:${'0'.repeat(64)}`; for (const row of database.prepare('SELECT * FROM mode_events ORDER BY sequence').all() as Row[]) { const expected = digest('kogg:interaction-modes:event:v1', JSON.stringify({ createdAt: String(row.created_at), eventName: String(row.event_name), previousDigest: previous, safeCode: String(row.safe_code), subjectDigest: String(row.subject_digest), subjectId: String(row.subject_id), taskId: String(row.task_id) })); if (String(row.previous_digest) !== previous || String(row.event_digest) !== expected) return false; previous = expected; } return true; }
function verifyTransitions(database: DatabaseSync): boolean { for (const row of database.prepare('SELECT * FROM mode_transitions').all() as Row[]) { const transitionDigest = transitionIntentDigest(row); if (String(row.transition_digest) !== transitionDigest) return false; const event = database.prepare('SELECT event_name,safe_code,subject_digest FROM mode_events WHERE subject_id=? ORDER BY sequence DESC LIMIT 1').get(String(row.transition_id)) as Row | undefined; if (!event || String(event.event_name) !== `mode.transition.${String(row.state)}` || String(event.safe_code) !== String(row.safe_code) || String(event.subject_digest) !== transitionDigest) return false; } return true; }
function transitionIntentDigest(row: Row): string { return digest('kogg:interaction-modes:transition-intent:v1', JSON.stringify({ actorAuthorityDigest: String(row.actor_authority_digest), challengeDigest: row.challenge_digest === null ? null : String(row.challenge_digest), configurationDigest: String(row.configuration_digest), createdAt: String(row.created_at), direction: String(row.direction), expectedSequence: Number(row.expected_sequence), expiresAt: row.expires_at === null ? null : String(row.expires_at), fromMode: String(row.from_mode), requestId: String(row.request_id), sessionId: String(row.session_id), taskId: String(row.task_id), toMode: String(row.to_mode), transitionId: String(row.transition_id) })); }
function metaAdmission(database: DatabaseSync): InteractionModeDiagnostics['admission'] { return String((database.prepare('SELECT admission FROM mode_meta WHERE singleton=1').get() as Row).admission) as InteractionModeDiagnostics['admission']; }
function digest(domain: string, value: string): string { return `sha256:${createHash('sha256').update(`${domain}\0${value}`).digest('hex')}`; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state')); }
