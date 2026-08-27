// observability-exempt: This file contains pure closed declarations with no operational behavior.
// diagnostic-exempt: Pure declarations have no independent runtime state.
export type ExecutionQualificationCode = 'EXECUTION_OK' | 'QUALIFICATION_PLATFORM_UNSUPPORTED'
  | 'QUALIFICATION_PROFILE_UNAVAILABLE' | 'QUALIFICATION_PROTOCOL_INVALID' | 'QUALIFICATION_EXPIRED'
  | 'QUALIFICATION_FAILED' | 'EXECUTION_INTERNAL_FAILED';
export type ExecutionGitCode = 'GIT_SEED_FAILED' | 'GIT_SEED_TIMEOUT' | 'GIT_SEED_OUTPUT_LIMIT'
  | 'GIT_BASE_CHANGED' | 'GIT_INDEPENDENCE_FAILED' | 'GIT_SOURCE_INTEGRITY_FAILED';
export type ExecutionAllocationCode = 'ALLOCATION_OK' | 'ALLOCATION_ADMISSION_BLOCKED' | 'ALLOCATION_PROTOCOL_INVALID'
  | 'ALLOCATION_REQUEST_REPLAY_MISMATCH' | 'ALLOCATION_RUN_EXISTS' | 'ALLOCATION_INTEGRITY_FAILED'
  | 'RECOVERY_OWNER_UNAVAILABLE';
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

export interface ExecutionQualificationProjection {
  readonly qualified: boolean;
  readonly targetId: string;
  readonly profileId: 'kogg-writable-agent-v1';
  readonly safeCode: ExecutionQualificationCode;
  readonly qualificationId?: string;
  readonly expiresAt?: string;
  readonly sourceMapsPresent: boolean;
}
