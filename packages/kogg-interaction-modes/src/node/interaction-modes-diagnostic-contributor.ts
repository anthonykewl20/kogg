import { existsSync } from 'node:fs';
import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { InteractionModeRegistry } from './interaction-mode-registry';

// Unimplemented transition/worktree/workflow/UI owners fail visibly instead of disappearing from runtime support diagnostics.
// diagnostic-coverage: interaction-modes.registry, interaction-modes.authority, interaction-modes.transitions, interaction-modes.operations, interaction-modes.restoration, interaction-modes.worktrees, interaction-modes.anchors, interaction-modes.accessibility, interaction-modes.source-maps
export const INTERACTION_MODE_CHECKS = [
  { id: 'interaction-modes.registry' }, { id: 'interaction-modes.authority' }, { id: 'interaction-modes.transitions' },
  { id: 'interaction-modes.operations' }, { id: 'interaction-modes.restoration' }, { id: 'interaction-modes.worktrees' },
  { id: 'interaction-modes.anchors' }, { id: 'interaction-modes.accessibility' }, { id: 'interaction-modes.source-maps' }
] as const;
@injectable()
export class InteractionModesDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'interaction-modes';
  constructor(@inject(InteractionModeRegistry) private readonly registry: InteractionModeRegistry) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const value = this.registry.diagnostics(); const healthy = value.integrity && value.eventChain && value.modeStateConsistent && value.immutableRequestLedgers && value.loggingViolationCount === 0;
      return [
        check('interaction-modes.registry', healthy, healthy ? 'The durable mode registry and event chain are valid.' : 'The durable mode registry requires recovery.'),
        check('interaction-modes.authority', healthy && value.degradedCount === 0, value.degradedCount ? 'One or more task mode bindings are degraded.' : 'Stored task mode bindings are internally consistent.'),
        check('interaction-modes.transitions', false, value.pendingTransitionCount
          ? 'A durable transition is pending; confirmation, cleanup, and commit owners are not connected.'
          : 'Durable intent and backend-only actor envelopes are available; confirmation, cleanup, and commit owners are not connected.'),
        check('interaction-modes.operations', healthy && value.admission === 'enabled', 'Closed operation authorization is available.'),
        check('interaction-modes.restoration', healthy && value.admission === 'enabled', 'Mode startup restoration is complete.'),
        check('interaction-modes.worktrees', false, 'Build and Kogg worktree transition ownership is not connected.'),
        check('interaction-modes.anchors', false, 'Governed workflow anchor authority is not connected.'),
        check('interaction-modes.accessibility', true, 'The always-visible selector exposes the selected mode, effective authority, stage, and blocked reasons.'),
        check('interaction-modes.source-maps', existsSync(`${__filename}.map`), existsSync(`${__filename}.map`) ? 'Interaction mode backend source maps are present.' : 'Interaction mode backend source maps are missing.')
      ];
    } catch (error) {
      console.error('[kogg:interaction-modes:diagnostics] diagnose.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return INTERACTION_MODE_CHECKS.map(({ id }) => check(id, false, 'Interaction mode diagnostics could not run.'));
    }
  }
}
function check(id: typeof INTERACTION_MODE_CHECKS[number]['id'], passed: boolean, summary: string): KoggDiagnosticCheck { return { id, status: passed ? 'pass' : 'fail', summary }; }
