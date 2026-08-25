import { inject, injectable } from 'inversify';
import {
    MarketplaceClientToken,
    type KoggDiagnosticCheck,
    type KoggDiagnosticContributor,
    type MarketplaceClient
} from '@kogg/contracts';
import { resolveRegistryUrl } from '../common/marketplace-policy';
import { KoggMarketplaceServiceImpl } from './marketplace-service-impl';

// diagnostic-coverage: marketplace.configuration, marketplace.registry, marketplace.installed

@injectable()
export class MarketplaceDiagnosticContributor implements KoggDiagnosticContributor {
    readonly id = 'marketplace';

    constructor(
        @inject(MarketplaceClientToken) private readonly marketplace: MarketplaceClient,
        @inject(KoggMarketplaceServiceImpl) private readonly service: KoggMarketplaceServiceImpl
    ) {}

    async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
        const checks: KoggDiagnosticCheck[] = [];
        try {
            const registry = resolveRegistryUrl();
            checks.push({
                id: 'marketplace.configuration',
                status: ['http:', 'https:'].includes(registry.protocol) ? 'pass' : 'fail',
                summary: 'Kogg registry configuration is valid.',
                details: { protocol: registry.protocol, local: ['localhost', '127.0.0.1'].includes(registry.hostname) }
            });
        } catch (error) {
            console.error('[kogg:marketplace:diagnostics] configuration.failed', { errorType: errorName(error) });
            checks.push({ id: 'marketplace.configuration', status: 'fail', summary: 'Kogg registry configuration is invalid.', details: { errorType: errorName(error) } });
        }
        try {
            const manifests = await this.marketplace.search('');
            checks.push({ id: 'marketplace.registry', status: 'pass', summary: 'Signed Kogg registry is reachable.', details: { resultCount: manifests.length } });
        } catch (error) {
            console.error('[kogg:marketplace:diagnostics] registry.failed', { errorType: errorName(error) });
            checks.push({ id: 'marketplace.registry', status: 'fail', summary: 'Signed Kogg registry check failed.', details: { errorType: errorName(error) } });
        }
        try {
            const installed = await this.service.listInstalled();
            checks.push({ id: 'marketplace.installed', status: 'pass', summary: 'Installed package state is readable.', details: { packageCount: installed.length } });
        } catch (error) {
            console.error('[kogg:marketplace:diagnostics] installed-state.failed', { errorType: errorName(error) });
            checks.push({ id: 'marketplace.installed', status: 'fail', summary: 'Installed package state is unreadable.', details: { errorType: errorName(error) } });
        }
        return checks;
    }
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
}
