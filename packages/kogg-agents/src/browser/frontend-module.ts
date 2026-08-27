import { WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggAgentsService, KoggAgentsServicePath } from '../common/agents-protocol';
import { AgentsClient } from './agents-client';
import { AgentsContribution } from './agents-contribution';
import { AgentsWidget } from './agents-widget';

// diagnostic-coverage: agents.source-maps

export default new ContainerModule(bind => {
  bind(AgentsClient).toSelf().inSingletonScope();
  bind(KoggAgentsService).toDynamicValue(context => WebSocketConnectionProvider.createProxy(
    context.container, KoggAgentsServicePath, context.container.get(AgentsClient)
  )).inSingletonScope();
  bind(AgentsWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({ id: AgentsWidget.ID, createWidget: () => context.container.get(AgentsWidget) })).inSingletonScope();
  bindViewContribution(bind, AgentsContribution);
});
