// diagnostic-exempt: Closed operations read-model declarations contain no operational behavior.

export const OWNER_KINDS = ['task', 'workflow', 'adapter', 'execution', 'operation', 'project', 'check', 'ranex', 'verdict', 'merge', 'diagnostic'] as const;
export type OwnerKind = typeof OWNER_KINDS[number];

export const OWNER_EVENT_KINDS = {
  task: ['task.created', 'task.updated', 'task.archived', 'approval.recorded', 'approval.revoked'],
  workflow: ['run.queued', 'run.started', 'run.waiting', 'run.retrying', 'run.blocked', 'run.cancelling', 'run.cleaning', 'run.failed', 'run.cancelled', 'run.recovered', 'run.completed', 'node.started', 'node.terminal'],
  adapter: ['attempt.requested', 'attempt.started', 'attempt.failed', 'attempt.cancelled', 'attempt.completed', 'usage.observed'],
  execution: ['execution.admitted', 'execution.refused', 'execution.started', 'execution.failed', 'execution.completed', 'execution.quarantined'],
  operation: ['process.reserved', 'process.spawning', 'process.started', 'process.ready', 'process.activity', 'process.exited', 'process.cancelling', 'process.cleaning', 'process.cleaned', 'process.spawn-failed', 'process.timed-out', 'process.residual', 'process.lost', 'process.quarantined', 'process.inventory-unknown'],
  project: ['project.available', 'project.unavailable', 'repository.changed'],
  check: ['check.requested', 'check.started', 'check.failed', 'check.passed', 'check.cleaned'],
  ranex: ['evidence.requested', 'evidence.admitted', 'evidence.refused', 'gate.decided'],
  verdict: ['verdict.requested', 'verdict.accepted', 'verdict.rejected', 'verdict.unknown'],
  merge: ['merge.requested', 'merge.refused', 'merge.committed', 'merge.recovered', 'merge.quarantined'],
  diagnostic: ['diagnostic.started', 'diagnostic.passed', 'diagnostic.failed']
} as const satisfies Record<OwnerKind, readonly string[]>;

export interface SafeCorrelationsV1 {
  readonly taskId?: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly operationId?: string;
  readonly processId?: string;
  readonly checkId?: string;
  readonly evidenceId?: string;
  readonly verdictId?: string;
  readonly mergeId?: string;
}

export interface CausalRefV1 {
  readonly ownerInstanceId: string;
  readonly epochId: string;
  readonly sequence: string;
  readonly eventDigest: string;
}

export interface SafeOwnerPayloadV1 {
  readonly lifecycle?: string;
  readonly safeCode?: string;
  readonly processKind?: string;
  readonly processState?: string;
  readonly cleanupState?: string;
  readonly terminalClass?: string;
  readonly abnormalClass?: string;
  readonly resultClass?: string;
  readonly decisionClass?: string;
  readonly freshness?: 'current' | 'stale' | 'unknown';
  readonly knownState?: 'known' | 'partial' | 'unknown';
  readonly count?: number;
  readonly retryOrdinal?: number;
  readonly durationMs?: number;
  readonly value?: number;
  readonly unit?: 'tokens' | 'milliseconds' | 'bytes' | 'items';
}

export interface OwnerEventV1 {
  readonly ownerKind: OwnerKind;
  readonly ownerInstanceId: string;
  readonly ownerSchemaVersion: 1;
  readonly epochId: string;
  readonly sequence: string;
  readonly eventId: string;
  readonly eventKind: string;
  readonly factId: string;
  readonly factDigest: string;
  readonly previousEventDigest: string;
  readonly causalParents: readonly CausalRefV1[];
  readonly correlations: SafeCorrelationsV1;
  readonly observedAt: string;
  readonly safePayload: SafeOwnerPayloadV1;
  readonly eventDigest: string;
}

export type ProjectionLifecycle = 'stopped' | 'verifying' | 'replaying' | 'current' | 'degraded' | 'rebuilding' | 'failed';
export type RunLifecycle = 'queued' | 'active' | 'waiting' | 'retrying' | 'blocked' | 'failed' | 'cancelling' | 'cleaning' | 'recovered' | 'completed' | 'unknown';

export interface OperationsProjectionRunV1 {
  readonly runId: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly lifecycle: RunLifecycle;
  readonly lifecycleCode?: string;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly liveProcessCount: number;
  readonly abnormalProcessCount: number;
  readonly checkSummary: string;
  readonly evidenceSummary: string;
  readonly verdictSummary: string;
  readonly mergeSummary: string;
  readonly freshness: 'current' | 'stale' | 'unknown';
  readonly degradedOwners: readonly OwnerKind[];
}

export interface OperationsTimelineEntryV1 {
  readonly entryId: string;
  readonly runId: string;
  readonly ownerKind: OwnerKind;
  readonly ownerSequence: string;
  readonly eventKind: string;
  readonly safeCode?: string;
  readonly attemptId?: string;
  readonly processId?: string;
  readonly displayTime: string;
}

export interface OperationsProjectionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly projectionEpoch: string;
  readonly changeSequence: string;
  readonly lifecycle: ProjectionLifecycle;
  readonly runs: readonly OperationsProjectionRunV1[];
  readonly faultCount: number;
}

export interface OperationsProjectionDiagnosticsV1 {
  readonly integrity: boolean;
  readonly foreignKeys: boolean;
  readonly lifecycle: ProjectionLifecycle;
  readonly ownerCount: number;
  readonly faultCount: number;
  readonly causalGapCount: number;
  readonly processAbnormalCount: number;
  readonly metricViolationCount: number;
}
