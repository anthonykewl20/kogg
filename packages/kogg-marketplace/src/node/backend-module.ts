import { ContainerModule } from 'inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { KoggDiagnosticContribution, MarketplaceClientToken } from '@kogg/contracts';
import { PluginDeployerParticipant, PluginDeployerResolver } from '@theia/plugin-ext/lib/common/plugin-protocol';
import { KoggMarketplaceClient } from './marketplace-client';
import { loadMarketplacePublicKey, MarketplaceBackendContribution } from './marketplace-backend-contribution';
import { KoggInstalledPluginResolver, KoggPluginStartupPolicy, KoggSignedPluginResolver, KoggSystemPluginResolver } from './signed-plugin-resolver';
import { KoggMarketplaceService, KoggMarketplaceServicePath } from '../common/marketplace-service';
import { KoggMarketplaceServiceImpl } from './marketplace-service-impl';
import { MarketplaceDiagnosticContributor } from './marketplace-diagnostic-contributor';

export default new ContainerModule((bind, unbind, isBound) => {
    if (isBound(PluginDeployerResolver)) unbind(PluginDeployerResolver);
    bind('KoggMarketplacePublicKey').toDynamicValue(() => loadMarketplacePublicKey()).inSingletonScope();
    bind(KoggMarketplaceClient).toSelf().inSingletonScope();
    bind(MarketplaceClientToken).toService(KoggMarketplaceClient);
    bind(MarketplaceBackendContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(MarketplaceBackendContribution);
    bind(KoggSignedPluginResolver).toSelf().inSingletonScope();
    bind(PluginDeployerResolver).toService(KoggSignedPluginResolver);
    bind(KoggSystemPluginResolver).toSelf().inSingletonScope();
    bind(PluginDeployerResolver).toService(KoggSystemPluginResolver);
    bind(KoggInstalledPluginResolver).toSelf().inSingletonScope();
    bind(PluginDeployerResolver).toService(KoggInstalledPluginResolver);
    bind(KoggPluginStartupPolicy).toSelf().inSingletonScope();
    bind(PluginDeployerParticipant).toService(KoggPluginStartupPolicy);
    bind(KoggMarketplaceServiceImpl).toSelf().inSingletonScope();
    bind(MarketplaceDiagnosticContributor).toSelf().inSingletonScope();
    bind(KoggDiagnosticContribution).toService(MarketplaceDiagnosticContributor);
    bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggMarketplaceService>(
        KoggMarketplaceServicePath,
        () => context.container.get(KoggMarketplaceServiceImpl)
    )).inSingletonScope();
});
