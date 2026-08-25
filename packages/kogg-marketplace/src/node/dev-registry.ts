import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import JSZip from 'jszip';
import type { KoggPackageManifest } from '@kogg/contracts';
import { canonicalManifestPayload, sha256 } from '../common/marketplace-policy';

const root = path.resolve(process.env.KOGG_ROOT ?? process.cwd());
const host = '127.0.0.1';
const port = Number(process.env.KOGG_REGISTRY_PORT ?? 3100);

async function createArtifact(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>');
    zip.file('extension.vsixmanifest', '<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Id="fixture" Version="0.1.0" Publisher="kogg" Language="en-US"/><DisplayName>Kogg Fixture</DisplayName><Description>Kogg signed fixture</Description></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" Version="[1.96.0,)"/></Installation><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>');
    zip.file('extension/package.json', JSON.stringify({ name: 'fixture', publisher: 'kogg', version: '0.1.0', engines: { vscode: '^1.96.0' }, main: './dist/extension.js', activationEvents: [] }));
    zip.file('extension/dist/extension.js', "'use strict'; exports.activate = () => undefined; exports.deactivate = () => undefined;\n");
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function createManifest(artifact: Buffer): Promise<KoggPackageManifest> {
    const privatePem = await fs.readFile(path.join(root, '.kogg', 'dev', 'marketplace-private.pem'), 'utf8');
    const unsigned: KoggPackageManifest = {
        schemaVersion: 1, id: 'kogg.fixture', publisher: 'kogg', version: '0.1.0', type: 'vscode-extension',
        engines: { kogg: '>=0.1.0', vscode: '^1.96.0' }, permissions: [], networkDomains: [], dependencies: {},
        license: 'MIT', signature: '', revoked: false,
        artifact: { url: `http://${host}:${port}/artifacts/kogg.fixture-0.1.0.vsix`, sha256: sha256(artifact), size: artifact.length },
        sbomUrl: `http://${host}:${port}/metadata/kogg.fixture.sbom.json`,
        provenanceUrl: `http://${host}:${port}/metadata/kogg.fixture.provenance.json`
    };
    return { ...unsigned, signature: sign(null, canonicalManifestPayload(unsigned), createPrivateKey(privatePem)).toString('base64url') };
}

void createArtifact().then(async artifact => ({ artifact, manifest: await createManifest(artifact) })).then(({ artifact, manifest }) => createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (url.pathname === '/health') return response.end(JSON.stringify({ ok: true, registry: 'Kogg Marketplace development fixture' }));
    if (url.pathname === '/kogg/v1/search') return response.end(JSON.stringify([manifest]));
    if (url.pathname === `/kogg/v1/packages/${manifest.id}/${manifest.version}` || url.pathname === `/kogg/v1/packages/${manifest.id}/latest`) return response.end(JSON.stringify(manifest));
    if (url.pathname === '/kogg/v1/revocations') return response.end(JSON.stringify({ generatedAt: new Date().toISOString(), revoked: [] }));
    if (url.pathname === '/api/-/search' || url.pathname === '/api/-/query') return response.end(JSON.stringify({ extensions: [], totalSize: 0 }));
    if (url.pathname.startsWith('/metadata/')) return response.end(JSON.stringify({ fixture: true, package: `${manifest.id}@${manifest.version}` }));
    if (url.pathname === '/artifacts/kogg.fixture-0.1.0.vsix') {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(artifact);
    }
    response.statusCode = 404;
    return response.end(JSON.stringify({ error: 'not found' }));
}).listen(port, host, () => process.stdout.write(`Kogg development registry listening on http://${host}:${port}\n`)));
