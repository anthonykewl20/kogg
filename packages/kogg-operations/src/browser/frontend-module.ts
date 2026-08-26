import { FrontendApplicationContribution, WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggOperationsClientToken, KoggOperationsService, KoggOperationsServicePath } from '../common/operations-protocol';
import { OperationsClient } from './operations-client';
import { OperationsContribution } from './operations-contribution';
import { OperationsWidget } from './operations-widget';

export default new ContainerModule(bind => {
  bind(OperationsClient).toSelf().inSingletonScope();
  bind(KoggOperationsClientToken).toService(OperationsClient);
  bind(KoggOperationsService).toDynamicValue(context => WebSocketConnectionProvider.createProxy(
    context.container, KoggOperationsServicePath, context.container.get(OperationsClient)
  )).inSingletonScope();
  bind(OperationsWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({ id: OperationsWidget.ID, createWidget: () => context.container.get(OperationsWidget) })).inSingletonScope();
  bindViewContribution(bind, OperationsContribution);
  bind(FrontendApplicationContribution).toService(OperationsContribution);
});
