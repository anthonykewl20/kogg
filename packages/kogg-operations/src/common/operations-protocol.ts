export const KoggOperationsServicePath = '/services/kogg-operations';
export const KoggOperationsService = Symbol('KoggOperationsService');
export const KoggOperationsClientToken = Symbol('KoggOperationsClient');
export const KoggOperationRegistry = Symbol('KoggOperationRegistry');

export type OperationState =
  | 'requested' | 'refused' | 'starting' | 'active' | 'waiting' | 'stalled'
  | 'cancelling' | 'completed' | 'failed' | 'timed-out' | 'cancelled'
  | 'recovery-required' | 'recovering' | 'recovered';
export type CleanupState = 'not-required' | 'required' | 'cleaning' | 'cleaned' | 'failed';
export type ProcessState =
  | 'registered' | 'spawning' | 'started' | 'ready' | 'spawn-failed'
  | 'exited' | 'signalled' | 'possible-residual';
export type OperationKind =
  | 'application-start' | 'application-stop' | 'recovery' | 'diagnostics'
  | 'support-export' | 'project-mutation' | 'repository-probe'
  | 'project-switch' | 'worktree' | 'marketplace' | 'provider-connection'
  | 'provider-session' | 'ranex-bridge' | 'ranex-request' | 'task'
  | 'agent-dispatch' | 'check' | 'build' | 'test' | 'debug'
  | 'evidence' | 'verdict' | 'merge';
export type ProcessKind =
  | 'git' | 'ranex-kernel' | 'provider-cli' | 'governed-command'
  | 'check' | 'build' | 'test' | 'debug-adapter' | 'delegated-theia';
export type ProcessOwner =
  | 'kogg-supervisor' | 'theia-task' | 'theia-terminal'
  | 'theia-debug' | 'theia-plugin-host' | 'ranex';
export type OperationSafeCode =
  | 'OPERATIONS_OK' | 'OPERATIONS_REFUSED' | 'OPERATIONS_ADMISSION_BLOCKED'
  | 'OPERATIONS_REGISTRY_UNAVAILABLE' | 'OPERATIONS_SCHEMA_INCOMPATIBLE' | 'OPERATIONS_INTEGRITY_FAILED'
  | 'OPERATIONS_TRANSITION_INVALID' | 'OPERATIONS_REQUEST_REPLAY_MISMATCH'
  | 'OPERATION_IDLE_TIMEOUT' | 'OPERATION_ABSOLUTE_TIMEOUT' | 'OPERATION_CANCELLED'
  | 'PROCESS_SPAWN_FAILED' | 'PROCESS_READINESS_FAILED' | 'PROCESS_EXIT_NONZERO' | 'PROCESS_SIGNALLED'
  | 'PROCESS_IDENTITY_UNVERIFIED' | 'PROCESS_RESIDUAL' | 'CLEANUP_TIMEOUT' | 'CLEANUP_FAILED'
  | 'RECOVERY_FAILED' | 'OWNER_UNAVAILABLE';

export interface OperationCorrelations {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly sessionId?: string;
  readonly worktreeId?: string;
}

export interface OperationSummary {
  readonly id: string;
  readonly kind: OperationKind;
  readonly state: OperationState;
  readonly cleanup: CleanupState;
  readonly safeCode?: OperationSafeCode;
  readonly correlations: OperationCorrelations;
  readonly processCount: number;
  readonly activityCount: number;
  readonly canCancel: boolean;
  readonly blocksAdmission: boolean;
}

export interface OperationsSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly admission: 'enabled' | 'recovering' | 'blocked';
  readonly active: readonly OperationSummary[];
  readonly recent: readonly OperationSummary[];
}

export interface KoggOperationsClient {
  changed(snapshot: OperationsSnapshot): void | Promise<void>;
}

export interface KoggOperationsService {
  snapshot(): Promise<OperationsSnapshot>;
  cancel(request: { readonly requestId: string; readonly operationId: string }): Promise<OperationsSnapshot>;
}

export interface StartOperation {
  readonly id?: string;
  readonly kind: OperationKind;
  readonly correlations?: OperationCorrelations;
  readonly absoluteTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly cancellable?: boolean;
}

export interface StartProcess {
  readonly kind: ProcessKind;
  readonly owner: ProcessOwner;
  readonly cancel?: () => Promise<void>;
}

export interface OperationLease {
  readonly id: string;
  readonly cancellable: boolean;
  start(): void;
  active(): void;
  waiting(): void;
  activity(): void;
  refuse(code: OperationSafeCode): void;
  complete(code?: OperationSafeCode): void;
  fail(code: OperationSafeCode, errorType: string): void;
  timeout(code: OperationSafeCode): void;
  cancel(): Promise<void>;
  cleanup(run?: () => Promise<void>): Promise<void>;
  registerProcess(process: StartProcess): ProcessLease;
}

export interface ProcessLease {
  readonly id: string;
  spawning(): void;
  started(pid: number): void;
  ready(): void;
  activity(): void;
  failed(code: OperationSafeCode, errorType: string): void;
  exited(exitClass: 'zero' | 'nonzero' | 'signal'): void;
  cleanup(): void;
}

export interface OperationRegistryApi extends KoggOperationsService {
  startOperation(operation: StartOperation): Promise<OperationLease>;
  diagnostics(): OperationDiagnostics;
}

export interface OperationDiagnostics {
  readonly integrity: boolean;
  readonly foreignKeys: boolean;
  readonly permissions: boolean;
  readonly recoveryComplete: boolean;
  readonly activeCount: number;
  readonly stalledCount: number;
  readonly residualCount: number;
  readonly cleanupFailureCount: number;
  readonly admission: 'enabled' | 'recovering' | 'blocked';
}
