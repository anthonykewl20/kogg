// diagnostic-exempt: Disposable issue #91 real Codex probe retained off production branches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

assert(process.debugPort > 0, 'probe must run with --inspect=0');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-codex-adapter-probe-'));
const workspace = path.join(temporary, 'workspace'); const codexHome = path.join(temporary, 'codex-home');
process.env.KOGG_STATE_DIR = path.join(temporary, 'state');
const { OperationRegistry } = await import('../../packages/kogg-operations/lib/node/operation-registry.js');
const registry = new OperationRegistry(3_000); const trace = [];
const codexBin = process.env.KOGG_CODEX_BIN ?? '/Applications/ChatGPT.app/Contents/Resources/codex';
const canary = `CODEX-ADAPTER-CONTENT-CANARY-${randomUUID()}`;

try {
  await mkdir(workspace); await mkdir(codexHome); await writeFile(path.join(workspace, 'seed.txt'), 'unchanged\n');
  await registry.onStart();
  const version = (await command(codexBin, ['--version'], 5_000)).stdout.trim();
  const binaryDigest = await digestFile(codexBin);
  emit('release.inspected', { versionClass: /^codex-cli /u.test(version) ? 'codex-cli' : 'unknown', binaryDigest: binaryDigest.slice(0, 12), qualification: 'unqualified-desktop-control' });

  const attemptId = randomUUID(); const lease = await registry.startOperation({ kind: 'agent-dispatch', correlations: { attemptId } }); lease.start();
  let child; const processLease = lease.registerProcess({ kind: 'provider-cli', owner: 'kogg-supervisor', cancel: async () => { if (child?.exitCode === null) child.kill('SIGKILL'); } });
  emit('process.registered', { attemptId, operationId: lease.id, processId: processLease.id }); processLease.spawning();
  child = spawn(codexBin, ['app-server', '--stdio', '--strict-config', '-c', 'analytics.enabled=false'], { cwd: workspace, env: { PATH: process.env.PATH ?? '', HOME: temporary, CODEX_HOME: codexHome, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'] });
  processLease.started(child.pid); lease.active(); emit('process.started', { attemptId, operationId: lease.id, processId: processLease.id });
  const peer = jsonPeer(child);
  peer.send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'kogg-codex-probe', title: 'Kogg Codex Adapter Probe', version: '0.0.0' }, capabilities: {} } });
  const initialized = await peer.next(message => message.id === 1, 5_000); assert.equal(initialized.result?.platformFamily, 'unix'); processLease.ready();
  peer.send({ method: 'initialized', params: {} }); emit('protocol.initialize.completed', { attemptId, protocol: 'v2' });

  peer.send({ method: 'thread/start', id: 9, params: { cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', multiAgentMode: 'explicitRequestOnly' } });
  const rejected = await peer.next(message => message.id === 9, 5_000); assert.equal(rejected.error?.code, -32600);
  emit('protocol.failure.observed', { attemptId, safeCode: 'CODEX_CAPABILITY_REFUSED', retry: false });

  peer.send({ method: 'thread/start', id: 2, params: { cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', experimentalRawEvents: false } });
  const threadReply = await peer.next(message => message.id === 2, 10_000); const threadId = threadReply.result?.thread?.id;
  assert.equal(typeof threadId, 'string', `thread/start failed (${String(threadReply.error?.code ?? 'invalid-result')})`); assert.equal(threadReply.result?.thread?.ephemeral, true);
  emit('thread.started', { attemptId, ephemeral: true, approvalPolicy: 'never', sandboxClass: 'read-only' });

  peer.send({ method: 'turn/start', id: 3, params: { threadId, input: [{ type: 'text', text: canary }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } } });
  const turnReply = await peer.next(message => message.id === 3, 15_000); const turnId = turnReply.result?.turn?.id; assert.equal(typeof turnId, 'string');
  await peer.next(message => message.method === 'turn/started' && message.params?.turn?.id === turnId, 15_000).catch(() => undefined);
  emit('turn.started', { attemptId, activityCount: 1 }); processLease.activity(); lease.activity();
  peer.send({ method: 'turn/interrupt', id: 4, params: { threadId, turnId } }); emit('cancel.requested', { attemptId, reason: 'prototype-interrupt' });
  await peer.next(message => message.id === 4, 15_000);
  const terminal = await peer.next(message => message.method === 'turn/completed' && message.params?.turn?.id === turnId, 30_000);
  const terminalClass = terminal.params?.turn?.status ?? 'unknown'; assert(['interrupted', 'failed', 'completed'].includes(terminalClass));
  emit('turn.terminal.observed', { attemptId, terminalClass, processCount: 1 }); assert.equal(child.exitCode, null);

  child.stdin.end(); await waitForExit(child, 5_000); if (child.exitCode === null) child.kill('SIGKILL'); await waitForExit(child, 5_000);
  processLease.exited(child.exitCode === 0 ? 'zero' : child.signalCode ? 'signal' : 'nonzero'); emit('process.exit', { attemptId, exitClass: child.exitCode === 0 ? 'zero' : child.signalCode ? 'signal' : 'nonzero' });
  processLease.cleanup(); await lease.cleanup(); await lease.cancel(); emit('cleanup.completed', { attemptId, processCount: 0 });

  assert.deepEqual(await readdir(workspace), ['seed.txt']);
  assert.equal(registry.diagnostics().residualCount, 0); assert.equal(registry.diagnostics().cleanupFailureCount, 0);
  const joined = trace.join('\n');
  for (const event of ['release.inspected', 'process.registered', 'process.started', 'protocol.initialize.completed', 'protocol.failure.observed', 'thread.started', 'turn.started', 'cancel.requested', 'turn.terminal.observed', 'process.exit', 'cleanup.completed']) assert.match(joined, new RegExp(event.replaceAll('.', '\\.')));
  assert.doesNotMatch(joined, new RegExp(canary)); assert.doesNotMatch(joined, /prompt|seed\.txt|\/Users|credential|environment|command|argument/iu);
  emit('qualification.refused', { safeCode: 'CODEX_RELEASE_UNQUALIFIED', missingCount: 3, fallback: false });
  process.stdout.write('Kogg Codex adapter real-boundary prototype passed with qualification refusal.\n');
} finally { await registry.onStop().catch(() => undefined); await rm(temporary, { recursive: true, force: true }); }

function jsonPeer(child) {
  const messages = []; const waiters = []; let invalid; let exited = false;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { messages.push(JSON.parse(line)); } catch { invalid = true; } wake(); });
  child.once('exit', () => { exited = true; wake(); }); child.stderr.resume();
  function wake() { for (const resolve of waiters.splice(0)) resolve(); }
  return { send: message => child.stdin.write(`${JSON.stringify(message)}\n`), next: async (predicate, timeout) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (invalid) throw new Error('CODEX_PROTOCOL_VIOLATION'); const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0]; if (exited) throw new Error('CODEX_APP_SERVER_EXITED'); await new Promise(resolve => { const timer = setTimeout(resolve, 25); waiters.push(() => { clearTimeout(timer); resolve(); }); }); } throw new Error('CODEX_PROTOCOL_TIMEOUT'); } };
}
function command(executable, args, timeout) { return new Promise((resolve, reject) => { const child = spawn(executable, args, { env: { PATH: process.env.PATH ?? '', HOME: temporary, CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'] }); const out = []; child.stdout.on('data', chunk => out.push(chunk)); child.stderr.resume(); const timer = setTimeout(() => child.kill('SIGKILL'), timeout); child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); if (code !== 0) reject(new Error('CODEX_RELEASE_INSPECTION_FAILED')); else resolve({ stdout: Buffer.concat(out).toString('utf8'), signal }); }); }); }
function digestFile(file) { return new Promise((resolve, reject) => { const hash = createHash('sha256'); createReadStream(file).on('data', chunk => hash.update(chunk)).once('error', reject).once('end', () => resolve(hash.digest('hex'))); }); }
async function waitForExit(child, timeout) { const deadline = Date.now() + timeout; while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25)); }
function emit(event, fields) { const line = `[kogg:codex:prototype] ${event} ${JSON.stringify(fields)}`; trace.push(line); console.info(line); }
