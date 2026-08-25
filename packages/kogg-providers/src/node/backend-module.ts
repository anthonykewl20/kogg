import { ContainerModule } from 'inversify';
import { CredentialStoreToken, ProviderRegistryToken } from '@kogg/contracts';
import { BrowserCredentialStore, ElectronCredentialStore } from './credential-store';
import { KoggProviderRegistry } from './provider-registry';

export default new ContainerModule(bind => {
    bind(BrowserCredentialStore).toSelf().inSingletonScope();
    bind(ElectronCredentialStore).toSelf().inSingletonScope();
    bind(CredentialStoreToken).toDynamicValue(context => process.env.KOGG_RUNTIME === 'browser'
        ? context.container.get(BrowserCredentialStore)
        : context.container.get(ElectronCredentialStore)).inSingletonScope();
    bind(KoggProviderRegistry).toSelf().inSingletonScope();
    bind(ProviderRegistryToken).toService(KoggProviderRegistry);
});
