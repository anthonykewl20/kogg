import type { CodexSafeCode } from '../common/codex-protocol';

// diagnostic-coverage: codex.release, codex.protocol, codex.processes, codex.cleanup, codex.recovery
type EventFields = {
  'release.verification.started': { adapterVersion: string };
  'release.verification.completed': { releaseId: string; target: string; adapterVersion: string };
  'release.verification.failed': { adapterVersion: string; safeCode: CodexSafeCode };
  'process.start.requested': { operationId: string; processId: string };
  'process.started': { operationId: string; processId: string };
  'process.failed': { operationId: string; processId: string; safeCode: CodexSafeCode };
  'protocol.phase.changed': { phase: string };
  'protocol.frame.refused': { safeCode: CodexSafeCode };
  'protocol.request.started': { attemptId: string; requestClass: string };
  'protocol.request.completed': { attemptId: string; requestClass: string };
  'protocol.request.failed': { attemptId: string; requestClass: string; safeCode: CodexSafeCode };
  'protocol.authority.denied': { attemptId: string; pendingCount: number };
  'content.delivery.started': { attemptId: string; pendingCount: number };
  'content.delivery.completed': { attemptId: string; pendingCount: number; deliveredCount: number };
  'content.delivery.failed': { attemptId: string; pendingCount: number; safeCode: CodexSafeCode };
  'content.closed': { attemptId: string; pendingCount: number };
  'cleanup.started': { attemptId: string; operationId: string; processId: string; resourceCount: number };
  'cleanup.completed': { attemptId: string; operationId: string; processId: string; resourceCount: number; residualCount: number };
  'cleanup.failed': { attemptId: string; operationId: string; processId: string; resourceCount: number; residualCount: number; safeCode: CodexSafeCode };
  'diagnostics.failed': { errorType: string };
};
const ALLOWED: { [K in keyof EventFields]: readonly (keyof EventFields[K])[] } = {
  'release.verification.started': ['adapterVersion'], 'release.verification.completed': ['releaseId', 'target', 'adapterVersion'],
  'release.verification.failed': ['adapterVersion', 'safeCode'], 'process.start.requested': ['operationId', 'processId'],
  'process.started': ['operationId', 'processId'], 'process.failed': ['operationId', 'processId', 'safeCode'],
  'protocol.phase.changed': ['phase'], 'protocol.frame.refused': ['safeCode'],
  'protocol.request.started': ['attemptId', 'requestClass'], 'protocol.request.completed': ['attemptId', 'requestClass'],
  'protocol.request.failed': ['attemptId', 'requestClass', 'safeCode'], 'protocol.authority.denied': ['attemptId', 'pendingCount'],
  'content.delivery.started': ['attemptId', 'pendingCount'], 'content.delivery.completed': ['attemptId', 'pendingCount', 'deliveredCount'],
  'content.delivery.failed': ['attemptId', 'pendingCount', 'safeCode'], 'content.closed': ['attemptId', 'pendingCount'],
  'cleanup.started': ['attemptId', 'operationId', 'processId', 'resourceCount'], 'cleanup.completed': ['attemptId', 'operationId', 'processId', 'resourceCount', 'residualCount'],
  'cleanup.failed': ['attemptId', 'operationId', 'processId', 'resourceCount', 'residualCount', 'safeCode'],
  'diagnostics.failed': ['errorType']
};
let violationCount = 0;
export function codexLog<K extends keyof EventFields>(event: K, fields: EventFields[K]): void {
  const allowed = ALLOWED[event] as readonly string[]; const record = fields as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key)) || Object.entries(record).some(([key, value]) => !safeValue(event, key, value))) { violationCount++; console.error('[kogg:agents:codex-release] logging.schema.violation', { event }); return; }
  if (event === 'release.verification.started') console.info('[kogg:agents:codex-release] release.verification.started', fields);
  else if (event === 'release.verification.completed') console.info('[kogg:agents:codex-release] release.verification.completed', fields);
  else if (event === 'release.verification.failed') console.error('[kogg:agents:codex-release] release.verification.failed', fields);
  else if (event === 'process.start.requested') console.info('[kogg:agents:codex-release] process.start.requested', fields);
  else if (event === 'process.started') console.info('[kogg:agents:codex-release] process.started', fields);
  else if (event === 'process.failed') console.error('[kogg:agents:codex-release] process.failed', fields);
  else if (event === 'protocol.phase.changed') console.info('[kogg:agents:codex-protocol] protocol.phase.changed', fields);
  else if (event === 'protocol.frame.refused') console.error('[kogg:agents:codex-protocol] protocol.frame.refused', fields);
  else if (event === 'protocol.request.failed') console.error('[kogg:agents:codex-protocol] protocol.request.failed', fields);
  else if (event === 'protocol.request.started') console.debug('[kogg:agents:codex-protocol] protocol.request.started', fields);
  else if (event === 'protocol.request.completed') console.info('[kogg:agents:codex-protocol] protocol.request.completed', fields);
  else if (event === 'protocol.authority.denied') console.info('[kogg:agents:codex-protocol] protocol.authority.denied', fields);
  else if (event === 'content.delivery.started') console.debug('[kogg:agents:codex-content] content.delivery.started', fields);
  else if (event === 'content.delivery.completed') console.debug('[kogg:agents:codex-content] content.delivery.completed', fields);
  else if (event === 'content.delivery.failed') console.error('[kogg:agents:codex-content] content.delivery.failed', fields);
  else if (event === 'content.closed') console.info('[kogg:agents:codex-content] content.closed', fields);
  else if (event === 'cleanup.started') console.info('[kogg:agents:codex-supervision] cleanup.started', fields);
  else if (event === 'cleanup.completed') console.info('[kogg:agents:codex-supervision] cleanup.completed', fields);
  else if (event === 'cleanup.failed') console.error('[kogg:agents:codex-supervision] cleanup.failed', fields);
  else console.error('[kogg:agents:codex-release] diagnostics.failed', fields);
}
export function codexLoggingDiagnostics(): { readonly schemaCount: number; readonly violationCount: number } { return { schemaCount: Object.keys(ALLOWED).length, violationCount }; }
function safeValue(_event: keyof EventFields, key: string, value: unknown): boolean { return ['pendingCount','deliveredCount','resourceCount','residualCount'].includes(key) ? typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 : typeof value === 'string' && value.length <= 128; }
