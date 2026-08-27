// diagnostic-exempt: Closed operations read-model declarations contain no operational behavior.

export const KoggOperationsReadModelServicePath = '/services/kogg-operations-read-model';
export const KoggOperationsReadModelService = Symbol('KoggOperationsReadModelService');

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

export interface OperationsRunQueryV1 {
  readonly lifecycle?: RunLifecycle;
  readonly abnormalOnly?: boolean;
  readonly sort: 'run-id-asc' | 'lifecycle-asc';
  readonly pageCursor?: string;
  readonly pageSize: number;
}

export interface OperationsRunPageV1 {
  readonly projectionEpoch: string;
  readonly items: readonly OperationsProjectionRunV1[];
  readonly nextCursor?: string;
}

export interface OperationsTimelinePageV1 {
  readonly projectionEpoch: string;
  readonly items: readonly OperationsTimelineEntryV1[];
  readonly nextCursor?: string;
}

export interface OperationsProjectionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly projectionEpoch: string;
  readonly changeSequence: string;
  readonly lifecycle: ProjectionLifecycle;
  readonly runs: readonly OperationsProjectionRunV1[];
  readonly faultCount: number;
}

export type OperationsMetricNameV1 =
  | 'kogg_operations_total' | 'kogg_attempts_total' | 'kogg_retries_total'
  | 'kogg_refusals_total' | 'kogg_recoveries_total' | 'kogg_quarantines_total'
  | 'kogg_runs_active' | 'kogg_processes_active' | 'kogg_queue_wait_ms'
  | 'kogg_run_duration_ms' | 'kogg_process_cleanup_ms' | 'kogg_recovery_duration_ms';

export interface OperationsMetricValueV1 {
  readonly name: OperationsMetricNameV1;
  readonly kind: 'counter' | 'gauge' | 'histogram';
  readonly labels: Readonly<Record<string, string>>;
  readonly bucketUpperBound?: number;
  readonly value: number;
}

export interface OperationsMetricsSnapshotV1 {
  readonly schemaVersion: 1;
  readonly projectionEpoch: string;
  readonly values: readonly OperationsMetricValueV1[];
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

export interface OperationsProjectionChangeV1 {
  readonly projectionEpoch: string;
  readonly sequence: string;
  readonly kind: 'owner-event' | 'rebuild' | 'resync-required';
  readonly runId?: string;
  readonly protected: boolean;
}

export interface OperationsStreamSubscriptionV1 {
  readonly state: 'current' | 'resync-required';
  readonly cursor: string;
  readonly changes: readonly OperationsProjectionChangeV1[];
}

export interface OperationsSupportExportRequestV1 { readonly requestId: string; readonly runId?: string; }
export interface OperationsSupportExportReceiptV1 { readonly exportId: string; readonly byteLength: number; readonly sha256: string; readonly expiresAt: string; }
export interface OperationsSupportExportContentV1 extends OperationsSupportExportReceiptV1 { readonly content: string; }
export type OperationsActionKindV1 = 'cancel' | 'pause' | 'resume' | 'retry' | 'diagnose' | 'open-owner-view';
export interface OperationsActionRequestV1 {
  readonly requestId: string;
  readonly action: OperationsActionKindV1;
  readonly runId: string;
  readonly operationId?: string;
  readonly expectedProjectionSequence: string;
}
export interface OperationsActionReceiptV1 {
  readonly requestId: string;
  readonly action: OperationsActionKindV1;
  readonly runId: string;
  readonly status: 'forwarded' | 'refused' | 'unknown';
  readonly safeCode: string;
}

export interface KoggOperationsReadModelClient {
  projectionChanged(change: OperationsProjectionChangeV1): void | Promise<void>;
}

export interface KoggOperationsReadModelService {
  projectionSnapshot(): OperationsProjectionSnapshotV1 | Promise<OperationsProjectionSnapshotV1>;
  listRuns(query: OperationsRunQueryV1): OperationsRunPageV1 | Promise<OperationsRunPageV1>;
  timelinePage(runId: string, pageCursor?: string, limit?: number): OperationsTimelinePageV1 | Promise<OperationsTimelinePageV1>;
  metricsSnapshot(): OperationsMetricsSnapshotV1 | Promise<OperationsMetricsSnapshotV1>;
  subscribe(resumeCursor?: string): OperationsStreamSubscriptionV1 | Promise<OperationsStreamSubscriptionV1>;
  exportSupport(request: OperationsSupportExportRequestV1): Promise<OperationsSupportExportReceiptV1>;
  readSupportExport(exportId: string): Promise<OperationsSupportExportContentV1>;
  requestAction(request: OperationsActionRequestV1): Promise<OperationsActionReceiptV1>;
}
