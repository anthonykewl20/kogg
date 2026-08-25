import { createHash, createPublicKey, verify } from 'node:crypto';
import type { KoggPackageManifest } from '@kogg/contracts';
import semver from 'semver';

const PUBLIC_REGISTRY_HOSTS = new Set(['open-vsx.org', 'marketplace.visualstudio.com']);

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key !== 'signature')
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonicalize(item)]));
    }
    return value;
}

export function canonicalManifestPayload(manifest: KoggPackageManifest): Buffer {
    return Buffer.from(JSON.stringify(canonicalize(manifest)), 'utf8');
}

export function sha256(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

export function resolveRegistryUrl(environment = process.env): URL {
    const configured = environment.KOGG_REGISTRY_URL;
    if (!configured) {
        throw new Error('KOGG_REGISTRY_URL is mandatory; Kogg has no public registry fallback');
    }
    const url = new URL(configured);
    if (PUBLIC_REGISTRY_HOSTS.has(url.hostname.toLowerCase())) {
        throw new Error(`Public extension registry ${url.hostname} is prohibited`);
    }
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
        throw new Error('KOGG_REGISTRY_URL must use HTTPS outside loopback development');
    }
    return url;
}

export function verifyPackageManifest(
    manifest: KoggPackageManifest,
    publicKeyPem: string,
    artifact?: Buffer
): void {
    if (!/^[a-z0-9][a-z0-9.-]+\.[a-z0-9][a-z0-9.-]+$/.test(manifest.id)) {
        throw new Error('Invalid Kogg package identity');
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.artifact.sha256)) {
        throw new Error('Invalid package SHA-256');
    }
    if (!Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 1) {
        throw new Error('Invalid package artifact size');
    }
    if (!semver.satisfies('0.1.0', manifest.engines.kogg) || (manifest.engines.vscode && !semver.satisfies('1.108.2', manifest.engines.vscode))) {
        throw new Error(`Kogg package ${manifest.id}@${manifest.version} is incompatible`);
    }
    if (manifest.revoked) {
        throw new Error(`Kogg package ${manifest.id}@${manifest.version} is revoked`);
    }
    if (artifact && (sha256(artifact) !== manifest.artifact.sha256 || artifact.length !== manifest.artifact.size)) {
        throw new Error('Package digest or size mismatch');
    }
    const signature = Buffer.from(manifest.signature, 'base64url');
    const valid = verify(null, canonicalManifestPayload(manifest), createPublicKey(publicKeyPem), signature);
    if (!valid) {
        throw new Error('Invalid Kogg marketplace signature');
    }
}
