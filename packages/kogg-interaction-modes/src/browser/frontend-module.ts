import { CommandContribution } from '@theia/core';
import { FrontendApplicationContribution, WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggInteractionModesService, KoggInteractionModesServicePath, type KoggInteractionModesService as InteractionModesService } from '../common/interaction-modes-protocol';
import { InteractionModeFrontendContribution } from './interaction-mode-frontend-contribution';

// observability-exempt: Declarative frontend bindings delegate operational behavior to InteractionModeFrontendContribution.
// diagnostic-coverage: interaction-modes.accessibility, interaction-modes.source-maps
export default new ContainerModule(bind => {
  bind(KoggInteractionModesService).toDynamicValue(context => WebSocketConnectionProvider.createProxy<InteractionModesService>(context.container, KoggInteractionModesServicePath)).inSingletonScope();
  bind(InteractionModeFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(InteractionModeFrontendContribution);
  bind(CommandContribution).toService(InteractionModeFrontendContribution);
});
