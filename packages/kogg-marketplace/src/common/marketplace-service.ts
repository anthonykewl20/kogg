import type { KoggPackageManifest } from '@kogg/contracts';

export const KoggMarketplaceServicePath = '/services/kogg-marketplace';
export const KoggMarketplaceService = Symbol('KoggMarketplaceService');

export interface InstalledKoggPackage {
    readonly id: string;
    readonly version: string;
}

export interface KoggMarketplaceService {
    search(query: string): Promise<readonly KoggPackageManifest[]>;
    install(id: string, version?: string): Promise<void>;
    update(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    rollback(id: string): Promise<void>;
    refreshRevocations(): Promise<void>;
    listInstalled(): Promise<readonly InstalledKoggPackage[]>;
}
