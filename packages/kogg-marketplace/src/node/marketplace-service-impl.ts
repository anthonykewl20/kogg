import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inject, injectable } from 'inversify';
import { MarketplaceClientToken, type MarketplaceClient } from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { runOperation } from '@kogg/operations/lib/node/run-operation';
import { PluginDeployer, PluginType } from '@theia/plugin-ext/lib/common/plugin-protocol';
import type { InstalledKoggPackage, KoggMarketplaceService } from '../common/marketplace-service';

// diagnostic-coverage: marketplace.installed, operations.registry, operations.cleanup

@injectable()
export class KoggMarketplaceServiceImpl implements KoggMarketplaceService {
    constructor(
        @inject(MarketplaceClientToken) private readonly marketplace: MarketplaceClient,
        @inject(PluginDeployer) private readonly deployer: LivePluginDeployer,
        @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi
    ) {}

    search(query: string) { return this.tracked(() => this.marketplace.search(query)); }

    async install(id: string, version = 'latest'): Promise<void> {
        await this.tracked(async activity => {
            const manifest = await this.marketplace.details(id, version); activity();
            await this.marketplace.install(manifest); activity();
            await this.deployer.deploy({ id: `kogg-installed:${manifest.id}@${manifest.version}`, type: PluginType.User });
        });
    }

    async update(id: string): Promise<void> {
        await this.tracked(async activity => {
            await this.marketplace.update(id); activity();
            const installed = (await this.readInstalled()).find(item => item.id === id);
            if (installed) await this.deployer.deploy({ id: `kogg-installed:${id}@${installed.version}`, type: PluginType.User });
        });
    }

    async remove(id: string): Promise<void> {
        await this.tracked(async activity => {
            for (const installed of await this.readInstalled()) if (installed.id === id) await this.deployer.undeploy(`${id}@${installed.version}`);
            activity(); await this.marketplace.remove(id);
        });
    }
    async rollback(id: string): Promise<void> {
        await this.tracked(async activity => {
            await this.marketplace.rollback(id); activity();
            const installed = (await this.readInstalled()).find(item => item.id === id);
            if (installed) await this.deployer.deploy({ id: `kogg-installed:${id}@${installed.version}`, type: PluginType.User });
        });
    }

    async refreshRevocations(): Promise<void> { await this.tracked(() => this.marketplace.refreshRevocations()); }

    async listInstalled(): Promise<readonly InstalledKoggPackage[]> {
        return this.tracked(() => this.readInstalled());
    }

    private tracked<T>(work: (activity: () => void) => Promise<T>): Promise<T> {
        return runOperation(this.operations, 'marketplace', work);
    }

    private async readInstalled(): Promise<readonly InstalledKoggPackage[]> {
        const root = path.join(stateRoot(), 'plugins');
        let entries;
        try { entries = await fs.readdir(root, { withFileTypes: true }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        return (await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
            try {
                const version = (await fs.readFile(path.join(root, entry.name, 'current'), 'utf8')).trim();
                return version ? { id: entry.name, version } : undefined;
            } catch (error) {
                console.warn('[kogg:marketplace:service] installed-entry.invalid', {
                    packageId: entry.name,
                    errorType: error instanceof Error ? error.name : 'UnknownError'
                });
                return undefined;
            }
        }))).filter((entry): entry is InstalledKoggPackage => Boolean(entry));
    }
}

interface LivePluginDeployer {
    deploy(plugin: { readonly id: string; readonly type: PluginType }): Promise<number>;
    undeploy(id: `${string}@${string}`): Promise<void>;
}

function stateRoot(): string {
    return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state'));
}
