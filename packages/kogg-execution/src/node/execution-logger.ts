import type { ExecutionImportCode, ExecutionQualificationCode, ExecutionSealCode } from '../common/execution-protocol';

// Closed execution qualification logging; host facts, paths, digests, commands, environments, and raw owner bodies are forbidden.
// diagnostic-coverage: execution.target-qualification, execution.recovery
type Fields = {
  'qualification.started': { targetId: string };
  'qualification.completed': { targetId: string; qualificationId: string };
  'qualification.invalidated': { targetId: string; safeCode: ExecutionQualificationCode };
  'qualification.failed': { targetId: string; safeCode: ExecutionQualificationCode; errorType: string };
  'diagnostics.failed': { errorType: string };
  'seal.started': { eventVersion: 1; operationId: string; runId: string; attemptId: string; worktreeId: string };
  'seal.completed': { eventVersion: 1; operationId: string; runId: string; attemptId: string; worktreeId: string; candidateCommit: string; candidateTree: string };
  'seal.refused': { eventVersion: 1; operationId: string; runId: string; attemptId: string; worktreeId: string; safeCode: ExecutionSealCode; errorType: string };
  'import.started': { eventVersion: 1; operationId: string; runId: string; attemptId: string; worktreeId: string };
  'import.completed': { eventVersion: 1; operationId: string; runId: string; attemptId: string; worktreeId: string; candidateCommit: string; candidateTree: string };
  'import.refused': { eventVersion: 1; operationId: string; runId: string; attemptId: string; worktreeId: string; safeCode: ExecutionImportCode; errorType: string };
};
const ALLOWED: { [K in keyof Fields]: readonly (keyof Fields[K])[] } = {
  'qualification.started': ['targetId'],
  'qualification.completed': ['targetId', 'qualificationId'],
  'qualification.invalidated': ['targetId', 'safeCode'],
  'qualification.failed': ['targetId', 'safeCode', 'errorType'],
  'diagnostics.failed': ['errorType'],
  'seal.started': ['eventVersion', 'operationId', 'runId', 'attemptId', 'worktreeId'],
  'seal.completed': ['eventVersion', 'operationId', 'runId', 'attemptId', 'worktreeId', 'candidateCommit', 'candidateTree'],
  'seal.refused': ['eventVersion', 'operationId', 'runId', 'attemptId', 'worktreeId', 'safeCode', 'errorType'],
  'import.started': ['eventVersion', 'operationId', 'runId', 'attemptId', 'worktreeId'],
  'import.completed': ['eventVersion', 'operationId', 'runId', 'attemptId', 'worktreeId', 'candidateCommit', 'candidateTree'],
  'import.refused': ['eventVersion', 'operationId', 'runId', 'attemptId', 'worktreeId', 'safeCode', 'errorType']
};
let violations = 0;
export function executionLog<K extends keyof Fields>(event: K, fields: Fields[K]): void {
  const allowed = ALLOWED[event] as readonly string[]; const values = fields as Record<string, unknown>;
  if (Object.keys(values).sort().join(',') !== [...allowed].sort().join(',') || Object.entries(values).some(([key, value]) => !validLogValue(key, value))) {
    violations++; console.error('[kogg:execution:target] logging.schema.violation', { event }); return;
  }
  if (event === 'import.started') console.info('[kogg:execution:candidate] import.started', fields);
  else if (event === 'import.completed') console.info('[kogg:execution:candidate] import.completed', fields);
  else if (event === 'import.refused') console.error('[kogg:execution:candidate] import.refused', fields);
  else if (event === 'seal.started') console.info('[kogg:execution:candidate] seal.started', fields);
  else if (event === 'seal.completed') console.info('[kogg:execution:candidate] seal.completed', fields);
  else if (event === 'seal.refused') console.error('[kogg:execution:candidate] seal.refused', fields);
  else if (event === 'qualification.started') console.info('[kogg:execution:target] qualification.started', fields);
  else if (event === 'qualification.completed') console.info('[kogg:execution:target] qualification.completed', fields);
  else if (event === 'qualification.invalidated') console.warn('[kogg:execution:target] qualification.invalidated', fields);
  else if (event === 'qualification.failed') console.error('[kogg:execution:target] qualification.failed', fields);
  else console.error('[kogg:execution:target] diagnostics.failed', fields);
}
export function executionLoggingDiagnostics(): { readonly schemaCount: number; readonly violationCount: number } { return { schemaCount: Object.keys(ALLOWED).length, violationCount: violations }; }

function validLogValue(key: string, value: unknown): boolean {
  if (key === 'eventVersion') return value === 1;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 128) return false;
  if (['operationId', 'runId', 'attemptId', 'worktreeId', 'qualificationId'].includes(key)) return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
  if (key === 'candidateCommit' || key === 'candidateTree') return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
  if (key === 'safeCode') return /^[A-Z][A-Z0-9_]{1,63}$/u.test(value);
  if (key === 'errorType') return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(value);
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value);
}
