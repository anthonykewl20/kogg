import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggAdapterRegistry, KoggAgentsServicePath, type KoggAgentsClient } from '../common/agents-protocol';
import { AdapterRegistry } from './adapter-registry';
import { AgentDiagnosticContributor } from './agent-diagnostic-contributor';
import { AgentRegistry } from './agent-registry';
import { FixtureAdapter } from './fixture-adapter';

// diagnostic-coverage: agents.adapters, agents.attempts, agents.processes, agents.recovery, agents.logging

export default new ContainerModule(bind => {
  bind(AdapterRegistry).toSelf().inSingletonScope();
  bind(KoggAdapterRegistry).toService(AdapterRegistry);
  bind(AgentRegistry).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(AgentRegistry);
  bind(FixtureAdapter).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(FixtureAdapter);
  bind(AgentDiagnosticContributor).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(AgentDiagnosticContributor);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggAgentsClient>(
    KoggAgentsServicePath,
    client => { const registry = context.container.get(AgentRegistry); registry.setClient(client); return registry; }
  )).inSingletonScope();
});
