import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggModeOperationAuthorizer, type ModeOperationAuthorizer } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import type {
  AdvanceExecutionStateV1, CandidateBindingV1, CandidateImportIntentV1, CompleteCandidateImportV1,
  CandidateRetentionV1, ExecutionAllocationSummaryV1, ExecutionBindingV1, ExecutionLifecycleCode, ExecutionRunListV1, ExecutionRunProjectionV1, ExecutionState,
  FailCandidateImportV1, GetExecutionRunV1, ImportedCandidateV1, ListExecutionRunsV1, PrepareCandidateImportV1,
  RecordCandidateRetentionV1, RecordPhysicalAllocationV1, RecordSealedCandidateV1, ReserveExecutionAllocationV1
} from '../common/execution-protocol';
import { CANDIDATE_MUTATION_POLICY_DIGEST } from './candidate-sealer';
import { ExecutionTargetRegistry } from './execution-target-registry';
import type { OperationsOwnerSink, OwnerEventV1, SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';

// Allocation identity and idempotency commit before external effects; ambiguous startup state is quarantined without pathname deletion or side-effect replay.
// diagnostic-coverage: execution.worktree-registry, execution.capacity, execution.recovery, execution.retention
type SqlRow = Record<string, SQLOutputValue>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SYMBOLIC = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const SHA1 = /^[0-9a-f]{40}$/u; const SHA256 = /^[0-9a-f]{64}$/u;
const BINDING_FIELDS = ['schemaVersion', 'projectId', 'projectRevision', 'repositoryId', 'repositoryBindingRevision', 'taskId',
  'taskRevisionId', 'taskRevisionDigest', 'approvalDigest', 'runId', 'attemptId', 'workflowPlanDigest', 'baseCommit', 'baseTree',
  'gitObjectFormat', 'repositoryIdentityDigest', 'targetId', 'qualificationId', 'qualificationDigest', 'profileId', 'profileDigest'] as const;
const LEGAL_TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  requested: ['refused', 'admitted'], refused: [], admitted: ['failed'], allocated: ['seeding', 'cleaning', 'quarantined'],
  seeding: ['verified', 'failed', 'timed-out', 'recovery-required'], verified: ['ready', 'cleaning', 'quarantined'], ready: ['leased', 'cleaning', 'quarantined'],
  leased: ['executing', 'cancelled', 'recovery-required'], executing: ['stopping', 'timed-out', 'failed', 'recovery-required'],
  stopping: ['sealed', 'cleaning', 'cancelled', 'timed-out', 'failed', 'cleanup-failed'], sealed: ['candidate-imported', 'recovery-required'],
  'candidate-imported': ['recovery-required'], retained: ['cleaning'], cleaning: ['cleaned', 'cleanup-failed', 'quarantined'],
  'cleanup-failed': ['cleaning', 'quarantined'], 'recovery-required': ['reconciling'], reconciling: ['refused', 'admitted', 'allocated', 'seeding', 'verified', 'ready', 'leased', 'executing', 'stopping', 'sealed', 'candidate-imported', 'retained', 'cleaning', 'cleaned', 'failed', 'timed-out', 'cancelled', 'cleanup-failed', 'quarantined'],
  cleaned: [], failed: ['cleaning'], 'timed-out': ['cleaning'], cancelled: ['cleaning'], quarantined: []
};
const TRANSITION_CODES = new Set(['ALLOCATION_OK', 'ALLOCATION_ADMISSION_BLOCKED', 'ALLOCATION_PROTOCOL_INVALID', 'ALLOCATION_REQUEST_REPLAY_MISMATCH', 'ALLOCATION_RUN_EXISTS', 'ALLOCATION_INTEGRITY_FAILED', 'ALLOCATION_REVISION_CONFLICT', 'ALLOCATION_BINDING_MISMATCH', 'ALLOCATION_STATE_INVALID', 'ALLOCATION_REPOSITORY_LEASE_CONFLICT', 'ALLOCATION_QUALIFICATION_INVALID', 'RECOVERY_OWNER_UNAVAILABLE', 'GIT_SEED_FAILED', 'GIT_SEED_TIMEOUT', 'GIT_SEED_OUTPUT_LIMIT', 'GIT_BASE_CHANGED', 'GIT_INDEPENDENCE_FAILED', 'GIT_SOURCE_INTEGRITY_FAILED', 'SEAL_OK', 'SEAL_FAILED', 'SEAL_BASE_MISMATCH', 'SEAL_NO_CHANGE', 'SEAL_DIRTY', 'SEAL_HEAD_INVALID', 'SEAL_ANCESTRY_INVALID', 'SEAL_MERGE_COMMIT', 'SEAL_MUTATION_POLICY', 'SEAL_OBJECT_INVALID', 'IMPORT_OK', 'IMPORT_FAILED', 'IMPORT_PROTOCOL_INVALID', 'IMPORT_SOURCE_CHANGED', 'IMPORT_CANDIDATE_INVALID', 'IMPORT_REF_EXISTS', 'IMPORT_SOURCE_INTEGRITY_FAILED', 'RETENTION_OK', 'RETENTION_ACTIVE', 'RETENTION_PROTOCOL_INVALID', 'EXECUTION_OK', 'QUALIFICATION_PLATFORM_UNSUPPORTED', 'QUALIFICATION_PROFILE_UNAVAILABLE', 'QUALIFICATION_PROTOCOL_INVALID', 'QUALIFICATION_EXPIRED', 'QUALIFICATION_FAILED', 'EXECUTION_INTERNAL_FAILED', 'PROCESS_EXIT_NONZERO', 'CLEANUP_FAILED', 'CLEANUP_IDENTITY_MISMATCH']);
const IMPORT_FAILURE_CODES = new Set(['IMPORT_FAILED', 'IMPORT_PROTOCOL_INVALID', 'IMPORT_SOURCE_CHANGED', 'IMPORT_CANDIDATE_INVALID', 'IMPORT_REF_EXISTS', 'IMPORT_SOURCE_INTEGRITY_FAILED']);
const RETENTION_MILLISECONDS = { rejected: 24 * 60 * 60 * 1000, completed: 24 * 60 * 60 * 1000, incident: 30 * 24 * 60 * 60 * 1000 } as const;
const FIRST_QUOTA_PROJECT_ID = 10_000;
const LAST_QUOTA_PROJECT_ID = 4_294_967_295;

export interface ExecutionAllocationDiagnostics {
  readonly integrity: boolean; readonly foreignKeys: boolean; readonly permissions: boolean;
  readonly admission: 'enabled' | 'recovering' | 'blocked'; readonly activeCount: number;
  readonly quarantinedCount: number; readonly recoveryRequiredCount: number; readonly unverifiedCount: number;
  readonly cleanupFailureCount: number; readonly reservationCount: number;
  readonly candidateCount: number; readonly pendingAllocationIntentCount: number; readonly pendingImportIntentCount: number; readonly activeRepositoryLeaseCount: number;
  readonly quarantinedRepositoryLeaseCount: number; readonly activeQuotaProjectLeaseCount: number; readonly quarantinedQuotaProjectLeaseCount: number;
  readonly pendingCleanupIntentCount: number; readonly retentionViolationCount: number; readonly loggingViolationCount: number;
}
export interface ExecutionWorkspaceContextV1 { readonly allocation: ExecutionAllocationSummaryV1; readonly binding: ExecutionBindingV1; }

export interface PreparePhysicalAllocationV1 { readonly requestId: string; readonly worktreeId: string; readonly expectedRevision: string; readonly bindingDigest: string; readonly helperDigest: string; readonly mountQuotaDigest: string }
export interface PhysicalAllocationIntentV1 {
  readonly schemaVersion: 1; readonly intentId: string; readonly worktreeId: string; readonly fencingToken: string;
  readonly expectedRevision: string; readonly allocationName: string; readonly allocationNonce: string;
  readonly ownerInstanceId: string; readonly createdAt: string; readonly quotaProjectId: string;
  readonly quotaBytes: string; readonly quotaInodes: string; readonly helperDigest: string; readonly mountQuotaDigest: string;
}
export interface FailPhysicalAllocationV1 {
  readonly requestId: string; readonly intentId: string; readonly worktreeId: string; readonly expectedRevision: string;
  readonly bindingDigest: string; readonly fencingToken: string;
  readonly safeCode: 'ALLOCATION_INTEGRITY_FAILED' | 'ALLOCATION_QUALIFICATION_INVALID' | 'CLEANUP_IDENTITY_MISMATCH';
}
export interface PreparePhysicalCleanupV1 { readonly requestId: string; readonly worktreeId: string; readonly expectedRevision: string; readonly bindingDigest: string }
export interface PhysicalCleanupIntentV1 {
  readonly schemaVersion: 1; readonly intentId: string; readonly worktreeId: string; readonly fencingToken: string;
  readonly expectedRevision: string; readonly expectedIdentityDigest: string; readonly allocationName: string; readonly allocationNonce: string;
  readonly ownerInstanceId: string; readonly createdAt: string;
  readonly filesystemDevice: string; readonly filesystemInode: string; readonly ownerUid: string; readonly mode: '0700'; readonly mountId: string;
  readonly quotaProjectId: string; readonly quotaBytes: string; readonly quotaInodes: string; readonly helperDigest: string; readonly mountQuotaDigest: string;
}
export interface CompletePhysicalCleanupV1 { readonly requestId: string; readonly intentId: string; readonly worktreeId: string; readonly expectedRevision: string; readonly bindingDigest: string; readonly fencingToken: string; readonly expectedIdentityDigest: string; readonly preDeleteIdentityDigest: string; readonly absenceProofDigest: string; readonly helperDigest: string; readonly mountQuotaDigest: string }
export interface FailPhysicalCleanupV1 { readonly requestId: string; readonly intentId: string; readonly worktreeId: string; readonly expectedRevision: string; readonly bindingDigest: string; readonly fencingToken: string; readonly expectedIdentityDigest: string; readonly observedIdentityDigest: string; readonly safeCode: 'CLEANUP_FAILED' | 'CLEANUP_IDENTITY_MISMATCH' }

@injectable()
export class ExecutionAllocationRegistry implements BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private startup: Promise<void> | undefined;
  private readonly ownerInstanceId = randomUUID();
  private readonly databasePath = path.join(stateRoot(), 'execution', 'registry.sqlite3');
  private ownerSink: OperationsOwnerSink | undefined;

  constructor(
    @inject(ExecutionTargetRegistry) private readonly targets: Pick<ExecutionTargetRegistry, 'authorize' | 'authorizePhysicalAllocation'>,
    @inject(KoggModeOperationAuthorizer) private readonly modes: ModeOperationAuthorizer
  ) {}

  onStart(): Promise<void> { return this.ensureStarted(); }
  onStop(): void { this.ownerSink = undefined; this.database?.close(); this.database = undefined; this.startup = undefined; }

  setOwnerSink(sink?: OperationsOwnerSink): void {
    this.ownerSink = sink;
    if (sink && this.database) this.publishOwnerEvents();
  }

  publishOwnerEvents(): void {
    if (!this.ownerSink || !this.database) return;
    const meta = this.database.prepare('SELECT owner_id,owner_epoch_id FROM execution_meta WHERE singleton=1').get() as SqlRow;
    let previous = '0'.repeat(64);
    for (const row of this.database.prepare(`SELECT e.*,a.run_id,a.attempt_id,a.project_id FROM allocation_events e JOIN allocations a ON a.worktree_id=e.worktree_id ORDER BY e.sequence`).all() as SqlRow[]) {
      if (sourceEventDigest(row) !== String(row.event_digest) || String(row.previous_event_digest) !== previousSourceDigest(this.database, Number(row.sequence))) {
        log('owner.publish.failed', { safeCode: 'ALLOCATION_INTEGRITY_FAILED', errorType: 'OwnerEventIntegrityError' });
        break;
      }
      const mapped = mapOwnerEvent(row, String(meta.owner_id), String(meta.owner_epoch_id), previous);
      previous = mapped.eventDigest;
      try { this.ownerSink.ingest(mapped); }
      catch (error) { // observability-exempt: owner.publish.failed records the closed failure before replay stops at the first unaccepted fact.
        log('owner.publish.failed', { safeCode: 'ALLOCATION_INTEGRITY_FAILED', errorType: errorType(error) }); break;
      }
    }
  }

  async getRun(request: GetExecutionRunV1): Promise<ExecutionRunProjectionV1 | undefined> {
    validateProjectionRequest(request, 'requestId,runId');
    log('projection.get.requested', { requestId: request.requestId, runId: request.runId });
    try {
      await this.ensureStarted();
      const row = this.databaseOrThrow().prepare('SELECT project_id,repository_id,run_id,attempt_id,state,revision,cleanup_state,safe_code FROM allocations WHERE run_id=?').get(request.runId) as SqlRow | undefined;
      const projection = row ? runProjection(row) : undefined;
      log('projection.get.completed', { requestId: request.requestId, runId: request.runId, resultCount: projection ? 1 : 0 });
      return projection;
    } catch (error) {
      log('projection.get.failed', { requestId: request.requestId, runId: request.runId, safeCode: projectionErrorCode(error), errorType: errorType(error) });
      throw error;
    }
  }

  async listRuns(request: ListExecutionRunsV1): Promise<ExecutionRunListV1> {
    validateProjectionRequest(request, 'projectId,requestId');
    log('projection.list.requested', { requestId: request.requestId, projectId: request.projectId });
    try {
      await this.ensureStarted();
      const rows = this.databaseOrThrow().prepare('SELECT project_id,repository_id,run_id,attempt_id,state,revision,cleanup_state,safe_code FROM allocations WHERE project_id=? ORDER BY updated_at DESC,run_id LIMIT 201').all(request.projectId) as SqlRow[];
      const truncated = rows.length > 200; const runs = rows.slice(0, 200).map(runProjection);
      log('projection.list.completed', { requestId: request.requestId, projectId: request.projectId, resultCount: runs.length, truncated: truncated ? 1 : 0 });
      return { schemaVersion: 1, projectId: request.projectId, runs, truncated };
    } catch (error) {
      log('projection.list.failed', { requestId: request.requestId, projectId: request.projectId, safeCode: projectionErrorCode(error), errorType: errorType(error) });
      throw error;
    }
  }

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
    let mode: Awaited<ReturnType<ModeOperationAuthorizer['authorizeOperation']>>;
    try { mode = await this.modes.authorizeOperation({ requestId: request.requestId, taskId: request.binding.taskId, operation: 'worktree-create' }); }
    catch { // observability-exempt: the immediately following closed refusal log records the allocation-domain denial without leaking authority error details.
      mode = { allowed: false, safeCode: 'MODE_AUTHORITY_REFUSED' } as Awaited<ReturnType<ModeOperationAuthorizer['authorizeOperation']>>;
    }
    if (!mode.allowed) {
      log('request.refused', { requestId: request.requestId, runId: request.binding.runId, safeCode: 'ALLOCATION_ADMISSION_BLOCKED' });
      throw new AllocationRegistryError('ALLOCATION_ADMISSION_BLOCKED');
    }
    if (!await this.targets.authorize(request.binding)) {
      log('request.refused', { requestId: request.requestId, runId: request.binding.runId, safeCode: 'ALLOCATION_QUALIFICATION_INVALID' });
      throw new AllocationRegistryError('ALLOCATION_QUALIFICATION_INVALID');
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

  async advance(request: AdvanceExecutionStateV1): Promise<ExecutionAllocationSummaryV1> {
    await this.ensureStarted(); validateAdvance(request); const requestDigest = digest('kogg-execution-state-request-v1', canonicalAdvance(request));
    log('state.requested', { requestId: request.requestId, worktreeId: request.worktreeId, state: request.nextState });
    const replay = this.databaseOrThrow().prepare(`SELECT request_digest,resource_id FROM lifecycle_request_results WHERE request_id=? AND response_kind='state'`).get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest) refuseState(request, 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
      log('state.completed', { requestId: request.requestId, worktreeId: request.worktreeId, state: request.nextState });
      return this.summary(String(replay.resource_id));
    }
    if (this.admission() !== 'enabled') refuseState(request, 'ALLOCATION_ADMISSION_BLOCKED');
    const row = this.databaseOrThrow().prepare('SELECT state,revision,binding_digest FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    if (!row) refuseState(request, 'ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest) refuseState(request, 'ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) refuseState(request, 'ALLOCATION_REVISION_CONFLICT');
    const current = String(row.state) as ExecutionState; if (['cleaning', 'cleaned', 'cleanup-failed'].includes(request.nextState) || !LEGAL_TRANSITIONS[current].includes(request.nextState)) refuseState(request, 'ALLOCATION_STATE_INVALID');
    const now = new Date().toISOString();
    this.transaction(database => {
      const cleanupState = undefined;
      const result = database.prepare('UPDATE allocations SET state=?,cleanup_state=coalesce(?,cleanup_state),safe_code=?,revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state=? AND binding_digest=?')
        .run(request.nextState, cleanupState ?? null, request.safeCode, now, request.worktreeId, Number(request.expectedRevision), current, request.bindingDigest);
      if (result.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare(`INSERT INTO lifecycle_request_results(request_id,request_digest,response_kind,resource_id,created_at) VALUES(?,?,'state',?,?)`).run(request.requestId, requestDigest, request.worktreeId, now);
      this.event(database, request.worktreeId, 'state.advanced', request.safeCode); this.bump(database);
    });
    log('state.completed', { requestId: request.requestId, worktreeId: request.worktreeId, state: request.nextState });
    return this.summary(request.worktreeId);
  }

  async workspaceContext(worktreeId: string): Promise<ExecutionWorkspaceContextV1> {
    await this.ensureStarted();
    if (!UUID.test(worktreeId)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
    const row = this.databaseOrThrow().prepare('SELECT binding_json FROM allocations WHERE worktree_id=?').get(worktreeId) as SqlRow | undefined;
    if (!row) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    const binding = JSON.parse(String(row.binding_json)) as ExecutionBindingV1;
    validateBinding(binding);
    return { allocation: this.summary(worktreeId), binding };
  }

  async preparePhysicalAllocation(request: PreparePhysicalAllocationV1): Promise<PhysicalAllocationIntentV1> {
    await this.ensureStarted(); validatePhysicalAllocationPrepare(request);
    const requestDigest = digest('kogg-execution-physical-allocation-prepare-v1', JSON.stringify(request));
    log('allocation.intent.requested', { requestId: request.requestId, worktreeId: request.worktreeId });
    const replay = this.databaseOrThrow().prepare('SELECT request_digest,intent_id FROM physical_allocation_prepare_results WHERE request_id=?').get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest) refusePhysicalAllocation(request, 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
      return this.physicalAllocationIntent(String(replay.intent_id));
    }
    if (this.admission() !== 'enabled') refusePhysicalAllocation(request, 'ALLOCATION_ADMISSION_BLOCKED');
    const row = this.databaseOrThrow().prepare('SELECT * FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    if (!row) refusePhysicalAllocation(request, 'ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest) refusePhysicalAllocation(request, 'ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) refusePhysicalAllocation(request, 'ALLOCATION_REVISION_CONFLICT');
    if (String(row.state) !== 'admitted') refusePhysicalAllocation(request, 'ALLOCATION_STATE_INVALID');
    const existing = this.databaseOrThrow().prepare("SELECT intent_id FROM allocation_intents WHERE worktree_id=? AND intent_type='allocation' AND phase='requested'").get(request.worktreeId) as SqlRow | undefined;
    if (existing) refusePhysicalAllocation(request, 'ALLOCATION_STATE_INVALID');
    const binding = JSON.parse(String(row.binding_json)) as ExecutionBindingV1;
    let mode: Awaited<ReturnType<ModeOperationAuthorizer['authorizeOperation']>>;
    try { mode = await this.modes.authorizeOperation({ requestId: request.requestId, taskId: binding.taskId, operation: 'worktree-create' }); }
    catch { // observability-exempt: the closed allocation refusal below records no authority error details.
      mode = { allowed: false, safeCode: 'MODE_AUTHORITY_REFUSED' } as Awaited<ReturnType<ModeOperationAuthorizer['authorizeOperation']>>;
    }
    if (!mode.allowed) refusePhysicalAllocation(request, 'ALLOCATION_ADMISSION_BLOCKED');
    if (!await this.targets.authorizePhysicalAllocation(binding, request.helperDigest, request.mountQuotaDigest)) refusePhysicalAllocation(request, 'ALLOCATION_QUALIFICATION_INVALID');
    const intentId = randomUUID(); const fencingToken = randomBytes(32).toString('hex'); const now = new Date().toISOString(); let quotaProjectId = 0;
    this.transaction(database => {
      const meta = database.prepare('SELECT next_quota_project_id FROM execution_meta WHERE singleton=1').get() as SqlRow;
      quotaProjectId = Number(meta.next_quota_project_id);
      if (!Number.isSafeInteger(quotaProjectId) || quotaProjectId < FIRST_QUOTA_PROJECT_ID || quotaProjectId > LAST_QUOTA_PROJECT_ID) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
      database.prepare("INSERT INTO allocation_intents(intent_id,worktree_id,intent_type,phase,fencing_token,expected_revision,helper_digest,mount_quota_digest,safe_code,created_at,updated_at) VALUES(?,?,'allocation','requested',?,?,?,?,'ALLOCATION_OK',?,?)")
        .run(intentId, request.worktreeId, fencingToken, request.expectedRevision, request.helperDigest, request.mountQuotaDigest, now, now);
      database.prepare("INSERT INTO quota_project_leases(project_id,intent_id,worktree_id,phase,safe_code,created_at,updated_at) VALUES(?,?,?,'active','ALLOCATION_OK',?,?)")
        .run(quotaProjectId, intentId, request.worktreeId, now, now);
      database.prepare('UPDATE execution_meta SET next_quota_project_id=next_quota_project_id+1 WHERE singleton=1').run();
      database.prepare('INSERT INTO physical_allocation_prepare_results(request_id,request_digest,intent_id,worktree_id,created_at) VALUES(?,?,?,?,?)')
        .run(request.requestId, requestDigest, intentId, request.worktreeId, now);
      this.event(database, request.worktreeId, 'allocation.intent.recorded', 'ALLOCATION_OK'); this.bump(database);
    });
    log('allocation.intent.recorded', { requestId: request.requestId, worktreeId: request.worktreeId, intentId });
    return this.physicalAllocationIntent(intentId);
  }

  async recordPhysicalAllocation(request: RecordPhysicalAllocationV1): Promise<ExecutionAllocationSummaryV1> {
    await this.ensureStarted(); validatePhysicalAllocation(request);
    const requestDigest = digest('kogg-execution-physical-allocation-request-v1', canonicalPhysicalAllocation(request));
    log('allocation.proof.requested', { requestId: request.requestId, worktreeId: request.worktreeId });
    const replay = this.databaseOrThrow().prepare('SELECT request_digest,worktree_id FROM physical_allocation_results WHERE request_id=?').get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest || String(replay.worktree_id) !== request.worktreeId) refusePhysicalAllocation(request, 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
      return this.summary(request.worktreeId);
    }
    if (this.admission() !== 'enabled') refusePhysicalAllocation(request, 'ALLOCATION_ADMISSION_BLOCKED');
    const row = this.databaseOrThrow().prepare('SELECT * FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    const intent = this.databaseOrThrow().prepare("SELECT * FROM allocation_intents WHERE intent_id=? AND intent_type='allocation'").get(request.intentId) as SqlRow | undefined;
    const quotaLease = this.databaseOrThrow().prepare('SELECT * FROM quota_project_leases WHERE intent_id=?').get(request.intentId) as SqlRow | undefined;
    if (!row || !intent || !quotaLease) refusePhysicalAllocation(request, 'ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest || String(row.allocation_name) !== request.allocationName
      || String(row.allocation_nonce_digest) !== request.allocationNonceDigest || String(intent.worktree_id) !== request.worktreeId
      || String(intent.fencing_token) !== request.fencingToken || String(intent.helper_digest) !== request.helperDigest
      || String(intent.mount_quota_digest) !== request.mountQuotaDigest || String(quotaLease.worktree_id) !== request.worktreeId
      || String(quotaLease.project_id) !== request.quotaProjectId) refusePhysicalAllocation(request, 'ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) refusePhysicalAllocation(request, 'ALLOCATION_REVISION_CONFLICT');
    if (String(row.state) !== 'admitted' || String(intent.phase) !== 'requested' || String(quotaLease.phase) !== 'active'
      || String(row.quota_bytes) !== request.quotaBytes || String(row.quota_inodes) !== request.quotaInodes) refusePhysicalAllocation(request, 'ALLOCATION_STATE_INVALID');
    const binding = JSON.parse(String(row.binding_json)) as ExecutionBindingV1;
    if (!await this.targets.authorizePhysicalAllocation(binding, request.helperDigest, request.mountQuotaDigest)) refusePhysicalAllocation(request, 'ALLOCATION_QUALIFICATION_INVALID');
    const identityDigest = digest('kogg-execution-filesystem-identity-v1', canonicalFilesystemIdentity(request));
    const now = new Date().toISOString();
    this.transaction(database => {
      const intentResult = database.prepare("UPDATE allocation_intents SET phase='completed',observed_identity_digest=?,safe_code='ALLOCATION_OK',updated_at=? WHERE intent_id=? AND intent_type='allocation' AND phase='requested' AND fencing_token=?")
        .run(identityDigest, now, request.intentId, request.fencingToken);
      const result = database.prepare(`UPDATE allocations SET state='allocated',filesystem_identity_digest=?,filesystem_device=?,filesystem_inode=?,owner_uid=?,allocation_mode=?,mount_id=?,quota_project_id=?,helper_digest=?,mount_quota_digest=?,safe_code='ALLOCATION_OK',revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state='admitted' AND binding_digest=?`)
        .run(identityDigest, request.filesystemDevice, request.filesystemInode, request.ownerUid, request.mode, request.mountId, request.quotaProjectId, request.helperDigest, request.mountQuotaDigest, now, request.worktreeId, Number(request.expectedRevision), request.bindingDigest);
      const leaseResult = database.prepare("UPDATE quota_project_leases SET phase='allocated',safe_code='ALLOCATION_OK',updated_at=? WHERE intent_id=? AND project_id=? AND phase='active'").run(now, request.intentId, Number(request.quotaProjectId));
      if (intentResult.changes !== 1 || result.changes !== 1 || leaseResult.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare('INSERT INTO physical_allocation_results(request_id,request_digest,worktree_id,filesystem_identity_digest,created_at) VALUES(?,?,?,?,?)')
        .run(request.requestId, requestDigest, request.worktreeId, identityDigest, now);
      this.event(database, request.worktreeId, 'allocation.proof.recorded', 'ALLOCATION_OK'); this.bump(database);
    });
    log('allocation.proof.completed', { requestId: request.requestId, worktreeId: request.worktreeId });
    return this.summary(request.worktreeId);
  }

  async failPhysicalAllocation(request: FailPhysicalAllocationV1): Promise<ExecutionAllocationSummaryV1> {
    await this.ensureStarted(); validatePhysicalAllocationFailure(request);
    const requestDigest = digest('kogg-execution-physical-allocation-failure-v1', JSON.stringify(request));
    log('allocation.failure.requested', { requestId: request.requestId, worktreeId: request.worktreeId, intentId: request.intentId });
    const replay = this.databaseOrThrow().prepare('SELECT request_digest,worktree_id FROM physical_allocation_failure_results WHERE request_id=?').get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest || String(replay.worktree_id) !== request.worktreeId) refusePhysicalAllocation(request, 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
      return this.summary(request.worktreeId);
    }
    const row = this.databaseOrThrow().prepare('SELECT state,revision,binding_digest FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    const intent = this.databaseOrThrow().prepare("SELECT * FROM allocation_intents WHERE intent_id=? AND intent_type='allocation'").get(request.intentId) as SqlRow | undefined;
    if (!row || !intent) refusePhysicalAllocation(request, 'ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest || String(intent.worktree_id) !== request.worktreeId
      || String(intent.fencing_token) !== request.fencingToken) refusePhysicalAllocation(request, 'ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) refusePhysicalAllocation(request, 'ALLOCATION_REVISION_CONFLICT');
    if (String(row.state) !== 'admitted' || String(intent.phase) !== 'requested') refusePhysicalAllocation(request, 'ALLOCATION_STATE_INVALID');
    const now = new Date().toISOString();
    this.transaction(database => {
      const intentResult = database.prepare("UPDATE allocation_intents SET phase='quarantined',safe_code=?,updated_at=? WHERE intent_id=? AND intent_type='allocation' AND phase='requested' AND fencing_token=?")
        .run(request.safeCode, now, request.intentId, request.fencingToken);
      const allocationResult = database.prepare("UPDATE allocations SET state='quarantined',cleanup_state='failed',safe_code=?,revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state='admitted' AND binding_digest=?")
        .run(request.safeCode, now, request.worktreeId, Number(request.expectedRevision), request.bindingDigest);
      const leaseResult = database.prepare("UPDATE quota_project_leases SET phase='quarantined',safe_code=?,updated_at=? WHERE intent_id=? AND phase='active'").run(request.safeCode, now, request.intentId);
      if (intentResult.changes !== 1 || allocationResult.changes !== 1 || leaseResult.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare('INSERT INTO physical_allocation_failure_results(request_id,request_digest,intent_id,worktree_id,created_at) VALUES(?,?,?,?,?)')
        .run(request.requestId, requestDigest, request.intentId, request.worktreeId, now);
      database.prepare("UPDATE execution_meta SET admission='blocked',revision=revision+1 WHERE singleton=1").run();
      this.event(database, request.worktreeId, 'allocation.quarantined', request.safeCode);
    });
    log('allocation.quarantined', { requestId: request.requestId, worktreeId: request.worktreeId, intentId: request.intentId, safeCode: request.safeCode });
    return this.summary(request.worktreeId);
  }

  async recordSeal(request: RecordSealedCandidateV1): Promise<CandidateBindingV1> {
    await this.ensureStarted(); validateSealed(request); const requestDigest = digest('kogg-execution-seal-record-v1', canonicalSealed(request));
    const replay = this.databaseOrThrow().prepare(`SELECT request_digest,resource_id FROM lifecycle_request_results WHERE request_id=? AND response_kind='seal'`).get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest) throw new AllocationRegistryError('ALLOCATION_REQUEST_REPLAY_MISMATCH');
      return this.candidate(String(replay.resource_id));
    }
    if (this.admission() !== 'enabled') throw new AllocationRegistryError('ALLOCATION_ADMISSION_BLOCKED');
    const row = this.databaseOrThrow().prepare('SELECT * FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    if (!row) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest) throw new AllocationRegistryError('ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
    if (String(row.state) !== 'stopping') throw new AllocationRegistryError('ALLOCATION_STATE_INVALID');
    const binding = JSON.parse(String(row.binding_json)) as ExecutionBindingV1; const candidate = request.candidate;
    const object = binding.gitObjectFormat === 'sha1' ? SHA1 : SHA256;
    if (candidate.worktreeId !== request.worktreeId || candidate.runId !== String(row.run_id) || candidate.attemptId !== String(row.attempt_id)
      || candidate.baseCommit !== binding.baseCommit || candidate.baseTree !== binding.baseTree
      || ![candidate.baseCommit, candidate.baseTree, candidate.candidateCommit, candidate.candidateTree].every(value => object.test(value))) throw new AllocationRegistryError('ALLOCATION_BINDING_MISMATCH');
    const now = new Date().toISOString(); const candidateJson = canonicalCandidate(candidate);
    this.transaction(database => {
      database.prepare(`INSERT INTO candidates(candidate_id,worktree_id,candidate_json,candidate_commit,candidate_tree,object_closure_digest,mutation_policy_digest,retention_class,retention_until,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(candidate.candidateId, request.worktreeId, candidateJson, candidate.candidateCommit, candidate.candidateTree, candidate.objectClosureDigest, candidate.mutationPolicyDigest, candidate.retentionClass, candidate.retentionUntil, now);
      const result = database.prepare(`UPDATE allocations SET state='sealed',safe_code='SEAL_OK',revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state='stopping' AND binding_digest=?`)
        .run(now, request.worktreeId, Number(request.expectedRevision), request.bindingDigest);
      if (result.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare(`INSERT INTO lifecycle_request_results(request_id,request_digest,response_kind,resource_id,created_at) VALUES(?,?,'seal',?,?)`).run(request.requestId, requestDigest, candidate.candidateId, now);
      this.event(database, request.worktreeId, 'seal.completed', 'SEAL_OK'); this.bump(database);
    });
    log('candidate.recorded', { requestId: request.requestId, worktreeId: request.worktreeId, candidateId: candidate.candidateId });
    return candidate;
  }

  async prepareCandidateImport(request: PrepareCandidateImportV1): Promise<CandidateImportIntentV1> {
    await this.ensureStarted(); validateImportIntent(request); const requestDigest = digest('kogg-execution-import-intent-v1', canonicalImportIntent(request));
    const replay = this.databaseOrThrow().prepare(`SELECT request_digest,resource_id FROM lifecycle_request_results WHERE request_id=? AND response_kind='import-intent'`).get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest) throw new AllocationRegistryError('ALLOCATION_REQUEST_REPLAY_MISMATCH');
      return { ...this.importIntent(String(replay.resource_id)), replay: true };
    }
    if (this.admission() !== 'enabled') throw new AllocationRegistryError('ALLOCATION_ADMISSION_BLOCKED');
    const row = this.databaseOrThrow().prepare('SELECT state,revision,binding_digest,repository_id FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    if (!row) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest) throw new AllocationRegistryError('ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
    if (String(row.state) !== 'sealed') throw new AllocationRegistryError('ALLOCATION_STATE_INVALID');
    const candidate = this.databaseOrThrow().prepare('SELECT candidate_id FROM candidates WHERE candidate_id=? AND worktree_id=?').get(request.candidateId, request.worktreeId) as SqlRow | undefined;
    if (!candidate) throw new AllocationRegistryError('ALLOCATION_BINDING_MISMATCH');
    const intentId = randomUUID(); const fencingToken = randomBytes(32).toString('hex'); const now = new Date().toISOString();
    log('repository.lease.requested', { requestId: request.requestId, repositoryId: String(row.repository_id) });
    this.transaction(database => {
      const conflictingLease = database.prepare(`SELECT lease_id FROM repository_mutation_leases WHERE repository_id=? AND phase IN ('active','quarantined')`).get(String(row.repository_id)) as SqlRow | undefined;
      if (conflictingLease) {
        log('repository.lease.refused', { requestId: request.requestId, repositoryId: String(row.repository_id), safeCode: 'ALLOCATION_REPOSITORY_LEASE_CONFLICT' });
        throw new AllocationRegistryError('ALLOCATION_REPOSITORY_LEASE_CONFLICT');
      }
      database.prepare(`INSERT INTO candidate_import_intents(intent_id,worktree_id,candidate_id,fencing_token,expected_source_identity_digest,phase,safe_code,created_at,updated_at) VALUES(?,?,?,?,?,'requested','IMPORT_OK',?,?)`)
        .run(intentId, request.worktreeId, request.candidateId, fencingToken, request.expectedSourceIdentityDigest, now, now);
      database.prepare(`INSERT INTO repository_mutation_leases(lease_id,repository_id,intent_id,worktree_id,fencing_token,owner_instance_id,phase,safe_code,created_at,updated_at) VALUES(?,?,?,?,?,?,'active','IMPORT_OK',?,?)`)
        .run(randomUUID(), String(row.repository_id), intentId, request.worktreeId, fencingToken, this.ownerInstanceId, now, now);
      database.prepare(`INSERT INTO lifecycle_request_results(request_id,request_digest,response_kind,resource_id,created_at) VALUES(?,?,'import-intent',?,?)`).run(request.requestId, requestDigest, intentId, now);
      this.event(database, request.worktreeId, 'import.requested', 'IMPORT_OK'); this.bump(database);
    });
    log('repository.lease.acquired', { requestId: request.requestId, repositoryId: String(row.repository_id), intentId });
    log('import.intent.recorded', { requestId: request.requestId, worktreeId: request.worktreeId, candidateId: request.candidateId, intentId });
    return { schemaVersion: 1, intentId, worktreeId: request.worktreeId, candidateId: request.candidateId, fencingToken, phase: 'requested', replay: false, safeCode: 'IMPORT_OK' };
  }

  async completeCandidateImport(request: CompleteCandidateImportV1): Promise<ImportedCandidateV1> {
    await this.ensureStarted(); validateImportCompletion(request); const requestDigest = digest('kogg-execution-import-complete-v1', canonicalImportCompletion(request));
    const replay = this.databaseOrThrow().prepare(`SELECT request_digest,resource_id FROM lifecycle_request_results WHERE request_id=? AND response_kind='import-complete'`).get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest) throw new AllocationRegistryError('ALLOCATION_REQUEST_REPLAY_MISMATCH');
      return this.importedCandidate(String(replay.resource_id));
    }
    const allocation = this.databaseOrThrow().prepare('SELECT state,revision,binding_digest FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    const intent = this.databaseOrThrow().prepare('SELECT * FROM candidate_import_intents WHERE intent_id=?').get(request.intentId) as SqlRow | undefined;
    const candidate = this.databaseOrThrow().prepare('SELECT * FROM candidates WHERE candidate_id=?').get(request.candidateId) as SqlRow | undefined;
    if (!allocation || !intent || !candidate) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    if (String(allocation.binding_digest) !== request.bindingDigest || String(intent.worktree_id) !== request.worktreeId || String(intent.candidate_id) !== request.candidateId || String(candidate.worktree_id) !== request.worktreeId) throw new AllocationRegistryError('ALLOCATION_BINDING_MISMATCH');
    if (String(allocation.revision) !== request.expectedRevision) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
    if (String(allocation.state) !== 'sealed' || String(intent.phase) !== 'requested') throw new AllocationRegistryError('ALLOCATION_STATE_INVALID');
    if (String(intent.fencing_token) !== request.fencingToken || String(candidate.candidate_commit) !== request.candidateCommit || String(candidate.candidate_tree) !== request.candidateTree) throw new AllocationRegistryError('ALLOCATION_BINDING_MISMATCH');
    const now = new Date().toISOString();
    this.transaction(database => {
      const intentResult = database.prepare(`UPDATE candidate_import_intents SET phase='completed',observed_quarantine_ref_digest=?,safe_code='IMPORT_OK',updated_at=? WHERE intent_id=? AND phase='requested' AND fencing_token=?`).run(request.quarantineRefDigest, now, request.intentId, request.fencingToken);
      const leaseResult = database.prepare(`UPDATE repository_mutation_leases SET phase='released',safe_code='IMPORT_OK',updated_at=? WHERE intent_id=? AND worktree_id=? AND phase='active' AND fencing_token=?`).run(now, request.intentId, request.worktreeId, request.fencingToken);
      const allocationResult = database.prepare(`UPDATE allocations SET state='candidate-imported',safe_code='IMPORT_OK',revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state='sealed' AND binding_digest=?`).run(now, request.worktreeId, Number(request.expectedRevision), request.bindingDigest);
      if (intentResult.changes !== 1 || leaseResult.changes !== 1 || allocationResult.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare('UPDATE candidates SET quarantine_ref_digest=?,updated_at=? WHERE candidate_id=? AND quarantine_ref_digest IS NULL').run(request.quarantineRefDigest, now, request.candidateId);
      database.prepare(`INSERT INTO lifecycle_request_results(request_id,request_digest,response_kind,resource_id,created_at) VALUES(?,?,'import-complete',?,?)`).run(request.requestId, requestDigest, request.candidateId, now);
      this.event(database, request.worktreeId, 'import.completed', 'IMPORT_OK'); this.bump(database);
    });
    log('repository.lease.released', { requestId: request.requestId, worktreeId: request.worktreeId, intentId: request.intentId });
    log('import.completed', { requestId: request.requestId, worktreeId: request.worktreeId, candidateId: request.candidateId, intentId: request.intentId });
    return this.importedCandidate(request.candidateId);
  }

  async failCandidateImport(request: FailCandidateImportV1): Promise<ExecutionAllocationSummaryV1> {
    await this.ensureStarted(); validateImportFailure(request); const requestDigest = digest('kogg-execution-import-failure-v1', canonicalImportFailure(request));
    const replay = this.databaseOrThrow().prepare(`SELECT request_digest,resource_id FROM lifecycle_request_results WHERE request_id=? AND response_kind='state'`).get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest) throw new AllocationRegistryError('ALLOCATION_REQUEST_REPLAY_MISMATCH');
      return this.summary(String(replay.resource_id));
    }
    const allocation = this.databaseOrThrow().prepare('SELECT state,revision,binding_digest FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    const intent = this.databaseOrThrow().prepare('SELECT worktree_id,candidate_id,fencing_token,phase FROM candidate_import_intents WHERE intent_id=?').get(request.intentId) as SqlRow | undefined;
    if (!allocation || !intent) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    if (String(allocation.binding_digest) !== request.bindingDigest || String(intent.worktree_id) !== request.worktreeId || String(intent.candidate_id) !== request.candidateId
      || String(intent.fencing_token) !== request.fencingToken) throw new AllocationRegistryError('ALLOCATION_BINDING_MISMATCH');
    if (String(allocation.revision) !== request.expectedRevision) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
    if (String(allocation.state) !== 'sealed' || String(intent.phase) !== 'requested') throw new AllocationRegistryError('ALLOCATION_STATE_INVALID');
    const now = new Date().toISOString();
    this.transaction(database => {
      const intentResult = database.prepare(`UPDATE candidate_import_intents SET phase='quarantined',safe_code=?,updated_at=? WHERE intent_id=? AND phase='requested' AND fencing_token=?`)
        .run(request.safeCode, now, request.intentId, request.fencingToken);
      const leaseResult = database.prepare(`UPDATE repository_mutation_leases SET phase='quarantined',safe_code=?,updated_at=? WHERE intent_id=? AND worktree_id=? AND phase='active' AND fencing_token=?`)
        .run(request.safeCode, now, request.intentId, request.worktreeId, request.fencingToken);
      const allocationResult = database.prepare(`UPDATE allocations SET state='quarantined',safe_code=?,revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state='sealed' AND binding_digest=?`)
        .run(request.safeCode, now, request.worktreeId, Number(request.expectedRevision), request.bindingDigest);
      if (intentResult.changes !== 1 || leaseResult.changes !== 1 || allocationResult.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare(`INSERT INTO lifecycle_request_results(request_id,request_digest,response_kind,resource_id,created_at) VALUES(?,?,'state',?,?)`).run(request.requestId, requestDigest, request.worktreeId, now);
      database.prepare(`UPDATE execution_meta SET admission='blocked',revision=revision+1 WHERE singleton=1`).run();
      this.event(database, request.worktreeId, 'import.quarantined', request.safeCode);
    });
    log('repository.lease.quarantined', { requestId: request.requestId, worktreeId: request.worktreeId, intentId: request.intentId, safeCode: request.safeCode });
    log('import.quarantined', { requestId: request.requestId, worktreeId: request.worktreeId, candidateId: request.candidateId, intentId: request.intentId, safeCode: request.safeCode });
    return this.summary(request.worktreeId);
  }

  async recordRetention(request: RecordCandidateRetentionV1): Promise<CandidateRetentionV1> {
    await this.ensureStarted(); validateRetention(request);
    const requestDigest = digest('kogg-execution-retention-v1', canonicalRetention(request));
    log('retention.requested', { requestId: request.requestId, worktreeId: request.worktreeId, candidateId: request.candidateId, retentionClass: request.retentionClass });
    const replay = this.databaseOrThrow().prepare('SELECT request_digest,candidate_id FROM retention_request_results WHERE request_id=?').get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (String(replay.request_digest) !== requestDigest) refuseRetention(request, 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
      const result = this.retention(String(replay.candidate_id));
      log('retention.completed', { requestId: request.requestId, worktreeId: request.worktreeId, candidateId: request.candidateId, retentionClass: result.retentionClass });
      return result;
    }
    if (this.admission() !== 'enabled') refuseRetention(request, 'ALLOCATION_ADMISSION_BLOCKED');
    const allocation = this.databaseOrThrow().prepare('SELECT state,revision,binding_digest FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    const candidateRow = this.databaseOrThrow().prepare('SELECT candidate_json,retention_class FROM candidates WHERE candidate_id=? AND worktree_id=?').get(request.candidateId, request.worktreeId) as SqlRow | undefined;
    if (!allocation || !candidateRow) refuseRetention(request, 'ALLOCATION_INTEGRITY_FAILED');
    if (String(allocation.binding_digest) !== request.bindingDigest) refuseRetention(request, 'ALLOCATION_BINDING_MISMATCH');
    if (String(allocation.revision) !== request.expectedRevision) refuseRetention(request, 'ALLOCATION_REVISION_CONFLICT');
    if (!['sealed', 'candidate-imported'].includes(String(allocation.state)) || String(candidateRow.retention_class) !== 'pending-evidence') refuseRetention(request, 'ALLOCATION_STATE_INVALID');
    const now = new Date(); const retentionUntil = new Date(now.getTime() + RETENTION_MILLISECONDS[request.retentionClass]).toISOString();
    const candidate = JSON.parse(String(candidateRow.candidate_json)) as CandidateBindingV1;
    const retainedCandidate: CandidateBindingV1 = { ...candidate, retentionClass: request.retentionClass, retentionUntil };
    this.transaction(database => {
      const candidateResult = database.prepare(`UPDATE candidates SET candidate_json=?,retention_class=?,retention_until=?,updated_at=? WHERE candidate_id=? AND worktree_id=? AND retention_class='pending-evidence'`)
        .run(canonicalCandidate(retainedCandidate), request.retentionClass, retentionUntil, now.toISOString(), request.candidateId, request.worktreeId);
      const allocationResult = database.prepare(`UPDATE allocations SET state='retained',safe_code='RETENTION_OK',revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state=? AND binding_digest=?`)
        .run(now.toISOString(), request.worktreeId, Number(request.expectedRevision), String(allocation.state), request.bindingDigest);
      if (candidateResult.changes !== 1 || allocationResult.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare('INSERT INTO retention_request_results(request_id,request_digest,candidate_id,authority_digest,created_at) VALUES(?,?,?,?,?)')
        .run(request.requestId, requestDigest, request.candidateId, request.authorityDigest, now.toISOString());
      this.event(database, request.worktreeId, 'retention.committed', 'RETENTION_OK'); this.bump(database);
    });
    const result = this.retention(request.candidateId);
    log('retention.completed', { requestId: request.requestId, worktreeId: request.worktreeId, candidateId: request.candidateId, retentionClass: result.retentionClass });
    return result;
  }

  async preparePhysicalCleanup(request: PreparePhysicalCleanupV1): Promise<PhysicalCleanupIntentV1> {
    await this.ensureStarted(); validateCleanupPrepare(request); const requestDigest = digest('kogg-execution-cleanup-prepare-v1', JSON.stringify(request));
    log('cleanup.intent.requested', { requestId: request.requestId, worktreeId: request.worktreeId });
    const replay = this.databaseOrThrow().prepare("SELECT request_digest,intent_id FROM cleanup_request_results WHERE request_id=? AND request_kind='prepare'").get(request.requestId) as SqlRow | undefined;
    if (replay) { if (String(replay.request_digest) !== requestDigest) refuseCleanup(request, 'ALLOCATION_REQUEST_REPLAY_MISMATCH'); return this.cleanupIntent(String(replay.intent_id)); }
    if (this.admission() !== 'enabled') refuseCleanup(request, 'ALLOCATION_ADMISSION_BLOCKED');
    const row = this.databaseOrThrow().prepare('SELECT * FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    if (!row || !physicalIdentityValid(row)) refuseCleanup(request, 'ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest) refuseCleanup(request, 'ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) refuseCleanup(request, 'ALLOCATION_REVISION_CONFLICT');
    const state = String(row.state) as ExecutionState; if (!LEGAL_TRANSITIONS[state].includes('cleaning')) refuseCleanup(request, 'ALLOCATION_STATE_INVALID');
    const binding = JSON.parse(String(row.binding_json)) as ExecutionBindingV1;
    if (!await this.targets.authorizePhysicalAllocation(binding, String(row.helper_digest), String(row.mount_quota_digest))) refuseCleanup(request, 'ALLOCATION_QUALIFICATION_INVALID');
    if (state === 'retained') {
      const retention = this.databaseOrThrow().prepare('SELECT retention_class,retention_until FROM candidates WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
      if (!retention || String(retention.retention_class) === 'pending-evidence' || !validTime(String(retention.retention_until))) refuseCleanup(request, 'ALLOCATION_INTEGRITY_FAILED');
      if (Date.parse(String(retention.retention_until)) > Date.now()) refuseCleanup(request, 'RETENTION_ACTIVE');
    }
    const intentId = randomUUID(); const fencingToken = randomBytes(32).toString('hex'); const now = new Date().toISOString();
    this.transaction(database => {
      const changed = database.prepare("UPDATE allocations SET state='cleaning',cleanup_state='cleaning',safe_code='ALLOCATION_OK',revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state=? AND binding_digest=?").run(now, request.worktreeId, Number(request.expectedRevision), state, request.bindingDigest);
      if (changed.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare("INSERT INTO allocation_intents(intent_id,worktree_id,intent_type,phase,fencing_token,expected_identity_digest,safe_code,created_at,updated_at) VALUES(?,?,'cleanup','requested',?,?,'ALLOCATION_OK',?,?)").run(intentId, request.worktreeId, fencingToken, String(row.filesystem_identity_digest), now, now);
      database.prepare("INSERT INTO cleanup_request_results(request_id,request_digest,request_kind,intent_id,worktree_id,created_at) VALUES(?,?,'prepare',?,?,?)").run(request.requestId, requestDigest, intentId, request.worktreeId, now);
      this.event(database, request.worktreeId, 'cleanup.requested', 'ALLOCATION_OK'); this.bump(database);
    });
    log('cleanup.intent.recorded', { requestId: request.requestId, worktreeId: request.worktreeId, intentId }); return this.cleanupIntent(intentId);
  }

  async completePhysicalCleanup(request: CompletePhysicalCleanupV1): Promise<ExecutionAllocationSummaryV1> {
    await this.ensureStarted(); validateCleanupComplete(request); const requestDigest = digest('kogg-execution-cleanup-complete-v1', JSON.stringify(request));
    log('cleanup.proof.requested', { requestId: request.requestId, worktreeId: request.worktreeId, intentId: request.intentId });
    const replay = this.databaseOrThrow().prepare("SELECT request_digest,worktree_id FROM cleanup_request_results WHERE request_id=? AND request_kind='complete'").get(request.requestId) as SqlRow | undefined;
    if (replay) { if (String(replay.request_digest) !== requestDigest) refuseCleanup(request, 'ALLOCATION_REQUEST_REPLAY_MISMATCH'); return this.summary(String(replay.worktree_id)); }
    const row = this.databaseOrThrow().prepare('SELECT * FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    const intent = this.databaseOrThrow().prepare("SELECT * FROM allocation_intents WHERE intent_id=? AND intent_type='cleanup'").get(request.intentId) as SqlRow | undefined;
    if (!row || !intent || !physicalIdentityValid(row)) refuseCleanup(request, 'ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest || String(intent.worktree_id) !== request.worktreeId || String(intent.fencing_token) !== request.fencingToken || String(intent.expected_identity_digest) !== request.expectedIdentityDigest) refuseCleanup(request, 'ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) refuseCleanup(request, 'ALLOCATION_REVISION_CONFLICT');
    if (String(row.state) !== 'cleaning' || String(intent.phase) !== 'requested') refuseCleanup(request, 'ALLOCATION_STATE_INVALID');
    if (request.preDeleteIdentityDigest !== request.expectedIdentityDigest || request.expectedIdentityDigest !== String(row.filesystem_identity_digest)) refuseCleanup(request, 'CLEANUP_IDENTITY_MISMATCH');
    const binding = JSON.parse(String(row.binding_json)) as ExecutionBindingV1; if (!await this.targets.authorizePhysicalAllocation(binding, request.helperDigest, request.mountQuotaDigest) || request.helperDigest !== String(row.helper_digest) || request.mountQuotaDigest !== String(row.mount_quota_digest)) refuseCleanup(request, 'ALLOCATION_QUALIFICATION_INVALID');
    const expectedAbsence = cleanupAbsenceProof(request); if (request.absenceProofDigest !== expectedAbsence) refuseCleanup(request, 'CLEANUP_IDENTITY_MISMATCH');
    const now = new Date().toISOString();
    this.transaction(database => {
      const intentResult = database.prepare("UPDATE allocation_intents SET phase='completed',observed_identity_digest=?,safe_code='ALLOCATION_OK',updated_at=? WHERE intent_id=? AND intent_type='cleanup' AND phase='requested' AND fencing_token=?").run(request.absenceProofDigest, now, request.intentId, request.fencingToken);
      const allocationResult = database.prepare("UPDATE allocations SET state='cleaned',cleanup_state='cleaned',safe_code='ALLOCATION_OK',revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state='cleaning' AND binding_digest=?").run(now, request.worktreeId, Number(request.expectedRevision), request.bindingDigest);
      const leaseResult = database.prepare("UPDATE quota_project_leases SET phase='released',safe_code='ALLOCATION_OK',updated_at=? WHERE worktree_id=? AND project_id=? AND phase='allocated'").run(now, request.worktreeId, Number(row.quota_project_id));
      if (intentResult.changes !== 1 || allocationResult.changes !== 1 || leaseResult.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare("INSERT INTO cleanup_request_results(request_id,request_digest,request_kind,intent_id,worktree_id,created_at) VALUES(?,?,'complete',?,?,?)").run(request.requestId, requestDigest, request.intentId, request.worktreeId, now);
      this.event(database, request.worktreeId, 'cleanup.completed', 'ALLOCATION_OK'); this.bump(database);
    });
    log('cleanup.proof.completed', { requestId: request.requestId, worktreeId: request.worktreeId, intentId: request.intentId }); return this.summary(request.worktreeId);
  }

  async failPhysicalCleanup(request: FailPhysicalCleanupV1): Promise<ExecutionAllocationSummaryV1> {
    await this.ensureStarted(); validateCleanupFailure(request); const requestDigest = digest('kogg-execution-cleanup-failure-v1', JSON.stringify(request));
    log('cleanup.failure.requested', { requestId: request.requestId, worktreeId: request.worktreeId, intentId: request.intentId });
    const replay = this.databaseOrThrow().prepare("SELECT request_digest,worktree_id FROM cleanup_request_results WHERE request_id=? AND request_kind='failure'").get(request.requestId) as SqlRow | undefined;
    if (replay) { if (String(replay.request_digest) !== requestDigest) refuseCleanup(request, 'ALLOCATION_REQUEST_REPLAY_MISMATCH'); return this.summary(String(replay.worktree_id)); }
    const row = this.databaseOrThrow().prepare('SELECT state,revision,binding_digest FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    const intent = this.databaseOrThrow().prepare("SELECT * FROM allocation_intents WHERE intent_id=? AND intent_type='cleanup'").get(request.intentId) as SqlRow | undefined;
    if (!row || !intent) refuseCleanup(request, 'ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest || String(intent.worktree_id) !== request.worktreeId || String(intent.fencing_token) !== request.fencingToken || String(intent.expected_identity_digest) !== request.expectedIdentityDigest) refuseCleanup(request, 'ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) refuseCleanup(request, 'ALLOCATION_REVISION_CONFLICT');
    if (String(row.state) !== 'cleaning' || String(intent.phase) !== 'requested') refuseCleanup(request, 'ALLOCATION_STATE_INVALID');
    const quarantined = request.safeCode === 'CLEANUP_IDENTITY_MISMATCH' || request.observedIdentityDigest !== request.expectedIdentityDigest; const nextState = quarantined ? 'quarantined' : 'cleanup-failed'; const now = new Date().toISOString();
    this.transaction(database => {
      const intentResult = database.prepare("UPDATE allocation_intents SET phase=?,observed_identity_digest=?,safe_code=?,updated_at=? WHERE intent_id=? AND intent_type='cleanup' AND phase='requested' AND fencing_token=?").run(quarantined ? 'quarantined' : 'failed', request.observedIdentityDigest, request.safeCode, now, request.intentId, request.fencingToken);
      const allocationResult = database.prepare('UPDATE allocations SET state=?,cleanup_state=\'failed\',safe_code=?,revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state=\'cleaning\' AND binding_digest=?').run(nextState, request.safeCode, now, request.worktreeId, Number(request.expectedRevision), request.bindingDigest);
      const leaseResult = quarantined ? database.prepare("UPDATE quota_project_leases SET phase='quarantined',safe_code=?,updated_at=? WHERE worktree_id=? AND phase='allocated'").run(request.safeCode, now, request.worktreeId) : undefined;
      if (intentResult.changes !== 1 || allocationResult.changes !== 1 || (leaseResult && leaseResult.changes !== 1)) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare("INSERT INTO cleanup_request_results(request_id,request_digest,request_kind,intent_id,worktree_id,created_at) VALUES(?,?,'failure',?,?,?)").run(request.requestId, requestDigest, request.intentId, request.worktreeId, now);
      database.prepare("UPDATE execution_meta SET admission='blocked',revision=revision+1 WHERE singleton=1").run(); this.event(database, request.worktreeId, quarantined ? 'cleanup.quarantined' : 'cleanup.failed', request.safeCode);
    });
    log(quarantined ? 'cleanup.quarantined' : 'cleanup.failed', { requestId: request.requestId, worktreeId: request.worktreeId, intentId: request.intentId, safeCode: request.safeCode }); return this.summary(request.worktreeId);
  }

  diagnostics(): ExecutionAllocationDiagnostics {
    const database = this.databaseOrThrow();
    const count = (sql: string): number => Number((database.prepare(sql).get() as SqlRow).count);
    return {
      integrity: String((database.prepare('PRAGMA integrity_check').get() as SqlRow).integrity_check) === 'ok' && ownerEventsValid(database),
      foreignKeys: database.prepare('PRAGMA foreign_key_check').all().length === 0,
      permissions: process.platform === 'win32' || (statSync(this.databasePath).mode & 0o077) === 0,
      admission: this.admission(),
      activeCount: count(`SELECT count(*) AS count FROM allocations WHERE state NOT IN ('refused','cleaned','quarantined')`),
      quarantinedCount: count(`SELECT count(*) AS count FROM allocations WHERE state='quarantined'`),
      recoveryRequiredCount: count(`SELECT count(*) AS count FROM allocations WHERE state IN ('recovery-required','reconciling')`),
      unverifiedCount: count(`SELECT count(*) AS count FROM allocations WHERE state IN ('admitted','allocated','seeding')`),
      cleanupFailureCount: count(`SELECT count(*) AS count FROM allocations WHERE state='cleanup-failed' OR cleanup_state='failed'`),
      reservationCount: count(`SELECT count(*) AS count FROM allocations WHERE state NOT IN ('refused','cleaned')`),
      candidateCount: count('SELECT count(*) AS count FROM candidates'),
      pendingAllocationIntentCount: count(`SELECT count(*) AS count FROM allocation_intents WHERE intent_type='allocation' AND phase='requested'`),
      pendingImportIntentCount: count(`SELECT count(*) AS count FROM candidate_import_intents WHERE phase='requested'`),
      activeRepositoryLeaseCount: count(`SELECT count(*) AS count FROM repository_mutation_leases WHERE phase='active'`),
      quarantinedRepositoryLeaseCount: count(`SELECT count(*) AS count FROM repository_mutation_leases WHERE phase='quarantined'`),
      activeQuotaProjectLeaseCount: count(`SELECT count(*) AS count FROM quota_project_leases WHERE phase IN ('active','allocated')`),
      quarantinedQuotaProjectLeaseCount: count(`SELECT count(*) AS count FROM quota_project_leases WHERE phase='quarantined'`),
      pendingCleanupIntentCount: count(`SELECT count(*) AS count FROM allocation_intents WHERE intent_type='cleanup' AND phase='requested'`),
      retentionViolationCount: count(`SELECT count(*) AS count FROM candidates JOIN allocations ON allocations.worktree_id=candidates.worktree_id LEFT JOIN retention_request_results ON retention_request_results.candidate_id=candidates.candidate_id WHERE (allocations.state='retained' AND (candidates.retention_class='pending-evidence' OR retention_request_results.candidate_id IS NULL)) OR (allocations.state IN ('sealed','candidate-imported') AND candidates.retention_class<>'pending-evidence') OR (allocations.state IN ('cleaning','cleaned') AND candidates.retention_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
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
      this.migrate(); if (process.platform !== 'win32') chmodSync(this.databasePath, 0o600); this.assertIntegrity(); this.recover(); this.publishOwnerEvents();
      log('registry.start.completed', { admission: this.admission() });
    } catch (error) {
      log('registry.start.failed', { safeCode: 'ALLOCATION_INTEGRITY_FAILED', errorType: errorType(error) });
      this.database?.close(); this.database = undefined; this.startup = undefined; throw error;
    }
  }

  private migrate(): void {
    this.databaseOrThrow().exec(`
      CREATE TABLE IF NOT EXISTS execution_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),revision INTEGER NOT NULL CHECK(revision>=1),owner_instance_id TEXT NOT NULL,owner_id TEXT,owner_epoch_id TEXT,admission TEXT NOT NULL CHECK(admission IN ('enabled','recovering','blocked')));
      CREATE TABLE IF NOT EXISTS allocations(
        worktree_id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,attempt_id TEXT NOT NULL,project_id TEXT NOT NULL,repository_id TEXT NOT NULL,
        binding_json TEXT NOT NULL,binding_digest TEXT NOT NULL,allocation_name TEXT NOT NULL UNIQUE,allocation_nonce TEXT NOT NULL,
        allocation_nonce_digest TEXT NOT NULL,filesystem_identity_digest TEXT,filesystem_device TEXT,filesystem_inode TEXT,owner_uid TEXT,allocation_mode TEXT,mount_id TEXT,quota_project_id TEXT,helper_digest TEXT,mount_quota_digest TEXT,quota_bytes TEXT NOT NULL,quota_inodes TEXT NOT NULL,
        owner_instance_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('requested','refused','admitted','allocated','seeding','verified','ready','leased','executing','stopping','sealed','candidate-imported','retained','cleaning','cleaned','failed','timed-out','cancelled','cleanup-failed','quarantined','recovery-required','reconciling')),
        cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('required','cleaning','cleaned','failed')),safe_code TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS allocation_intents(intent_id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),intent_type TEXT NOT NULL,phase TEXT NOT NULL,fencing_token TEXT NOT NULL,expected_revision TEXT,expected_identity_digest TEXT,observed_identity_digest TEXT,helper_digest TEXT,mount_quota_digest TEXT,safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS allocation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),event_id TEXT,event_name TEXT NOT NULL,execution_state TEXT,event_digest TEXT,previous_event_digest TEXT,safe_code TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS physical_allocation_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),filesystem_identity_digest TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS physical_allocation_prepare_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,intent_id TEXT NOT NULL UNIQUE REFERENCES allocation_intents(intent_id),worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS physical_allocation_failure_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,intent_id TEXT NOT NULL UNIQUE REFERENCES allocation_intents(intent_id),worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup_request_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,request_kind TEXT NOT NULL CHECK(request_kind IN ('prepare','complete','failure')),intent_id TEXT NOT NULL REFERENCES allocation_intents(intent_id),worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle_request_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,response_kind TEXT NOT NULL CHECK(response_kind IN ('state','seal','import-intent','import-complete')),resource_id TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(candidate_id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL UNIQUE REFERENCES allocations(worktree_id),candidate_json TEXT NOT NULL,candidate_commit TEXT NOT NULL,candidate_tree TEXT NOT NULL,object_closure_digest TEXT NOT NULL,mutation_policy_digest TEXT NOT NULL,quarantine_ref_digest TEXT,retention_class TEXT NOT NULL CHECK(retention_class IN ('pending-evidence','rejected','incident','completed')),retention_until TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT);
      CREATE TABLE IF NOT EXISTS retention_request_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),authority_digest TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidate_import_intents(intent_id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),fencing_token TEXT NOT NULL,expected_source_identity_digest TEXT NOT NULL,observed_quarantine_ref_digest TEXT,phase TEXT NOT NULL CHECK(phase IN ('requested','completed','failed','quarantined')),safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_mutation_leases(lease_id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,intent_id TEXT NOT NULL UNIQUE REFERENCES candidate_import_intents(intent_id),worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),fencing_token TEXT NOT NULL,owner_instance_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('active','released','quarantined')),safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quota_project_leases(project_id INTEGER PRIMARY KEY CHECK(project_id BETWEEN 10000 AND 4294967295),intent_id TEXT NOT NULL UNIQUE REFERENCES allocation_intents(intent_id),worktree_id TEXT NOT NULL UNIQUE REFERENCES allocations(worktree_id),phase TEXT NOT NULL CHECK(phase IN ('active','allocated','released','quarantined')),safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS repository_mutation_lease_owner ON repository_mutation_leases(repository_id) WHERE phase IN ('active','quarantined');
      INSERT OR IGNORE INTO execution_meta(singleton,schema_version,revision,owner_instance_id,admission) VALUES(1,1,1,'bootstrap','recovering');
    `);
    ensurePhysicalIdentitySchema(this.databaseOrThrow());
    ensureAllocationIntentSchema(this.databaseOrThrow());
    ensureQuotaProjectLeaseSchema(this.databaseOrThrow());
    ensureOwnerSchema(this.databaseOrThrow());
    const version = Number((this.databaseOrThrow().prepare('SELECT schema_version FROM execution_meta WHERE singleton=1').get() as SqlRow).schema_version);
    if (version !== 1) throw new Error('Unsupported execution registry schema');
  }

  private assertIntegrity(): void {
    const database = this.databaseOrThrow();
    if (String((database.prepare('PRAGMA integrity_check').get() as SqlRow).integrity_check) !== 'ok'
      || database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Execution registry integrity failed');
    if (!ownerEventsValid(database)) throw new Error('Execution owner event integrity failed');
    for (const row of database.prepare("SELECT * FROM allocations WHERE filesystem_identity_digest IS NOT NULL").all() as SqlRow[]) if (!physicalIdentityValid(row)) throw new Error('Execution physical identity integrity failed');
    if (!quotaProjectLeasesValid(database)) throw new Error('Execution quota project lease integrity failed');
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
        current.prepare(`UPDATE repository_mutation_leases SET phase='quarantined',safe_code='RECOVERY_OWNER_UNAVAILABLE',updated_at=? WHERE worktree_id=? AND phase='active'`).run(new Date().toISOString(), worktreeId);
        current.prepare(`UPDATE quota_project_leases SET phase='quarantined',safe_code='RECOVERY_OWNER_UNAVAILABLE',updated_at=? WHERE worktree_id=? AND phase IN ('active','allocated')`).run(new Date().toISOString(), worktreeId);
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
      cleanupState: String(row.cleanup_state) as ExecutionAllocationSummaryV1['cleanupState'], safeCode: String(row.safe_code) as ExecutionAllocationSummaryV1['safeCode']
    };
  }
  private candidate(candidateId: string): CandidateBindingV1 { const row = this.databaseOrThrow().prepare('SELECT candidate_json FROM candidates WHERE candidate_id=?').get(candidateId) as SqlRow | undefined; if (!row) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED'); return JSON.parse(String(row.candidate_json)) as CandidateBindingV1; }
  private retention(candidateId: string): CandidateRetentionV1 {
    const row = this.databaseOrThrow().prepare(`SELECT candidates.candidate_id,candidates.worktree_id,candidates.retention_class,candidates.retention_until,allocations.state,allocations.revision FROM candidates JOIN allocations ON allocations.worktree_id=candidates.worktree_id WHERE candidates.candidate_id=?`).get(candidateId) as SqlRow | undefined;
    if (!row || String(row.state) !== 'retained' || !['rejected', 'incident', 'completed'].includes(String(row.retention_class)) || !validTime(String(row.retention_until))) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    return { schemaVersion: 1, candidateId, worktreeId: String(row.worktree_id), retentionClass: String(row.retention_class) as CandidateRetentionV1['retentionClass'], retentionUntil: String(row.retention_until), state: 'retained', revision: String(row.revision), safeCode: 'RETENTION_OK' };
  }
  private cleanupIntent(intentId: string): PhysicalCleanupIntentV1 {
    const row = this.databaseOrThrow().prepare("SELECT i.intent_id,i.fencing_token,i.expected_identity_digest,a.* FROM allocation_intents i JOIN allocations a ON a.worktree_id=i.worktree_id WHERE i.intent_id=? AND i.intent_type='cleanup'").get(intentId) as SqlRow | undefined;
    if (!row || !physicalIdentityValid(row)) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    return { schemaVersion: 1, intentId, worktreeId: String(row.worktree_id), fencingToken: String(row.fencing_token), expectedRevision: String(row.revision), expectedIdentityDigest: String(row.expected_identity_digest), allocationName: String(row.allocation_name), allocationNonce: String(row.allocation_nonce), ownerInstanceId: String(row.owner_instance_id), createdAt: String(row.created_at), filesystemDevice: String(row.filesystem_device), filesystemInode: String(row.filesystem_inode), ownerUid: String(row.owner_uid), mode: '0700', mountId: String(row.mount_id), quotaProjectId: String(row.quota_project_id), quotaBytes: String(row.quota_bytes), quotaInodes: String(row.quota_inodes), helperDigest: String(row.helper_digest), mountQuotaDigest: String(row.mount_quota_digest) };
  }
  private physicalAllocationIntent(intentId: string): PhysicalAllocationIntentV1 {
    const row = this.databaseOrThrow().prepare("SELECT i.intent_id,i.fencing_token,i.expected_revision AS intent_expected_revision,i.helper_digest AS intent_helper_digest,i.mount_quota_digest AS intent_mount_quota_digest,q.project_id AS lease_project_id,q.phase AS lease_phase,a.* FROM allocation_intents i JOIN allocations a ON a.worktree_id=i.worktree_id JOIN quota_project_leases q ON q.intent_id=i.intent_id WHERE i.intent_id=? AND i.intent_type='allocation'").get(intentId) as SqlRow | undefined;
    if (!row || !['active', 'allocated', 'released', 'quarantined'].includes(String(row.lease_phase)) || !DECIMAL.test(String(row.intent_expected_revision)) || !DIGEST.test(String(row.intent_helper_digest)) || !DIGEST.test(String(row.intent_mount_quota_digest)) || !validTime(String(row.created_at))) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    return { schemaVersion: 1, intentId, worktreeId: String(row.worktree_id), fencingToken: String(row.fencing_token), expectedRevision: String(row.intent_expected_revision), allocationName: String(row.allocation_name), allocationNonce: String(row.allocation_nonce), ownerInstanceId: String(row.owner_instance_id), createdAt: String(row.created_at), quotaProjectId: String(row.lease_project_id), quotaBytes: String(row.quota_bytes), quotaInodes: String(row.quota_inodes), helperDigest: String(row.intent_helper_digest), mountQuotaDigest: String(row.intent_mount_quota_digest) };
  }
  private importIntent(intentId: string): CandidateImportIntentV1 { const row = this.databaseOrThrow().prepare('SELECT * FROM candidate_import_intents WHERE intent_id=?').get(intentId) as SqlRow | undefined; if (!row || String(row.phase) !== 'requested') throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED'); return { schemaVersion: 1, intentId, worktreeId: String(row.worktree_id), candidateId: String(row.candidate_id), fencingToken: String(row.fencing_token), phase: 'requested', replay: false, safeCode: 'IMPORT_OK' }; }
  private importedCandidate(candidateId: string): ImportedCandidateV1 { const candidate = this.candidate(candidateId); const row = this.databaseOrThrow().prepare('SELECT quarantine_ref_digest FROM candidates WHERE candidate_id=?').get(candidateId) as SqlRow | undefined; if (!row || !DIGEST.test(String(row.quarantine_ref_digest))) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED'); const { safeCode: _sealCode, ...binding } = candidate; return { ...binding, quarantineRefDigest: String(row.quarantine_ref_digest), safeCode: 'IMPORT_OK' }; }
  private admission(): ExecutionAllocationDiagnostics['admission'] { return String((this.databaseOrThrow().prepare('SELECT admission FROM execution_meta WHERE singleton=1').get() as SqlRow).admission) as ExecutionAllocationDiagnostics['admission']; }
  private event(database: DatabaseSync, worktreeId: string, eventName: string, safeCode: string): void {
    const allocation = database.prepare('SELECT state FROM allocations WHERE worktree_id=?').get(worktreeId) as SqlRow;
    const eventId = randomUUID(); const executionState = String(allocation.state); const createdAt = new Date().toISOString();
    const prior = database.prepare('SELECT event_digest FROM allocation_events ORDER BY sequence DESC LIMIT 1').get() as SqlRow | undefined;
    const previousEventDigest = prior ? String(prior.event_digest) : '0'.repeat(64);
    const eventDigest = ownerHash({ eventId, worktreeId, eventName, executionState, safeCode, createdAt, previousEventDigest });
    database.prepare('INSERT INTO allocation_events(worktree_id,event_id,event_name,execution_state,event_digest,previous_event_digest,safe_code,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(worktreeId, eventId, eventName, executionState, eventDigest, previousEventDigest, safeCode, createdAt);
  }
  private bump(database: DatabaseSync): void { database.prepare('UPDATE execution_meta SET revision=revision+1 WHERE singleton=1').run(); }
  private transaction(run: (database: DatabaseSync) => void): void { const database = this.databaseOrThrow(); database.exec('BEGIN IMMEDIATE'); try { run(database); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; } this.publishOwnerEvents(); }
  private databaseOrThrow(): DatabaseSync { if (!this.database) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED'); return this.database; }
}

export class AllocationRegistryError extends Error { constructor(readonly code: ExecutionLifecycleCode) { super(code); this.name = 'AllocationRegistryError'; } }

function validateRequest(request: ReserveExecutionAllocationV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'binding,quotaBytes,quotaInodes,requestId'
    || !UUID.test(request.requestId) || !boundedDecimal(request.quotaBytes, 10n * 1024n * 1024n * 1024n * 1024n)
    || !boundedDecimal(request.quotaInodes, 1_000_000_000n)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
  validateBinding(request.binding);
}
function validateProjectionRequest(request: unknown, keys: 'requestId,runId' | 'projectId,requestId'): asserts request is GetExecutionRunV1 & ListExecutionRunsV1 {
  const value = request as Record<string, unknown> | undefined;
  if (!value || Object.keys(value).sort().join(',') !== keys
    || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
    || (keys === 'requestId,runId' && (typeof value.runId !== 'string' || !UUID.test(value.runId)))
    || (keys === 'projectId,requestId' && (typeof value.projectId !== 'string' || !UUID.test(value.projectId)))) {
    log('projection.request.refused', { safeCode: 'ALLOCATION_PROTOCOL_INVALID' });
    throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
  }
}
function validateAdvance(request: AdvanceExecutionStateV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'bindingDigest,expectedRevision,nextState,requestId,safeCode,worktreeId'
    || !UUID.test(request.requestId) || !UUID.test(request.worktreeId) || !DIGEST.test(request.bindingDigest)
    || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0' || !Object.hasOwn(LEGAL_TRANSITIONS, request.nextState)
    || !TRANSITION_CODES.has(request.safeCode)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validatePhysicalAllocation(request: RecordPhysicalAllocationV1): void {
  const keys = ['allocationName', 'allocationNonceDigest', 'bindingDigest', 'expectedRevision', 'fencingToken', 'filesystemDevice', 'filesystemInode', 'helperDigest', 'intentId', 'mode', 'mountId', 'mountQuotaDigest', 'ownerUid', 'quotaBytes', 'quotaInodes', 'quotaProjectId', 'requestId', 'worktreeId'];
  if (!request || Object.keys(request).sort().join(',') !== keys.join(',')
    || ![request.requestId, request.intentId, request.worktreeId].every(value => UUID.test(value)) || !SHA256.test(request.fencingToken)
    || ![request.allocationNonceDigest, request.bindingDigest, request.helperDigest, request.mountQuotaDigest].every(value => DIGEST.test(value))
    || !/^r-[a-z2-7]{26}$/u.test(request.allocationName) || request.mode !== '0700'
    || ![request.expectedRevision, request.filesystemDevice, request.filesystemInode, request.ownerUid, request.mountId, request.quotaProjectId, request.quotaBytes, request.quotaInodes].every(value => DECIMAL.test(value))
    || request.expectedRevision === '0' || request.filesystemInode === '0' || request.quotaProjectId === '0'
    || !boundedDecimal(request.quotaBytes, 10n * 1024n * 1024n * 1024n * 1024n) || !boundedDecimal(request.quotaInodes, 1_000_000_000n)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validatePhysicalAllocationPrepare(request: PreparePhysicalAllocationV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'bindingDigest,expectedRevision,helperDigest,mountQuotaDigest,requestId,worktreeId'
    || ![request.requestId, request.worktreeId].every(value => UUID.test(value))
    || ![request.bindingDigest, request.helperDigest, request.mountQuotaDigest].every(value => DIGEST.test(value))
    || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0') throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validatePhysicalAllocationFailure(request: FailPhysicalAllocationV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'bindingDigest,expectedRevision,fencingToken,intentId,requestId,safeCode,worktreeId'
    || ![request.requestId, request.intentId, request.worktreeId].every(value => UUID.test(value)) || !DIGEST.test(request.bindingDigest)
    || !SHA256.test(request.fencingToken) || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0'
    || !['ALLOCATION_INTEGRITY_FAILED', 'ALLOCATION_QUALIFICATION_INVALID', 'CLEANUP_IDENTITY_MISMATCH'].includes(request.safeCode)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validateSealed(request: RecordSealedCandidateV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'bindingDigest,candidate,expectedRevision,requestId,worktreeId'
    || !UUID.test(request.requestId) || !UUID.test(request.worktreeId) || !DIGEST.test(request.bindingDigest) || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0') throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
  const candidate = request.candidate; const keys = ['attemptId', 'baseCommit', 'baseTree', 'candidateCommit', 'candidateId', 'candidateTree', 'mutationPolicyDigest', 'objectClosureDigest', 'retentionClass', 'retentionUntil', 'safeCode', 'schemaVersion', 'sealedAt', 'worktreeId', 'runId'];
  if (!candidate || Object.keys(candidate).sort().join(',') !== keys.sort().join(',') || candidate.schemaVersion !== 1 || candidate.safeCode !== 'SEAL_OK' || candidate.retentionClass !== 'pending-evidence'
    || ![candidate.candidateId, candidate.worktreeId, candidate.runId, candidate.attemptId].every(UUID.test.bind(UUID)) || !DIGEST.test(candidate.objectClosureDigest)
    || candidate.mutationPolicyDigest !== CANDIDATE_MUTATION_POLICY_DIGEST || ![candidate.baseCommit, candidate.baseTree, candidate.candidateCommit, candidate.candidateTree].every(value => SHA1.test(value) || SHA256.test(value))
    || candidate.retentionUntil !== '9999-12-31T23:59:59.999Z' || !validTime(candidate.sealedAt)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validateImportIntent(request: PrepareCandidateImportV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'bindingDigest,candidateId,expectedRevision,expectedSourceIdentityDigest,requestId,worktreeId'
    || ![request.requestId, request.worktreeId, request.candidateId].every(value => UUID.test(value)) || ![request.bindingDigest, request.expectedSourceIdentityDigest].every(value => DIGEST.test(value))
    || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0') throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validateImportCompletion(request: CompleteCandidateImportV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'bindingDigest,candidateCommit,candidateId,candidateTree,expectedRevision,fencingToken,intentId,quarantineRefDigest,requestId,worktreeId'
    || ![request.requestId, request.intentId, request.worktreeId, request.candidateId].every(value => UUID.test(value)) || ![request.bindingDigest, request.quarantineRefDigest].every(value => DIGEST.test(value))
    || !/^[0-9a-f]{64}$/u.test(request.fencingToken) || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0'
    || ![request.candidateCommit, request.candidateTree].every(value => SHA1.test(value) || SHA256.test(value))) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validateImportFailure(request: FailCandidateImportV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'bindingDigest,candidateId,expectedRevision,fencingToken,intentId,requestId,safeCode,worktreeId'
    || ![request.requestId, request.intentId, request.worktreeId, request.candidateId].every(value => UUID.test(value)) || !DIGEST.test(request.bindingDigest)
    || !/^[0-9a-f]{64}$/u.test(request.fencingToken) || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0'
    || !IMPORT_FAILURE_CODES.has(request.safeCode)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validateRetention(request: RecordCandidateRetentionV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'authorityDigest,bindingDigest,candidateId,expectedRevision,requestId,retentionClass,worktreeId'
    || ![request.requestId, request.worktreeId, request.candidateId].every(value => UUID.test(value))
    || ![request.bindingDigest, request.authorityDigest].every(value => DIGEST.test(value))
    || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0'
    || !Object.hasOwn(RETENTION_MILLISECONDS, request.retentionClass)) throw new AllocationRegistryError('RETENTION_PROTOCOL_INVALID');
}
function validateCleanupPrepare(request: PreparePhysicalCleanupV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'bindingDigest,expectedRevision,requestId,worktreeId'
    || ![request.requestId, request.worktreeId].every(value => UUID.test(value)) || !DIGEST.test(request.bindingDigest)
    || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0') throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validateCleanupComplete(request: CompletePhysicalCleanupV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'absenceProofDigest,bindingDigest,expectedIdentityDigest,expectedRevision,fencingToken,helperDigest,intentId,mountQuotaDigest,preDeleteIdentityDigest,requestId,worktreeId'
    || ![request.requestId, request.intentId, request.worktreeId].every(value => UUID.test(value))
    || ![request.bindingDigest, request.expectedIdentityDigest, request.preDeleteIdentityDigest, request.absenceProofDigest, request.helperDigest, request.mountQuotaDigest].every(value => DIGEST.test(value))
    || !SHA256.test(request.fencingToken) || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0') throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validateCleanupFailure(request: FailPhysicalCleanupV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'bindingDigest,expectedIdentityDigest,expectedRevision,fencingToken,intentId,observedIdentityDigest,requestId,safeCode,worktreeId'
    || ![request.requestId, request.intentId, request.worktreeId].every(value => UUID.test(value))
    || ![request.bindingDigest, request.expectedIdentityDigest, request.observedIdentityDigest].every(value => DIGEST.test(value))
    || !SHA256.test(request.fencingToken) || !DECIMAL.test(request.expectedRevision) || request.expectedRevision === '0'
    || !['CLEANUP_FAILED', 'CLEANUP_IDENTITY_MISMATCH'].includes(request.safeCode)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function validateBinding(value: ExecutionBindingV1): void {
  const object = value?.gitObjectFormat === 'sha1' ? SHA1 : SHA256;
  if (!value || Object.keys(value).sort().join(',') !== [...BINDING_FIELDS].sort().join(',') || value.schemaVersion !== 1
    || ![value.projectId, value.repositoryId, value.taskId, value.taskRevisionId, value.runId, value.attemptId, value.qualificationId].every(id => UUID.test(id))
    || ![value.projectRevision, value.repositoryBindingRevision].every(revision => DECIMAL.test(revision))
    || ![value.repositoryIdentityDigest, value.taskRevisionDigest, value.approvalDigest, value.workflowPlanDigest, value.qualificationDigest, value.profileDigest].every(item => DIGEST.test(item))
    || !object.test(value.baseCommit) || !object.test(value.baseTree) || !SYMBOLIC.test(value.targetId)
    || value.profileId !== 'kogg-writable-agent-v1' || !['sha1', 'sha256'].includes(value.gitObjectFormat)) throw new AllocationRegistryError('ALLOCATION_PROTOCOL_INVALID');
}
function canonicalRequest(value: ReserveExecutionAllocationV1): string { return `{"binding":${canonicalBinding(value.binding)},"quotaBytes":${JSON.stringify(value.quotaBytes)},"quotaInodes":${JSON.stringify(value.quotaInodes)},"requestId":${JSON.stringify(value.requestId)}}`; }
function canonicalAdvance(value: AdvanceExecutionStateV1): string { return `{"bindingDigest":${JSON.stringify(value.bindingDigest)},"expectedRevision":${JSON.stringify(value.expectedRevision)},"nextState":${JSON.stringify(value.nextState)},"requestId":${JSON.stringify(value.requestId)},"safeCode":${JSON.stringify(value.safeCode)},"worktreeId":${JSON.stringify(value.worktreeId)}}`; }
function canonicalPhysicalAllocation(value: RecordPhysicalAllocationV1): string { return JSON.stringify({ allocationName: value.allocationName, allocationNonceDigest: value.allocationNonceDigest, bindingDigest: value.bindingDigest, expectedRevision: value.expectedRevision, fencingToken: value.fencingToken, filesystemDevice: value.filesystemDevice, filesystemInode: value.filesystemInode, helperDigest: value.helperDigest, intentId: value.intentId, mode: value.mode, mountId: value.mountId, mountQuotaDigest: value.mountQuotaDigest, ownerUid: value.ownerUid, quotaBytes: value.quotaBytes, quotaInodes: value.quotaInodes, quotaProjectId: value.quotaProjectId, requestId: value.requestId, worktreeId: value.worktreeId }); }
function canonicalFilesystemIdentity(value: RecordPhysicalAllocationV1): string { return JSON.stringify({ allocationName: value.allocationName, allocationNonceDigest: value.allocationNonceDigest, filesystemDevice: value.filesystemDevice, filesystemInode: value.filesystemInode, helperDigest: value.helperDigest, mode: value.mode, mountId: value.mountId, mountQuotaDigest: value.mountQuotaDigest, ownerUid: value.ownerUid, quotaBytes: value.quotaBytes, quotaInodes: value.quotaInodes, quotaProjectId: value.quotaProjectId, worktreeId: value.worktreeId }); }
function canonicalFilesystemIdentityRow(row: SqlRow): string { return JSON.stringify({ allocationName: String(row.allocation_name), allocationNonceDigest: String(row.allocation_nonce_digest), filesystemDevice: String(row.filesystem_device), filesystemInode: String(row.filesystem_inode), helperDigest: String(row.helper_digest), mode: String(row.allocation_mode), mountId: String(row.mount_id), mountQuotaDigest: String(row.mount_quota_digest), ownerUid: String(row.owner_uid), quotaBytes: String(row.quota_bytes), quotaInodes: String(row.quota_inodes), quotaProjectId: String(row.quota_project_id), worktreeId: String(row.worktree_id) }); }
function physicalIdentityComplete(row: SqlRow): boolean {
  return ['filesystem_identity_digest', 'filesystem_device', 'filesystem_inode', 'owner_uid', 'allocation_mode', 'mount_id', 'quota_project_id', 'helper_digest', 'mount_quota_digest']
    .every(column => typeof row[column] === 'string' && String(row[column]).length > 0);
}
function physicalIdentityValid(row: SqlRow): boolean {
  return physicalIdentityComplete(row) && typeof row.allocation_nonce === 'string'
    && digest('kogg-execution-allocation-nonce-v1', row.allocation_nonce) === String(row.allocation_nonce_digest)
    && digest('kogg-execution-filesystem-identity-v1', canonicalFilesystemIdentityRow(row)) === String(row.filesystem_identity_digest);
}
function cleanupAbsenceProof(value: CompletePhysicalCleanupV1): string {
  return digest('kogg-execution-cleanup-absence-v1', JSON.stringify({ expectedIdentityDigest: value.expectedIdentityDigest, fencingToken: value.fencingToken, helperDigest: value.helperDigest, intentId: value.intentId, mountQuotaDigest: value.mountQuotaDigest, worktreeId: value.worktreeId }));
}
function canonicalSealed(value: RecordSealedCandidateV1): string { return `{"bindingDigest":${JSON.stringify(value.bindingDigest)},"candidate":${canonicalCandidate(value.candidate)},"expectedRevision":${JSON.stringify(value.expectedRevision)},"requestId":${JSON.stringify(value.requestId)},"worktreeId":${JSON.stringify(value.worktreeId)}}`; }
function canonicalImportIntent(value: PrepareCandidateImportV1): string { return JSON.stringify({ bindingDigest: value.bindingDigest, candidateId: value.candidateId, expectedRevision: value.expectedRevision, expectedSourceIdentityDigest: value.expectedSourceIdentityDigest, requestId: value.requestId, worktreeId: value.worktreeId }); }
function canonicalImportCompletion(value: CompleteCandidateImportV1): string { return JSON.stringify({ bindingDigest: value.bindingDigest, candidateCommit: value.candidateCommit, candidateId: value.candidateId, candidateTree: value.candidateTree, expectedRevision: value.expectedRevision, fencingToken: value.fencingToken, intentId: value.intentId, quarantineRefDigest: value.quarantineRefDigest, requestId: value.requestId, worktreeId: value.worktreeId }); }
function canonicalImportFailure(value: FailCandidateImportV1): string { return JSON.stringify({ bindingDigest: value.bindingDigest, candidateId: value.candidateId, expectedRevision: value.expectedRevision, fencingToken: value.fencingToken, intentId: value.intentId, requestId: value.requestId, safeCode: value.safeCode, worktreeId: value.worktreeId }); }
function canonicalRetention(value: RecordCandidateRetentionV1): string { return JSON.stringify({ authorityDigest: value.authorityDigest, bindingDigest: value.bindingDigest, candidateId: value.candidateId, expectedRevision: value.expectedRevision, requestId: value.requestId, retentionClass: value.retentionClass, worktreeId: value.worktreeId }); }
function canonicalCandidate(value: CandidateBindingV1): string { const record = value as unknown as Record<string, unknown>; return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(record[key])}`).join(',')}}`; }
function validTime(value: string): boolean { const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function refuseState(request: AdvanceExecutionStateV1, code: ExecutionLifecycleCode): never { log('state.refused', { requestId: request.requestId, worktreeId: request.worktreeId, state: request.nextState, safeCode: code }); throw new AllocationRegistryError(code); }
function refusePhysicalAllocation(request: { readonly requestId: string; readonly worktreeId: string }, code: ExecutionLifecycleCode): never { log('allocation.proof.refused', { requestId: request.requestId, worktreeId: request.worktreeId, safeCode: code }); throw new AllocationRegistryError(code); }
function refuseRetention(request: RecordCandidateRetentionV1, code: ExecutionLifecycleCode): never { log('retention.refused', { requestId: request.requestId, worktreeId: request.worktreeId, candidateId: request.candidateId, retentionClass: request.retentionClass, safeCode: code }); throw new AllocationRegistryError(code); }
function refuseCleanup(request: { readonly requestId: string; readonly worktreeId: string }, code: ExecutionLifecycleCode): never { log('cleanup.refused', { requestId: request.requestId, worktreeId: request.worktreeId, safeCode: code }); throw new AllocationRegistryError(code); }
function canonicalBinding(value: ExecutionBindingV1): string { return `{${[...BINDING_FIELDS].sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(value[key as keyof ExecutionBindingV1])}`).join(',')}}`; }
function digest(domain: string, value: string): string { return `sha256:${createHash('sha256').update(`${domain}\0${value}`).digest('hex')}`; }
function allocationName(worktreeId: string): string { const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'; const bytes = Buffer.from(worktreeId.replaceAll('-', ''), 'hex'); let bits = 0; let accumulator = 0; let output = ''; for (const byte of bytes) { accumulator = (accumulator << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; output += alphabet[(accumulator >>> bits) & 31]; } } if (bits) output += alphabet[(accumulator << (5 - bits)) & 31]; return `r-${output}`; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state')); }
function errorType(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function projectionErrorCode(error: unknown): ExecutionLifecycleCode { return error instanceof AllocationRegistryError ? error.code : 'ALLOCATION_INTEGRITY_FAILED'; }
function runProjection(row: SqlRow): ExecutionRunProjectionV1 {
  return {
    schemaVersion: 1, projectId: String(row.project_id), repositoryId: String(row.repository_id), runId: String(row.run_id),
    attemptId: String(row.attempt_id), state: String(row.state) as ExecutionState, revision: String(row.revision),
    cleanupState: String(row.cleanup_state) as ExecutionRunProjectionV1['cleanupState'], safeCode: String(row.safe_code) as ExecutionRunProjectionV1['safeCode']
  };
}

function ensurePhysicalIdentitySchema(database: DatabaseSync): void {
  const columns = new Set((database.prepare('PRAGMA table_info(allocations)').all() as SqlRow[]).map(row => String(row.name)));
  const required = ['filesystem_device', 'filesystem_inode', 'owner_uid', 'allocation_mode', 'mount_id', 'quota_project_id', 'helper_digest', 'mount_quota_digest'] as const;
  for (const column of required) if (!columns.has(column)) database.exec(`ALTER TABLE allocations ADD COLUMN ${column} TEXT`);
}

function ensureAllocationIntentSchema(database: DatabaseSync): void {
  const columns = new Set((database.prepare('PRAGMA table_info(allocation_intents)').all() as SqlRow[]).map(row => String(row.name)));
  if (!columns.has('expected_revision')) database.exec('ALTER TABLE allocation_intents ADD COLUMN expected_revision TEXT');
  if (!columns.has('helper_digest')) database.exec('ALTER TABLE allocation_intents ADD COLUMN helper_digest TEXT');
  if (!columns.has('mount_quota_digest')) database.exec('ALTER TABLE allocation_intents ADD COLUMN mount_quota_digest TEXT');
}

function ensureQuotaProjectLeaseSchema(database: DatabaseSync): void {
  const columns = new Set((database.prepare('PRAGMA table_info(execution_meta)').all() as SqlRow[]).map(row => String(row.name)));
  if (!columns.has('next_quota_project_id')) database.exec('ALTER TABLE execution_meta ADD COLUMN next_quota_project_id INTEGER');
  database.prepare('UPDATE execution_meta SET next_quota_project_id=COALESCE(next_quota_project_id,?) WHERE singleton=1').run(FIRST_QUOTA_PROJECT_ID);
}

function quotaProjectLeasesValid(database: DatabaseSync): boolean {
  const invalid = database.prepare(`SELECT count(*) AS count FROM quota_project_leases q
    JOIN allocation_intents i ON i.intent_id=q.intent_id JOIN allocations a ON a.worktree_id=q.worktree_id
    WHERE i.intent_type<>'allocation' OR i.worktree_id<>q.worktree_id
      OR (q.phase='active' AND (i.phase<>'requested' OR a.state<>'admitted'))
      OR (q.phase='allocated' AND (i.phase<>'completed' OR a.quota_project_id IS NULL OR a.quota_project_id<>CAST(q.project_id AS TEXT) OR a.state IN ('admitted','cleaned','quarantined')))
      OR (q.phase='released' AND a.state<>'cleaned')
      OR (q.phase='quarantined' AND a.state<>'quarantined')`).get() as SqlRow;
  const missing = database.prepare(`SELECT count(*) AS count FROM allocation_intents i LEFT JOIN quota_project_leases q ON q.intent_id=i.intent_id
    WHERE i.intent_type='allocation' AND q.intent_id IS NULL`).get() as SqlRow;
  const meta = database.prepare('SELECT next_quota_project_id FROM execution_meta WHERE singleton=1').get() as SqlRow;
  const next = Number(meta.next_quota_project_id);
  return Number(invalid.count) === 0 && Number(missing.count) === 0 && Number.isSafeInteger(next) && next >= FIRST_QUOTA_PROJECT_ID && next <= LAST_QUOTA_PROJECT_ID + 1;
}

function ensureOwnerSchema(database: DatabaseSync): void {
  const meta = new Set((database.prepare('PRAGMA table_info(execution_meta)').all() as SqlRow[]).map(row => String(row.name)));
  if (!meta.has('owner_id')) database.exec('ALTER TABLE execution_meta ADD COLUMN owner_id TEXT');
  if (!meta.has('owner_epoch_id')) database.exec('ALTER TABLE execution_meta ADD COLUMN owner_epoch_id TEXT');
  database.prepare('UPDATE execution_meta SET owner_id=COALESCE(owner_id,?),owner_epoch_id=COALESCE(owner_epoch_id,?) WHERE singleton=1').run(randomUUID(), randomUUID());
  const columns = new Set((database.prepare('PRAGMA table_info(allocation_events)').all() as SqlRow[]).map(row => String(row.name)));
  if (!columns.has('event_id')) database.exec('ALTER TABLE allocation_events ADD COLUMN event_id TEXT');
  if (!columns.has('execution_state')) database.exec('ALTER TABLE allocation_events ADD COLUMN execution_state TEXT');
  if (!columns.has('event_digest')) database.exec('ALTER TABLE allocation_events ADD COLUMN event_digest TEXT');
  if (!columns.has('previous_event_digest')) database.exec('ALTER TABLE allocation_events ADD COLUMN previous_event_digest TEXT');
  let previous = '0'.repeat(64);
  for (const row of database.prepare('SELECT e.*,a.state AS current_state FROM allocation_events e JOIN allocations a ON a.worktree_id=e.worktree_id ORDER BY e.sequence').all() as SqlRow[]) {
    if (typeof row.event_id === 'string' && typeof row.execution_state === 'string' && typeof row.event_digest === 'string' && typeof row.previous_event_digest === 'string') {
      previous = String(row.event_digest); continue;
    }
    const eventId = randomUUID(); const executionState = legacyExecutionState(String(row.event_name), String(row.current_state));
    const normalized = { ...row, event_id: eventId, execution_state: executionState, previous_event_digest: previous } as SqlRow;
    const eventDigest = sourceEventDigest(normalized);
    database.prepare('UPDATE allocation_events SET event_id=?,execution_state=?,previous_event_digest=?,event_digest=? WHERE sequence=?').run(eventId, executionState, previous, eventDigest, Number(row.sequence));
    previous = eventDigest;
  }
  database.exec(`CREATE TRIGGER IF NOT EXISTS execution_owner_events_update BEFORE UPDATE ON allocation_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS execution_owner_events_delete BEFORE DELETE ON allocation_events BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
}

function legacyExecutionState(eventName: string, currentState: string): string {
  const fixed: Record<string, string> = {
    'allocation.requested': 'admitted', 'allocation.intent.recorded': 'admitted', 'allocation.proof.recorded': 'allocated', 'seal.completed': 'sealed',
    'import.requested': 'sealed', 'import.completed': 'candidate-imported', 'import.quarantined': 'quarantined',
    'retention.committed': 'retained', 'recovery.started': 'recovery-required',
    'recovery.resource.classified': 'reconciling', 'resource.quarantined': 'quarantined'
  };
  return fixed[eventName] ?? currentState;
}

function previousSourceDigest(database: DatabaseSync, sequence: number): string {
  const row = database.prepare('SELECT event_digest FROM allocation_events WHERE sequence<? ORDER BY sequence DESC LIMIT 1').get(sequence) as SqlRow | undefined;
  return row ? String(row.event_digest) : '0'.repeat(64);
}

function sourceEventDigest(row: SqlRow): string {
  return ownerHash({ eventId: String(row.event_id), worktreeId: String(row.worktree_id), eventName: String(row.event_name),
    executionState: String(row.execution_state), safeCode: String(row.safe_code), createdAt: String(row.created_at), previousEventDigest: String(row.previous_event_digest) });
}

function ownerEventsValid(database: DatabaseSync): boolean {
  const triggerCount = Number((database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('execution_owner_events_update','execution_owner_events_delete')").get() as SqlRow).count);
  if (triggerCount !== 2) return false;
  let previous = '0'.repeat(64);
  for (const row of database.prepare('SELECT * FROM allocation_events ORDER BY sequence').all() as SqlRow[]) {
    if (String(row.previous_event_digest) !== previous || sourceEventDigest(row) !== String(row.event_digest)) return false;
    previous = String(row.event_digest);
  }
  return true;
}

function ownerHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function mapOwnerEvent(row: SqlRow, ownerInstanceId: string, epochId: string, previousEventDigest: string): OwnerEventV1 {
  const state = String(row.execution_state) as ExecutionState; const eventKind = ownerEventKind(state);
  const terminalClass: SafeOwnerPayloadV1['terminalClass'] | undefined = eventKind === 'execution.completed' ? 'completed'
    : eventKind === 'execution.failed' ? 'failed' : eventKind === 'execution.quarantined' ? 'quarantined' : undefined;
  const safePayload: SafeOwnerPayloadV1 = { lifecycle: ownerLifecycle(eventKind), safeCode: String(row.safe_code), freshness: 'current', ...(terminalClass ? { terminalClass } : {}) };
  const unsigned: Omit<OwnerEventV1, 'eventDigest'> = {
    ownerKind: 'execution', ownerInstanceId, ownerSchemaVersion: 1, epochId, sequence: String(row.sequence),
    eventId: String(row.event_id), eventKind, factId: String(row.worktree_id), factDigest: String(row.event_digest), previousEventDigest,
    causalParents: [], correlations: { projectId: String(row.project_id), runId: String(row.run_id), attemptId: String(row.attempt_id) },
    observedAt: String(row.created_at), safePayload
  };
  return { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) };
}

function ownerEventKind(state: ExecutionState): 'execution.admitted' | 'execution.started' | 'execution.failed' | 'execution.completed' | 'execution.quarantined' {
  if (state === 'quarantined') return 'execution.quarantined';
  if (['failed', 'timed-out', 'cancelled', 'cleanup-failed'].includes(state)) return 'execution.failed';
  if (['candidate-imported', 'retained', 'cleaned'].includes(state)) return 'execution.completed';
  if (state === 'admitted' || state === 'requested' || state === 'refused') return 'execution.admitted';
  return 'execution.started';
}

function ownerLifecycle(eventKind: ReturnType<typeof ownerEventKind>): SafeOwnerPayloadV1['lifecycle'] {
  if (eventKind === 'execution.admitted') return 'admitted';
  if (eventKind === 'execution.started') return 'started';
  if (eventKind === 'execution.completed') return 'completed';
  if (eventKind === 'execution.quarantined') return 'quarantined';
  return 'failed';
}
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
  'allocation.intent.requested': ['requestId', 'worktreeId'], 'allocation.intent.recorded': ['requestId', 'worktreeId', 'intentId'],
  'allocation.failure.requested': ['requestId', 'worktreeId', 'intentId'], 'allocation.quarantined': ['requestId', 'worktreeId', 'intentId', 'safeCode'],
  'allocation.proof.requested': ['requestId', 'worktreeId'], 'allocation.proof.completed': ['requestId', 'worktreeId'],
  'allocation.proof.refused': ['requestId', 'worktreeId', 'safeCode'],
  'state.requested': ['requestId', 'worktreeId', 'state'], 'state.completed': ['requestId', 'worktreeId', 'state'],
  'state.refused': ['requestId', 'worktreeId', 'state', 'safeCode'],
  'candidate.recorded': ['requestId', 'worktreeId', 'candidateId'],
  'retention.requested': ['requestId', 'worktreeId', 'candidateId', 'retentionClass'],
  'retention.completed': ['requestId', 'worktreeId', 'candidateId', 'retentionClass'],
  'retention.refused': ['requestId', 'worktreeId', 'candidateId', 'retentionClass', 'safeCode'],
  'cleanup.intent.requested': ['requestId', 'worktreeId'], 'cleanup.intent.recorded': ['requestId', 'worktreeId', 'intentId'],
  'cleanup.proof.requested': ['requestId', 'worktreeId', 'intentId'], 'cleanup.proof.completed': ['requestId', 'worktreeId', 'intentId'],
  'cleanup.failure.requested': ['requestId', 'worktreeId', 'intentId'],
  'cleanup.refused': ['requestId', 'worktreeId', 'safeCode'],
  'cleanup.failed': ['requestId', 'worktreeId', 'intentId', 'safeCode'], 'cleanup.quarantined': ['requestId', 'worktreeId', 'intentId', 'safeCode'],
  'repository.lease.requested': ['requestId', 'repositoryId'], 'repository.lease.acquired': ['requestId', 'repositoryId', 'intentId'],
  'repository.lease.refused': ['requestId', 'repositoryId', 'safeCode'],
  'repository.lease.released': ['requestId', 'worktreeId', 'intentId'],
  'repository.lease.quarantined': ['requestId', 'worktreeId', 'intentId', 'safeCode'],
  'import.intent.recorded': ['requestId', 'worktreeId', 'candidateId', 'intentId'],
  'import.completed': ['requestId', 'worktreeId', 'candidateId', 'intentId'],
  'import.quarantined': ['requestId', 'worktreeId', 'candidateId', 'intentId', 'safeCode'],
  'recovery.resource.classified': ['runId', 'worktreeId', 'state', 'safeCode'],
  'recovery.completed': ['resourceCount', 'quarantinedCount', 'admission'],
  'projection.request.refused': ['safeCode'], 'projection.get.requested': ['requestId', 'runId'],
  'projection.get.completed': ['requestId', 'runId', 'resultCount'], 'projection.get.failed': ['requestId', 'runId', 'safeCode', 'errorType'],
  'projection.list.requested': ['requestId', 'projectId'], 'projection.list.completed': ['requestId', 'projectId', 'resultCount', 'truncated'],
  'projection.list.failed': ['requestId', 'projectId', 'safeCode', 'errorType'],
  'owner.publish.failed': ['safeCode', 'errorType']
} as const;
type AllocationLogEvent = keyof typeof LOG_FIELDS;
let allocationLoggingViolations = 0;
function log(event: AllocationLogEvent, fields: Readonly<Record<string, string | number>>): void {
  const expected = [...LOG_FIELDS[event]].sort(); const keys = Object.keys(fields).sort();
  const validKeys = keys.join(',') === expected.join(',');
  const validValues = Object.entries(fields).every(([key, value]) => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
    if (Buffer.byteLength(value) > 128) return false;
    if (['requestId', 'projectId', 'repositoryId', 'runId', 'worktreeId', 'candidateId', 'intentId'].includes(key)) return UUID.test(value);
    if (key === 'admission') return ['enabled', 'recovering', 'blocked'].includes(value);
    if (key === 'state') return Object.hasOwn(LEGAL_TRANSITIONS, value);
    if (key === 'retentionClass') return ['rejected', 'incident', 'completed'].includes(value);
    if (key === 'safeCode') return /^[A-Z][A-Z0-9_]{1,63}$/u.test(value);
    return /^[A-Za-z][A-Za-z0-9_.]{0,63}$/u.test(value);
  });
  if (!validKeys || !validValues) { allocationLoggingViolations++; console.error('[kogg:execution:allocation] logging.schema.violation', { event }); return; }
  if (event.includes('failed')) console.error('[kogg:execution:allocation]', event, fields);
  else if (event.includes('refused')) console.warn('[kogg:execution:allocation]', event, fields);
  else console.info('[kogg:execution:allocation]', event, fields);
}
