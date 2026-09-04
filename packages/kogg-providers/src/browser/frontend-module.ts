import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { KoggProviderChatClientToken, KoggProviderService, KoggProviderServicePath } from '../common/provider-service';
import { KoggProviderWidget } from './provider-widget';
import { KoggProviderContribution } from './provider-contribution';
import { ProviderChatClient } from './chat-client';

// diagnostic-exempt: inversify wiring only; the bound services carry the operational coverage.

export default new ContainerModule(bind => {
    bind(ProviderChatClient).toSelf().inSingletonScope();
    bind(KoggProviderChatClientToken).toService(ProviderChatClient);
    // Passing the local chat client to createProxy lets the backend push
    // stream events over the same WebSocket (see KoggOperationsClient).
    bind(KoggProviderService).toDynamicValue(context =>
        WebSocketConnectionProvider.createProxy(context.container, KoggProviderServicePath, context.container.get(ProviderChatClient))
    ).inSingletonScope();    bind(KoggProviderWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({ id: KoggProviderWidget.ID, createWidget: () => context.container.get(KoggProviderWidget) })).inSingletonScope();
    bindViewContribution(bind, KoggProviderContribution);
    bind(FrontendApplicationContribution).toService(KoggProviderContribution);
});
