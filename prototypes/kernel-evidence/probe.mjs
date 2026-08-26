// diagnostic-exempt: Disposable issue #105 real Ranex compatibility probe retained off production branches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

assert(process.debugPort > 0, 'probe must run with --inspect=0');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-kernel-evidence-probe-'));
const root = process.cwd(); process.env.KOGG_STATE_DIR = path.join(temporary, 'state');
const { OperationRegistry } = await import('../../packages/kogg-operations/lib/node/operation-registry.js');
const registry = new OperationRegistry(3_000); const trace = [];
const provenance = JSON.parse(await readFile(path.join(root, 'vendor/ranex/PROVENANCE.json'), 'utf8'));
const advertised = ['gate.evaluate', 'journal.verify', 'run', 'suite.freeze', 'deps.fetch', 'deps.approve', 'keygen', 'task.dispatch', 'task.judge', 'task.merge', 'task.delegate', 'task.fanout'];
const required = ['kernel.handshake', 'kernel.health', 'task.bind', 'producer.dispatch', 'suite.freeze', 'suite.execute', 'evidence.admit', 'gate.evaluate', 'verdict.read', 'operation.reconcile', 'operation.cancel'];

try {
  await registry.onStart();
  const attemptId = randomUUID(); const operation = await registry.startOperation({ kind: 'ranex-request', correlations: { attemptId } }); operation.start();
  let child; const processLease = operation.registerProcess({ kind: 'ranex-kernel', owner: 'ranex', cancel: async () => { if (child?.exitCode === null) child.kill('SIGKILL'); } });
  processLease.spawning(); child = spawn(path.join(root, '.venv/bin/python'), ['-u', path.join(root, 'packages/kogg-kernel/python/kogg_ranex_adapter.py')], {
    cwd: temporary,
    env: { PATH: '/usr/bin:/bin', PYTHONPATH: path.join(root, 'vendor/ranex/src'), KOGG_RANEX_JOURNAL: path.join(temporary, 'journal.sqlite3'), KOGG_RANEX_PROVENANCE: path.join(root, 'vendor/ranex/PROVENANCE.json'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  processLease.started(child.pid); emit('process.started', { attemptId, operationId: operation.id, processId: processLease.id });
  const peer = jsonPeer(child); peer.send({ id: 'probe-1', method: 'handshake', params: { protocol: 'kogg-ranex-stdio', protocolVersion: 1, ranexCommit: provenance.commit } });
  const handshake = await peer.next(message => message.id === 'probe-1', 5_000); assert.equal(handshake.result?.ranexCommit, provenance.commit); assert.equal(handshake.result?.protocolVersion, 1);
  assert.deepEqual(handshake.result?.commands, advertised); processLease.ready(); operation.active(); emit('protocol.v1.ready', { attemptId, advertisedCount: advertised.length, confinement: handshake.result?.confinement });

  const missing = required.filter(name => !handshake.result.commands.includes(name)); assert(missing.length >= 8);
  emit('capability.v2.refused', { attemptId, safeCode: 'KERNEL_CAPABILITY_UNAVAILABLE', requiredCount: required.length, missingCount: missing.length, fallback: false });
  const advertisedButUnavailable = advertised.filter(method => method !== 'journal.verify');
  for (const [index, method] of advertisedButUnavailable.entries()) {
    peer.send({ id: `advertised-${index}`, method, params: {} });
    const response = await peer.next(message => message.id === `advertised-${index}`, 5_000); assert.equal(response.error?.code, 'ValueError');
  }
  emit('advertised.commands.refused', { attemptId, refusedCount: advertisedButUnavailable.length, safeCode: 'KERNEL_CAPABILITY_UNAVAILABLE' });

  peer.send({ id: 'v2-task-bind', method: 'task.bind', params: {} });
  const taskBind = await peer.next(message => message.id === 'v2-task-bind', 5_000); assert.equal(taskBind.error?.code, 'ValueError');
  emit('evidence.operation.refused', { attemptId, operation: 'task.bind', safeCode: 'KERNEL_CAPABILITY_UNAVAILABLE', journalMutation: false });
  peer.send({ id: 'journal', method: 'journal.verify', params: {} });
  const journal = await peer.next(message => message.id === 'journal', 5_000); assert.deepEqual(journal.result, { valid: false, reason: 'missing' });

  peer.send({ id: 'shutdown', method: 'shutdown', params: {} }); await peer.next(message => message.id === 'shutdown', 5_000); await waitForExit(child, 5_000);
  assert.equal(child.exitCode, 0); processLease.exited('zero'); emit('process.exit', { attemptId, exitClass: 'zero' });
  processLease.cleanup(); await operation.cleanup(); operation.fail('OWNER_UNAVAILABLE', 'Error'); emit('cleanup.completed', { attemptId, processCount: 0 });
  emit('qualification.refused', { attemptId, safeCode: 'KERNEL_CAPABILITY_UNAVAILABLE', protocol: 'v2', fallback: false });

  const diagnostics = registry.diagnostics(); assert.equal(diagnostics.activeCount, 0); assert.equal(diagnostics.residualCount, 0); assert.equal(diagnostics.cleanupFailureCount, 0);
  const joined = trace.join('\n');
  for (const event of ['process.started', 'protocol.v1.ready', 'capability.v2.refused', 'advertised.commands.refused', 'evidence.operation.refused', 'process.exit', 'cleanup.completed', 'qualification.refused']) assert.match(joined, new RegExp(event.replaceAll('.', '\\.')));
  assert.doesNotMatch(joined, /\/Users|prompt|source|diff|credential|authorization|rawBody|commandArgument|environmentValue/iu);
  process.stdout.write('Kogg Ranex evidence boundary passed with v2 capability refusal.\n');
} finally { await registry.onStop().catch(() => undefined); await rm(temporary, { recursive: true, force: true }); }

function jsonPeer(child) {
  const messages = []; const waiters = []; let invalid = false; let exited = false;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { messages.push(JSON.parse(line)); } catch { invalid = true; } wake(); });
  child.stderr.resume(); child.once('exit', () => { exited = true; wake(); });
  function wake() { for (const resolve of waiters.splice(0)) resolve(); }
  return { send: message => child.stdin.write(`${JSON.stringify(message)}\n`), next: async (predicate, timeout) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (invalid) throw new Error('KERNEL_PROTOCOL_INVALID'); const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0]; if (exited) throw new Error('KERNEL_PROCESS_EXITED'); await new Promise(resolve => { const timer = setTimeout(resolve, 25); waiters.push(() => { clearTimeout(timer); resolve(); }); }); } throw new Error('KERNEL_PROTOCOL_TIMEOUT'); } };
}
async function waitForExit(child, timeout) { const deadline = Date.now() + timeout; while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25)); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
function emit(event, fields) { const line = `[kogg:kernel:prototype] ${event} ${JSON.stringify(fields)}`; trace.push(line); console.info(line); }
