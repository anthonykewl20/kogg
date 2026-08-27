import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
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

test('maps a structurally invalid operation to a closed protocol refusal', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'kogg-kernel-invalid-operation-test-'));
  const root = process.cwd();
  const python = process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  const child = spawn(python, ['-u', path.join(root, 'packages', 'kogg-kernel', 'python', 'kogg_ranex_adapter.py')], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      PYTHONPATH: path.join(root, 'vendor', 'ranex', 'src'),
      KOGG_RANEX_JOURNAL: path.join(state, 'journal.sqlite3'),
      KOGG_RANEX_PROVENANCE: path.join(root, 'vendor', 'ranex', 'PROVENANCE.json')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  try {
    const request = {
      protocol: 'kogg.ranex/v2', requestId: '11111111-1111-4111-8111-111111111111',
      operationId: '22222222-2222-4222-8222-222222222222', idempotencyKey: `sha256:${'0'.repeat(64)}`,
      operation: {}, operationVersion: 1, ranexCommit: KOGG_RANEX_COMMIT,
      schemaSetDigest: `sha256:b44b4f9fc8c16386e1c5b4f22dcdf6f910b951dce48799689e623f14ef5497f3`,
      bodyDigest: `sha256:${'0'.repeat(64)}`, body: {}
    };
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      let received = Buffer.alloc(0);
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        received = Buffer.concat([received, Buffer.from(chunk)]);
        if (received.length < 4) return;
        const length = received.readUInt32BE(0);
        if (received.length >= length + 4) resolve(JSON.parse(received.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>);
      });
    });
    child.stdin.end(frame);
    assert.equal((await response).safeCode, 'KERNEL_PROTOCOL_INVALID');
  } finally {
    child.kill();
    await rm(state, { recursive: true, force: true });
  }
});

function logger(): ILogger { return { debug() {}, info() {}, warn() {}, error() {} } as unknown as ILogger; }
