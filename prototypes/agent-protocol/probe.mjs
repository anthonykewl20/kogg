// diagnostic-exempt: Disposable issue #81 real-process probe retained off production branches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

if (process.argv[2] === '--fake-peer') {
  await fakePeer(process.argv[3]);
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-agent-protocol-probe-'));
process.env.KOGG_STATE_DIR = path.join(temporary, 'state');
const { OperationRegistry } = await import('../../packages/kogg-operations/lib/node/operation-registry.js');
const registry = new OperationRegistry(2_000);
const safeTrace = [];
const canary = 'AGENT-PROTOCOL-PROMPT-CANARY';

try {
  await registry.onStart();
  const codexBin = process.env.KOGG_CODEX_BIN ?? '/Applications/ChatGPT.app/Contents/Resources/codex';
  const real = await startHost('codex-real', codexBin, ['app-server', '--stdio'], 5_000);
  real.send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'kogg-probe', title: 'Kogg Agent Protocol Probe', version: '0.0.0' }, capabilities: {} } });
  const initialized = await real.next(message => message.id === 1, 5_000);
  assert.match(initialized.result?.userAgent ?? '', /kogg-probe/u);
  assert.equal(initialized.result?.platformFamily, 'unix');
  assert.equal(typeof initialized.result?.codexHome, 'string');
  real.ready();
  emit('adapter.handshake.completed', { adapter: 'codex-real', protocol: 'codex-app-server' });
  await real.cancelAndClean('real-handshake-complete');

  const normalized = await startHost('fake-normalized', process.execPath, [fileURLToPath(import.meta.url), '--fake-peer', 'normalized'], 2_000);
  normalized.send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'kogg-probe', version: '0.0.0' } } });
  await normalized.next(message => message.id === 1, 2_000); normalized.ready();
  normalized.send({ method: 'probe/start', id: 2, params: { inputHandle: 'opaque-authorized-input' } });
  const activity = await normalized.next(message => message.method === 'probe/activity', 2_000);
  normalized.activity();
  assert.deepEqual(activity.params, { kind: 'progress', sequence: 1 });
  const usage = await normalized.next(message => message.method === 'probe/usage', 2_000);
  assert.deepEqual(usage.params, { inputTokens: 7, outputTokens: 3, totalTokens: 10, status: 'observed' });
  const completion = await normalized.next(message => message.id === 2, 2_000);
  assert.equal(completion.result?.status, 'completed-observed');
  assert.equal(normalized.isAlive(), true, 'provider completion must not imply host cleanup');
  emit('attempt.completed.observed', { adapter: 'fake-normalized', usageStatus: 'observed', processCount: 1 });
  normalized.send({ method: 'probe/cancel', id: 3, params: {} });
  const cancelled = await normalized.next(message => message.id === 3, 2_000);
  assert.equal(cancelled.result?.terminalCount, 0);
  await normalized.cancelAndClean('cooperative-cancel');

  await expectFailure('malformed', 'ADAPTER_PROTOCOL_INVALID');
  await expectFailure('timeout', 'ADAPTER_HANDSHAKE_TIMEOUT');
  await expectFailure('crash', 'ADAPTER_HOST_EXITED');

  const snapshot = await registry.snapshot();
  assert.equal(snapshot.active.length, 0);
  assert.equal(registry.diagnostics().residualCount, 0);
  assert.equal(registry.diagnostics().cleanupFailureCount, 0);
  const joined = safeTrace.join('\n');
  for (const event of ['process.registered', 'process.started', 'adapter.handshake.completed', 'attempt.completed.observed', 'process.exit', 'process.cleanup.completed', 'adapter.failed']) assert.match(joined, new RegExp(event.replaceAll('.', '\\.')));
  assert.doesNotMatch(joined, new RegExp(canary));
  assert.doesNotMatch(joined, /prompt|opaque-authorized-input|command|environment|credential/iu);
  process.stdout.write('Kogg agent protocol real-boundary prototype passed.\n');
} finally {
  await registry.onStop().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}

async function expectFailure(mode, safeCode) {
  const host = await startHost(`fake-${mode}`, process.execPath, [fileURLToPath(import.meta.url), '--fake-peer', mode], 400);
  host.send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'kogg-probe', version: '0.0.0' } } });
  if (mode === 'malformed') await assert.rejects(host.next(() => true, 400), /protocol invalid/u);
  if (mode === 'timeout') await assert.rejects(host.next(() => true, 400), /timeout/u);
  if (mode === 'crash') await assert.rejects(host.next(() => true, 400), /host exited/u);
  emit('adapter.failed', { adapter: `fake-${mode}`, safeCode });
  await host.failAndClean();
}

async function startHost(adapter, executable, args, timeoutMs) {
  const attemptId = randomUUID();
  const lease = await registry.startOperation({ kind: 'agent-dispatch', correlations: { attemptId } });
  lease.start();
  let child;
  const processLease = lease.registerProcess({ kind: 'provider-cli', owner: 'kogg-supervisor', cancel: async () => { if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } });
  emit('process.registered', { adapter, attemptId, operationId: lease.id, processId: processLease.id });
  processLease.spawning();
  child = spawn(executable, args, { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CODEX_HOME: process.env.CODEX_HOME ?? path.join(process.env.HOME ?? temporary, '.codex') }, stdio: ['pipe', 'pipe', 'pipe'] });
  processLease.started(child.pid); lease.active(); emit('process.started', { adapter, attemptId, operationId: lease.id, processId: processLease.id });
  const messages = []; const waiters = []; let protocolError; let exited;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try { messages.push(JSON.parse(line)); } catch { protocolError = new Error('adapter protocol invalid'); }
    flush();
  });
  child.once('exit', (code, signal) => { exited = { code, signal }; flush(); });
  child.stderr.resume();
  function flush() { for (const wake of waiters.splice(0)) wake(); }
  async function next(predicate, waitMs = timeoutMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (protocolError) throw protocolError;
      const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0];
      if (exited) throw new Error('adapter host exited');
      await new Promise(resolve => { const timer = setTimeout(resolve, 20); waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
    throw new Error('adapter handshake timeout');
  }
  const finish = async terminal => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const result = child.exitCode !== null || child.signalCode !== null
      ? { code: child.exitCode, signal: child.signalCode }
      : await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    processLease.exited(result.code === 0 ? 'zero' : result.signal ? 'signal' : 'nonzero'); emit('process.exit', { adapter, exitClass: result.code === 0 ? 'zero' : result.signal ? 'signal' : 'nonzero' });
    processLease.cleanup(); await lease.cleanup();
    if (terminal === 'failed') lease.fail('PROCESS_EXIT_NONZERO', 'Error'); else await lease.cancel();
    emit('process.cleanup.completed', { adapter, processCount: 0 });
  };
  return {
    send: message => child.stdin.write(`${JSON.stringify(message)}\n`),
    next, ready: () => processLease.ready(), activity: () => { processLease.activity(); lease.activity(); },
    isAlive: () => child.exitCode === null && child.signalCode === null,
    cancelAndClean: async reason => { emit('attempt.cancel.requested', { adapter, reason }); await finish('cancelled'); },
    failAndClean: async () => finish('failed')
  };
}

function emit(event, fields) {
  const line = `[kogg:agents:supervision] ${event} ${JSON.stringify(fields)}`;
  safeTrace.push(line); console.info(line);
}

async function fakePeer(mode) {
  const input = readline.createInterface({ input: process.stdin });
  for await (const line of input) {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      if (mode === 'timeout') continue;
      if (mode === 'crash') process.exit(9);
      if (mode === 'malformed') { process.stdout.write('{invalid-json\n'); continue; }
      process.stdout.write(`${JSON.stringify({ id: message.id, result: { protocol: 'kogg-fake-v1', capabilities: ['activity', 'usage', 'cancel'] } })}\n`);
    } else if (message.method === 'probe/start') {
      process.stdout.write(`${JSON.stringify({ method: 'probe/activity', params: { kind: 'progress', sequence: 1 } })}\n`);
      process.stdout.write(`${JSON.stringify({ method: 'probe/usage', params: { inputTokens: 7, outputTokens: 3, totalTokens: 10, status: 'observed' } })}\n`);
      process.stdout.write(`${JSON.stringify({ id: message.id, result: { status: 'completed-observed', terminalCount: 1 } })}\n`);
    } else if (message.method === 'probe/cancel') {
      process.stdout.write(`${JSON.stringify({ id: message.id, result: { status: 'cancelled', terminalCount: 0 } })}\n`);
    }
  }
}
