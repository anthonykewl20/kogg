import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inject, injectable } from 'inversify';
import { MarketplaceClientToken, type MarketplaceClient } from '@kogg/contracts';
import { PluginDeployer, PluginType } from '@theia/plugin-ext/lib/common/plugin-protocol';
import type { InstalledKoggPackage, KoggMarketplaceService } from '../common/marketplace-service';

// diagnostic-coverage: marketplace.installed

@injectable()
export class KoggMarketplaceServiceImpl implements KoggMarketplaceService {
    constructor(
        @inject(MarketplaceClientToken) private readonly marketplace: MarketplaceClient,
        @inject(PluginDeployer) private readonly deployer: LivePluginDeployer
    ) {}

    search(query: string) { return this.marketplace.search(query); }

    async install(id: string, version = 'latest'): Promise<void> {
        const manifest = await this.marketplace.details(id, version);
        await this.marketplace.install(manifest);
        await this.deployer.deploy({ id: `kogg-installed:${manifest.id}@${manifest.version}`, type: PluginType.User });
    }

    async update(id: string): Promise<void> {
        await this.marketplace.update(id);
        const installed = (await this.listInstalled()).find(item => item.id === id);
        if (installed) await this.deployer.deploy({ id: `kogg-installed:${id}@${installed.version}`, type: PluginType.User });
    }

    async remove(id: string): Promise<void> {
        for (const installed of await this.listInstalled()) if (installed.id === id) await this.deployer.undeploy(`${id}@${installed.version}`);
        await this.marketplace.remove(id);
    }
    async rollback(id: string): Promise<void> {
        await this.marketplace.rollback(id);
        const installed = (await this.listInstalled()).find(item => item.id === id);
        if (installed) await this.deployer.deploy({ id: `kogg-installed:${id}@${installed.version}`, type: PluginType.User });
    }

    async refreshRevocations(): Promise<void> { await this.marketplace.refreshRevocations(); }

    async listInstalled(): Promise<readonly InstalledKoggPackage[]> {
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
