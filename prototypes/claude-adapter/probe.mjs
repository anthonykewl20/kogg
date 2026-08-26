// diagnostic-exempt: Disposable issue #96 real artifact/legal-gate probe retained off production branches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

assert(process.debugPort > 0, 'probe must run with --inspect=0');
assert.equal(process.env.KOGG_CLAUDE_COMMERCIAL_APPROVAL_RECORD, undefined, 'this negative control must not receive an approval record');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-claude-adapter-probe-'));
process.env.KOGG_STATE_DIR = path.join(temporary, 'state');
const { OperationRegistry } = await import('../../packages/kogg-operations/lib/node/operation-registry.js');
const registry = new OperationRegistry(3_000); const trace = [];
const integrity = 'FtR0HoHHNqeqJWjZN8qLUAzZVFUI9ztXYNPPwv98Ecmv9qq2QTauI8IzkY26CC0mleWAqb9RQEW2C0OtiUliug==';
const expectedSha512 = Buffer.from(integrity, 'base64').toString('hex');
const cacheRoot = process.env.npm_config_cache ?? path.join(os.homedir(), '.npm');
const artifact = path.join(cacheRoot, '_cacache', 'content-v2', 'sha512', expectedSha512.slice(0, 2), expectedSha512.slice(2, 4), expectedSha512.slice(4));
const expectedEntries = ['package/LICENSE.md', 'package/README.md', 'package/agentSdkTypes.d.ts', 'package/bridge.d.ts', 'package/bridge.mjs', 'package/browser-sdk.d.ts', 'package/browser-sdk.js', 'package/extractFromBunfs.d.ts', 'package/extractFromBunfs.js', 'package/manifest.json', 'package/manifest.zst.json', 'package/package.json', 'package/sdk-tools.d.ts', 'package/sdk.d.ts', 'package/sdk.mjs'];

try {
  await registry.onStart();
  emit('artifact.verify.started', { artifactClass: 'npm-cache', expectedVersion: '0.3.246' });
  const metadata = await lstat(artifact); assert(metadata.isFile()); assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(await digest(artifact, 'sha512'), expectedSha512); assert.equal(await digest(artifact, 'sha1'), '0009206e79ee0ae25f68ebb526584031cb5db048');

  const check = await registry.startOperation({ kind: 'check', correlations: { attemptId: randomUUID() } }); check.start();
  let child; const processLease = check.registerProcess({ kind: 'check', owner: 'kogg-supervisor', cancel: async () => { if (child?.exitCode === null) child.kill('SIGKILL'); } });
  processLease.spawning(); child = spawn('/usr/bin/tar', ['-tzf', artifact], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] });
  processLease.started(child.pid); check.active(); emit('artifact.inspect.started', { operationId: check.id, processId: processLease.id });
  const entries = await boundedOutput(child, 64 * 1024); processLease.exited(child.exitCode === 0 ? 'zero' : child.signalCode ? 'signal' : 'nonzero');
  emit('artifact.inspect.exit', { operationId: check.id, processId: processLease.id, exitClass: child.exitCode === 0 ? 'zero' : child.signalCode ? 'signal' : 'nonzero' });
  assert.equal(child.exitCode, 0); assert.deepEqual(entries.trim().split('\n').sort(), expectedEntries);
  processLease.cleanup(); await check.cleanup(); check.complete('OPERATIONS_OK'); emit('artifact.verify.completed', { fileCount: expectedEntries.length, integrity: 'matched' });

  const attempt = await registry.startOperation({ kind: 'agent-dispatch', correlations: { attemptId: randomUUID() } });
  emit('legal.verify.started', { approvalClass: 'repository-controlled' });
  attempt.refuse('OPERATIONS_REFUSED'); emit('legal.verify.failed', { safeCode: 'CLAUDE_LEGAL_APPROVAL_REQUIRED', retry: false });
  emit('adapter.refused', { safeCode: 'CLAUDE_LEGAL_APPROVAL_REQUIRED', sdkImported: false, credentialMinted: false, processSpawned: false, fallback: false });

  const diagnostics = registry.diagnostics(); assert.equal(diagnostics.activeCount, 0); assert.equal(diagnostics.residualCount, 0); assert.equal(diagnostics.cleanupFailureCount, 0);
  const joined = trace.join('\n');
  for (const event of ['artifact.verify.started', 'artifact.inspect.started', 'artifact.inspect.exit', 'artifact.verify.completed', 'legal.verify.started', 'legal.verify.failed', 'adapter.refused']) assert.match(joined, new RegExp(event.replaceAll('.', '\\.')));
  assert.doesNotMatch(joined, /\/Users|credentialValue|authorization|cookie|rawBody|promptHandle|sourceText/iu);
  process.stdout.write('Kogg Claude adapter artifact boundary passed with legal approval refusal.\n');
} finally { await registry.onStop().catch(() => undefined); await rm(temporary, { recursive: true, force: true }); }

function digest(file, algorithm) { return new Promise((resolve, reject) => { const hash = createHash(algorithm); createReadStream(file).on('data', chunk => hash.update(chunk)).once('error', reject).once('end', () => resolve(hash.digest('hex'))); }); }
function boundedOutput(child, limit) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; child.stdout.on('data', chunk => { size += chunk.length; if (size > limit) { child.kill('SIGKILL'); reject(new Error('ARTIFACT_LIST_OVERFLOW')); return; } chunks.push(chunk); }); child.once('error', reject); child.once('close', () => resolve(Buffer.concat(chunks).toString('utf8'))); }); }
function emit(event, fields) { const line = `[kogg:claude:prototype] ${event} ${JSON.stringify(fields)}`; trace.push(line); console.info(line); }
