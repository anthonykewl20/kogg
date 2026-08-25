import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { inject, injectable } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import {
    PluginDeployerParticipant,
    PluginDeployerResolver,
    type PluginDeployerResolverContext,
    type PluginDeployerStartContext,
    type PluginDeployOptions
} from '@theia/plugin-ext/lib/common/plugin-protocol';
import { VSCodeExtensionUri } from '@theia/plugin-ext-vscode/lib/common/plugin-vscode-uri';
import { MarketplaceClientToken, type MarketplaceClient } from '@kogg/contracts';

// diagnostic-coverage: marketplace.configuration, marketplace.installed

@injectable()
export class KoggSignedPluginResolver implements PluginDeployerResolver {
    constructor(@inject(MarketplaceClientToken) private readonly marketplace: MarketplaceClient) {}

    accept(origin: string): boolean {
        return Boolean(VSCodeExtensionUri.toId(new URI(origin)));
    }

    async resolve(context: PluginDeployerResolverContext, options?: PluginDeployOptions): Promise<void> {
        const origin = context.getOriginId();
        const requested = VSCodeExtensionUri.toId(new URI(origin));
        if (!requested) {
            throw new Error(`Kogg rejected an extension source outside its signed marketplace: ${sourceKind(origin)}`);
        }
        const manifest = await this.marketplace.details(requested.id, options?.version ?? requested.version);
        if (manifest.type !== 'vscode-extension') {
            throw new Error(`${manifest.id} is not a VS Code-compatible Kogg package`);
        }
        await this.marketplace.install(manifest);
        const artifact = path.join(pluginRoot(), manifest.id, manifest.version, 'package.vsix');
        context.addPlugin(`${manifest.id}@${manifest.version}`, artifact);
        console.info('[kogg:marketplace:resolver] plugin.resolved', { packageId: manifest.id, version: manifest.version });
    }
}

@injectable()
export class KoggPluginStartupPolicy implements PluginDeployerParticipant {
    async onWillStart(context: PluginDeployerStartContext): Promise<void> {
        context.userEntries.splice(0, context.userEntries.length, 'kogg-installed:all');
        const allowed = [`local-dir:${systemPluginRoot()}`];
        context.systemEntries.splice(0, context.systemEntries.length, ...allowed);
        console.info('[kogg:marketplace:startup-policy] sources.restricted');
    }
}

@injectable()
export class KoggInstalledPluginResolver implements PluginDeployerResolver {
    accept(origin: string): boolean { return origin.startsWith('kogg-installed:'); }

    async resolve(context: PluginDeployerResolverContext): Promise<void> {
        const requested = context.getOriginId().slice('kogg-installed:'.length);
        if (requested === 'all') {
            let entries;
            try { entries = await fs.readdir(pluginRoot(), { withFileTypes: true }); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
            }
            for (const entry of entries.filter(item => item.isDirectory())) {
                const version = await fs.readFile(path.join(pluginRoot(), entry.name, 'current'), 'utf8').catch(() => '');
                if (version.trim()) this.add(context, entry.name, version.trim());
            }
            console.info('[kogg:marketplace:installed-resolver] catalog.resolved', { entryCount: entries.length });
            return;
        }
        const separator = requested.lastIndexOf('@');
        if (separator < 1) throw new Error('Invalid installed Kogg package reference');
        this.add(context, requested.slice(0, separator), requested.slice(separator + 1));
    }

    private add(context: PluginDeployerResolverContext, id: string, version: string): void {
        if (!/^[a-z0-9][a-z0-9.-]*$/u.test(id) || !/^[a-z0-9][a-z0-9.-]*$/u.test(version)) {
            throw new Error('Unsafe installed Kogg package reference');
        }
        context.addPlugin(`${id}@${version}`, path.join(pluginRoot(), id, version, 'package.vsix'));
    }
}

@injectable()
export class KoggSystemPluginResolver implements PluginDeployerResolver {
    accept(origin: string): boolean { return trustedSystemOrigin(origin); }

    async resolve(context: PluginDeployerResolverContext): Promise<void> {
        const root = systemPluginRoot();
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) context.addPlugin(entry.name, path.join(root, entry.name));
        }
        console.info('[kogg:marketplace:system-resolver] catalog.resolved', { entryCount: entries.length });
    }
}

function pluginRoot(): string {
    const state = path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state'));
    return path.join(state, 'plugins');
}

function systemPluginRoot(): string {
    const packaged = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const packagedPlugins = packaged && path.join(packaged, 'kogg-system-plugins');
    return path.resolve(packagedPlugins && existsSync(packagedPlugins)
        ? packagedPlugins
        : path.join(process.env.KOGG_ROOT ?? process.cwd(), 'plugins'));
}

function trustedSystemOrigin(origin: string): boolean {
    if (!origin.startsWith('local-dir:')) return false;
    const raw = origin.slice('local-dir:'.length).replace(/^\/\//u, '');
    const requested = path.resolve(process.cwd(), decodeURIComponent(raw));
    return requested === systemPluginRoot();
}

function sourceKind(origin: string): string {
    const separator = origin.indexOf(':');
    return separator > 0 ? origin.slice(0, separator) : 'local-file';
}
