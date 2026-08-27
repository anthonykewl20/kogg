import type { AgentSafeCode, AttemptState, UsageProjectionV1 } from './agents-protocol';
import type { ModeSafeCodeV1 } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';

// diagnostic-coverage: agents.logging

type NoFields = Record<string, never>;
type CancelReason = 'user' | 'parent' | 'shutdown' | 'policy';
type DeadlineClass = 'handshake' | 'first-activity' | 'idle' | 'provider-request' | 'absolute' | 'cancel-grace' | 'cleanup';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LoggerArea = 'roles' | 'registry' | 'adapter' | 'supervision' | 'recovery';

export interface AgentLogFields {
  'adapter.registered': { adapterKey: string; adapterVersion: string; protocolId: string; protocolVersion: string; ownerKind: string };
  'binding.resolve.requested': { roleRevisionId: string; providerId: string; modelId: string; adapterKey: string; adapterVersion: string };
  'binding.resolve.approved': { roleRevisionId: string; providerId: string; modelId: string; adapterKey: string; adapterVersion: string; safeCode: AgentSafeCode };
  'binding.resolve.refused': { roleRevisionId: string; providerId: string; modelId: string; adapterKey: string; adapterVersion: string; safeCode: AgentSafeCode };
  'attempt.requested': { requestId: string; attemptId: string; rootAttemptId: string; parentAttemptId?: string };
  'attempt.mode.refused': { requestId: string; taskId: string; safeCode: ModeSafeCodeV1 };
  'attempt.admitted': { requestId: string; attemptId: string; roleRevisionId: string; projectId: string; taskId: string; runId?: string; worktreeId?: string; safeCode: AgentSafeCode };
  'attempt.refused': { requestId?: string; attemptId: string; roleRevisionId: string; projectId: string; taskId: string; safeCode: AgentSafeCode };
  'adapter.resolved': { attemptId: string; adapterKey: string; adapterVersion: string; protocolId: string; protocolVersion: string; providerId: string; modelId: string };
  'credential.lease.issued': { attemptId: string; adapterKey: string; adapterVersion: string; providerId: string; modelId: string };
  'resource.registered': { attemptId: string; operationId: string; resourceId: string; ownerKind: string; resourceKind: string };
  'adapter.start.requested': { attemptId: string; resourceId: string; deadlineClass?: DeadlineClass; durationMs?: number };
  'adapter.ready': { attemptId: string; resourceId: string; deadlineClass?: DeadlineClass; durationMs?: number };
  'adapter.host.exited': { attemptId: string; resourceId: string; exitClass: 'zero' | 'nonzero' | 'signal' };
  'adapter.stdin.failed': { attemptId: string; resourceId: string; errorType: string };
  'adapter.observation.refused': { attemptId: string; resourceId: string; safeCode: AgentSafeCode; errorType: string };
  'attempt.activity': { attemptId: string; activityKind: string; activityCount: number; durationMs?: number };
  'usage.observed': { attemptId: string; usageSource: UsageProjectionV1['source']; usageStatus: UsageProjectionV1['status']; fieldName?: string; safeCode?: AgentSafeCode };
  'usage.invalid': { attemptId: string; usageSource: UsageProjectionV1['source']; usageStatus: UsageProjectionV1['status']; fieldName?: string; safeCode?: AgentSafeCode };
  'attempt.completion.observed': { attemptId: string; safeCode: AgentSafeCode; activityCount: number };
  'attempt.failed': { attemptId: string; safeCode: AgentSafeCode; activityCount: number };
  'cancel.requested': { attemptId: string; reason: CancelReason; resourceCount: number; deadlineClass?: DeadlineClass };
  'cancel.acknowledged': { attemptId: string; reason: CancelReason; resourceCount: number; deadlineClass?: DeadlineClass };
  'cancel.escalated': { attemptId: string; reason: CancelReason; resourceCount: number; deadlineClass?: DeadlineClass };
  'timeout.expired': { attemptId: string; deadlineClass: DeadlineClass; generation: number; configuredMs: number };
  'cleanup.started': { attemptId: string; childCount: number; resourceCount: number };
  'cleanup.completed': { attemptId: string; childCount: number; resourceCount: number; residualCount: number };
  'cleanup.failed': { attemptId?: string; childCount: number; resourceCount: number; residualCount: number; safeCode?: AgentSafeCode };
  'attempt.terminal.committed': { attemptId: string; finalState: AttemptState; safeCode: AgentSafeCode; usageStatus: UsageProjectionV1['status'] };
  'recovery.started': NoFields;
  'recovery.classified': { attemptId?: string; resourceId?: string; recoveryClass?: string; recoveredCount?: number; blockedCount?: number; safeCode?: AgentSafeCode };
  'recovery.completed': { attemptId?: string; resourceId?: string; recoveryClass?: string; recoveredCount?: number; blockedCount?: number; safeCode?: AgentSafeCode };
  'recovery.failed': { attemptId?: string; resourceId?: string; recoveryClass?: string; recoveredCount?: number; blockedCount?: number; safeCode?: AgentSafeCode };
  'shutdown.started': { activeCount: number };
  'shutdown.completed': { residualCount: number };
  'role.revision.requested': { requestId: string; roleKey: string };
  'role.revision.completed': { requestId: string; roleRevisionId: string; roleKey: string };
  'mutation.failed': { operation: string; requestId: string; safeCode: AgentSafeCode; errorType: string };
  'mutation.rollback.failed': { errorType: string };
  'subscription.failed': { errorType: string };
  'diagnostics.failed': { errorType: string };
  'frontend.operation.failed': { safeCode: AgentSafeCode; errorType: string };
  'logging.schema.refused': { schemaId: string; violationCode: 'AGENT_LOG_SCHEMA_REFUSED' };
}

export type AgentLogEvent = keyof AgentLogFields;
type Schema = { readonly area: LoggerArea; readonly level: LogLevel; readonly fields: readonly string[]; readonly required: readonly string[] };
const schema = (area: LoggerArea, level: LogLevel, required: readonly string[], optional: readonly string[] = []): Schema => ({ area, level, fields: [...required, ...optional], required });
const SCHEMAS: Record<AgentLogEvent, Schema> = {
  'adapter.registered': schema('adapter', 'info', ['adapterKey', 'adapterVersion', 'protocolId', 'protocolVersion', 'ownerKind']),
  'binding.resolve.requested': schema('adapter', 'debug', ['roleRevisionId', 'providerId', 'modelId', 'adapterKey', 'adapterVersion']),
  'binding.resolve.approved': schema('adapter', 'info', ['roleRevisionId', 'providerId', 'modelId', 'adapterKey', 'adapterVersion', 'safeCode']),
  'binding.resolve.refused': schema('adapter', 'warn', ['roleRevisionId', 'providerId', 'modelId', 'adapterKey', 'adapterVersion', 'safeCode']),
  'attempt.requested': schema('registry', 'debug', ['requestId', 'attemptId', 'rootAttemptId'], ['parentAttemptId']),
  'attempt.mode.refused': schema('registry', 'warn', ['requestId', 'taskId', 'safeCode']),
  'attempt.admitted': schema('registry', 'info', ['requestId', 'attemptId', 'roleRevisionId', 'projectId', 'taskId', 'safeCode'], ['runId', 'worktreeId']),
  'attempt.refused': schema('registry', 'warn', ['attemptId', 'roleRevisionId', 'projectId', 'taskId', 'safeCode'], ['requestId']),
  'adapter.resolved': schema('adapter', 'info', ['attemptId', 'adapterKey', 'adapterVersion', 'protocolId', 'protocolVersion', 'providerId', 'modelId']),
  'credential.lease.issued': schema('adapter', 'debug', ['attemptId', 'adapterKey', 'adapterVersion', 'providerId', 'modelId']),
  'resource.registered': schema('supervision', 'info', ['attemptId', 'operationId', 'resourceId', 'ownerKind', 'resourceKind']),
  'adapter.start.requested': schema('adapter', 'debug', ['attemptId', 'resourceId'], ['deadlineClass', 'durationMs']),
  'adapter.ready': schema('adapter', 'info', ['attemptId', 'resourceId'], ['deadlineClass', 'durationMs']),
  'adapter.host.exited': schema('adapter', 'info', ['attemptId', 'resourceId', 'exitClass']),
  'adapter.stdin.failed': schema('adapter', 'warn', ['attemptId', 'resourceId', 'errorType']),
  'adapter.observation.refused': schema('adapter', 'warn', ['attemptId', 'resourceId', 'safeCode', 'errorType']),
  'attempt.activity': schema('registry', 'debug', ['attemptId', 'activityKind', 'activityCount'], ['durationMs']),
  'usage.observed': schema('registry', 'debug', ['attemptId', 'usageSource', 'usageStatus'], ['fieldName', 'safeCode']),
  'usage.invalid': schema('registry', 'warn', ['attemptId', 'usageSource', 'usageStatus'], ['fieldName', 'safeCode']),
  'attempt.completion.observed': schema('registry', 'info', ['attemptId', 'safeCode', 'activityCount']),
  'attempt.failed': schema('adapter', 'error', ['attemptId', 'safeCode', 'activityCount']),
  'cancel.requested': schema('supervision', 'info', ['attemptId', 'reason', 'resourceCount'], ['deadlineClass']),
  'cancel.acknowledged': schema('supervision', 'debug', ['attemptId', 'reason', 'resourceCount'], ['deadlineClass']),
  'cancel.escalated': schema('supervision', 'warn', ['attemptId', 'reason', 'resourceCount'], ['deadlineClass']),
  'timeout.expired': schema('supervision', 'warn', ['attemptId', 'deadlineClass', 'generation', 'configuredMs']),
  'cleanup.started': schema('supervision', 'info', ['attemptId', 'childCount', 'resourceCount']),
  'cleanup.completed': schema('supervision', 'info', ['attemptId', 'childCount', 'resourceCount', 'residualCount']),
  'cleanup.failed': schema('supervision', 'error', ['childCount', 'resourceCount', 'residualCount'], ['attemptId', 'safeCode']),
  'attempt.terminal.committed': schema('registry', 'info', ['attemptId', 'finalState', 'safeCode', 'usageStatus']),
  'recovery.started': schema('recovery', 'info', []),
  'recovery.classified': schema('recovery', 'warn', [], ['attemptId', 'resourceId', 'recoveryClass', 'recoveredCount', 'blockedCount', 'safeCode']),
  'recovery.completed': schema('recovery', 'info', [], ['attemptId', 'resourceId', 'recoveryClass', 'recoveredCount', 'blockedCount', 'safeCode']),
  'recovery.failed': schema('recovery', 'error', [], ['attemptId', 'resourceId', 'recoveryClass', 'recoveredCount', 'blockedCount', 'safeCode']),
  'shutdown.started': schema('supervision', 'info', ['activeCount']),
  'shutdown.completed': schema('supervision', 'info', ['residualCount']),
  'role.revision.requested': schema('roles', 'debug', ['requestId', 'roleKey']),
  'role.revision.completed': schema('roles', 'info', ['requestId', 'roleRevisionId', 'roleKey']),
  'mutation.failed': schema('registry', 'error', ['operation', 'requestId', 'safeCode', 'errorType']),
  'mutation.rollback.failed': schema('registry', 'error', ['errorType']),
  'subscription.failed': schema('registry', 'warn', ['errorType']),
  'diagnostics.failed': schema('registry', 'error', ['errorType']),
  'frontend.operation.failed': schema('registry', 'error', ['safeCode', 'errorType']),
  'logging.schema.refused': schema('registry', 'warn', ['schemaId', 'violationCode'])
};

let violationCount = 0;
export function agentLog<K extends AgentLogEvent>(event: K, fields: AgentLogFields[K]): boolean {
  const definition = SCHEMAS[event]; const record = fields as Record<string, unknown>; const keys = Object.keys(record);
  const valid = definition.required.every(key => record[key] !== undefined)
    && keys.every(key => definition.fields.includes(key) && safeValue(record[key]));
  if (!valid) {
    violationCount += 1;
    agentLog('logging.schema.refused', { schemaId: event, violationCode: 'AGENT_LOG_SCHEMA_REFUSED' });
    return false;
  }
  const bounded = Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  console[definition.level](`[kogg:agents:${definition.area}] ${event}`, bounded);
  return true;
}

export function agentLoggingDiagnostics(): { readonly schemaCount: number; readonly violationCount: number } { return { schemaCount: Object.keys(SCHEMAS).length, violationCount }; }
function safeValue(value: unknown): boolean { return value === undefined || (typeof value === 'string' && new TextEncoder().encode(value).byteLength <= 128 && !/[\u0000-\u001f\u007f]/u.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || typeof value === 'boolean'; }
