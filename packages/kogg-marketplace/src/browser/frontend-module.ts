import { ContainerModule } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { KoggMarketplaceService, KoggMarketplaceServicePath } from '../common/marketplace-service';
import { KoggMarketplaceWidget } from './marketplace-widget';
import { KoggMarketplaceContribution } from './marketplace-contribution';

export default new ContainerModule(bind => {
    bind(KoggMarketplaceService).toDynamicValue(context =>
        WebSocketConnectionProvider.createProxy(context.container, KoggMarketplaceServicePath)
    ).inSingletonScope();
    bind(KoggMarketplaceWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: KoggMarketplaceWidget.ID,
        createWidget: () => context.container.get(KoggMarketplaceWidget)
    })).inSingletonScope();
    bindViewContribution(bind, KoggMarketplaceContribution);
});
