import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import JSZip from 'jszip';
import type { KoggPackageManifest } from '@kogg/contracts';
import { canonicalManifestPayload, sha256 } from '../common/marketplace-policy';

// diagnostic-coverage: marketplace.registry

const root = path.resolve(process.env.KOGG_ROOT ?? process.cwd());
const host = '127.0.0.1';
const port = Number(process.env.KOGG_REGISTRY_PORT ?? 3100);

async function createArtifact(version: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>');
    zip.file('extension.vsixmanifest', `<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Id="fixture" Version="${version}" Publisher="kogg" Language="en-US"/><DisplayName>Kogg Fixture</DisplayName><Description>Kogg signed fixture</Description></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" Version="[1.96.0,)"/></Installation><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`);
    zip.file('extension/package.json', JSON.stringify({
        name: 'fixture', publisher: 'kogg', displayName: 'Kogg Signed Fixture', version,
        engines: { vscode: '^1.96.0' }, main: './dist/extension.js',
        activationEvents: ['onCommand:kogg.fixture.ping'],
        contributes: { commands: [{ command: 'kogg.fixture.ping', title: 'Fixture: Verify Activation', category: 'Kogg' }] }
    }));
    zip.file('extension/dist/extension.js', `'use strict'; const vscode = require('vscode'); exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('kogg.fixture.ping', () => vscode.window.showInformationMessage('Kogg signed fixture ${version} is active.'))); exports.deactivate = () => undefined;\n`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function createManifest(artifact: Buffer, version: string): Promise<KoggPackageManifest> {
    const privatePem = await fs.readFile(path.join(root, '.kogg', 'dev', 'marketplace-private.pem'), 'utf8');
    const unsigned: KoggPackageManifest = {
        schemaVersion: 1, id: 'kogg.fixture', publisher: 'kogg', version, type: 'vscode-extension',
        engines: { kogg: '>=0.1.0', vscode: '^1.96.0' }, permissions: [], networkDomains: [], dependencies: {},
        license: 'MIT', signature: '', revoked: false,
        artifact: { url: `http://${host}:${port}/artifacts/kogg.fixture-${version}.vsix`, sha256: sha256(artifact), size: artifact.length },
        sbomUrl: `http://${host}:${port}/metadata/kogg.fixture.sbom.json`,
        provenanceUrl: `http://${host}:${port}/metadata/kogg.fixture.provenance.json`
    };
    return { ...unsigned, signature: sign(null, canonicalManifestPayload(unsigned), createPrivateKey(privatePem)).toString('base64url') };
}

void Promise.all(['0.1.0', '0.2.0'].map(async version => {
    const artifact = await createArtifact(version);
    return { artifact, manifest: await createManifest(artifact, version) };
})).then(fixtures => createServer((request, response) => {
    const initial = fixtures[0]!;
    const latest = fixtures[1]!;
    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (url.pathname === '/health') return response.end(JSON.stringify({ ok: true, registry: 'Kogg Marketplace development fixture' }));
    if (url.pathname === '/provider/v1/models') return response.end(JSON.stringify({ data: [{ id: 'kogg-fixture-model', name: 'Kogg Fixture Model' }] }));
    if (url.pathname === '/provider/v1/chat/completions' && request.method === 'POST') {
        return response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Kogg provider fixture responded successfully.' } }] }));
    }
    if (url.pathname === '/kogg/v1/search') return response.end(JSON.stringify([initial.manifest]));
    if (url.pathname === `/kogg/v1/packages/${latest.manifest.id}/latest`) return response.end(JSON.stringify(latest.manifest));
    const fixture = fixtures.find(item => url.pathname === `/kogg/v1/packages/${item.manifest.id}/${item.manifest.version}`);
    if (fixture) return response.end(JSON.stringify(fixture.manifest));
    if (url.pathname === '/kogg/v1/revocations') return response.end(JSON.stringify({ generatedAt: new Date().toISOString(), revoked: [] }));
    if (url.pathname === '/api/-/search' || url.pathname === '/api/-/query') return response.end(JSON.stringify({ extensions: [], totalSize: 0 }));
    if (url.pathname.startsWith('/metadata/')) return response.end(JSON.stringify({ fixture: true, package: 'kogg.fixture' }));
    const artifactFixture = fixtures.find(item => url.pathname === `/artifacts/kogg.fixture-${item.manifest.version}.vsix`);
    if (artifactFixture) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(artifactFixture.artifact);
    }
    response.statusCode = 404;
    return response.end(JSON.stringify({ error: 'not found' }));
}).listen(port, host, () => console.info('[kogg:marketplace:dev-registry] server.listening', { host, port })))
    .catch(error => {
        console.error('[kogg:marketplace:dev-registry] server.start-failed', {
            errorType: error instanceof Error ? error.name : 'UnknownError'
        });
        process.exitCode = 1;
    });
