import { inject, injectable } from 'inversify';
import {
    CredentialStoreToken,
    ProviderRegistryToken,
    type CredentialStore,
    type KoggDiagnosticCheck,
    type KoggDiagnosticContributor,
    type ProviderRegistry
} from '@kogg/contracts';

// diagnostic-coverage: providers.registry, providers.credentials

@injectable()
export class ProviderDiagnosticContributor implements KoggDiagnosticContributor {
    readonly id = 'providers';

    constructor(
        @inject(ProviderRegistryToken) private readonly providers: ProviderRegistry,
        @inject(CredentialStoreToken) private readonly credentials: CredentialStore
    ) {}

    async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
        const checks: KoggDiagnosticCheck[] = [];
        try {
            const providers = this.providers.listProviders();
            checks.push({
                id: 'providers.registry',
                status: providers.length ? 'pass' : 'fail',
                summary: providers.length ? 'Provider registry is available.' : 'Provider registry is empty.',
                details: { providerCount: providers.length, localCount: providers.filter(item => item.capabilities.local).length }
            });
        } catch (error) {
            console.error('[kogg:providers:diagnostics] registry.failed', { errorType: errorName(error) });
            checks.push({ id: 'providers.registry', status: 'fail', summary: 'Provider registry check failed.', details: { errorType: errorName(error) } });
        }
        try {
            const metadata = await this.credentials.listMetadata();
            checks.push({
                id: 'providers.credentials',
                status: 'pass',
                summary: 'Credential metadata is readable.',
                details: { configuredCount: metadata.length }
            });
        } catch (error) {
            console.error('[kogg:providers:diagnostics] credential-metadata.failed', { errorType: errorName(error) });
            checks.push({ id: 'providers.credentials', status: 'fail', summary: 'Credential metadata is unreadable.', details: { errorType: errorName(error) } });
        }
        return checks;
    }
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
}
