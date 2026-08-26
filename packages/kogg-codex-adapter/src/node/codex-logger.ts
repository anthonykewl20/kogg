import type { CodexSafeCode } from '../common/codex-protocol';

// diagnostic-coverage: codex.release, codex.protocol, codex.processes, codex.cleanup, codex.recovery
type EventFields = {
  'release.verification.started': { adapterVersion: string };
  'release.verification.completed': { releaseId: string; target: string; adapterVersion: string };
  'release.verification.failed': { adapterVersion: string; safeCode: CodexSafeCode };
  'process.start.requested': { operationId: string; processId: string };
  'process.started': { operationId: string; processId: string };
  'process.failed': { operationId: string; processId: string; safeCode: CodexSafeCode };
  'diagnostics.failed': { errorType: string };
};
const ALLOWED: { [K in keyof EventFields]: readonly (keyof EventFields[K])[] } = {
  'release.verification.started': ['adapterVersion'], 'release.verification.completed': ['releaseId', 'target', 'adapterVersion'],
  'release.verification.failed': ['adapterVersion', 'safeCode'], 'process.start.requested': ['operationId', 'processId'],
  'process.started': ['operationId', 'processId'], 'process.failed': ['operationId', 'processId', 'safeCode'], 'diagnostics.failed': ['errorType']
};
let violationCount = 0;
export function codexLog<K extends keyof EventFields>(event: K, fields: EventFields[K]): void {
  const allowed = ALLOWED[event] as readonly string[]; const record = fields as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key)) || Object.values(record).some(value => typeof value !== 'string' || value.length > 128)) { violationCount++; console.error('[kogg:agents:codex-release] logging.schema.violation', { event }); return; }
  if (event === 'release.verification.started') console.info('[kogg:agents:codex-release] release.verification.started', fields);
  else if (event === 'release.verification.completed') console.info('[kogg:agents:codex-release] release.verification.completed', fields);
  else if (event === 'release.verification.failed') console.error('[kogg:agents:codex-release] release.verification.failed', fields);
  else if (event === 'process.start.requested') console.info('[kogg:agents:codex-release] process.start.requested', fields);
  else if (event === 'process.started') console.info('[kogg:agents:codex-release] process.started', fields);
  else if (event === 'process.failed') console.error('[kogg:agents:codex-release] process.failed', fields);
  else console.error('[kogg:agents:codex-release] diagnostics.failed', fields);
}
export function codexLoggingDiagnostics(): { readonly schemaCount: number; readonly violationCount: number } { return { schemaCount: Object.keys(ALLOWED).length, violationCount }; }
