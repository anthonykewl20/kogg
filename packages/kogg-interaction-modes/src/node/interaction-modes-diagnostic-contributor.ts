import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { InteractionModeRegistry } from './interaction-mode-registry';
import { ModeTransitionCoordinator } from './mode-transition-coordinator';
import { interactionModeSourceMapDiagnostics } from './interaction-mode-source-map-diagnostics';

// Runtime support diagnostics report the exact owner wiring required for a safe transition.
// diagnostic-coverage: interaction-modes.registry, interaction-modes.authority, interaction-modes.transitions, interaction-modes.operations, interaction-modes.restoration, interaction-modes.worktrees, interaction-modes.anchors, interaction-modes.accessibility, interaction-modes.source-maps
export const INTERACTION_MODE_CHECKS = [
  { id: 'interaction-modes.registry' }, { id: 'interaction-modes.authority' }, { id: 'interaction-modes.transitions' },
  { id: 'interaction-modes.operations' }, { id: 'interaction-modes.restoration' }, { id: 'interaction-modes.worktrees' },
  { id: 'interaction-modes.anchors' }, { id: 'interaction-modes.accessibility' }, { id: 'interaction-modes.source-maps' }
] as const;
@injectable()
export class InteractionModesDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'interaction-modes';
  constructor(
    @inject(InteractionModeRegistry) private readonly registry: InteractionModeRegistry,
    @inject(ModeTransitionCoordinator) private readonly coordinator: ModeTransitionCoordinator
  ) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const value = this.registry.diagnostics(); const healthy = value.integrity && value.eventChain && value.modeStateConsistent && value.immutableRequestLedgers && value.loggingViolationCount === 0;
      const owners = new Set(this.coordinator.ownerIds());
      const transitionOwners = ['operations', 'agent-binding', 'execution-target', 'workflow-anchors'].every(owner => owners.has(owner));
      const worktreeOwners = owners.has('operations') && owners.has('execution-target');
      const workflowOwners = owners.has('operations') && owners.has('workflow-anchors');
      const sourceMaps = interactionModeSourceMapDiagnostics();
      return [
        check('interaction-modes.registry', healthy, healthy ? 'The durable mode registry and event chain are valid.' : 'The durable mode registry requires recovery.'),
        check('interaction-modes.authority', healthy && value.degradedCount === 0, value.degradedCount ? 'One or more task mode bindings are degraded.' : 'Stored task mode bindings are internally consistent.'),
        check('interaction-modes.transitions', healthy && transitionOwners && value.pendingTransitionCount === 0, value.pendingTransitionCount
          ? 'A durable transition is pending owner qualification or cancellation.'
          : transitionOwners ? 'Confirmation, cleanup, exact configuration qualification, and CAS commit owners are connected.' : 'One or more required transition owners are not connected.'),
        check('interaction-modes.operations', healthy && value.admission === 'enabled', 'Closed operation authorization is available.'),
        check('interaction-modes.restoration', healthy && value.admission === 'enabled', 'Mode startup restoration is complete.'),
        check('interaction-modes.worktrees', healthy && worktreeOwners, worktreeOwners ? 'Task cleanup and fresh execution-target qualification owners are connected.' : 'Build execution-target ownership is not connected.'),
        check('interaction-modes.anchors', healthy && workflowOwners, workflowOwners ? 'Task cleanup and governed workflow-anchor qualification owners are connected.' : 'Governed workflow anchor authority is not connected.'),
        check('interaction-modes.accessibility', true, 'The always-visible selector exposes the selected mode, effective authority, stage, and blocked reasons.'),
        { ...check('interaction-modes.source-maps', sourceMaps.missingCount === 0, sourceMaps.missingCount === 0 ? 'Every interaction-mode browser, authority, transition, and backend boundary has a debugger source map.' : 'One or more interaction-mode source maps are missing.'), details: { ...sourceMaps } }
      ];
    } catch (error) {
      console.error('[kogg:interaction-modes:diagnostics] diagnose.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return INTERACTION_MODE_CHECKS.map(({ id }) => check(id, false, 'Interaction mode diagnostics could not run.'));
    }
  }
}
function check(id: typeof INTERACTION_MODE_CHECKS[number]['id'], passed: boolean, summary: string): KoggDiagnosticCheck { return { id, status: passed ? 'pass' : 'fail', summary }; }
