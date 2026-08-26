import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inject, injectable } from 'inversify';
import type { KoggPackageManifest, MarketplaceClient } from '@kogg/contracts';
import { resolveRegistryUrl, verifyPackageManifest } from '../common/marketplace-policy';

// diagnostic-coverage: marketplace.configuration, marketplace.registry, marketplace.installed

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9.-]*$/;
const NETWORK_TIMEOUT_MS = 30_000;

@injectable()
export class KoggMarketplaceClient implements MarketplaceClient {
    constructor(@inject('KoggMarketplacePublicKey') private readonly publicKey: string) {}

    async search(query: string): Promise<KoggPackageManifest[]> {
        console.debug('[kogg:marketplace:client] search.requested', { queryLength: query.length });
        const url = new URL('/kogg/v1/search', resolveRegistryUrl());
        url.searchParams.set('query', query);
        const response = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`Kogg Marketplace search failed (${response.status})`);
        }
        const manifests = await response.json() as KoggPackageManifest[];
        manifests.forEach(manifest => verifyPackageManifest(manifest, this.publicKey));
        console.info('[kogg:marketplace:client] search.completed', { resultCount: manifests.length });
        return manifests;
    }

    async details(id: string, version = 'latest'): Promise<KoggPackageManifest> {
        this.assertSafe(id, version);
        const url = new URL(`/kogg/v1/packages/${encodeURIComponent(id)}/${encodeURIComponent(version)}`, resolveRegistryUrl());
        const response = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`Kogg package lookup failed (${response.status})`);
        }
        const manifest = await response.json() as KoggPackageManifest;
        verifyPackageManifest(manifest, this.publicKey);
        console.debug('[kogg:marketplace:client] details.verified', { packageId: manifest.id });
        return manifest;
    }

    async install(manifest: KoggPackageManifest): Promise<void> {
        this.assertSafe(manifest.id, manifest.version);
        verifyPackageManifest(manifest, this.publicKey);
        const artifactUrl = new URL(manifest.artifact.url);
        if (artifactUrl.origin !== resolveRegistryUrl().origin) {
            throw new Error('Package artifact is outside the configured Kogg registry');
        }
        const response = await fetch(artifactUrl, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`Kogg package download failed (${response.status})`);
        }
        const artifact = Buffer.from(await response.arrayBuffer());
        verifyPackageManifest(manifest, this.publicKey, artifact);

        const root = this.pluginRoot();
        const destination = path.join(root, manifest.id, manifest.version);
        const temporary = `${destination}.partial-${process.pid}`;
        await fs.rm(temporary, { recursive: true, force: true });
        await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(temporary, 'package.vsix'), artifact, { mode: 0o600 });
        await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.rm(destination, { recursive: true, force: true });
        await fs.rename(temporary, destination);
        await fs.writeFile(path.join(root, manifest.id, 'current'), manifest.version, { mode: 0o600 });
        console.info('[kogg:marketplace:client] install.completed', { packageId: manifest.id, version: manifest.version });
    }

    async update(id: string): Promise<void> {
        await this.install(await this.details(id));
    }

    async remove(id: string): Promise<void> {
        this.assertSafe(id);
        await fs.rm(path.join(this.pluginRoot(), id), { recursive: true, force: true });
        console.info('[kogg:marketplace:client] remove.completed', { packageId: id });
    }

    async rollback(id: string): Promise<void> {
        this.assertSafe(id);
        const packageRoot = path.join(this.pluginRoot(), id);
        const entries = (await fs.readdir(packageRoot, { withFileTypes: true }))
            .filter(entry => entry.isDirectory() && !entry.name.includes('.partial-'))
            .map(entry => entry.name)
            .sort();
        if (entries.length < 2) {
            throw new Error(`No previous Kogg package is retained for ${id}`);
        }
        await fs.writeFile(path.join(packageRoot, 'current'), entries.at(-2)!, { mode: 0o600 });
        console.info('[kogg:marketplace:client] rollback.completed', { packageId: id });
    }

    async refreshRevocations(): Promise<void> {
        const response = await fetch(new URL('/kogg/v1/revocations', resolveRegistryUrl()), { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`Revocation refresh failed (${response.status})`);
        }
        const stateRoot = path.join(this.stateRoot(), 'marketplace');
        await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(stateRoot, 'revocations.json'), await response.text(), { mode: 0o600 });
        console.info('[kogg:marketplace:client] revocations.refreshed');
    }

    private assertSafe(...segments: string[]): void {
        if (segments.some(segment => !SAFE_SEGMENT.test(segment))) {
            throw new Error('Unsafe Kogg package path');
        }
    }

    private stateRoot(): string {
        return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state'));
    }

    private pluginRoot(): string {
        return path.join(this.stateRoot(), 'plugins');
    }
}
