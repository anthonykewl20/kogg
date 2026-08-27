// observability-exempt: This file contains pure closed declarations with no operational behavior.
// diagnostic-exempt: Pure declarations have no independent runtime state.
export type ExecutionQualificationCode = 'EXECUTION_OK' | 'QUALIFICATION_PLATFORM_UNSUPPORTED'
  | 'QUALIFICATION_PROFILE_UNAVAILABLE' | 'QUALIFICATION_PROTOCOL_INVALID' | 'QUALIFICATION_EXPIRED'
  | 'QUALIFICATION_FAILED' | 'EXECUTION_INTERNAL_FAILED';
export type ExecutionGitCode = 'GIT_SEED_FAILED' | 'GIT_SEED_TIMEOUT' | 'GIT_SEED_OUTPUT_LIMIT'
  | 'GIT_BASE_CHANGED' | 'GIT_INDEPENDENCE_FAILED' | 'GIT_SOURCE_INTEGRITY_FAILED';
export type ExecutionAllocationCode = 'ALLOCATION_OK' | 'ALLOCATION_ADMISSION_BLOCKED' | 'ALLOCATION_PROTOCOL_INVALID'
  | 'ALLOCATION_REQUEST_REPLAY_MISMATCH' | 'ALLOCATION_RUN_EXISTS' | 'ALLOCATION_INTEGRITY_FAILED'
  | 'ALLOCATION_REVISION_CONFLICT' | 'ALLOCATION_BINDING_MISMATCH' | 'ALLOCATION_STATE_INVALID'
  | 'RECOVERY_OWNER_UNAVAILABLE';
export type ExecutionSealCode = 'SEAL_OK' | 'SEAL_FAILED' | 'SEAL_BASE_MISMATCH' | 'SEAL_NO_CHANGE' | 'SEAL_DIRTY'
  | 'SEAL_HEAD_INVALID' | 'SEAL_ANCESTRY_INVALID' | 'SEAL_MERGE_COMMIT' | 'SEAL_MUTATION_POLICY' | 'SEAL_OBJECT_INVALID';
export type ExecutionImportCode = 'IMPORT_OK' | 'IMPORT_FAILED' | 'IMPORT_PROTOCOL_INVALID' | 'IMPORT_SOURCE_CHANGED'
  | 'IMPORT_CANDIDATE_INVALID' | 'IMPORT_REF_EXISTS' | 'IMPORT_SOURCE_INTEGRITY_FAILED';
export type ExecutionState = 'requested' | 'refused' | 'admitted' | 'allocated' | 'seeding' | 'verified' | 'ready'
  | 'leased' | 'executing' | 'stopping' | 'sealed' | 'candidate-imported' | 'retained' | 'cleaning' | 'cleaned'
  | 'failed' | 'timed-out' | 'cancelled' | 'cleanup-failed' | 'quarantined' | 'recovery-required' | 'reconciling';

export interface ExecutionBindingV1 {
  readonly schemaVersion: 1; readonly projectId: string; readonly projectRevision: string;
  readonly repositoryId: string; readonly repositoryBindingRevision: string; readonly taskId: string;
  readonly taskRevisionId: string; readonly taskRevisionDigest: string; readonly approvalDigest: string;
  readonly runId: string; readonly attemptId: string; readonly workflowPlanDigest: string;
  readonly baseCommit: string; readonly baseTree: string; readonly gitObjectFormat: 'sha1' | 'sha256';
  readonly targetId: string; readonly qualificationId: string; readonly qualificationDigest: string;
  readonly profileId: 'kogg-writable-agent-v1'; readonly profileDigest: string;
}
export interface ReserveExecutionAllocationV1 {
  readonly requestId: string; readonly binding: ExecutionBindingV1;
  readonly quotaBytes: string; readonly quotaInodes: string;
}
export interface ExecutionAllocationSummaryV1 {
  readonly schemaVersion: 1; readonly worktreeId: string; readonly runId: string; readonly attemptId: string;
  readonly allocationName: string; readonly allocationNonceDigest: string; readonly bindingDigest: string;
  readonly state: ExecutionState; readonly revision: string; readonly cleanupState: 'required' | 'cleaning' | 'cleaned' | 'failed';
  readonly safeCode: ExecutionAllocationCode;
}
export interface AdvanceExecutionStateV1 {
  readonly requestId: string; readonly worktreeId: string; readonly expectedRevision: string;
  readonly bindingDigest: string; readonly nextState: ExecutionState;
  readonly safeCode: ExecutionAllocationCode | ExecutionGitCode | ExecutionSealCode | ExecutionImportCode | ExecutionQualificationCode | 'PROCESS_EXIT_NONZERO' | 'CLEANUP_FAILED';
}
export interface SealCandidateV1 {
  readonly projectId: string; readonly runId: string; readonly attemptId: string; readonly worktreeId: string;
  readonly privateRoot: string; readonly baseCommit: string; readonly baseTree: string;
  readonly objectFormat: 'sha1' | 'sha256'; readonly maximumTreeBytes: string;
}
export interface CandidateBindingV1 {
  readonly schemaVersion: 1; readonly candidateId: string; readonly worktreeId: string; readonly runId: string;
  readonly attemptId: string; readonly baseCommit: string; readonly baseTree: string; readonly candidateCommit: string;
  readonly candidateTree: string; readonly objectClosureDigest: string; readonly mutationPolicyDigest: string;
  readonly quarantineRefDigest?: string; readonly sealedAt: string; readonly retentionClass: 'pending-evidence'; readonly retentionUntil: string;
  readonly safeCode: ExecutionSealCode;
}
export interface RecordSealedCandidateV1 {
  readonly requestId: string; readonly worktreeId: string; readonly expectedRevision: string;
  readonly bindingDigest: string; readonly candidate: CandidateBindingV1;
}
export interface PrepareCandidateImportV1 {
  readonly requestId: string; readonly worktreeId: string; readonly expectedRevision: string; readonly bindingDigest: string;
  readonly candidateId: string; readonly expectedSourceIdentityDigest: string;
}
export interface CandidateImportIntentV1 {
  readonly schemaVersion: 1; readonly intentId: string; readonly worktreeId: string; readonly candidateId: string;
  readonly fencingToken: string; readonly phase: 'requested'; readonly safeCode: 'IMPORT_OK';
}
export interface CompleteCandidateImportV1 {
  readonly requestId: string; readonly intentId: string; readonly worktreeId: string; readonly expectedRevision: string;
  readonly bindingDigest: string; readonly candidateId: string; readonly fencingToken: string;
  readonly candidateCommit: string; readonly candidateTree: string; readonly quarantineRefDigest: string;
}
export interface ImportCandidateV1 {
  readonly projectId: string; readonly repositoryId: string; readonly sourceRoot: string; readonly sourceGitDirectory: string; readonly privateRoot: string;
  readonly bundlePath: string; readonly expectedSourceHead: string; readonly expectedSourceTree: string;
  readonly objectFormat: 'sha1' | 'sha256'; readonly candidate: CandidateBindingV1;
}
export interface ImportedCandidateV1 extends Omit<CandidateBindingV1, 'safeCode'> {
  readonly quarantineRefDigest: string; readonly safeCode: 'IMPORT_OK';
}

export interface ExecutionQualificationProjection {
  readonly qualified: boolean;
  readonly targetId: string;
  readonly profileId: 'kogg-writable-agent-v1';
  readonly safeCode: ExecutionQualificationCode;
  readonly qualificationId?: string;
  readonly expiresAt?: string;
  readonly sourceMapsPresent: boolean;
}
