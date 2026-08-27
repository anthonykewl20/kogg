import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalKernelJson, KOGG_RANEX_COMMIT, KOGG_RANEX_PROTOCOL_VERSION, type FrozenSuiteV1, type KernelJson, type ProducerBindingV1, type RepositoryStateV1, type TaskExecutionBindingV1 } from '@kogg/contracts';
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
    assert.deepEqual(capabilities.operations.map(operation => operation.operation), ['kernel.handshake', 'kernel.health', 'task.bind', 'producer.dispatch', 'suite.freeze']);
    const verification = await bridge.verifyJournal();
    assert.equal(verification.valid, false);
    assert.equal(verification.reason, 'missing');
    const unavailable = await bridge.execute('task.bind', {});
    assert.equal(unavailable.status, 'refused');
    assert.equal(unavailable.safeCode, 'KERNEL_AUTHORITY_INVALID');
    assert.equal(unavailable.projection, null);
    assert.equal(unavailable.journal, null);
    const unauthorizedProducer = await bridge.execute('producer.dispatch', {});
    assert.equal(unauthorizedProducer.status, 'refused');
    assert.equal(unauthorizedProducer.safeCode, 'KERNEL_AUTHORITY_INVALID');
    assert.equal((await bridge.execute('suite.freeze', {})).safeCode, 'KERNEL_AUTHORITY_INVALID');
    const committed = await bridge.bindTask(fixtureBinding());
    assert.equal(committed.status, 'succeeded');
    assert.equal(committed.safeCode, 'KERNEL_OK');
    assert.equal(committed.journal?.sequence, '1');
    const replay = await bridge.bindTask(fixtureBinding());
    assert.deepEqual(replay, { ...committed, requestId: replay.requestId, operationId: replay.operationId });
    const producer = fixtureProducer(committed.projection!.taskBindingDigest);
    const producerCommitted = await bridge.dispatchProducer(producer);
    assert.equal(producerCommitted.status, 'succeeded');
    assert.equal(producerCommitted.journal?.sequence, '2');
    assert.equal(producerCommitted.projection?.attemptId, producer.attemptId);
    const producerReplay = await bridge.dispatchProducer(producer);
    assert.deepEqual(producerReplay, { ...producerCommitted, requestId: producerReplay.requestId, operationId: producerReplay.operationId });
    const authorityMismatch = await bridge.dispatchProducer({ ...producer, attemptId: '88888888-8888-4888-8888-888888888888', authorityDigest: `sha256:${'f'.repeat(64)}` });
    assert.equal(authorityMismatch.status, 'refused');
    assert.equal(authorityMismatch.safeCode, 'KERNEL_AUTHORITY_INVALID');
    const suite = fixtureSuite(committed.projection!.taskBindingDigest);
    const frozen = await bridge.freezeSuite(suite);
    assert.equal(frozen.status, 'succeeded');
    assert.equal(frozen.journal?.sequence, '3');
    const frozenReplay = await bridge.freezeSuite(suite);
    assert.deepEqual(frozenReplay, { ...frozen, requestId: frozenReplay.requestId, operationId: frozenReplay.operationId });
    const manifestMismatch = await bridge.freezeSuite({ ...suite, suiteId: '99999999-9999-4999-8999-999999999999', manifestDigest: `sha256:${'0'.repeat(64)}` });
    assert.equal(manifestMismatch.status, 'refused');
    assert.equal(manifestMismatch.safeCode, 'KERNEL_SUITE_MISMATCH');
    assert.equal((await bridge.verifyJournal()).valid, true);
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

function fixtureBinding(): TaskExecutionBindingV1 {
  const repository = fixtureRepository();
  return {
    taskId: '11111111-1111-4111-8111-111111111111', taskRevision: 3, specificationDigest: `sha256:${'1'.repeat(64)}`,
    approvalId: '22222222-2222-4222-8222-222222222222', approvalDigest: `sha256:${'2'.repeat(64)}`,
    authorityDigest: `sha256:${'3'.repeat(64)}`, projectId: '33333333-3333-4333-8333-333333333333',
    repositoryId: '44444444-4444-4444-8444-444444444444', repositoryIdentityDigest: `sha256:${'4'.repeat(64)}`,
    protectedSource: repository, worktreeId: '55555555-5555-4555-8555-555555555555',
    worktreeIdentityDigest: repository.worktreeIdentity, baseState: repository,
    executionProfileDigest: `sha256:${'5'.repeat(64)}`, expiresAt: '2099-08-27T07:30:00.000Z'
  };
}

function fixtureProducer(taskBindingDigest: `sha256:${string}`): ProducerBindingV1 {
  return {
    producerId: '66666666-6666-4666-8666-666666666666', producerRole: 'implementation', adapterId: 'kogg.fixture',
    adapterArtifactDigest: `sha256:${'b'.repeat(64)}`, provider: 'kogg.fixture', model: 'fixture.echo',
    attemptId: '77777777-7777-4777-8777-777777777777', taskBindingDigest,
    authorityDigest: `sha256:${'3'.repeat(64)}`, executionProfileDigest: `sha256:${'5'.repeat(64)}`
  };
}

function fixtureSuite(taskBindingDigest: `sha256:${string}`): FrozenSuiteV1 {
  const checks = [{
    checkId: 'unit', kind: 'unit' as const, executableArtifactDigest: `sha256:${'a'.repeat(64)}` as const,
    argvTemplateDigest: `sha256:${'b'.repeat(64)}` as const, environmentProfileDigest: `sha256:${'c'.repeat(64)}` as const,
    timeoutMs: 30_000, outputPolicyDigest: `sha256:${'d'.repeat(64)}` as const, requiredProducerSeparation: true
  }];
  const gateCatalogDigest = `sha256:${'e'.repeat(64)}` as const;
  const verifierAuthorityDigest = `sha256:${'f'.repeat(64)}` as const;
  const manifestDigest = domainDigest('suite', { checks, gateCatalogDigest, subjectPolicy: 'exact-commit', taskBindingDigest, verifierAuthorityDigest });
  return { suiteId: '88888888-8888-4888-8888-888888888888', suiteRevision: 1, manifestDigest, taskBindingDigest, subjectPolicy: 'exact-commit', checks, gateCatalogDigest, verifierAuthorityDigest };
}

function domainDigest(domain: string, value: KernelJson): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(Buffer.concat([Buffer.from(`kogg:${domain}:v1\n`, 'utf8'), Buffer.from(canonicalKernelJson(value), 'utf8')])).digest('hex')}`;
}

function fixtureRepository(): RepositoryStateV1 {
  return {
    objectFormat: 'sha1', commitObjectId: '1'.repeat(40), treeObjectId: '2'.repeat(40),
    gitCommonDirectoryIdentity: `sha256:${'6'.repeat(64)}`, worktreeIdentity: `sha256:${'7'.repeat(64)}`,
    indexDigest: `sha256:${'8'.repeat(64)}`, trackedContentDigest: `sha256:${'9'.repeat(64)}`,
    untrackedPolicyDigest: `sha256:${'a'.repeat(64)}`, isClean: true
  };
}
