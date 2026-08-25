import { ContainerModule } from 'inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { MarketplaceClientToken } from '@kogg/contracts';
import { PluginDeployerParticipant, PluginDeployerResolver } from '@theia/plugin-ext/lib/common/plugin-protocol';
import { KoggMarketplaceClient } from './marketplace-client';
import { loadMarketplacePublicKey, MarketplaceBackendContribution } from './marketplace-backend-contribution';
import { KoggPluginStartupPolicy, KoggSignedPluginResolver } from './signed-plugin-resolver';

export default new ContainerModule((bind, unbind, isBound) => {
    if (isBound(PluginDeployerResolver)) unbind(PluginDeployerResolver);
    bind('KoggMarketplacePublicKey').toDynamicValue(() => loadMarketplacePublicKey()).inSingletonScope();
    bind(KoggMarketplaceClient).toSelf().inSingletonScope();
    bind(MarketplaceClientToken).toService(KoggMarketplaceClient);
    bind(MarketplaceBackendContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(MarketplaceBackendContribution);
    bind(KoggSignedPluginResolver).toSelf().inSingletonScope();
    bind(PluginDeployerResolver).toService(KoggSignedPluginResolver);
    bind(KoggPluginStartupPolicy).toSelf().inSingletonScope();
    bind(PluginDeployerParticipant).toService(KoggPluginStartupPolicy);
});
