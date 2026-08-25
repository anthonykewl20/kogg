import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import * as tar from 'tar';

const VERSION = '1.108.2';
const ARCHIVE_SHA256 = '05a20cf3e671c8d328b04d9ce72b25688b0e762e4a3f5592f31a21ee38280367';
const URL = `https://github.com/eclipse-theia/vscode-builtin-extensions/releases/download/${VERSION}/vscode-builtin-extensions-${VERSION}.tar.gz`;
const BUILTINS = [
  'vscode.git-base.vsix',
  'vscode.git.vsix',
  'ms-vscode.js-debug.vsix',
  'ms-vscode.js-debug-companion.vsix'
];

const root = process.cwd().endsWith(path.join('apps', 'browser')) || process.cwd().endsWith(path.join('apps', 'electron'))
  ? path.resolve(process.cwd(), '../..')
  : process.cwd();
const destination = path.join(root, 'plugins');
const marker = path.join(destination, `.kogg-builtins-${VERSION}.json`);

try {
  const state = JSON.parse(await readFile(marker, 'utf8'));
  if (state.sha256 === ARCHIVE_SHA256 && BUILTINS.every(name => state.extensions.includes(name))) {
    process.stdout.write(`Kogg system extensions ${VERSION} already provisioned.\n`);
    process.exit(0);
  }
} catch {
  // A missing or invalid marker triggers a clean, verified provision.
}

const work = path.join(tmpdir(), `kogg-builtins-${process.pid}`);
const archive = path.join(work, 'builtins.tar.gz');
const extracted = path.join(work, 'archive');
await rm(work, { recursive: true, force: true });
await mkdir(extracted, { recursive: true });

const response = await fetch(URL, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Cannot download Kogg system extensions (${response.status})`);
await writeFile(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
const digest = await sha256File(archive);
if (digest !== ARCHIVE_SHA256) throw new Error(`System extension archive digest mismatch: ${digest}`);

await tar.x({ file: archive, cwd: extracted, strict: true }, BUILTINS);
const staging = `${destination}.partial-${process.pid}`;
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

for (const name of BUILTINS) {
  const zip = await JSZip.loadAsync(await readFile(path.join(extracted, name)));
  const manifestEntry = zip.file('extension/package.json');
  if (!manifestEntry) throw new Error(`${name} has no extension manifest`);
  const manifest = JSON.parse(await manifestEntry.async('string'));
  const id = `${manifest.publisher}.${manifest.name}`;
  const extensionRoot = path.join(staging, id);
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (!entryName.startsWith('extension/') || entry.dir) continue;
    const relative = entryName.slice('extension/'.length);
    const target = path.join(extensionRoot, relative);
    if (!target.startsWith(`${extensionRoot}${path.sep}`)) throw new Error(`Unsafe VSIX entry: ${entryName}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await entry.async('nodebuffer'));
  }
}

await writeFile(path.join(staging, `.kogg-builtins-${VERSION}.json`), JSON.stringify({
  source: URL,
  sha256: ARCHIVE_SHA256,
  extensions: BUILTINS
}, null, 2));
await rm(destination, { recursive: true, force: true });
await rename(staging, destination);
await rm(work, { recursive: true, force: true });
process.stdout.write(`Provisioned ${BUILTINS.length} checksum-verified Kogg system extensions.\n`);

async function sha256File(file) {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
