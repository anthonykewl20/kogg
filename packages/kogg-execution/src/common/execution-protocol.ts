// observability-exempt: This file contains pure closed declarations with no operational behavior.
// diagnostic-exempt: Pure declarations have no independent runtime state.
export type ExecutionQualificationCode = 'EXECUTION_OK' | 'QUALIFICATION_PLATFORM_UNSUPPORTED'
  | 'QUALIFICATION_PROFILE_UNAVAILABLE' | 'QUALIFICATION_PROTOCOL_INVALID' | 'QUALIFICATION_EXPIRED'
  | 'QUALIFICATION_FAILED' | 'EXECUTION_INTERNAL_FAILED';
export type ExecutionGitCode = 'GIT_SEED_FAILED' | 'GIT_SEED_TIMEOUT' | 'GIT_SEED_OUTPUT_LIMIT'
  | 'GIT_BASE_CHANGED' | 'GIT_INDEPENDENCE_FAILED' | 'GIT_SOURCE_INTEGRITY_FAILED';

export interface ExecutionQualificationProjection {
  readonly qualified: boolean;
  readonly targetId: string;
  readonly profileId: 'kogg-writable-agent-v1';
  readonly safeCode: ExecutionQualificationCode;
  readonly qualificationId?: string;
  readonly expiresAt?: string;
  readonly recoveryComplete: boolean;
  readonly activeAllocationCount: number;
  readonly residualProcessCount: number;
  readonly sourceMapsPresent: boolean;
}
