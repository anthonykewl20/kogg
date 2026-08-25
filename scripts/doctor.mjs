import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const failures = [];
const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
};
const command = (name, args = []) => spawnSync(name, args, { encoding: 'utf8' });
const version = (name, args = ['--version']) => {
  const result = command(name, args);
  return { ok: result.status === 0, text: (result.stdout || result.stderr).trim() };
};

record('architecture', process.arch === 'arm64' || process.arch === 'x64', `${process.platform}/${process.arch}`);
record('node', process.version === 'v22.23.2', process.version);
const yarn = version('yarn');
record('yarn', yarn.ok && yarn.text === '1.22.22', yarn.text || 'missing');
const uv = version('uv');
record('uv', uv.ok && uv.text.includes('0.12.5'), uv.text || 'missing');
const python = version(process.platform === 'win32'
  ? path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
  : path.join(process.cwd(), '.venv', 'bin', 'python'));
record('python venv', python.ok && python.text.includes('3.12.14'), python.text || 'missing');
for (const [tool, args] of [['git', ['--version']], ['sqlite3', ['--version']], ['clang', ['--version']], ['cmake', ['--version']], ['pkg-config', ['--version']]]) {
  const result = version(tool, args);
  record(tool, result.ok, result.text.split('\n')[0] || 'missing');
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kogg-doctor-'));
try {
  const source = path.join(tempDir, 'smoke.c');
  const binary = path.join(tempDir, 'smoke');
  await writeFile(source, '#include <stdio.h>\nint main(void){puts("kogg-native-ok");return 0;}\n');
  const compile = command('clang', [source, '-o', binary]);
  const execute = compile.status === 0 ? command(binary) : { status: 1, stdout: '', stderr: compile.stderr };
  record('native compiler', execute.status === 0 && execute.stdout.trim() === 'kogg-native-ok', execute.stderr?.trim() || execute.stdout?.trim());
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

const checkPort = port => new Promise(resolve => {
  const server = net.createServer();
  server.once('error', error => resolve({ port, ok: false, detail: error.code }));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve({ port, ok: true, detail: 'available' })));
});
for (const result of await Promise.all([3000, 3100, 3200].map(checkPort))) {
  record(`port ${result.port}`, result.ok, result.detail);
}

const docker = command('docker', ['info', '--format', '{{.ServerVersion}}']);
record('docker (optional)', true, docker.status === 0 ? docker.stdout.trim() : 'unavailable; Electron development remains supported');

for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
if (failures.length) {
  console.error(`\n${failures.length} required development check(s) failed.`);
  process.exit(1);
}
