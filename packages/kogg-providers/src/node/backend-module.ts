import { ContainerModule } from 'inversify';
import { CredentialStoreToken, KoggDiagnosticContribution, ProviderRegistryToken } from '@kogg/contracts';
import { BrowserCredentialStore, ElectronCredentialStore } from './credential-store';
import { KoggProviderRegistry } from './provider-registry';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { KoggProviderChatClient, KoggProviderServicePath } from '../common/provider-service';
import { KoggProviderServiceImpl } from './provider-service-impl';
import { AccountLoginManager } from './account-login-manager';
import { ProviderDiagnosticContributor } from './provider-diagnostic-contributor';

// diagnostic-exempt: inversify wiring only; the bound services carry the operational coverage.

export default new ContainerModule(bind => {
    bind(BrowserCredentialStore).toSelf().inSingletonScope();
    bind(ElectronCredentialStore).toSelf().inSingletonScope();
    bind(CredentialStoreToken).toDynamicValue(context => process.env.KOGG_RUNTIME === 'browser'
        ? context.container.get(BrowserCredentialStore)
        : context.container.get(ElectronCredentialStore)).inSingletonScope();
    bind(KoggProviderRegistry).toSelf().inSingletonScope();
    bind(ProviderRegistryToken).toService(KoggProviderRegistry);
    bind(AccountLoginManager).toSelf().inSingletonScope();
    bind(KoggProviderServiceImpl).toSelf().inSingletonScope();
    bind(ProviderDiagnosticContributor).toSelf().inSingletonScope();
    bind(KoggDiagnosticContribution).toService(ProviderDiagnosticContributor);
    bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggProviderChatClient>(
        KoggProviderServicePath,
        client => {
            // The frontend's chat client rides the same JSON-RPC connection so
            // the backend can push stream deltas (see KoggOperationsClient).
            const service = context.container.get(KoggProviderServiceImpl);
            service.setChatClient(client);
            return service;
        }
    )).inSingletonScope();
});
