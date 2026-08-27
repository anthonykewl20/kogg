import type { ExecutionQualificationCode, ExecutionQualificationProjection, ExecutionRunProjectionV1, ExecutionState } from './execution-protocol';

// Pure safe UI policy: visible run start remains disabled until both target qualification and the governed workflow start owner exist.
// observability-exempt: This file is a deterministic presentation policy with no lifecycle or external effects.
// diagnostic-exempt: Pure presentation policy has no independent runtime state.
export interface ExecutionStartGateV1 { readonly enabled: false; readonly safeCode: ExecutionQualificationCode; readonly summary: string; }

export function executionStartGate(qualification: ExecutionQualificationProjection): ExecutionStartGateV1 {
  if (!qualification.qualified) return { enabled: false, safeCode: qualification.safeCode, summary: `Run start unavailable: ${qualification.safeCode}.` };
  return { enabled: false, safeCode: 'EXECUTION_INTERNAL_FAILED', summary: 'Run start unavailable: governed workflow start owner is not connected.' };
}

export function executionStateLabel(state: ExecutionState): string { return state.split('-').map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' '); }

export function executionAuthorityNotice(run: Pick<ExecutionRunProjectionV1, 'authorityMode'>): string {
  if (run.authorityMode === 'build') return 'Build work is unverified. Continue in Kogg mode to run the required governed lifecycle.';
  if (run.authorityMode === 'kogg') return 'Kogg execution output still requires current independent evidence, verdict, and controlled merge; this lifecycle state alone is not PASS or completion.';
  return 'Execution authority is unavailable for this legacy run; it cannot claim Build or governed Kogg completion.';
}
