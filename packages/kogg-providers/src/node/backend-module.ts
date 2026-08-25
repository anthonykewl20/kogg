import { ContainerModule } from 'inversify';
import { CredentialStoreToken, KoggDiagnosticContribution, ProviderRegistryToken } from '@kogg/contracts';
import { BrowserCredentialStore, ElectronCredentialStore } from './credential-store';
import { KoggProviderRegistry } from './provider-registry';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { KoggProviderService, KoggProviderServicePath } from '../common/provider-service';
import { KoggProviderServiceImpl } from './provider-service-impl';
import { ProviderDiagnosticContributor } from './provider-diagnostic-contributor';

export default new ContainerModule(bind => {
    bind(BrowserCredentialStore).toSelf().inSingletonScope();
    bind(ElectronCredentialStore).toSelf().inSingletonScope();
    bind(CredentialStoreToken).toDynamicValue(context => process.env.KOGG_RUNTIME === 'browser'
        ? context.container.get(BrowserCredentialStore)
        : context.container.get(ElectronCredentialStore)).inSingletonScope();
    bind(KoggProviderRegistry).toSelf().inSingletonScope();
    bind(ProviderRegistryToken).toService(KoggProviderRegistry);
    bind(KoggProviderServiceImpl).toSelf().inSingletonScope();
    bind(ProviderDiagnosticContributor).toSelf().inSingletonScope();
    bind(KoggDiagnosticContribution).toService(ProviderDiagnosticContributor);
    bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggProviderService>(
        KoggProviderServicePath,
        () => context.container.get(KoggProviderServiceImpl)
    )).inSingletonScope();
});
