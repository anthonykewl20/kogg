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
// clang is the reference toolchain; cc/gcc are accepted so hosts and CI
// images without clang still build the pinned helper.
const compilers = [process.env.KOGG_EXECUTION_HELPER_CC, 'clang', 'cc', 'gcc'].filter(Boolean);
let compiled;
for (const compiler of compilers) {
  compiled = spawnSync(compiler, flags, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (compiled.status === 0) break;
  if (compiled.error?.code === 'ENOENT') {
    process.stdout.write(`Kogg execution helper compiler unavailable: ${compiler} not found.\n`);
    compiled = undefined;
    continue;
  }
  break;
}
if (!compiled || compiled.status !== 0) {
  await rm(outputRoot, { recursive: true, force: true });
  process.stderr.write('Kogg execution helper compilation failed.\n');
  if (compiled?.stdout?.trim()) process.stderr.write(compiled.stdout);
  if (compiled?.stderr?.trim()) process.stderr.write(compiled.stderr);
  if (compiled?.error) process.stderr.write(`${compiled.error.message}\n`);
  process.exit(compiled?.status ?? 1);
}
await chmod(binary, 0o500);
const artifact = await readFile(binary);
const sourceDigest = createHash('sha256').update(await readFile(source)).digest('hex');
const artifactDigest = createHash('sha256').update(artifact).digest('hex');
await writeFile(manifest, `${JSON.stringify({ schemaVersion: 1, platform: 'linux', architecture: 'x64', sourceDigest: `sha256:${sourceDigest}`, artifactDigest: `sha256:${artifactDigest}` })}\n`, { mode: 0o400 });
process.stdout.write(`Built pinned Kogg execution helper (${artifact.length} bytes).\n`);
