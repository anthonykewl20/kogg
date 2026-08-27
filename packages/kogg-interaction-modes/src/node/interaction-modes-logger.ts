import type { InteractionModeV1, ModeOperationV1, ModeSafeCodeV1 } from '../common/interaction-modes-protocol';

// Closed mode logs contain only safe identifiers, mode/catalog values, result counts, and stable codes.
// diagnostic-coverage: interaction-modes.registry, interaction-modes.authority, interaction-modes.operations, interaction-modes.restoration
type Fields = {
  'registry.start.requested': Record<string, never>; 'registry.start.completed': { restoredCount: number };
  'registry.start.failed': { safeCode: ModeSafeCodeV1; errorType: string };
  'mode.selected': { requestId: string; taskId: string; selectedMode: InteractionModeV1; safeCode: ModeSafeCodeV1 };
  'mode.restored': { requestId: string; taskId: string; selectedMode: InteractionModeV1; safeCode: ModeSafeCodeV1 };
  'mode.operation.requested': { requestId: string; taskId: string; selectedMode: InteractionModeV1; operation: ModeOperationV1 };
  'mode.operation.approved': { requestId: string; taskId: string; selectedMode: InteractionModeV1; operation: ModeOperationV1; safeCode: ModeSafeCodeV1 };
  'mode.operation.refused': { requestId: string; taskId: string; selectedMode: InteractionModeV1; operation: ModeOperationV1; safeCode: ModeSafeCodeV1 };
  'mode.transition.requested': { requestId: string; taskId: string; fromMode: InteractionModeV1; toMode: InteractionModeV1 };
  'mode.transition.awaiting-confirmation': { requestId: string; taskId: string; fromMode: InteractionModeV1; toMode: InteractionModeV1; safeCode: ModeSafeCodeV1 };
  'mode.transition.cleanup-pending': { requestId: string; taskId: string; fromMode: InteractionModeV1; toMode: InteractionModeV1; safeCode: ModeSafeCodeV1 };
  'mode.transition.committed': { requestId: string; taskId: string; fromMode: InteractionModeV1; toMode: InteractionModeV1; safeCode: ModeSafeCodeV1 };
  'mode.transition.cancelled': { requestId: string; taskId: string; fromMode: InteractionModeV1; toMode: InteractionModeV1; safeCode: ModeSafeCodeV1 };
  'mode.transition.restored': { requestId: string; taskId: string; fromMode: InteractionModeV1; toMode: InteractionModeV1; safeCode: ModeSafeCodeV1 };
  'mode.transition.expired': { taskId: string; fromMode: InteractionModeV1; toMode: InteractionModeV1; safeCode: ModeSafeCodeV1 };
  'mode.transition.refused': { requestId: string; taskId: string; fromMode: InteractionModeV1; toMode: InteractionModeV1; safeCode: ModeSafeCodeV1 };
};
const FIELDS: { [K in keyof Fields]: readonly (keyof Fields[K])[] } = {
  'registry.start.requested': [], 'registry.start.completed': ['restoredCount'], 'registry.start.failed': ['safeCode', 'errorType'],
  'mode.selected': ['requestId', 'taskId', 'selectedMode', 'safeCode'], 'mode.restored': ['requestId', 'taskId', 'selectedMode', 'safeCode'],
  'mode.operation.requested': ['requestId', 'taskId', 'selectedMode', 'operation'],
  'mode.operation.approved': ['requestId', 'taskId', 'selectedMode', 'operation', 'safeCode'],
  'mode.operation.refused': ['requestId', 'taskId', 'selectedMode', 'operation', 'safeCode'],
  'mode.transition.requested': ['requestId', 'taskId', 'fromMode', 'toMode'],
  'mode.transition.awaiting-confirmation': ['requestId', 'taskId', 'fromMode', 'toMode', 'safeCode'],
  'mode.transition.cleanup-pending': ['requestId', 'taskId', 'fromMode', 'toMode', 'safeCode'],
  'mode.transition.committed': ['requestId', 'taskId', 'fromMode', 'toMode', 'safeCode'],
  'mode.transition.cancelled': ['requestId', 'taskId', 'fromMode', 'toMode', 'safeCode'],
  'mode.transition.restored': ['requestId', 'taskId', 'fromMode', 'toMode', 'safeCode'],
  'mode.transition.expired': ['taskId', 'fromMode', 'toMode', 'safeCode'],
  'mode.transition.refused': ['requestId', 'taskId', 'fromMode', 'toMode', 'safeCode']
};
let violations = 0;
export function modeLog<K extends keyof Fields>(event: K, fields: Fields[K]): void {
  const keys = Object.keys(fields).sort(); if (keys.join(',') !== [...FIELDS[event]].sort().join(',') || !Object.values(fields).every(validValue)) {
    violations++; console.error('[kogg:interaction-modes:service] logging.schema.violation', { event }); return;
  }
  if (event.endsWith('failed') || event.endsWith('refused')) console.error('[kogg:interaction-modes:service]', event, fields);
  else if (event.endsWith('expired')) console.warn('[kogg:interaction-modes:service]', event, fields);
  else console.info('[kogg:interaction-modes:service]', event, fields);
}
export function modeLoggingDiagnostics(): { readonly violationCount: number } { return { violationCount: violations }; }
function validValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
  return typeof value === 'string' && Buffer.byteLength(value) <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}
