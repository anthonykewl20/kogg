import { ContainerModule } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { KoggProviderService, KoggProviderServicePath } from '../common/provider-service';
import { KoggProviderWidget } from './provider-widget';
import { KoggProviderContribution } from './provider-contribution';

export default new ContainerModule(bind => {
    bind(KoggProviderService).toDynamicValue(context =>
        WebSocketConnectionProvider.createProxy(context.container, KoggProviderServicePath)
    ).inSingletonScope();
    bind(KoggProviderWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({ id: KoggProviderWidget.ID, createWidget: () => context.container.get(KoggProviderWidget) })).inSingletonScope();
    bindViewContribution(bind, KoggProviderContribution);
});
