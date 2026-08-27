import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { CredentialLeaseAuthority, KoggAdapterRegistry, KoggAgentBindingAuthorizer, KoggAgentsService, KoggAgentsServicePath, type KoggAgentsClient } from '../common/agents-protocol';
import { AdapterRegistry } from './adapter-registry';
import { AgentDiagnosticContributor } from './agent-diagnostic-contributor';
import { AgentRegistry } from './agent-registry';
import { KoggModeTransitionOwner } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import { AgentModeTransitionOwner } from './interaction-mode-transition-owner';
import { FixtureAdapter } from './fixture-adapter';
import { LocalCredentialLeaseAuthority } from './credential-lease-authority';
import { AgentOperationsOwnerWiring } from './agent-operations-owner-wiring';

// diagnostic-coverage: agents.adapters, agents.attempts, agents.processes, agents.recovery, agents.logging

export default new ContainerModule(bind => {
  bind(AdapterRegistry).toSelf().inSingletonScope();
  bind(KoggAdapterRegistry).toService(AdapterRegistry);
  bind(LocalCredentialLeaseAuthority).toSelf().inSingletonScope();
  bind(CredentialLeaseAuthority).toService(LocalCredentialLeaseAuthority);
  bind(AgentRegistry).toSelf().inSingletonScope();
  bind(KoggAgentsService).toService(AgentRegistry);
  bind(KoggAgentBindingAuthorizer).toService(AgentRegistry);
  bind(AgentModeTransitionOwner).toSelf().inSingletonScope();
  bind(KoggModeTransitionOwner).toService(AgentModeTransitionOwner);
  bind(BackendApplicationContribution).toService(AgentRegistry);
  bind(AgentOperationsOwnerWiring).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(AgentOperationsOwnerWiring);
  bind(FixtureAdapter).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(FixtureAdapter);
  bind(AgentDiagnosticContributor).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(AgentDiagnosticContributor);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggAgentsClient>(
    KoggAgentsServicePath,
    client => { const registry = context.container.get(AgentRegistry); registry.setClient(client); return registry; }
  )).inSingletonScope();
});
