import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const nativeRoot = path.join(root, 'packages', 'kogg-execution', 'native');
const outputRoot = path.join(nativeRoot, 'bin');
const targetRoot = path.join(outputRoot, 'linux-x64');
const binary = path.join(targetRoot, 'kogg-execution-helper');
const manifest = path.join(targetRoot, 'manifest.json');

await rm(outputRoot, { recursive: true, force: true });
if (process.platform !== 'linux' || process.arch !== 'x64') {
  process.stdout.write('Kogg execution helper unavailable: qualified target requires linux-x64.\n');
  process.exit(0);
}

await mkdir(targetRoot, { recursive: true, mode: 0o700 });
const source = path.join(nativeRoot, 'kogg-execution-helper.c');
const flags = [
  '-std=c17', '-O2', '-g1', '-fno-omit-frame-pointer', '-D_FORTIFY_SOURCE=3', '-fstack-protector-strong', '-fPIE', '-pie',
  '-Wl,-z,relro,-z,now', '-Wall', '-Wextra', '-Werror', source, '-o', binary
];
const compiled = spawnSync('clang', flags, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (compiled.status !== 0) {
  await rm(outputRoot, { recursive: true, force: true });
  process.stderr.write('Kogg execution helper compilation failed.\n');
  process.exit(compiled.status ?? 1);
}
await chmod(binary, 0o500);
const artifact = await readFile(binary);
const sourceDigest = createHash('sha256').update(await readFile(source)).digest('hex');
const artifactDigest = createHash('sha256').update(artifact).digest('hex');
await writeFile(manifest, `${JSON.stringify({ schemaVersion: 1, platform: 'linux', architecture: 'x64', sourceDigest: `sha256:${sourceDigest}`, artifactDigest: `sha256:${artifactDigest}` })}\n`, { mode: 0o400 });
process.stdout.write(`Built pinned Kogg execution helper (${artifact.length} bytes).\n`);
