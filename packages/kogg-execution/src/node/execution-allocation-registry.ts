import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { injectable } from '@theia/core/shared/inversify';
import type {
  ExecutionAllocationCode, ExecutionAllocationSummaryV1, ExecutionBindingV1, ExecutionState, ReserveExecutionAllocationV1
} from '../common/execution-protocol';

// Allocation identity and idempotency commit before external effects; ambiguous startup state is quarantined without pathname deletion or side-effect replay.
// diagnostic-coverage: execution.worktree-registry, execution.capacity, execution.recovery
type SqlRow = Record<string, SQLOutputValue>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SYMBOLIC = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const SHA1 = /^[0-9a-f]{40}$/u; const SHA256 = /^[0-9a-f]{64}$/u;
const BINDING_FIELDS = ['schemaVersion', 'projectId', 'projectRevision', 'repositoryId', 'repositoryBindingRevision', 'taskId',
  'taskRevisionId', 'taskRevisionDigest', 'approvalDigest', 'runId', 'attemptId', 'workflowPlanDigest', 'baseCommit', 'baseTree',
  'gitObjectFormat', 'targetId', 'qualificationId', 'qualificationDigest', 'profileId', 'profileDigest'] as const;

export interface ExecutionAllocationDiagnostics {
  readonly integrity: boolean; readonly foreignKeys: boolean; readonly permissions: boolean;
  readonly admission: 'enabled' | 'recovering' | 'blocked'; readonly activeCount: number;
  readonly quarantinedCount: number; readonly recoveryRequiredCount: number; readonly unverifiedCount: number;
  readonly cleanupFailureCount: number; readonly reservationCount: number;
  readonly loggingViolationCount: number;
}

@injectable()
export class ExecutionAllocationRegistry implements BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private startup: Promise<void> | undefined;
  private readonly ownerInstanceId = randomUUID();
  private readonly databasePath = path.join(stateRoot(), 'execution', 'registry.sqlite3');

  onStart(): Promise<void> { return this.ensureStarted(); }
  onStop(): void { this.database?.close(); this.database = undefined; this.startup = undefined; }

  async reserve(request: ReserveExecutionAllocationV1): Promise<ExecutionAllocationSummaryV1> {
    await this.ensureStarted(); validateRequest(request);
    const requestDigest = digest('kogg-execution-allocation-request-v1', canonicalRequest(request));
    const replay = this.databaseOrThrow().prepare('SELECT request_digest,worktree_id FROM request_results WHERE request_id=?').get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest) {
        log('request.refused', { requestId: request.requestId, runId: request.binding.runId, safeCode: 'ALLOCATION_REQUEST_REPLAY_MISMATCH' });
        throw new AllocationRegistryError('ALLOCATION_REQUEST_REPLAY_MISMATCH');
      }
      return this.summary(String(replay.worktree_id));
    }
    if (this.admission() !== 'enabled') {
      log('request.refused', { requestId: request.requestId, runId: request.binding.runId, safeCode: 'ALLOCATION_ADMISSION_BLOCKED' });
      throw new AllocationRegistryError('ALLOCATION_ADMISSION_BLOCKED');
    }
    log('allocation.requested', { requestId: request.requestId, runId: request.binding.runId });
    const existing = this.databaseOrThrow().prepare('SELECT binding_digest FROM allocations WHERE run_id=?').get(request.binding.runId) as SqlRow | undefined;
    if (existing) {
      log('request.refused', { requestId: request.requestId, runId: request.binding.runId, safeCode: 'ALLOCATION_RUN_EXISTS' });
      throw new AllocationRegistryError('ALLOCATION_RUN_EXISTS');
    }
    const worktreeId = randomUUID(); const nonce = randomBytes(32).toString('hex');
    const bindingJson = canonicalBinding(request.binding); const bindingDigest = digest('kogg-execution-binding-v1', bindingJson);
    const now = new Date().toISOString();
    this.transaction(database => {
      database.prepare(`INSERT INTO allocations(
        worktree_id,run_id,attempt_id,project_id,repository_id,binding_json,binding_digest,allocation_name,
        allocation_nonce,allocation_nonce_digest,quota_bytes,quota_inodes,owner_instance_id,state,cleanup_state,
        safe_code,revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'admitted','required','ALLOCATION_OK',1,?,?)`).run(
        worktreeId, request.binding.runId, request.binding.attemptId, request.binding.projectId, request.binding.repositoryId,
        bindingJson, bindingDigest, allocationName(worktreeId), nonce, digest('kogg-execution-allocation-nonce-v1', nonce),
        request.quotaBytes, request.quotaInodes, this.ownerInstanceId, now, now
      );
      database.prepare('INSERT INTO request_results(request_id,request_digest,worktree_id,created_at) VALUES(?,?,?,?)')
        .run(request.requestId, requestDigest, worktreeId, now);
      this.event(database, worktreeId, 'allocation.requested', 'ALLOCATION_OK'); this.bump(database);
    });
    log('allocation.reserved', { requestId: request.requestId, runId: request.binding.runId, worktreeId });
    return this.summary(worktreeId);
  }

  diagnostics(): ExecutionAllocationDiagnostics {
    const database = this.databaseOrThrow();
    const count = (sql: string): number => Number((database.prepare(sql).get() as SqlRow).count);
    return {
      integrity: String((database.prepare('PRAGMA integrity_check').get() as SqlRow).integrity_check) === 'ok',
      foreignKeys: database.prepare('PRAGMA foreign_key_check').all().length === 0,
      permissions: process.platform === 'win32' || (statSync(this.databasePath).mode & 0o077) === 0,
      admission: this.admission(),
      activeCount: count(`SELECT count(*) AS count FROM allocations WHERE state NOT IN ('refused','cleaned','quarantined')`),
      quarantinedCount: count(`SELECT count(*) AS count FROM allocations WHERE state='quarantined'`),
      recoveryRequiredCount: count(`SELECT count(*) AS count FROM allocations WHERE state IN ('recovery-required','reconciling')`),
      unverifiedCount: count(`SELECT count(*) AS count FROM allocations WHERE state IN ('admitted','allocated','seeding')`),
      cleanupFailureCount: count(`SELECT count(*) AS count FROM allocations WHERE state='cleanup-failed' OR cleanup_state='failed'`),
      reservationCount: count(`SELECT count(*) AS count FROM allocations WHERE state NOT IN ('refused','cleaned')`),
      loggingViolationCount: allocationLoggingViolations
    };
  }

  private async ensureStarted(): Promise<void> { if (this.database) return; this.startup ??= this.startDatabase(); return this.startup; }
  private async startDatabase(): Promise<void> {
    log('registry.start.requested', {});
    try {
      mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.migrate(); if (process.platform !== 'win32') chmodSync(this.databasePath, 0o600); this.assertIntegrity(); this.recover();
      log('registry.start.completed', { admission: this.admission() });
    } catch (error) {
      log('registry.start.failed', { safeCode: 'ALLOCATION_INTEGRITY_FAILED', errorType: errorType(error) });
      this.database?.close(); this.database = undefined; this.startup = undefined; throw error;
    }
  }

  private migrate(): void {
    this.databaseOrThrow().exec(`
      CREATE TABLE IF NOT EXISTS execution_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),revision INTEGER NOT NULL CHECK(revision>=1),owner_instance_id TEXT NOT NULL,admission TEXT NOT NULL CHECK(admission IN ('enabled','recovering','blocked')));
      CREATE TABLE IF NOT EXISTS allocations(
        worktree_id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,attempt_id TEXT NOT NULL,project_id TEXT NOT NULL,repository_id TEXT NOT NULL,
        binding_json TEXT NOT NULL,binding_digest TEXT NOT NULL,allocation_name TEXT NOT NULL UNIQUE,allocation_nonce TEXT NOT NULL,
        allocation_nonce_digest TEXT NOT NULL,filesystem_identity_digest TEXT,quota_project_id TEXT,quota_bytes TEXT NOT NULL,quota_inodes TEXT NOT NULL,
        owner_instance_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('requested','refused','admitted','allocated','seeding','verified','ready','leased','executing','stopping','sealed','candidate-imported','retained','cleaning','cleaned','failed','timed-out','cancelled','cleanup-failed','quarantined','recovery-required','reconciling')),
        cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('required','cleaning','cleaned','failed')),safe_code TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS allocation_intents(intent_id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),intent_type TEXT NOT NULL,phase TEXT NOT NULL,fencing_token TEXT NOT NULL,expected_identity_digest TEXT,observed_identity_digest TEXT,safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS allocation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),event_name TEXT NOT NULL,safe_code TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO execution_meta(singleton,schema_version,revision,owner_instance_id,admission) VALUES(1,1,1,'bootstrap','recovering');
    `);
    const version = Number((this.databaseOrThrow().prepare('SELECT schema_version FROM execution_meta WHERE singleton=1').get() as SqlRow).schema_version);
    if (version !== 1) throw new Error('Unsupported execution registry schema');
  }

  private assertIntegrity(): void {
    const database = this.databaseOrThrow();
    if (String((database.prepare('PRAGMA integrity_check').get() as SqlRow).integrity_check) !== 'ok'
      || database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Execution registry integrity failed');
  }

  private recover(): void {
    const database = this.databaseOrThrow();
    database.prepare(`UPDATE execution_meta SET admission='recovering',owner_instance_id=?,revision=revision+1 WHERE singleton=1`).run(this.ownerInstanceId);
    const rows = database.prepare(`SELECT worktree_id,run_id FROM allocations WHERE state NOT IN ('refused','cleaned','quarantined') OR cleanup_state IN ('cleaning','failed') ORDER BY worktree_id`).all() as SqlRow[];
    log('recovery.started', { resourceCount: rows.length });
    for (const row of rows) {
      const worktreeId = String(row.worktree_id); const runId = String(row.run_id);
      this.transaction(current => {
        current.prepare(`UPDATE allocations SET state='recovery-required',revision=revision+1,updated_at=? WHERE worktree_id=?`).run(new Date().toISOString(), worktreeId);
        this.event(current, worktreeId, 'recovery.started', 'RECOVERY_OWNER_UNAVAILABLE');
        current.prepare(`UPDATE allocations SET state='reconciling',revision=revision+1,updated_at=? WHERE worktree_id=?`).run(new Date().toISOString(), worktreeId);
        this.event(current, worktreeId, 'recovery.resource.classified', 'RECOVERY_OWNER_UNAVAILABLE');
        current.prepare(`UPDATE allocations SET state='quarantined',cleanup_state='failed',safe_code='RECOVERY_OWNER_UNAVAILABLE',revision=revision+1,updated_at=? WHERE worktree_id=?`).run(new Date().toISOString(), worktreeId);
        this.event(current, worktreeId, 'resource.quarantined', 'RECOVERY_OWNER_UNAVAILABLE');
      });
      log('recovery.resource.classified', { runId, worktreeId, state: 'quarantined', safeCode: 'RECOVERY_OWNER_UNAVAILABLE' });
    }
    database.prepare(`UPDATE execution_meta SET admission=?,revision=revision+1 WHERE singleton=1`).run(rows.length ? 'blocked' : 'enabled');
    log('recovery.completed', { resourceCount: rows.length, quarantinedCount: rows.length, admission: rows.length ? 'blocked' : 'enabled' });
  }

  private summary(worktreeId: string): ExecutionAllocationSummaryV1 {
    const row = this.databaseOrThrow().prepare('SELECT * FROM allocations WHERE worktree_id=?').get(worktreeId) as SqlRow | undefined;
    if (!row) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    return {
      schemaVersion: 1, worktreeId, runId: String(row.run_id), attemptId: String(row.attempt_id),
      allocationName: String(row.allocation_name), allocationNonceDigest: String(row.allocation_nonce_digest),
      bindingDigest: String(row.binding_digest), state: String(row.state) as ExecutionState, revision: String(row.revision),
      cleanupState: String(row.cleanup_state) as ExecutionAllocationSummaryV1['cleanupState'], safeCode: String(row.safe_code) as ExecutionAllocationCode
    };
  }
  private admission(): ExecutionAllocationDiagnostics['admission'] { return String((this.databaseOrThrow().prepare('SELECT admission FROM execution_meta WHERE singleton=1').get() as SqlRow).admission) as ExecutionAllocationDiagnostics['admission']; }
  private event(database: DatabaseSync, worktreeId: string, eventName: string, safeCode: ExecutionAllocationCode): void { database.prepare('INSERT INTO allocation_events(worktree_id,event_name,safe_code,created_at) VALUES(?,?,?,?)').run(worktreeId, eventName, safeCode, new Date().toISOString()); }
  private bump(database: DatabaseSync): void { database.prepare('UPDATE execution_meta SET revision=revision+1 WHERE singleton=1').run(); }
  private transaction(run: (database: DatabaseSync) => void): void { const database = this.databaseOrThrow(); database.exec('BEGIN IMMEDIATE'); try { run(database); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; } }
  private databaseOrThrow(): DatabaseSync { if (!this.database) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED'); return this.database; }
}

export class AllocationRegistryError extends Error { constructor(readonly code: ExecutionAllocationCode) { super(code); this.name = 'AllocationRegistryError'; } }

function validateRequest(request: ReserveExecutionAllocationV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'binding,quotaBytes,quotaInodes,requestId'
    || !UUID.test(request.requestId) || !boundedDecimal(request.quotaBytes, 10n * 1024n * 1024n * 1024n * 1024n)
    || !boundedDecimal(request.quotaInodes, 1_000_000_000n)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
  validateBinding(request.binding);
}
function validateBinding(value: ExecutionBindingV1): void {
  const object = value?.gitObjectFormat === 'sha1' ? SHA1 : SHA256;
  if (!value || Object.keys(value).sort().join(',') !== [...BINDING_FIELDS].sort().join(',') || value.schemaVersion !== 1
    || ![value.projectId, value.repositoryId, value.taskId, value.taskRevisionId, value.runId, value.attemptId, value.qualificationId].every(id => UUID.test(id))
    || ![value.projectRevision, value.repositoryBindingRevision].every(revision => DECIMAL.test(revision))
    || ![value.taskRevisionDigest, value.approvalDigest, value.workflowPlanDigest, value.qualificationDigest, value.profileDigest].every(item => DIGEST.test(item))
    || !object.test(value.baseCommit) || !object.test(value.baseTree) || !SYMBOLIC.test(value.targetId)
    || value.profileId !== 'kogg-writable-agent-v1' || !['sha1', 'sha256'].includes(value.gitObjectFormat)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function canonicalRequest(value: ReserveExecutionAllocationV1): string { return `{"binding":${canonicalBinding(value.binding)},"quotaBytes":${JSON.stringify(value.quotaBytes)},"quotaInodes":${JSON.stringify(value.quotaInodes)},"requestId":${JSON.stringify(value.requestId)}}`; }
function canonicalBinding(value: ExecutionBindingV1): string { return `{${[...BINDING_FIELDS].sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(value[key as keyof ExecutionBindingV1])}`).join(',')}}`; }
function digest(domain: string, value: string): string { return `sha256:${createHash('sha256').update(`${domain}\0${value}`).digest('hex')}`; }
function allocationName(worktreeId: string): string { const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'; const bytes = Buffer.from(worktreeId.replaceAll('-', ''), 'hex'); let bits = 0; let accumulator = 0; let output = ''; for (const byte of bytes) { accumulator = (accumulator << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; output += alphabet[(accumulator >>> bits) & 31]; } } if (bits) output += alphabet[(accumulator << (5 - bits)) & 31]; return `r-${output}`; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state')); }
function errorType(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function boundedDecimal(value: string, maximum: bigint): boolean {
  if (!DECIMAL.test(value) || value === '0') return false;
  try { return BigInt(value) <= maximum; }
  catch { // observability-exempt: Invalid untrusted decimal input is intentionally reduced to a closed protocol refusal.
    return false;
  }
}

const LOG_FIELDS = {
  'registry.start.requested': [], 'registry.start.completed': ['admission'], 'registry.start.failed': ['safeCode', 'errorType'],
  'request.refused': ['requestId', 'runId', 'safeCode'], 'allocation.requested': ['requestId', 'runId'],
  'allocation.reserved': ['requestId', 'runId', 'worktreeId'], 'recovery.started': ['resourceCount'],
  'recovery.resource.classified': ['runId', 'worktreeId', 'state', 'safeCode'],
  'recovery.completed': ['resourceCount', 'quarantinedCount', 'admission']
} as const;
type AllocationLogEvent = keyof typeof LOG_FIELDS;
let allocationLoggingViolations = 0;
function log(event: AllocationLogEvent, fields: Readonly<Record<string, string | number>>): void {
  const expected = [...LOG_FIELDS[event]].sort(); const keys = Object.keys(fields).sort();
  const validKeys = keys.join(',') === expected.join(',');
  const validValues = Object.entries(fields).every(([key, value]) => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
    if (Buffer.byteLength(value) > 128) return false;
    if (['requestId', 'runId', 'worktreeId'].includes(key)) return UUID.test(value);
    if (key === 'admission') return ['enabled', 'recovering', 'blocked'].includes(value);
    if (key === 'state') return value === 'quarantined';
    if (key === 'safeCode') return /^[A-Z][A-Z0-9_]{1,63}$/u.test(value);
    return /^[A-Za-z][A-Za-z0-9_.]{0,63}$/u.test(value);
  });
  if (!validKeys || !validValues) { allocationLoggingViolations++; console.error('[kogg:execution:allocation] logging.schema.violation', { event }); return; }
  if (event.includes('failed')) console.error('[kogg:execution:allocation]', event, fields);
  else if (event.includes('refused')) console.warn('[kogg:execution:allocation]', event, fields);
  else console.info('[kogg:execution:allocation]', event, fields);
}
