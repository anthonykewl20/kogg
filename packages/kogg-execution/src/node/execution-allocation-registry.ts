import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { injectable } from '@theia/core/shared/inversify';
import type {
  AdvanceExecutionStateV1, CandidateBindingV1, CandidateImportIntentV1, CompleteCandidateImportV1, ExecutionAllocationCode,
  ExecutionAllocationSummaryV1, ExecutionBindingV1, ExecutionRunListV1, ExecutionRunProjectionV1, ExecutionState,
  FailCandidateImportV1, GetExecutionRunV1, ImportedCandidateV1, ListExecutionRunsV1, PrepareCandidateImportV1,
  RecordSealedCandidateV1, ReserveExecutionAllocationV1
} from '../common/execution-protocol';
import { CANDIDATE_MUTATION_POLICY_DIGEST } from './candidate-sealer';

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
const LEGAL_TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  requested: ['refused', 'admitted'], refused: [], admitted: ['allocated', 'failed'], allocated: ['seeding', 'cleaning', 'quarantined'],
  seeding: ['verified', 'failed', 'timed-out', 'recovery-required'], verified: ['ready', 'cleaning', 'quarantined'], ready: ['leased', 'cleaning', 'quarantined'],
  leased: ['executing', 'cancelled', 'recovery-required'], executing: ['stopping', 'timed-out', 'failed', 'recovery-required'],
  stopping: ['sealed', 'cancelled', 'timed-out', 'failed', 'cleanup-failed'], sealed: ['candidate-imported', 'retained', 'cleaning', 'recovery-required'],
  'candidate-imported': ['retained', 'cleaning', 'recovery-required'], retained: ['cleaning'], cleaning: ['cleaned', 'cleanup-failed', 'quarantined'],
  'cleanup-failed': ['cleaning', 'quarantined'], 'recovery-required': ['reconciling'], reconciling: ['refused', 'admitted', 'allocated', 'seeding', 'verified', 'ready', 'leased', 'executing', 'stopping', 'sealed', 'candidate-imported', 'retained', 'cleaning', 'cleaned', 'failed', 'timed-out', 'cancelled', 'cleanup-failed', 'quarantined'],
  cleaned: [], failed: ['cleaning'], 'timed-out': ['cleaning'], cancelled: ['cleaning'], quarantined: []
};
const TRANSITION_CODES = new Set(['ALLOCATION_OK', 'ALLOCATION_ADMISSION_BLOCKED', 'ALLOCATION_PROTOCOL_INVALID', 'ALLOCATION_REQUEST_REPLAY_MISMATCH', 'ALLOCATION_RUN_EXISTS', 'ALLOCATION_INTEGRITY_FAILED', 'ALLOCATION_REVISION_CONFLICT', 'ALLOCATION_BINDING_MISMATCH', 'ALLOCATION_STATE_INVALID', 'RECOVERY_OWNER_UNAVAILABLE', 'GIT_SEED_FAILED', 'GIT_SEED_TIMEOUT', 'GIT_SEED_OUTPUT_LIMIT', 'GIT_BASE_CHANGED', 'GIT_INDEPENDENCE_FAILED', 'GIT_SOURCE_INTEGRITY_FAILED', 'SEAL_OK', 'SEAL_FAILED', 'SEAL_BASE_MISMATCH', 'SEAL_NO_CHANGE', 'SEAL_DIRTY', 'SEAL_HEAD_INVALID', 'SEAL_ANCESTRY_INVALID', 'SEAL_MERGE_COMMIT', 'SEAL_MUTATION_POLICY', 'SEAL_OBJECT_INVALID', 'IMPORT_OK', 'IMPORT_FAILED', 'IMPORT_PROTOCOL_INVALID', 'IMPORT_SOURCE_CHANGED', 'IMPORT_CANDIDATE_INVALID', 'IMPORT_REF_EXISTS', 'IMPORT_SOURCE_INTEGRITY_FAILED', 'EXECUTION_OK', 'QUALIFICATION_PLATFORM_UNSUPPORTED', 'QUALIFICATION_PROFILE_UNAVAILABLE', 'QUALIFICATION_PROTOCOL_INVALID', 'QUALIFICATION_EXPIRED', 'QUALIFICATION_FAILED', 'EXECUTION_INTERNAL_FAILED', 'PROCESS_EXIT_NONZERO', 'CLEANUP_FAILED']);
const IMPORT_FAILURE_CODES = new Set(['IMPORT_FAILED', 'IMPORT_PROTOCOL_INVALID', 'IMPORT_SOURCE_CHANGED', 'IMPORT_CANDIDATE_INVALID', 'IMPORT_REF_EXISTS', 'IMPORT_SOURCE_INTEGRITY_FAILED']);

export interface ExecutionAllocationDiagnostics {
  readonly integrity: boolean; readonly foreignKeys: boolean; readonly permissions: boolean;
  readonly admission: 'enabled' | 'recovering' | 'blocked'; readonly activeCount: number;
  readonly quarantinedCount: number; readonly recoveryRequiredCount: number; readonly unverifiedCount: number;
  readonly cleanupFailureCount: number; readonly reservationCount: number;
  readonly candidateCount: number; readonly pendingImportIntentCount: number; readonly loggingViolationCount: number;
}

@injectable()
export class ExecutionAllocationRegistry implements BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private startup: Promise<void> | undefined;
  private readonly ownerInstanceId = randomUUID();
  private readonly databasePath = path.join(stateRoot(), 'execution', 'registry.sqlite3');

  onStart(): Promise<void> { return this.ensureStarted(); }
  onStop(): void { this.database?.close(); this.database = undefined; this.startup = undefined; }

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
    const current = String(row.state) as ExecutionState; if (!LEGAL_TRANSITIONS[current].includes(request.nextState)) refuseState(request, 'ALLOCATION_STATE_INVALID');
    const now = new Date().toISOString();
    this.transaction(database => {
      const cleanupState = request.nextState === 'cleaning' ? 'cleaning' : request.nextState === 'cleaned' ? 'cleaned' : request.nextState === 'cleanup-failed' ? 'failed' : undefined;
      const result = database.prepare('UPDATE allocations SET state=?,cleanup_state=coalesce(?,cleanup_state),safe_code=?,revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state=? AND binding_digest=?')
        .run(request.nextState, cleanupState ?? null, request.safeCode, now, request.worktreeId, Number(request.expectedRevision), current, request.bindingDigest);
      if (result.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare(`INSERT INTO lifecycle_request_results(request_id,request_digest,response_kind,resource_id,created_at) VALUES(?,?,'state',?,?)`).run(request.requestId, requestDigest, request.worktreeId, now);
      this.event(database, request.worktreeId, 'state.advanced', request.safeCode); this.bump(database);
    });
    log('state.completed', { requestId: request.requestId, worktreeId: request.worktreeId, state: request.nextState });
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
    const row = this.databaseOrThrow().prepare('SELECT state,revision,binding_digest FROM allocations WHERE worktree_id=?').get(request.worktreeId) as SqlRow | undefined;
    if (!row) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED');
    if (String(row.binding_digest) !== request.bindingDigest) throw new AllocationRegistryError('ALLOCATION_BINDING_MISMATCH');
    if (String(row.revision) !== request.expectedRevision) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
    if (String(row.state) !== 'sealed') throw new AllocationRegistryError('ALLOCATION_STATE_INVALID');
    const candidate = this.databaseOrThrow().prepare('SELECT candidate_id FROM candidates WHERE candidate_id=? AND worktree_id=?').get(request.candidateId, request.worktreeId) as SqlRow | undefined;
    if (!candidate) throw new AllocationRegistryError('ALLOCATION_BINDING_MISMATCH');
    const intentId = randomUUID(); const fencingToken = randomBytes(32).toString('hex'); const now = new Date().toISOString();
    this.transaction(database => {
      database.prepare(`INSERT INTO candidate_import_intents(intent_id,worktree_id,candidate_id,fencing_token,expected_source_identity_digest,phase,safe_code,created_at,updated_at) VALUES(?,?,?,?,?,'requested','IMPORT_OK',?,?)`)
        .run(intentId, request.worktreeId, request.candidateId, fencingToken, request.expectedSourceIdentityDigest, now, now);
      database.prepare(`INSERT INTO lifecycle_request_results(request_id,request_digest,response_kind,resource_id,created_at) VALUES(?,?,'import-intent',?,?)`).run(request.requestId, requestDigest, intentId, now);
      this.event(database, request.worktreeId, 'import.requested', 'IMPORT_OK'); this.bump(database);
    });
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
      const allocationResult = database.prepare(`UPDATE allocations SET state='candidate-imported',safe_code='IMPORT_OK',revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state='sealed' AND binding_digest=?`).run(now, request.worktreeId, Number(request.expectedRevision), request.bindingDigest);
      if (intentResult.changes !== 1 || allocationResult.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare('UPDATE candidates SET quarantine_ref_digest=?,updated_at=? WHERE candidate_id=? AND quarantine_ref_digest IS NULL').run(request.quarantineRefDigest, now, request.candidateId);
      database.prepare(`INSERT INTO lifecycle_request_results(request_id,request_digest,response_kind,resource_id,created_at) VALUES(?,?,'import-complete',?,?)`).run(request.requestId, requestDigest, request.candidateId, now);
      this.event(database, request.worktreeId, 'import.completed', 'IMPORT_OK'); this.bump(database);
    });
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
      const allocationResult = database.prepare(`UPDATE allocations SET state='quarantined',safe_code=?,revision=revision+1,updated_at=? WHERE worktree_id=? AND revision=? AND state='sealed' AND binding_digest=?`)
        .run(request.safeCode, now, request.worktreeId, Number(request.expectedRevision), request.bindingDigest);
      if (intentResult.changes !== 1 || allocationResult.changes !== 1) throw new AllocationRegistryError('ALLOCATION_REVISION_CONFLICT');
      database.prepare(`INSERT INTO lifecycle_request_results(request_id,request_digest,response_kind,resource_id,created_at) VALUES(?,?,'state',?,?)`).run(request.requestId, requestDigest, request.worktreeId, now);
      database.prepare(`UPDATE execution_meta SET admission='blocked',revision=revision+1 WHERE singleton=1`).run();
      this.event(database, request.worktreeId, 'import.quarantined', request.safeCode);
    });
    log('import.quarantined', { requestId: request.requestId, worktreeId: request.worktreeId, candidateId: request.candidateId, intentId: request.intentId, safeCode: request.safeCode });
    return this.summary(request.worktreeId);
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
      candidateCount: count('SELECT count(*) AS count FROM candidates'),
      pendingImportIntentCount: count(`SELECT count(*) AS count FROM candidate_import_intents WHERE phase='requested'`),
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
      CREATE TABLE IF NOT EXISTS lifecycle_request_results(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,response_kind TEXT NOT NULL CHECK(response_kind IN ('state','seal','import-intent','import-complete')),resource_id TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(candidate_id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL UNIQUE REFERENCES allocations(worktree_id),candidate_json TEXT NOT NULL,candidate_commit TEXT NOT NULL,candidate_tree TEXT NOT NULL,object_closure_digest TEXT NOT NULL,mutation_policy_digest TEXT NOT NULL,quarantine_ref_digest TEXT,retention_class TEXT NOT NULL CHECK(retention_class IN ('pending-evidence','rejected','incident','completed')),retention_until TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT);
      CREATE TABLE IF NOT EXISTS candidate_import_intents(intent_id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL REFERENCES allocations(worktree_id),candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),fencing_token TEXT NOT NULL,expected_source_identity_digest TEXT NOT NULL,observed_quarantine_ref_digest TEXT,phase TEXT NOT NULL CHECK(phase IN ('requested','completed','failed','quarantined')),safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
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
      cleanupState: String(row.cleanup_state) as ExecutionAllocationSummaryV1['cleanupState'], safeCode: String(row.safe_code) as ExecutionAllocationSummaryV1['safeCode']
    };
  }
  private candidate(candidateId: string): CandidateBindingV1 { const row = this.databaseOrThrow().prepare('SELECT candidate_json FROM candidates WHERE candidate_id=?').get(candidateId) as SqlRow | undefined; if (!row) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED'); return JSON.parse(String(row.candidate_json)) as CandidateBindingV1; }
  private importIntent(intentId: string): CandidateImportIntentV1 { const row = this.databaseOrThrow().prepare('SELECT * FROM candidate_import_intents WHERE intent_id=?').get(intentId) as SqlRow | undefined; if (!row || String(row.phase) !== 'requested') throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED'); return { schemaVersion: 1, intentId, worktreeId: String(row.worktree_id), candidateId: String(row.candidate_id), fencingToken: String(row.fencing_token), phase: 'requested', replay: false, safeCode: 'IMPORT_OK' }; }
  private importedCandidate(candidateId: string): ImportedCandidateV1 { const candidate = this.candidate(candidateId); const row = this.databaseOrThrow().prepare('SELECT quarantine_ref_digest FROM candidates WHERE candidate_id=?').get(candidateId) as SqlRow | undefined; if (!row || !DIGEST.test(String(row.quarantine_ref_digest))) throw new AllocationRegistryError('ALLOCATION_INTEGRITY_FAILED'); const { safeCode: _sealCode, ...binding } = candidate; return { ...binding, quarantineRefDigest: String(row.quarantine_ref_digest), safeCode: 'IMPORT_OK' }; }
  private admission(): ExecutionAllocationDiagnostics['admission'] { return String((this.databaseOrThrow().prepare('SELECT admission FROM execution_meta WHERE singleton=1').get() as SqlRow).admission) as ExecutionAllocationDiagnostics['admission']; }
  private event(database: DatabaseSync, worktreeId: string, eventName: string, safeCode: string): void { database.prepare('INSERT INTO allocation_events(worktree_id,event_name,safe_code,created_at) VALUES(?,?,?,?)').run(worktreeId, eventName, safeCode, new Date().toISOString()); }
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
function canonicalAdvance(value: AdvanceExecutionStateV1): string { return `{"bindingDigest":${JSON.stringify(value.bindingDigest)},"expectedRevision":${JSON.stringify(value.expectedRevision)},"nextState":${JSON.stringify(value.nextState)},"requestId":${JSON.stringify(value.requestId)},"safeCode":${JSON.stringify(value.safeCode)},"worktreeId":${JSON.stringify(value.worktreeId)}}`; }
function canonicalSealed(value: RecordSealedCandidateV1): string { return `{"bindingDigest":${JSON.stringify(value.bindingDigest)},"candidate":${canonicalCandidate(value.candidate)},"expectedRevision":${JSON.stringify(value.expectedRevision)},"requestId":${JSON.stringify(value.requestId)},"worktreeId":${JSON.stringify(value.worktreeId)}}`; }
function canonicalImportIntent(value: PrepareCandidateImportV1): string { return JSON.stringify({ bindingDigest: value.bindingDigest, candidateId: value.candidateId, expectedRevision: value.expectedRevision, expectedSourceIdentityDigest: value.expectedSourceIdentityDigest, requestId: value.requestId, worktreeId: value.worktreeId }); }
function canonicalImportCompletion(value: CompleteCandidateImportV1): string { return JSON.stringify({ bindingDigest: value.bindingDigest, candidateCommit: value.candidateCommit, candidateId: value.candidateId, candidateTree: value.candidateTree, expectedRevision: value.expectedRevision, fencingToken: value.fencingToken, intentId: value.intentId, quarantineRefDigest: value.quarantineRefDigest, requestId: value.requestId, worktreeId: value.worktreeId }); }
function canonicalImportFailure(value: FailCandidateImportV1): string { return JSON.stringify({ bindingDigest: value.bindingDigest, candidateId: value.candidateId, expectedRevision: value.expectedRevision, fencingToken: value.fencingToken, intentId: value.intentId, requestId: value.requestId, safeCode: value.safeCode, worktreeId: value.worktreeId }); }
function canonicalCandidate(value: CandidateBindingV1): string { const record = value as unknown as Record<string, unknown>; return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(record[key])}`).join(',')}}`; }
function validTime(value: string): boolean { const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function refuseState(request: AdvanceExecutionStateV1, code: ExecutionAllocationCode): never { log('state.refused', { requestId: request.requestId, worktreeId: request.worktreeId, state: request.nextState, safeCode: code }); throw new AllocationRegistryError(code); }
function canonicalBinding(value: ExecutionBindingV1): string { return `{${[...BINDING_FIELDS].sort().map(key => `${JSON.stringify(key)}:${JSON.stringify(value[key as keyof ExecutionBindingV1])}`).join(',')}}`; }
function digest(domain: string, value: string): string { return `sha256:${createHash('sha256').update(`${domain}\0${value}`).digest('hex')}`; }
function allocationName(worktreeId: string): string { const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'; const bytes = Buffer.from(worktreeId.replaceAll('-', ''), 'hex'); let bits = 0; let accumulator = 0; let output = ''; for (const byte of bytes) { accumulator = (accumulator << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; output += alphabet[(accumulator >>> bits) & 31]; } } if (bits) output += alphabet[(accumulator << (5 - bits)) & 31]; return `r-${output}`; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state')); }
function errorType(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function projectionErrorCode(error: unknown): ExecutionAllocationCode { return error instanceof AllocationRegistryError ? error.code : 'ALLOCATION_INTEGRITY_FAILED'; }
function runProjection(row: SqlRow): ExecutionRunProjectionV1 {
  return {
    schemaVersion: 1, projectId: String(row.project_id), repositoryId: String(row.repository_id), runId: String(row.run_id),
    attemptId: String(row.attempt_id), state: String(row.state) as ExecutionState, revision: String(row.revision),
    cleanupState: String(row.cleanup_state) as ExecutionRunProjectionV1['cleanupState'], safeCode: String(row.safe_code) as ExecutionRunProjectionV1['safeCode']
  };
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
  'state.requested': ['requestId', 'worktreeId', 'state'], 'state.completed': ['requestId', 'worktreeId', 'state'],
  'state.refused': ['requestId', 'worktreeId', 'state', 'safeCode'],
  'candidate.recorded': ['requestId', 'worktreeId', 'candidateId'],
  'import.intent.recorded': ['requestId', 'worktreeId', 'candidateId', 'intentId'],
  'import.completed': ['requestId', 'worktreeId', 'candidateId', 'intentId'],
  'import.quarantined': ['requestId', 'worktreeId', 'candidateId', 'intentId', 'safeCode'],
  'recovery.resource.classified': ['runId', 'worktreeId', 'state', 'safeCode'],
  'recovery.completed': ['resourceCount', 'quarantinedCount', 'admission'],
  'projection.request.refused': ['safeCode'], 'projection.get.requested': ['requestId', 'runId'],
  'projection.get.completed': ['requestId', 'runId', 'resultCount'], 'projection.get.failed': ['requestId', 'runId', 'safeCode', 'errorType'],
  'projection.list.requested': ['requestId', 'projectId'], 'projection.list.completed': ['requestId', 'projectId', 'resultCount', 'truncated'],
  'projection.list.failed': ['requestId', 'projectId', 'safeCode', 'errorType']
} as const;
type AllocationLogEvent = keyof typeof LOG_FIELDS;
let allocationLoggingViolations = 0;
function log(event: AllocationLogEvent, fields: Readonly<Record<string, string | number>>): void {
  const expected = [...LOG_FIELDS[event]].sort(); const keys = Object.keys(fields).sort();
  const validKeys = keys.join(',') === expected.join(',');
  const validValues = Object.entries(fields).every(([key, value]) => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
    if (Buffer.byteLength(value) > 128) return false;
    if (['requestId', 'projectId', 'runId', 'worktreeId', 'candidateId', 'intentId'].includes(key)) return UUID.test(value);
    if (key === 'admission') return ['enabled', 'recovering', 'blocked'].includes(value);
    if (key === 'state') return Object.hasOwn(LEGAL_TRANSITIONS, value);
    if (key === 'safeCode') return /^[A-Z][A-Z0-9_]{1,63}$/u.test(value);
    return /^[A-Za-z][A-Za-z0-9_.]{0,63}$/u.test(value);
  });
  if (!validKeys || !validValues) { allocationLoggingViolations++; console.error('[kogg:execution:allocation] logging.schema.violation', { event }); return; }
  if (event.includes('failed')) console.error('[kogg:execution:allocation]', event, fields);
  else if (event.includes('refused')) console.warn('[kogg:execution:allocation]', event, fields);
  else console.info('[kogg:execution:allocation]', event, fields);
}
