import { createHash } from 'node:crypto';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { ModeTransitionConfigurationCandidateV1, ModeTransitionConfigurationContextV1, ModeTransitionOwnerContribution, ModeTransitionOwnerRequestV1, ModeTransitionOwnerResultV1 } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import { ExecutionTargetBindingAuthority, type ExecutionTargetBindingAuthority as TargetBindingAuthority } from '../common/execution-protocol';

// Requires a fresh pinned writable-target qualification and exact requested target identity.
// diagnostic-coverage: execution.target-qualification, interaction-modes.worktrees, interaction-modes.transitions
@injectable()
export class ExecutionModeTransitionOwner implements ModeTransitionOwnerContribution {
  readonly owner = 'execution-target' as const;
  constructor(@inject(ExecutionTargetBindingAuthority) private readonly targets: TargetBindingAuthority) {}
  async configurationCandidates(_context: ModeTransitionConfigurationContextV1): Promise<readonly ModeTransitionConfigurationCandidateV1[]> {
    const binding = await this.targets.resolveTargetBinding(); return binding ? [{ owner: this.owner, targetId: binding.targetId }] : [];
  }
  async qualifyTransition(request: ModeTransitionOwnerRequestV1): Promise<ModeTransitionOwnerResultV1> {
    if (request.configuration.kind !== 'build') return { owner: this.owner, qualified: false, safeCode: 'MODE_WORKTREE_INVALID' };
    const binding = await this.targets.resolveTargetBinding();
    if (!binding || binding.targetId !== request.configuration.targetId) {
      console.warn('[kogg:interaction-modes:execution-owner] qualification.refused', { transitionId: request.transitionId, taskId: request.taskId, safeCode: binding ? 'MODE_WORKTREE_INVALID' : 'MODE_HOST_UNQUALIFIED' });
      return { owner: this.owner, qualified: false, safeCode: binding ? 'MODE_WORKTREE_INVALID' : 'MODE_HOST_UNQUALIFIED' };
    }
    const proofDigest = `sha256:${createHash('sha256').update(`kogg:interaction-modes:execution-target:v1\0${JSON.stringify({ binding, taskId: request.taskId, transitionId: request.transitionId })}`).digest('hex')}`;
    console.info('[kogg:interaction-modes:execution-owner] qualification.completed', { transitionId: request.transitionId, taskId: request.taskId, targetId: binding.targetId, qualificationId: binding.qualificationId });
    return { owner: this.owner, qualified: true, safeCode: 'MODE_OK', proofDigest };
  }
}
