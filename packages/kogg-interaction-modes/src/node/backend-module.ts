import { BackendApplicationContribution } from '@theia/core/lib/node';
import { KoggDiagnosticContribution } from '@kogg/contracts';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggInteractionModesServicePath, type KoggInteractionModesService } from '../common/interaction-modes-protocol';
import { InteractionModeRegistry } from './interaction-mode-registry';
import { InteractionModesDiagnosticContributor } from './interaction-modes-diagnostic-contributor';

// diagnostic-coverage: interaction-modes.registry, interaction-modes.authority, interaction-modes.operations, interaction-modes.restoration
export default new ContainerModule(bind => {
  bind(InteractionModeRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(InteractionModeRegistry);
  bind(InteractionModesDiagnosticContributor).toSelf().inSingletonScope(); bind(KoggDiagnosticContribution).toService(InteractionModesDiagnosticContributor);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggInteractionModesService>(KoggInteractionModesServicePath, () => context.container.get(InteractionModeRegistry))).inSingletonScope();
});
