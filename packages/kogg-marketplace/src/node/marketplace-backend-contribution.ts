import { readFileSync } from 'node:fs';
import path from 'node:path';
import { injectable } from 'inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { resolveRegistryUrl } from '../common/marketplace-policy';

// diagnostic-coverage: marketplace.configuration

export function loadMarketplacePublicKey(): string {
    const root = path.resolve(process.env.KOGG_ROOT ?? process.cwd());
    const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const packagedKey = electronResources ? path.join(electronResources, 'kogg-runtime', 'marketplace-public.pem') : undefined;
    const configured = process.env.KOGG_MARKETPLACE_PUBLIC_KEY
        ?? (packagedKey && readFileExists(packagedKey) ? packagedKey : path.join(root, '.kogg', 'dev', 'marketplace-public.pem'));
    return readFileSync(configured, 'utf8');
}

function readFileExists(candidate: string): boolean {
    try {
        readFileSync(candidate);
        return true;
    } catch {
        // observability-exempt: Probing an optional public-key path is an expected branch before selecting the development fallback.
        return false;
    }
}

@injectable()
export class MarketplaceBackendContribution implements BackendApplicationContribution {
    onStart(): void {
        const registry = resolveRegistryUrl().toString().replace(/\/$/, '');
        process.env.VSX_REGISTRY_URL = registry;
        console.info('[kogg:marketplace:backend] registry.configured');
    }
}
