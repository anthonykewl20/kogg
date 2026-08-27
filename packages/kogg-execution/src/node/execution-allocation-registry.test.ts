import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExecutionBindingV1, ReserveExecutionAllocationV1 } from '../common/execution-protocol';
import { AllocationRegistryError, ExecutionAllocationRegistry } from './execution-allocation-registry';

// diagnostic-coverage: execution.worktree-registry, execution.capacity, execution.recovery
test('reserves one opaque allocation identity before effects and replays only an identical request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-registry-')); process.env.KOGG_STATE_DIR = root;
  const registry = new ExecutionAllocationRegistry(); await registry.onStart();
  const logs: string[] = []; const original = { info: console.info, warn: console.warn };
  console.info = (...values: unknown[]) => { logs.push(JSON.stringify(values)); }; console.warn = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  try {
    const request = allocationRequest(); const first = await registry.reserve(request); const replay = await registry.reserve(request);
    assert.deepEqual(replay, first); assert.match(first.worktreeId, /^[0-9a-f-]{36}$/u); assert.match(first.allocationName, /^r-[a-z2-7]{26}$/u);
    assert.match(first.allocationNonceDigest, /^sha256:[0-9a-f]{64}$/u); assert.match(first.bindingDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(first.state, 'admitted'); assert.equal(first.revision, '1'); assert.equal(first.cleanupState, 'required');
    await assert.rejects(() => registry.reserve({ ...request, quotaBytes: '2048' }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
    await assert.rejects(() => registry.reserve({ ...request, requestId: '10000000-0000-4000-8000-00000000000c' }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_RUN_EXISTS');
    const diagnostics = registry.diagnostics(); assert.equal(diagnostics.activeCount, 1); assert.equal(diagnostics.unverifiedCount, 1);
    assert.equal(diagnostics.integrity, true); assert.equal(diagnostics.foreignKeys, true); assert.equal(diagnostics.permissions, true);
    assert.equal(logs.join('\n').includes('private-target-canary'), false);
  } finally { console.info = original.info; console.warn = original.warn; registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('startup quarantines an ambiguous reserved allocation and blocks new admission without replaying effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-recovery-')); process.env.KOGG_STATE_DIR = root;
  const request = allocationRequest(); const first = new ExecutionAllocationRegistry(); await first.onStart();
  const reserved = await first.reserve(request); first.onStop();
  const recovered = new ExecutionAllocationRegistry(); await recovered.onStart();
  try {
    const diagnostics = recovered.diagnostics(); assert.equal(diagnostics.admission, 'blocked'); assert.equal(diagnostics.activeCount, 0);
    assert.equal(diagnostics.quarantinedCount, 1); assert.equal(diagnostics.cleanupFailureCount, 1); assert.equal(diagnostics.recoveryRequiredCount, 0);
    const replay = await recovered.reserve(request); assert.equal(replay.worktreeId, reserved.worktreeId); assert.equal(replay.state, 'quarantined');
    assert.equal(replay.safeCode, 'RECOVERY_OWNER_UNAVAILABLE'); assert.equal(replay.revision, '4');
    await assert.rejects(() => recovered.reserve({ ...request, requestId: '10000000-0000-4000-8000-00000000000d', binding: { ...request.binding, runId: '10000000-0000-4000-8000-00000000000e' } }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_ADMISSION_BLOCKED');
  } finally { recovered.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('refuses unknown allocation fields before creating durable state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-invalid-')); process.env.KOGG_STATE_DIR = root;
  const registry = new ExecutionAllocationRegistry(); await registry.onStart();
  try {
    await assert.rejects(() => registry.reserve({ ...allocationRequest(), privatePath: '/private/canary' } as never),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_PROTOCOL_INVALID');
    assert.equal(registry.diagnostics().reservationCount, 0);
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

function allocationRequest(): ReserveExecutionAllocationV1 {
  return { requestId: '10000000-0000-4000-8000-00000000000b', binding: binding(), quotaBytes: '1073741824', quotaInodes: '100000' };
}
function binding(): ExecutionBindingV1 {
  const digest = `sha256:${'a'.repeat(64)}`;
  return {
    schemaVersion: 1, projectId: '10000000-0000-4000-8000-000000000001', projectRevision: '1',
    repositoryId: '10000000-0000-4000-8000-000000000002', repositoryBindingRevision: '1',
    taskId: '10000000-0000-4000-8000-000000000003', taskRevisionId: '10000000-0000-4000-8000-000000000004',
    taskRevisionDigest: digest, approvalDigest: digest, runId: '10000000-0000-4000-8000-000000000005',
    attemptId: '10000000-0000-4000-8000-000000000006', workflowPlanDigest: digest, baseCommit: 'b'.repeat(40),
    baseTree: 'c'.repeat(40), gitObjectFormat: 'sha1', targetId: 'private-target-canary',
    qualificationId: '10000000-0000-4000-8000-000000000007', qualificationDigest: digest,
    profileId: 'kogg-writable-agent-v1', profileDigest: digest
  };
}
