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

@injectable()
export class KoggSignedPluginResolver implements PluginDeployerResolver {
    constructor(@inject(MarketplaceClientToken) private readonly marketplace: MarketplaceClient) {}

    accept(): boolean {
        return true;
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
    }
}

@injectable()
export class KoggPluginStartupPolicy implements PluginDeployerParticipant {
    async onWillStart(context: PluginDeployerStartContext): Promise<void> {
        context.systemEntries.splice(0);
        context.userEntries.splice(0);
    }
}

function pluginRoot(): string {
    const state = path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state'));
    return path.join(state, 'plugins');
}

function sourceKind(origin: string): string {
    const separator = origin.indexOf(':');
    return separator > 0 ? origin.slice(0, separator) : 'local-file';
}
