import type { ModeProjectionV1 } from './interaction-modes-protocol';

// Mode presentation must preserve closed backend refusal states instead of rendering zero authority as a usable mode.
// diagnostic-coverage: interaction-modes.restoration, interaction-modes.accessibility
export function modeAuthorityLabel(projection: ModeProjectionV1): string {
  if (projection.state === 'transition-pending') return 'disabled during transition';
  if (projection.state !== 'ready') return `disabled: ${projection.safeCode}`;
  return `${projection.effectiveCapabilities.length} bounded capabilities`;
}

export function modeSelectionAllowed(projection: ModeProjectionV1): boolean {
  return projection.state === 'ready';
}

export function modeBlockedExplanation(projection: ModeProjectionV1): string {
  if (projection.state === 'transition-pending') return 'All mode operations are refused until transition confirmation, qualification, cleanup, and commit.';
  if (projection.state !== 'ready') return `Mode authority is disabled because the backend reported ${projection.safeCode}. Restore the exact current task binding before requesting a transition.`;
  if (projection.selectedMode === 'plan') return 'Plan cannot modify production files; switch to Build or Kogg through explicit confirmation.';
  if (projection.selectedMode === 'build') return 'Build cannot claim governed PASS or merge; continue through Kogg verification.';
  return 'Kogg remains bounded by approvals, independent checks, evidence, verdict, controlled merge, and cleanup.';
}
