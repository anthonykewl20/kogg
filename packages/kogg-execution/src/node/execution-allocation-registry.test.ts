import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExecutionBindingV1, ReserveExecutionAllocationV1 } from '../common/execution-protocol';
import { CANDIDATE_MUTATION_POLICY_DIGEST } from './candidate-sealer';
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

test('persists only legal binding-and-revision-fenced state transitions with exact request replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-state-')); process.env.KOGG_STATE_DIR = root; const registry = new ExecutionAllocationRegistry(); await registry.onStart();
  try {
    const allocation = await registry.reserve(allocationRequest()); const request = { requestId: '10000000-0000-4000-8000-00000000000c', worktreeId: allocation.worktreeId, expectedRevision: '1', bindingDigest: allocation.bindingDigest, nextState: 'allocated' as const, safeCode: 'ALLOCATION_OK' as const };
    const advanced = await registry.advance(request); assert.equal(advanced.state, 'allocated'); assert.equal(advanced.revision, '2'); assert.deepEqual(await registry.advance(request), advanced);
    await assert.rejects(() => registry.advance({ ...request, requestId: '10000000-0000-4000-8000-00000000000d', expectedRevision: '2', nextState: 'sealed' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_STATE_INVALID');
    await assert.rejects(() => registry.advance({ ...request, requestId: '10000000-0000-4000-8000-00000000000e', expectedRevision: '1', nextState: 'seeding' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REVISION_CONFLICT');
    await assert.rejects(() => registry.advance({ ...request, requestId: '10000000-0000-4000-8000-00000000000f', expectedRevision: '2', bindingDigest: `sha256:${'b'.repeat(64)}`, nextState: 'seeding' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_BINDING_MISMATCH');
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('records one sealed candidate only after the legal stopping state and replays the exact request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-seal-')); process.env.KOGG_STATE_DIR = root; const registry = new ExecutionAllocationRegistry(); await registry.onStart();
  try {
    const allocation = await advanceToStopping(registry);
    const candidate = { schemaVersion: 1 as const, candidateId: '30000000-0000-4000-8000-000000000001', worktreeId: allocation.worktreeId, runId: allocationRequest().binding.runId, attemptId: allocationRequest().binding.attemptId, baseCommit: allocationRequest().binding.baseCommit, baseTree: allocationRequest().binding.baseTree, candidateCommit: 'd'.repeat(40), candidateTree: 'e'.repeat(40), objectClosureDigest: `sha256:${'f'.repeat(64)}`, mutationPolicyDigest: CANDIDATE_MUTATION_POLICY_DIGEST, sealedAt: new Date().toISOString(), retentionClass: 'pending-evidence' as const, retentionUntil: '9999-12-31T23:59:59.999Z', safeCode: 'SEAL_OK' as const };
    const request = { requestId: '30000000-0000-4000-8000-000000000002', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, candidate };
    assert.deepEqual(await registry.recordSeal(request), candidate); assert.deepEqual(await registry.recordSeal(request), candidate);
    const intentRequest = { requestId: '30000000-0000-4000-8000-000000000004', worktreeId: allocation.worktreeId, expectedRevision: String(Number(allocation.revision) + 1), bindingDigest: allocation.bindingDigest, candidateId: candidate.candidateId, expectedSourceIdentityDigest: `sha256:${'1'.repeat(64)}` };
    const intent = await registry.prepareCandidateImport(intentRequest); const intentReplay = await registry.prepareCandidateImport(intentRequest); assert.equal(intent.replay, false); assert.equal(intentReplay.replay, true); assert.equal(intentReplay.intentId, intent.intentId); assert.equal(intentReplay.fencingToken, intent.fencingToken); assert.match(intent.fencingToken, /^[0-9a-f]{64}$/u);
    assert.equal(registry.diagnostics().candidateCount, 1); assert.equal(registry.diagnostics().pendingImportIntentCount, 1);
    const imported = await registry.completeCandidateImport({ requestId: '30000000-0000-4000-8000-000000000005', intentId: intent.intentId, worktreeId: allocation.worktreeId, expectedRevision: intentRequest.expectedRevision, bindingDigest: allocation.bindingDigest, candidateId: candidate.candidateId, fencingToken: intent.fencingToken, candidateCommit: candidate.candidateCommit, candidateTree: candidate.candidateTree, quarantineRefDigest: `sha256:${'2'.repeat(64)}` });
    assert.equal(imported.safeCode, 'IMPORT_OK'); assert.equal(imported.quarantineRefDigest, `sha256:${'2'.repeat(64)}`);
    assert.equal(registry.diagnostics().pendingImportIntentCount, 0);
    await assert.rejects(() => registry.recordSeal({ ...request, requestId: '30000000-0000-4000-8000-000000000003', expectedRevision: '1' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REVISION_CONFLICT');
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('startup retains an ambiguous import intent and quarantines its allocation without replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-import-recovery-')); process.env.KOGG_STATE_DIR = root; const first = new ExecutionAllocationRegistry(); await first.onStart();
  const allocation = await advanceToStopping(first); const base = allocationRequest().binding;
  const candidate = { schemaVersion: 1 as const, candidateId: '30000000-0000-4000-8000-000000000011', worktreeId: allocation.worktreeId, runId: base.runId, attemptId: base.attemptId, baseCommit: base.baseCommit, baseTree: base.baseTree, candidateCommit: 'd'.repeat(40), candidateTree: 'e'.repeat(40), objectClosureDigest: `sha256:${'f'.repeat(64)}`, mutationPolicyDigest: CANDIDATE_MUTATION_POLICY_DIGEST, sealedAt: new Date().toISOString(), retentionClass: 'pending-evidence' as const, retentionUntil: '9999-12-31T23:59:59.999Z', safeCode: 'SEAL_OK' as const };
  await first.recordSeal({ requestId: '30000000-0000-4000-8000-000000000012', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, candidate });
  await first.prepareCandidateImport({ requestId: '30000000-0000-4000-8000-000000000013', worktreeId: allocation.worktreeId, expectedRevision: String(Number(allocation.revision) + 1), bindingDigest: allocation.bindingDigest, candidateId: candidate.candidateId, expectedSourceIdentityDigest: `sha256:${'1'.repeat(64)}` }); first.onStop();
  const recovered = new ExecutionAllocationRegistry(); await recovered.onStart();
  try { const diagnostics = recovered.diagnostics(); assert.equal(diagnostics.admission, 'blocked'); assert.equal(diagnostics.quarantinedCount, 1); assert.equal(diagnostics.pendingImportIntentCount, 1); assert.equal(diagnostics.candidateCount, 1); }
  finally { recovered.onStop(); await rm(root, { recursive: true, force: true }); }
});

function allocationRequest(): ReserveExecutionAllocationV1 {
  return { requestId: '10000000-0000-4000-8000-00000000000b', binding: binding(), quotaBytes: '1073741824', quotaInodes: '100000' };
}
async function advanceToStopping(registry: ExecutionAllocationRegistry) {
  let allocation = await registry.reserve(allocationRequest()); const states = ['allocated', 'seeding', 'verified', 'ready', 'leased', 'executing', 'stopping'] as const;
  for (let index = 0; index < states.length; index++) allocation = await registry.advance({ requestId: `20000000-0000-4000-8000-00000000000${index}`, worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, nextState: states[index]!, safeCode: 'ALLOCATION_OK' });
  return allocation;
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
