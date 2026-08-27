import { inject, injectable, multiInject, optional } from '@theia/core/shared/inversify';
import { KoggModeTransitionOwner, type ModeTransitionConfigurationCandidateV1, type ModeTransitionConfigurationOptionsRequestV1, type ModeTransitionConfigurationOptionsV1, type ModeTransitionConfigurationV1, type ModeTransitionConfirmRequestV1, type ModeTransitionOwnerContribution, type ModeTransitionProjectionV1 } from '../common/interaction-modes-protocol';
import { InteractionModeRegistry } from './interaction-mode-registry';
import type { ModeTransitionContextV1 } from './mode-transition-authority';

// Coordinates real owner qualification; no owner result or selector state is inferred.
// diagnostic-coverage: interaction-modes.transitions, interaction-modes.worktrees, interaction-modes.anchors
@injectable()
export class ModeTransitionCoordinator {
  constructor(
    @inject(InteractionModeRegistry) private readonly registry: InteractionModeRegistry,
    @multiInject(KoggModeTransitionOwner) @optional() private readonly owners: readonly ModeTransitionOwnerContribution[] = []
  ) {}

  confirm(request: ModeTransitionConfirmRequestV1, context: ModeTransitionContextV1): Promise<ModeTransitionProjectionV1> {
    console.info('[kogg:interaction-modes:service] transition.validation.started', { transitionId: request.transitionId, taskId: request.taskId, ownerCount: this.owners.length });
    return this.registry.confirmTransition(request, context, this.owners);
  }

  async configurations(request: ModeTransitionConfigurationOptionsRequestV1): Promise<ModeTransitionConfigurationOptionsV1> {
    if (!request || !['plan', 'build', 'kogg'].includes(request.toMode)) return { schemaVersion: 1, options: [] };
    const projection = await this.registry.get({ requestId: request.requestId, taskId: request.taskId });
    if (projection.state !== 'ready' && projection.state !== 'transition-pending') return { schemaVersion: 1, options: [] };
    if (request.toMode === 'plan') return { schemaVersion: 1, options: [{ schemaVersion: 1, kind: 'plan' }] };
    const context = { taskId: projection.taskId, projectId: projection.projectId, repositoryId: projection.repositoryId, taskRevision: projection.taskRevision };
    const candidates: ModeTransitionConfigurationCandidateV1[] = [];
    for (const owner of this.owners) if (owner.configurationCandidates) {
      try { candidates.push(...await owner.configurationCandidates(context)); }
      catch (error) { // observability-exempt: configuration discovery emits only the closed owner id and error type.
        console.error('[kogg:interaction-modes:service] transition.configuration.failed', { taskId: request.taskId, owner: owner.owner, errorType: error instanceof Error ? error.name : 'UnknownError' });
      }
    }
    let options: ModeTransitionConfigurationV1[];
    if (request.toMode === 'build') {
      const agents = candidates.filter((candidate): candidate is Extract<ModeTransitionConfigurationCandidateV1, { owner: 'agent-binding' }> => candidate.owner === 'agent-binding');
      const targets = candidates.filter((candidate): candidate is Extract<ModeTransitionConfigurationCandidateV1, { owner: 'execution-target' }> => candidate.owner === 'execution-target');
      options = agents.flatMap(agent => targets.map(target => ({ schemaVersion: 1 as const, kind: 'build' as const, roleRevisionId: agent.roleRevisionId, providerId: agent.providerId, modelId: agent.modelId, adapterKey: agent.adapterKey, adapterVersion: agent.adapterVersion, deadlinePolicyId: agent.deadlinePolicyId, targetId: target.targetId })));
    } else options = candidates.filter((candidate): candidate is Extract<ModeTransitionConfigurationCandidateV1, { owner: 'workflow-anchors' }> => candidate.owner === 'workflow-anchors').map(candidate => ({ schemaVersion: 1, kind: 'kogg', workflowVersionId: candidate.workflowVersionId }));
    console.info('[kogg:interaction-modes:service] transition.configuration.completed', { taskId: request.taskId, toMode: request.toMode, optionCount: Math.min(options.length, 100) });
    return { schemaVersion: 1, options: options.slice(0, 100) };
  }

  ownerIds(): readonly string[] { return this.owners.map(owner => owner.owner).sort(); }
}
