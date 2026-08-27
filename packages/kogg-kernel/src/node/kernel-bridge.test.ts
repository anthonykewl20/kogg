import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KOGG_RANEX_COMMIT, KOGG_RANEX_PROTOCOL_VERSION } from '@kogg/contracts';
import { OperationRegistry } from '@kogg/operations/lib/node/operation-registry';
import type { ILogger } from '@theia/core/lib/common/logger';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { KernelBridgeImpl } from './kernel-bridge';

test('handshakes with the pinned Ranex kernel and fails closed on missing journal', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-kernel-operation-test-'));
  process.env.KOGG_STATE_DIR = state;
  const operations = new OperationRegistry();
  const bridge = new KernelBridgeImpl(operations, new ProcessManager(logger()), logger());
  try {
    const capabilities = await bridge.start();
    assert.equal(capabilities.ranexCommit, KOGG_RANEX_COMMIT);
    assert.equal(capabilities.protocolVersion, KOGG_RANEX_PROTOCOL_VERSION);
    assert.deepEqual(capabilities.operations.map(operation => operation.operation), ['kernel.handshake', 'kernel.health']);
    const verification = await bridge.verifyJournal();
    assert.equal(verification.valid, false);
    assert.equal(verification.reason, 'missing');
    const unavailable = await bridge.execute('task.bind', {});
    assert.equal(unavailable.status, 'refused');
    assert.equal(unavailable.safeCode, 'KERNEL_CAPABILITY_UNAVAILABLE');
    assert.equal(unavailable.projection, null);
    assert.equal(unavailable.journal, null);
    await bridge.shutdown();
    assert.equal((await operations.snapshot()).active.length, 0);
  } finally {
    await bridge.shutdown();
    await operations.onStop();
    await rm(state, { recursive: true, force: true });
  }
});

function logger(): ILogger { return { debug() {}, info() {}, warn() {}, error() {} } as unknown as ILogger; }
