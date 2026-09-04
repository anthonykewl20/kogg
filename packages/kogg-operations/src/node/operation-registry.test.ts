import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationRegistry } from './operation-registry';
import { OperationsReadModel } from './operations-read-model';

test('persists a real registered process lifecycle with safe cleanup and diagnostics', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-test-'));
  process.env.KOGG_STATE_DIR = state;
  const registry = new OperationRegistry();
  const lines: string[] = [];
  const original = { info: console.info, warn: console.warn, error: console.error };
  console.info = (...args: unknown[]) => { lines.push(JSON.stringify(args)); };
  console.warn = (...args: unknown[]) => { lines.push(JSON.stringify(args)); };
  console.error = (...args: unknown[]) => { lines.push(JSON.stringify(args)); };
  try {
    await registry.onStart();
    const operation = await registry.startOperation({ kind: 'check' }); operation.start();
    let child: ReturnType<typeof spawn> | undefined;
    const processLease = operation.registerProcess({ kind: 'check', owner: 'kogg-supervisor', executionAuthority: fixtureExecutionAuthority(), cancel: async () => { child?.kill('SIGKILL'); } });
    child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 25)'], { detached: process.platform !== 'win32', stdio: 'ignore' });
    processLease.spawning(); assert.ok(child.pid); processLease.started(child.pid); processLease.ready(); operation.active();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject);
    });
    processLease.exited(exit.signal ? 'signal' : exit.code === 0 ? 'zero' : 'nonzero', `sha256:${'7'.repeat(64)}`); processLease.cleanup();
    await operation.cleanup(); operation.complete();
    const attestation = await registry.processExecutionAttestation(processLease.id);
    assert.equal(attestation?.operationId, operation.id); assert.equal(attestation?.processRegistrationId, processLease.id);
    assert.equal(attestation?.processKind, 'check'); assert.equal(attestation?.operationState, 'completed');
    assert.equal(attestation?.exitClass, 'zero'); assert.match(attestation?.cleanupProofDigest ?? '', /^sha256:[0-9a-f]{64}$/u);
    const snapshot = await registry.snapshot();
    assert.equal(snapshot.active.length, 0); assert.equal(snapshot.recent[0]?.state, 'completed'); assert.equal(snapshot.recent[0]?.cleanup, 'cleaned');
    assert.equal((await registry.recoveryResult(operation.id)).status, 'cleaned'); assert.equal((await registry.recoveryResult(randomUUID())).status, 'missing');
    assert.deepEqual(registry.diagnostics(), {
      integrity: true, foreignKeys: true, permissions: true, recoveryComplete: true, activeCount: 0,
      stalledCount: 0, residualCount: 0, cleanupFailureCount: 0, admission: 'enabled'
    });
    const trace = lines.join('\n');
    assert(trace.indexOf('process.registered') < trace.indexOf('"processState":"started"'));
    assert(trace.indexOf('"processState":"started"') < trace.lastIndexOf('cleanup.completed'));
    assert.equal(trace.includes(state), false); assert.equal(trace.includes('setTimeout'), false);
  } finally {
    console.info = original.info; console.warn = original.warn; console.error = original.error;
    await registry.onStop(); await rm(state, { recursive: true, force: true });
  }
});

test('records spawn failure and refuses conflicting terminal transitions', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-failure-test-'));
  process.env.KOGG_STATE_DIR = state;
  const registry = new OperationRegistry();
  try {
    const operation = await registry.startOperation({ kind: 'test' }); operation.start();
    const processLease = operation.registerProcess({ kind: 'test', owner: 'kogg-supervisor' });
    processLease.spawning(); processLease.failed('PROCESS_SPAWN_FAILED', 'Error'); processLease.cleanup();
    await operation.cleanup(); operation.fail('PROCESS_SPAWN_FAILED', 'Error');
    assert.throws(() => operation.complete(), /conflicting terminal/u);
    const snapshot = await registry.snapshot(); assert.equal(snapshot.recent[0]?.state, 'failed'); assert.equal(snapshot.recent[0]?.safeCode, 'PROCESS_SPAWN_FAILED');
  } finally { await registry.onStop(); await rm(state, { recursive: true, force: true }); }
});

test('publishes process activity through the closed owner payload contract', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-owner-activity-test-'));
  process.env.KOGG_STATE_DIR = state;
  const registry = new OperationRegistry(); const projection = new OperationsReadModel(path.join(state, 'projection.sqlite3'));
  try {
    await registry.onStart(); projection.start(); projection.registerOwner('operation'); registry.setOwnerSink(projection);
    const operation = await registry.startOperation({ kind: 'test' }); operation.start();
    const processLease = operation.registerProcess({ kind: 'test', owner: 'kogg-supervisor' });
    processLease.activity();
    assert.equal(projection.diagnostics().faultCount, 0);
    assert.equal(projection.diagnostics().ownerCount, 1);
  } finally { await registry.onStop(); projection.stop(); await rm(state, { recursive: true, force: true }); }
});

test('refuses a process execution attestation until both process and operation cleanup are terminal', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-attestation-test-'));
  process.env.KOGG_STATE_DIR = state;
  const registry = new OperationRegistry();
  try {
    const operation = await registry.startOperation({ kind: 'check' }); operation.start();
    const processLease = operation.registerProcess({ kind: 'check', owner: 'kogg-supervisor', executionAuthority: fixtureExecutionAuthority() });
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    processLease.spawning(); assert.ok(child.pid); processLease.started(child.pid); processLease.ready(); operation.active();
    assert.equal(await registry.processExecutionAttestation(processLease.id), undefined);
    await new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    processLease.exited('zero', `sha256:${'7'.repeat(64)}`); processLease.cleanup(); await operation.cleanup(); operation.complete();
    assert.equal((await registry.processExecutionAttestation(processLease.id))?.exitClass, 'zero');
  } finally { await registry.onStop(); await rm(state, { recursive: true, force: true }); }
});

function fixtureExecutionAuthority() {
  return {
    suiteDigest: `sha256:${'1'.repeat(64)}` as const, checkDefinitionDigest: `sha256:${'2'.repeat(64)}` as const,
    subjectStateDigest: `sha256:${'3'.repeat(64)}` as const, verifierId: '11111111-1111-4111-8111-111111111111',
    verifierArtifactDigest: `sha256:${'4'.repeat(64)}` as const, executionProfileDigest: `sha256:${'5'.repeat(64)}` as const
  };
}

test('reconciles a real matching child after an interrupted backend with an empty queue on qualified Linux', async () => {
  if (process.platform !== 'linux') return;
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-recovery-test-'));
  process.env.KOGG_STATE_DIR = state;
  const interrupted = new OperationRegistry();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const operation = await interrupted.startOperation({ kind: 'recovery' }); operation.start();
    const processLease = operation.registerProcess({ kind: 'governed-command', owner: 'kogg-supervisor' });
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
    const liveChild = child;
    processLease.spawning(); assert.ok(liveChild.pid); processLease.started(liveChild.pid); processLease.ready(); operation.active();
    (interrupted as unknown as { database?: { close(): void } }).database?.close();
    const recovered = new OperationRegistry();
    try {
      await recovered.onStart();
      const snapshot = await recovered.snapshot();
      assert.equal(snapshot.admission, 'enabled'); assert.equal(snapshot.active.length, 0);
      const recoveredOperation = snapshot.recent.find(item => item.id === operation.id);
      assert.equal(recoveredOperation?.state, 'recovered'); assert.equal(recoveredOperation?.cleanup, 'cleaned');
      assert.equal((await recovered.recoveryResult(operation.id)).status, 'cleaned');
      assert.equal(recovered.diagnostics().residualCount, 0);
    } finally { await recovered.onStop(); }
    await new Promise<void>(resolve => {
      if (liveChild.exitCode !== null || liveChild.signalCode !== null) resolve(); else liveChild.once('exit', () => resolve());
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(state, { recursive: true, force: true });
  }
});

test('fails closed without signalling a live process whose durable identity does not match', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-identity-test-'));
  process.env.KOGG_STATE_DIR = state;
  const interrupted = new OperationRegistry();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const operation = await interrupted.startOperation({ kind: 'recovery' }); operation.start();
    const processLease = operation.registerProcess({ kind: 'governed-command', owner: 'kogg-supervisor' });
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: process.platform !== 'win32', stdio: 'ignore' });
    const liveChild = child;
    processLease.spawning(); assert.ok(liveChild.pid); processLease.started(liveChild.pid); processLease.ready(); operation.active();
    const database = (interrupted as unknown as { database: { prepare(sql: string): { run(...values: unknown[]): unknown }; close(): void } }).database;
    if (process.platform === 'linux') database.prepare(`UPDATE processes SET identity_fingerprint='deliberate-mismatch'`).run();
    database.close();
    const recovered = new OperationRegistry();
    try {
      await recovered.onStart();
      assert.equal((await recovered.snapshot()).admission, 'blocked');
      assert.equal(recovered.diagnostics().residualCount, 1);
      assert.equal((await recovered.recoveryResult(operation.id)).status, 'unverified');
      assert.doesNotThrow(() => process.kill(liveChild.pid!, 0));
    } finally { await recovered.onStop(); }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const cleanupChild = child;
      try { if (process.platform !== 'win32') process.kill(-cleanupChild.pid!, 'SIGKILL'); else cleanupChild.kill('SIGKILL'); }
      catch { cleanupChild.kill('SIGKILL'); }
      await new Promise<void>(resolve => cleanupChild.once('exit', () => resolve()));
    }
    await rm(state, { recursive: true, force: true });
  }
});

test('idle timeout cancels a real child, records its exit, and proves cleanup', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-timeout-test-'));
  process.env.KOGG_STATE_DIR = state;
  const registry = new OperationRegistry();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const operation = await registry.startOperation({ kind: 'test', idleTimeoutMs: 100 });
    operation.start();
    let processLease: ReturnType<typeof operation.registerProcess>;
    processLease = operation.registerProcess({
      kind: 'test', owner: 'kogg-supervisor', cancel: async () => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGKILL');
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child!.once('exit', (code, signal) => resolve({ code, signal })));
        processLease.exited(exit.signal ? 'signal' : exit.code === 0 ? 'zero' : 'nonzero');
      }
    });
    processLease.spawning();
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: process.platform !== 'win32', stdio: 'ignore' });
    assert.ok(child.pid); processLease.started(child.pid); processLease.ready(); operation.active();
    // Windows CI can defer the child exit event while many test processes are
    // contending; retain a hard bound while waiting for the durable cleanup.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const candidate = (await registry.snapshot()).recent[0];
      if (candidate?.state === 'timed-out' && candidate.cleanup === 'cleaned') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const terminal = (await registry.snapshot()).recent[0];
    assert.equal(terminal?.state, 'timed-out'); assert.equal(terminal?.cleanup, 'cleaned');
    assert.equal(terminal?.safeCode, 'OPERATION_IDLE_TIMEOUT'); assert.equal(registry.diagnostics().residualCount, 0);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await registry.onStop(); await rm(state, { recursive: true, force: true });
  }
});

test('cleanup failure is durable and blocks admission', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-cleanup-test-'));
  process.env.KOGG_STATE_DIR = state;
  const registry = new OperationRegistry();
  try {
    const operation = await registry.startOperation({ kind: 'evidence' }); operation.start(); operation.active();
    await assert.rejects(operation.cleanup(async () => { throw new Error('deliberate cleanup failure'); }), /deliberate cleanup failure/u);
    operation.fail('CLEANUP_FAILED', 'Error');
    const snapshot = await registry.snapshot();
    assert.equal(snapshot.admission, 'blocked'); assert.equal(snapshot.recent[0]?.cleanup, 'failed');
    assert.equal(registry.diagnostics().cleanupFailureCount, 1);
    await registry.onStop();
    const restarted = new OperationRegistry();
    try {
      await restarted.onStart();
      assert.equal((await restarted.snapshot()).admission, 'blocked');
      assert.equal(restarted.diagnostics().cleanupFailureCount, 1);
    } finally { await restarted.onStop(); }
  } finally { await registry.onStop(); await rm(state, { recursive: true, force: true }); }
});

test('cancel request replay is idempotent and a mismatched replay is rejected', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-cancel-test-'));
  process.env.KOGG_STATE_DIR = state;
  const registry = new OperationRegistry();
  try {
    const operation = await registry.startOperation({ kind: 'debug' }); operation.start(); operation.active();
    const requestId = randomUUID();
    const first = await registry.cancel({ requestId, operationId: operation.id });
    assert.equal(first.recent[0]?.state, 'cancelled'); assert.equal(first.recent[0]?.cleanup, 'cleaned');
    assert.deepEqual(await registry.cancel({ requestId, operationId: operation.id }), first);
    await assert.rejects(registry.cancel({ requestId, operationId: randomUUID() }), /OPERATIONS_REQUEST_REPLAY_MISMATCH/u);
  } finally { await registry.onStop(); await rm(state, { recursive: true, force: true }); }
});

test('cleanup timeout is bounded, durable, and release-blocking', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-cleanup-timeout-test-'));
  process.env.KOGG_STATE_DIR = state;
  const registry = new OperationRegistry(100);
  try {
    const operation = await registry.startOperation({ kind: 'build' }); operation.start(); operation.active();
    await assert.rejects(operation.cleanup(() => new Promise<void>(() => undefined)), /cleanup exceeded its bound/iu);
    operation.fail('CLEANUP_TIMEOUT', 'CleanupTimeoutError');
    const snapshot = await registry.snapshot();
    assert.equal(snapshot.admission, 'blocked'); assert.equal(snapshot.recent[0]?.safeCode, 'CLEANUP_TIMEOUT');
    assert.equal(snapshot.recent[0]?.cleanup, 'failed');
  } finally { await registry.onStop(); await rm(state, { recursive: true, force: true }); }
});

test('production operation registry emits a TypeScript source map', async () => {
  const sourceMap = JSON.parse(await readFile(path.join(__dirname, 'operation-registry.js.map'), 'utf8')) as { sources?: string[] };
  assert(sourceMap.sources?.some(source => source.endsWith('/src/node/operation-registry.ts')));
});

test('reopens the owner stream under a new epoch after projection divergence', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-owner-epoch-'));
    process.env.KOGG_STATE_DIR = state;
    const registry = new OperationRegistry();
    const firstAccepted: Array<{ epoch: string; sequence: string }> = [];
    const firstSink = {
        registerOwner: () => undefined,
        ingest: (event: { sequence: string; epochId?: string }) => { firstAccepted.push({ epoch: event.epochId ?? '', sequence: event.sequence }); return 'accepted'; }
    };
    try {
        await registry.onStart();
        registry.setOwnerSink(firstSink as never);
        for (let i = 0; i < 5; i++) { const op = await registry.startOperation({ kind: 'check' }); op.start(); op.complete(); }
        assert.ok(firstAccepted.length >= 5);
        const oldEpoch = firstAccepted[0]!.epoch;
        const lastSequence = firstAccepted[firstAccepted.length - 1]!.sequence;

        // Simulate projection divergence: the projection store no longer
        // continues the owner's accepted cursor at the replay start.
        const secondAccepted: Array<{ epoch: string; sequence: string }> = [];
        let diverged = false;
        const secondSink = {
            registerOwner: () => undefined,
            ingest: (event: { sequence: string; epochId?: string }) => {
                if (!diverged && event.sequence === lastSequence) { diverged = true; throw new Error('OWNER_CURSOR_GAP'); }
                secondAccepted.push({ epoch: event.epochId ?? '', sequence: event.sequence });
                return 'accepted';
            }
        };
        registry.setOwnerSink(secondSink as never);

        // The owner re-opens under a fresh epoch: the retained history replays
        // contiguously from sequence 1 under exactly one new epoch.
        const newEpochEntries = secondAccepted.filter(entry => entry.epoch !== oldEpoch);
        const retainedSequences = new Set(firstAccepted.map(entry => entry.sequence));
        assert.ok(newEpochEntries.length >= retainedSequences.size, 'full retained history replayed under the new epoch');
        assert.equal(new Set(newEpochEntries.map(entry => entry.epoch)).size, 1);
        const newEpoch = newEpochEntries[0]!.epoch;
        assert.notEqual(newEpoch, oldEpoch);
        assert.equal(newEpochEntries[0]!.sequence, '1');
        assert.equal(newEpochEntries[newEpochEntries.length - 1]!.sequence, String(newEpochEntries.length));
    } finally {
        await registry.onStop();
        await rm(state, { recursive: true, force: true });
        delete process.env.KOGG_STATE_DIR;
    }
});