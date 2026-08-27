import type { ExecutionQualificationCode } from '../common/execution-protocol';

// Closed execution qualification logging; host facts, paths, digests, commands, environments, and raw owner bodies are forbidden.
// diagnostic-coverage: execution.target-qualification, execution.recovery
type Fields = {
  'qualification.started': { targetId: string };
  'qualification.completed': { targetId: string; qualificationId: string };
  'qualification.invalidated': { targetId: string; safeCode: ExecutionQualificationCode };
  'qualification.failed': { targetId: string; safeCode: ExecutionQualificationCode; errorType: string };
  'diagnostics.failed': { errorType: string };
};
const ALLOWED: { [K in keyof Fields]: readonly (keyof Fields[K])[] } = {
  'qualification.started': ['targetId'],
  'qualification.completed': ['targetId', 'qualificationId'],
  'qualification.invalidated': ['targetId', 'safeCode'],
  'qualification.failed': ['targetId', 'safeCode', 'errorType'],
  'diagnostics.failed': ['errorType']
};
let violations = 0;
export function executionLog<K extends keyof Fields>(event: K, fields: Fields[K]): void {
  const allowed = ALLOWED[event] as readonly string[]; const values = fields as Record<string, unknown>;
  if (Object.keys(values).some(key => !allowed.includes(key)) || Object.values(values).some(value => typeof value !== 'string' || Buffer.byteLength(value) > 128)) {
    violations++; console.error('[kogg:execution:target] logging.schema.violation', { event }); return;
  }
  if (event === 'qualification.started') console.info('[kogg:execution:target] qualification.started', fields);
  else if (event === 'qualification.completed') console.info('[kogg:execution:target] qualification.completed', fields);
  else if (event === 'qualification.invalidated') console.warn('[kogg:execution:target] qualification.invalidated', fields);
  else if (event === 'qualification.failed') console.error('[kogg:execution:target] qualification.failed', fields);
  else console.error('[kogg:execution:target] diagnostics.failed', fields);
}
export function executionLoggingDiagnostics(): { readonly schemaCount: number; readonly violationCount: number } { return { schemaCount: Object.keys(ALLOWED).length, violationCount: violations }; }
