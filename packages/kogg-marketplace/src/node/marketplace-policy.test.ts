import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import type { KoggPackageManifest } from '@kogg/contracts';
import { canonicalManifestPayload, resolveRegistryUrl, sha256, verifyPackageManifest } from '../common/marketplace-policy';
import { KoggSignedPluginResolver } from './signed-plugin-resolver';

test('accepts only intact Kogg-signed artifacts', () => {
    const keys = generateKeyPairSync('ed25519');
    const artifact = Buffer.from('fixture');
    const unsigned: KoggPackageManifest = {
        schemaVersion: 1, id: 'kogg.fixture', publisher: 'kogg', version: '1.0.0', type: 'vscode-extension',
        engines: { kogg: '>=0.1.0' }, permissions: [], networkDomains: [], dependencies: {}, license: 'MIT',
        artifact: { url: 'https://registry.kogg.example/fixture.vsix', sha256: sha256(artifact), size: artifact.length },
        signature: '', revoked: false, sbomUrl: 'https://registry.kogg.example/sbom',
        provenanceUrl: 'https://registry.kogg.example/provenance'
    };
    const manifest: KoggPackageManifest = {
        ...unsigned,
        signature: sign(null, canonicalManifestPayload(unsigned), keys.privateKey).toString('base64url')
    };
    const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    assert.doesNotThrow(() => verifyPackageManifest(manifest, publicPem, artifact));
    assert.throws(() => verifyPackageManifest(manifest, publicPem, Buffer.from('tampered')), /digest.*mismatch/);
    assert.throws(() => verifyPackageManifest({ ...manifest, revoked: true }, publicPem, artifact), /revoked/);
    assert.throws(() => verifyPackageManifest({ ...manifest, engines: { kogg: '>=99.0.0' } }, publicPem, artifact), /incompatible/);
});

test('has no public registry fallback', () => {
    assert.throws(() => resolveRegistryUrl({}), /mandatory/);
    assert.throws(() => resolveRegistryUrl({ KOGG_REGISTRY_URL: 'https://open-vsx.org' }), /prohibited/);
    assert.equal(resolveRegistryUrl({ KOGG_REGISTRY_URL: 'http://127.0.0.1:3100' }).port, '3100');
});

test('backend resolver rejects arbitrary URLs and local VSIX files', async () => {
    const marketplace = {} as never;
    const resolver = new KoggSignedPluginResolver(marketplace);
    for (const origin of ['https://example.com/extension.vsix', 'file:///tmp/extension.vsix', 'github:publisher/repository']) {
        await assert.rejects(() => resolver.resolve({ getOriginId: () => origin } as never), /outside its signed marketplace/);
    }
});
