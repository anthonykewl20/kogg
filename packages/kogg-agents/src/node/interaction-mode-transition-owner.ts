import { createHash } from 'node:crypto';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { ModeTransitionConfigurationCandidateV1, ModeTransitionConfigurationContextV1, ModeTransitionOwnerContribution, ModeTransitionOwnerRequestV1, ModeTransitionOwnerResultV1 } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import { KoggAgentBindingAuthorizer, type AgentBindingAuthorizer } from '../common/agents-protocol';
import { AgentRegistry } from './agent-registry';

// Revalidates the exact selected immutable agent/provider/model/adapter binding at transition time.
// diagnostic-coverage: agents.adapters, agents.attempts, interaction-modes.transitions
@injectable()
export class AgentModeTransitionOwner implements ModeTransitionOwnerContribution {
  readonly owner = 'agent-binding' as const;
  constructor(@inject(KoggAgentBindingAuthorizer) private readonly bindings: AgentBindingAuthorizer, @inject(AgentRegistry) private readonly registry: AgentRegistry) {}
  async configurationCandidates(_context: ModeTransitionConfigurationContextV1): Promise<readonly ModeTransitionConfigurationCandidateV1[]> {
    const snapshot = await this.registry.snapshot(); const candidates: ModeTransitionConfigurationCandidateV1[] = [];
    for (const role of snapshot.roles) for (const adapter of snapshot.adapters) {
      if (!adapter.enabled || !role.providerPolicy.requiredAdapterCapabilities.every(capability => adapter.capabilityIds.includes(capability))) continue;
      for (const providerId of role.providerPolicy.permittedProviderIds) {
        if (!adapter.providerIds.includes(providerId)) continue;
        for (const modelId of role.providerPolicy.permittedModelIds) candidates.push({ owner: this.owner, roleRevisionId: role.roleRevisionId, providerId, modelId, adapterKey: adapter.adapterKey, adapterVersion: adapter.adapterVersion, deadlinePolicyId: 'interactive-v1' });
      }
    }
    return candidates.slice(0, 100);
  }
  async qualifyTransition(request: ModeTransitionOwnerRequestV1): Promise<ModeTransitionOwnerResultV1> {
    if (request.configuration.kind !== 'build') return { owner: this.owner, qualified: false, safeCode: 'MODE_PROVIDER_UNQUALIFIED' };
    const configuration = request.configuration;
    const result = await this.bindings.authorizeBinding({ roleRevisionId: configuration.roleRevisionId, providerId: configuration.providerId, modelId: configuration.modelId, adapterKey: configuration.adapterKey, adapterVersion: configuration.adapterVersion, deadlinePolicyId: configuration.deadlinePolicyId });
    if (!result.allowed) {
      console.warn('[kogg:interaction-modes:agent-owner] qualification.refused', { transitionId: request.transitionId, taskId: request.taskId, safeCode: 'MODE_PROVIDER_UNQUALIFIED' });
      return { owner: this.owner, qualified: false, safeCode: 'MODE_PROVIDER_UNQUALIFIED' };
    }
    const proofDigest = `sha256:${createHash('sha256').update(`kogg:interaction-modes:agent-binding:v1\0${JSON.stringify({ configuration, registryRevision: result.registryRevision, taskId: request.taskId, transitionId: request.transitionId })}`).digest('hex')}`;
    console.info('[kogg:interaction-modes:agent-owner] qualification.completed', { transitionId: request.transitionId, taskId: request.taskId });
    return { owner: this.owner, qualified: true, safeCode: 'MODE_OK', proofDigest };
  }
}
