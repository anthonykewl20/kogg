import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ExecutionAllocationSummaryV1, ExecutionBindingV1, RecordPhysicalAllocationV1, ReserveExecutionAllocationV1 } from '../common/execution-protocol';
import { CANDIDATE_MUTATION_POLICY_DIGEST } from './candidate-sealer';
import { AllocationRegistryError, ExecutionAllocationRegistry } from './execution-allocation-registry';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';

// diagnostic-coverage: execution.worktree-registry, execution.process-cleanup, execution.capacity, execution.recovery, execution.retention
test('reserves one opaque allocation identity before effects and replays only an identical request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-registry-')); process.env.KOGG_STATE_DIR = root;
  const registry = allocationRegistry(); await registry.onStart();
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

test('publishes restart-safe execution owner facts into the operations projection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-owner-')); process.env.KOGG_STATE_DIR = root;
  const projection = new OperationsReadModel(path.join(root, 'operations.sqlite3')); await projection.onStart(); projection.registerOwner('execution');
  const first = allocationRegistry(); await first.onStart(); first.setOwnerSink(projection);
  try {
    let allocation = await first.reserve(allocationRequest());
    allocation = await first.recordPhysicalAllocation(await physicalAllocationProof(first, allocation, '10000000-0000-4000-8000-000000000019'));
    allocation = await first.advance({ requestId: '10000000-0000-4000-8000-00000000001a', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, nextState: 'seeding', safeCode: 'ALLOCATION_OK' });
    assert.deepEqual(projection.timeline(allocation.runId).map(event => event.eventKind), ['execution.admitted', 'execution.admitted', 'execution.started', 'execution.started']);
    assert.equal(projection.diagnostics().ownerCount, 1); assert.equal(projection.diagnostics().faultCount, 0);
    first.onStop(); const recovered = allocationRegistry(); await recovered.onStart(); recovered.setOwnerSink(projection);
    assert.equal(projection.timeline(allocation.runId).at(-1)?.eventKind, 'execution.quarantined');
    assert.equal(projection.diagnostics().faultCount, 0); recovered.onStop();
  } finally { first.onStop(); projection.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('refuses startup when a durable execution owner fact is altered', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-owner-integrity-')); process.env.KOGG_STATE_DIR = root;
  const first = allocationRegistry(); await first.onStart(); await first.reserve(allocationRequest()); first.onStop();
  try {
    const database = new DatabaseSync(path.join(root, 'execution', 'registry.sqlite3'));
    database.exec('DROP TRIGGER execution_owner_events_update'); database.prepare("UPDATE allocation_events SET safe_code='CLEANUP_FAILED' WHERE sequence=1").run(); database.close();
    await assert.rejects(allocationRegistry().onStart(), /integrity/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup quarantines an ambiguous reserved allocation and blocks new admission without replaying effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-recovery-')); process.env.KOGG_STATE_DIR = root;
  const request = allocationRequest(); const first = allocationRegistry(); await first.onStart();
  const reserved = await first.reserve(request); first.onStop();
  const recovered = allocationRegistry(); await recovered.onStart();
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
  const registry = allocationRegistry(); await registry.onStart();
  try {
    await assert.rejects(() => registry.reserve({ ...allocationRequest(), privatePath: '/private/canary' } as never),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_PROTOCOL_INVALID');
    assert.equal(registry.diagnostics().reservationCount, 0);
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('revalidates the exact live qualification before reserving any allocation identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-qualification-')); process.env.KOGG_STATE_DIR = root;
  let observed: ExecutionBindingV1 | undefined;
  const registry = allocationRegistry(async binding => { observed = binding; return false; }); await registry.onStart();
  try {
    const request = allocationRequest();
    await assert.rejects(() => registry.reserve(request),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_QUALIFICATION_INVALID');
    assert.deepEqual(observed, request.binding);
    assert.equal(registry.diagnostics().reservationCount, 0);
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('projects execution runs through the closed path-free RPC contract and refuses extra fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-projection-')); process.env.KOGG_STATE_DIR = root;
  const registry = allocationRegistry(); await registry.onStart();
  try {
    const allocation = await registry.reserve(allocationRequest());
    const requestId = '10000000-0000-4000-8000-000000000020';
    const run = await registry.getRun({ requestId, runId: allocation.runId });
    assert.deepEqual(run, {
      schemaVersion: 1, projectId: allocationRequest().binding.projectId, repositoryId: allocationRequest().binding.repositoryId,
      runId: allocation.runId, attemptId: allocation.attemptId, state: 'admitted', revision: '1', cleanupState: 'required', safeCode: 'ALLOCATION_OK'
    });
    assert.deepEqual(await registry.getRun({ requestId: '10000000-0000-4000-8000-000000000021', runId: '10000000-0000-4000-8000-000000000099' }), undefined);
    const list = await registry.listRuns({ requestId: '10000000-0000-4000-8000-000000000022', projectId: allocationRequest().binding.projectId });
    assert.equal(list.schemaVersion, 1); assert.equal(list.projectId, allocationRequest().binding.projectId); assert.equal(list.truncated, false);
    assert.deepEqual(list.runs, [run]);
    const serialized = JSON.stringify(list); assert.equal(serialized.includes('worktreeId'), false); assert.equal(serialized.includes('allocationName'), false);
    assert.equal(serialized.includes('bindingDigest'), false); assert.equal(serialized.includes('private'), false);
    await assert.rejects(() => registry.getRun({ requestId: '10000000-0000-4000-8000-000000000023', runId: allocation.runId, sourceRoot: '/private/canary' } as never),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_PROTOCOL_INVALID');
    await assert.rejects(() => registry.listRuns({ requestId: '10000000-0000-4000-8000-000000000024', projectId: 'not-an-id' }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_PROTOCOL_INVALID');
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('persists only legal binding-and-revision-fenced state transitions with exact request replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-state-')); process.env.KOGG_STATE_DIR = root; const registry = allocationRegistry(); await registry.onStart();
  try {
    const allocation = await registry.reserve(allocationRequest()); const request = { requestId: '10000000-0000-4000-8000-00000000000c', worktreeId: allocation.worktreeId, expectedRevision: '1', bindingDigest: allocation.bindingDigest, nextState: 'allocated' as const, safeCode: 'ALLOCATION_OK' as const };
    await assert.rejects(() => registry.advance(request), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_STATE_INVALID');
    const proof = await physicalAllocationProof(registry, allocation, '10000000-0000-4000-8000-000000000019');
    const advanced = await registry.recordPhysicalAllocation(proof); assert.equal(advanced.state, 'allocated'); assert.equal(advanced.revision, '2'); assert.deepEqual(await registry.recordPhysicalAllocation(proof), advanced);
    await assert.rejects(() => registry.recordPhysicalAllocation({ ...proof, quotaProjectId: '8' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
    await assert.rejects(() => registry.advance({ ...request, requestId: '10000000-0000-4000-8000-00000000000d', expectedRevision: '2', nextState: 'sealed' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_STATE_INVALID');
    await assert.rejects(() => registry.advance({ ...request, requestId: '10000000-0000-4000-8000-00000000000e', expectedRevision: '1', nextState: 'seeding' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REVISION_CONFLICT');
    await assert.rejects(() => registry.advance({ ...request, requestId: '10000000-0000-4000-8000-00000000000f', expectedRevision: '2', bindingDigest: `sha256:${'b'.repeat(64)}`, nextState: 'seeding' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_BINDING_MISMATCH');
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('fences physical allocation behind one durable pre-effect intent and quarantines ambiguous restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-intent-')); process.env.KOGG_STATE_DIR = root;
  const first = allocationRegistry(); await first.onStart(); const allocation = await first.reserve(allocationRequest());
  const prepare = { requestId: '19000000-0000-4000-8000-000000000001', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, helperDigest: `sha256:${'8'.repeat(64)}`, mountQuotaDigest: `sha256:${'9'.repeat(64)}` };
  const intent = await first.preparePhysicalAllocation(prepare);
  assert.deepEqual(await first.preparePhysicalAllocation(prepare), intent); assert.match(intent.allocationNonce, /^[0-9a-f]{64}$/u);
  assert.match(intent.fencingToken, /^[0-9a-f]{64}$/u); assert.equal(intent.quotaProjectId, '10000'); assert.match(intent.ownerInstanceId, /^[0-9a-f-]{36}$/u);
  assert.equal(new Date(intent.createdAt).toISOString(), intent.createdAt); assert.equal(first.diagnostics().pendingAllocationIntentCount, 1); assert.equal(first.diagnostics().activeQuotaProjectLeaseCount, 1);
  await assert.rejects(() => first.preparePhysicalAllocation({ ...prepare, helperDigest: `sha256:${'7'.repeat(64)}` }),
    (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
  await assert.rejects(() => first.recordPhysicalAllocation({
    requestId: '19000000-0000-4000-8000-000000000002', intentId: '19000000-0000-4000-8000-000000000003', fencingToken: intent.fencingToken,
    worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, allocationName: allocation.allocationName,
    allocationNonceDigest: allocation.allocationNonceDigest, filesystemDevice: '2049', filesystemInode: '4001', ownerUid: '1000', mode: '0700', mountId: '55',
    quotaProjectId: intent.quotaProjectId, quotaBytes: intent.quotaBytes, quotaInodes: intent.quotaInodes, helperDigest: intent.helperDigest, mountQuotaDigest: intent.mountQuotaDigest
  }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_INTEGRITY_FAILED');
  first.onStop(); const recovered = allocationRegistry(); await recovered.onStart();
  try {
    const diagnostics = recovered.diagnostics(); assert.equal(diagnostics.admission, 'blocked'); assert.equal(diagnostics.quarantinedCount, 1);
    assert.equal(diagnostics.pendingAllocationIntentCount, 1); assert.equal(diagnostics.activeQuotaProjectLeaseCount, 0); assert.equal(diagnostics.quarantinedQuotaProjectLeaseCount, 1);
  } finally { recovered.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('atomically quarantines a refused physical allocation effect and blocks admission immediately', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-failure-')); process.env.KOGG_STATE_DIR = root;
  const registry = allocationRegistry(); await registry.onStart();
  try {
    const allocation = await registry.reserve(allocationRequest());
    const intent = await registry.preparePhysicalAllocation({ requestId: '19500000-0000-4000-8000-000000000001', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, helperDigest: `sha256:${'8'.repeat(64)}`, mountQuotaDigest: `sha256:${'9'.repeat(64)}` });
    const failure = { requestId: '19500000-0000-4000-8000-000000000002', intentId: intent.intentId, worktreeId: allocation.worktreeId, expectedRevision: intent.expectedRevision, bindingDigest: allocation.bindingDigest, fencingToken: intent.fencingToken, safeCode: 'ALLOCATION_QUALIFICATION_INVALID' as const };
    const quarantined = await registry.failPhysicalAllocation(failure);
    assert.equal(quarantined.state, 'quarantined'); assert.equal(quarantined.cleanupState, 'failed'); assert.equal(quarantined.safeCode, failure.safeCode);
    assert.deepEqual(await registry.failPhysicalAllocation(failure), quarantined);
    const diagnostics = registry.diagnostics(); assert.equal(diagnostics.admission, 'blocked'); assert.equal(diagnostics.pendingAllocationIntentCount, 0); assert.equal(diagnostics.quarantinedCount, 1);
    assert.equal(diagnostics.activeQuotaProjectLeaseCount, 0); assert.equal(diagnostics.quarantinedQuotaProjectLeaseCount, 1);
    await assert.rejects(() => registry.failPhysicalAllocation({ ...failure, safeCode: 'ALLOCATION_INTEGRITY_FAILED' }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('assigns non-reused durable project IDs before either physical effect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-project-lease-')); process.env.KOGG_STATE_DIR = root;
  const registry = allocationRegistry(); await registry.onStart();
  try {
    const first = await registry.reserve(allocationRequest());
    const secondRequest: ReserveExecutionAllocationV1 = { ...allocationRequest(), requestId: '19600000-0000-4000-8000-000000000001', binding: { ...allocationRequest().binding, runId: '19600000-0000-4000-8000-000000000002', attemptId: '19600000-0000-4000-8000-000000000003' } };
    const second = await registry.reserve(secondRequest);
    const helperDigest = `sha256:${'8'.repeat(64)}`; const mountQuotaDigest = `sha256:${'9'.repeat(64)}`;
    const firstIntent = await registry.preparePhysicalAllocation({ requestId: '19600000-0000-4000-8000-000000000004', worktreeId: first.worktreeId, expectedRevision: first.revision, bindingDigest: first.bindingDigest, helperDigest, mountQuotaDigest });
    const secondIntent = await registry.preparePhysicalAllocation({ requestId: '19600000-0000-4000-8000-000000000005', worktreeId: second.worktreeId, expectedRevision: second.revision, bindingDigest: second.bindingDigest, helperDigest, mountQuotaDigest });
    assert.equal(firstIntent.quotaProjectId, '10000'); assert.equal(secondIntent.quotaProjectId, '10001'); assert.notEqual(firstIntent.quotaProjectId, secondIntent.quotaProjectId);
    assert.equal(registry.diagnostics().activeQuotaProjectLeaseCount, 2); assert.equal(registry.diagnostics().quarantinedQuotaProjectLeaseCount, 0);
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('records one sealed candidate only after the legal stopping state and replays the exact request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-seal-')); process.env.KOGG_STATE_DIR = root; const registry = allocationRegistry(); await registry.onStart();
  try {
    const allocation = await advanceToStopping(registry);
    const candidate = { schemaVersion: 1 as const, candidateId: '30000000-0000-4000-8000-000000000001', worktreeId: allocation.worktreeId, runId: allocationRequest().binding.runId, attemptId: allocationRequest().binding.attemptId, baseCommit: allocationRequest().binding.baseCommit, baseTree: allocationRequest().binding.baseTree, candidateCommit: 'd'.repeat(40), candidateTree: 'e'.repeat(40), objectClosureDigest: `sha256:${'f'.repeat(64)}`, mutationPolicyDigest: CANDIDATE_MUTATION_POLICY_DIGEST, sealedAt: new Date().toISOString(), retentionClass: 'pending-evidence' as const, retentionUntil: '9999-12-31T23:59:59.999Z', safeCode: 'SEAL_OK' as const };
    const request = { requestId: '30000000-0000-4000-8000-000000000002', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, candidate };
    assert.deepEqual(await registry.recordSeal(request), candidate); assert.deepEqual(await registry.recordSeal(request), candidate);
    const intentRequest = { requestId: '30000000-0000-4000-8000-000000000004', worktreeId: allocation.worktreeId, expectedRevision: String(Number(allocation.revision) + 1), bindingDigest: allocation.bindingDigest, candidateId: candidate.candidateId, expectedSourceIdentityDigest: `sha256:${'1'.repeat(64)}` };
    const intent = await registry.prepareCandidateImport(intentRequest); const intentReplay = await registry.prepareCandidateImport(intentRequest); assert.equal(intent.replay, false); assert.equal(intentReplay.replay, true); assert.equal(intentReplay.intentId, intent.intentId); assert.equal(intentReplay.fencingToken, intent.fencingToken); assert.match(intent.fencingToken, /^[0-9a-f]{64}$/u);
    assert.equal(registry.diagnostics().candidateCount, 1); assert.equal(registry.diagnostics().pendingImportIntentCount, 1); assert.equal(registry.diagnostics().activeRepositoryLeaseCount, 1);
    const imported = await registry.completeCandidateImport({ requestId: '30000000-0000-4000-8000-000000000005', intentId: intent.intentId, worktreeId: allocation.worktreeId, expectedRevision: intentRequest.expectedRevision, bindingDigest: allocation.bindingDigest, candidateId: candidate.candidateId, fencingToken: intent.fencingToken, candidateCommit: candidate.candidateCommit, candidateTree: candidate.candidateTree, quarantineRefDigest: `sha256:${'2'.repeat(64)}` });
    assert.equal(imported.safeCode, 'IMPORT_OK'); assert.equal(imported.quarantineRefDigest, `sha256:${'2'.repeat(64)}`);
    assert.equal(registry.diagnostics().pendingImportIntentCount, 0); assert.equal(registry.diagnostics().activeRepositoryLeaseCount, 0); assert.equal(registry.diagnostics().quarantinedRepositoryLeaseCount, 0);
    await assert.rejects(() => registry.recordSeal({ ...request, requestId: '30000000-0000-4000-8000-000000000003', expectedRevision: '1' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REVISION_CONFLICT');
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('requires a durable authority-bound retention fact and refuses cleanup before its policy deadline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-retention-')); process.env.KOGG_STATE_DIR = root; const registry = allocationRegistry(); await registry.onStart();
  try {
    const allocation = await advanceToStopping(registry); const candidate = candidateFor(allocation, '35000000-0000-4000-8000-000000000001');
    const sealed = await registry.recordSeal({ requestId: '35000000-0000-4000-8000-000000000002', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, candidate });
    const sealedRevision = String(Number(allocation.revision) + 1);
    await assert.rejects(() => registry.advance({ requestId: '35000000-0000-4000-8000-000000000003', worktreeId: allocation.worktreeId, expectedRevision: sealedRevision, bindingDigest: allocation.bindingDigest, nextState: 'cleaning', safeCode: 'ALLOCATION_OK' }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_STATE_INVALID');
    const request = { requestId: '35000000-0000-4000-8000-000000000004', worktreeId: allocation.worktreeId, expectedRevision: sealedRevision, bindingDigest: allocation.bindingDigest, candidateId: sealed.candidateId, retentionClass: 'rejected' as const, authorityDigest: `sha256:${'9'.repeat(64)}` };
    const before = Date.now(); const retained = await registry.recordRetention(request); const after = Date.now();
    assert.equal(retained.state, 'retained'); assert.equal(retained.retentionClass, 'rejected'); assert.equal(retained.safeCode, 'RETENTION_OK');
    assert.ok(Date.parse(retained.retentionUntil) >= before + 86_400_000); assert.ok(Date.parse(retained.retentionUntil) <= after + 86_400_000);
    assert.deepEqual(await registry.recordRetention(request), retained);
    assert.equal(registry.diagnostics().retentionViolationCount, 0); assert.equal(registry.diagnostics().loggingViolationCount, 0);
    await assert.rejects(() => registry.recordRetention({ ...request, retentionClass: 'completed' }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
    await assert.rejects(() => registry.preparePhysicalCleanup({ requestId: '35000000-0000-4000-8000-000000000005', worktreeId: allocation.worktreeId, expectedRevision: retained.revision, bindingDigest: allocation.bindingDigest }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'RETENTION_ACTIVE');
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('fences cleanup behind a durable exact-identity intent and absence proof', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-cleanup-')); process.env.KOGG_STATE_DIR = root; const registry = allocationRegistry(); await registry.onStart();
  try {
    const request = allocationRequest(); let allocation = await registry.reserve(request);
    allocation = await registry.recordPhysicalAllocation(await physicalAllocationProof(registry, allocation, '36000000-0000-4000-8000-000000000001'));
    await assert.rejects(() => registry.advance({ requestId: '36000000-0000-4000-8000-000000000002', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, nextState: 'cleaning', safeCode: 'ALLOCATION_OK' }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_STATE_INVALID');
    const prepare = { requestId: '36000000-0000-4000-8000-000000000003', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest };
    const intent = await registry.preparePhysicalCleanup(prepare); assert.deepEqual(await registry.preparePhysicalCleanup(prepare), intent);
    assert.equal(intent.expectedRevision, '3'); assert.match(intent.allocationNonce, /^[0-9a-f]{64}$/u); assert.equal(intent.mode, '0700');
    assert.equal(registry.diagnostics().pendingCleanupIntentCount, 1);
    const completionBase = { requestId: '36000000-0000-4000-8000-000000000004', intentId: intent.intentId, worktreeId: intent.worktreeId, expectedRevision: intent.expectedRevision, bindingDigest: allocation.bindingDigest, fencingToken: intent.fencingToken, expectedIdentityDigest: intent.expectedIdentityDigest, preDeleteIdentityDigest: intent.expectedIdentityDigest, helperDigest: intent.helperDigest, mountQuotaDigest: intent.mountQuotaDigest };
    const completion = { ...completionBase, absenceProofDigest: cleanupProof(completionBase) };
    const cleaned = await registry.completePhysicalCleanup(completion); assert.equal(cleaned.state, 'cleaned'); assert.equal(cleaned.cleanupState, 'cleaned'); assert.equal(cleaned.revision, '4');
    assert.deepEqual(await registry.completePhysicalCleanup(completion), cleaned); assert.equal(registry.diagnostics().pendingCleanupIntentCount, 0); assert.equal(registry.diagnostics().activeQuotaProjectLeaseCount, 0); assert.equal(registry.diagnostics().quarantinedQuotaProjectLeaseCount, 0);
    assert.equal(JSON.stringify(await registry.getRun({ requestId: '36000000-0000-4000-8000-000000000005', runId: cleaned.runId })).includes(intent.allocationNonce), false);
    await assert.rejects(() => registry.completePhysicalCleanup({ ...completion, absenceProofDigest: `sha256:${'0'.repeat(64)}` }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('quarantines cleanup identity mismatch and blocks admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-cleanup-mismatch-')); process.env.KOGG_STATE_DIR = root; const registry = allocationRegistry(); await registry.onStart();
  try {
    let allocation = await registry.reserve(allocationRequest()); allocation = await registry.recordPhysicalAllocation(await physicalAllocationProof(registry, allocation, '37000000-0000-4000-8000-000000000001'));
    const intent = await registry.preparePhysicalCleanup({ requestId: '37000000-0000-4000-8000-000000000002', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest });
    const failure = { requestId: '37000000-0000-4000-8000-000000000003', intentId: intent.intentId, worktreeId: allocation.worktreeId, expectedRevision: intent.expectedRevision, bindingDigest: allocation.bindingDigest, fencingToken: intent.fencingToken, expectedIdentityDigest: intent.expectedIdentityDigest, observedIdentityDigest: `sha256:${'0'.repeat(64)}`, safeCode: 'CLEANUP_IDENTITY_MISMATCH' as const };
    const quarantined = await registry.failPhysicalCleanup(failure); assert.equal(quarantined.state, 'quarantined'); assert.equal(quarantined.cleanupState, 'failed'); assert.equal(quarantined.safeCode, 'CLEANUP_IDENTITY_MISMATCH');
    assert.deepEqual(await registry.failPhysicalCleanup(failure), quarantined); const diagnostics = registry.diagnostics(); assert.equal(diagnostics.admission, 'blocked'); assert.equal(diagnostics.pendingCleanupIntentCount, 0); assert.equal(diagnostics.quarantinedCount, 1); assert.equal(diagnostics.activeQuotaProjectLeaseCount, 0); assert.equal(diagnostics.quarantinedQuotaProjectLeaseCount, 1);
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('startup quarantines an ambiguous cleanup intent without replaying deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-cleanup-recovery-')); process.env.KOGG_STATE_DIR = root; const first = allocationRegistry(); await first.onStart();
  let allocation = await first.reserve(allocationRequest()); allocation = await first.recordPhysicalAllocation(await physicalAllocationProof(first, allocation, '38000000-0000-4000-8000-000000000001'));
  await first.preparePhysicalCleanup({ requestId: '38000000-0000-4000-8000-000000000002', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest }); first.onStop();
  const recovered = allocationRegistry(); await recovered.onStart();
  try { const diagnostics = recovered.diagnostics(); assert.equal(diagnostics.admission, 'blocked'); assert.equal(diagnostics.quarantinedCount, 1); assert.equal(diagnostics.pendingCleanupIntentCount, 1); }
  finally { recovered.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('refuses startup when a persisted physical identity component is altered', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-identity-integrity-')); process.env.KOGG_STATE_DIR = root; const first = allocationRegistry(); await first.onStart();
  let allocation = await first.reserve(allocationRequest()); allocation = await first.recordPhysicalAllocation(await physicalAllocationProof(first, allocation, '39000000-0000-4000-8000-000000000001')); first.onStop();
  try {
    const database = new DatabaseSync(path.join(root, 'execution', 'registry.sqlite3')); database.prepare('UPDATE allocations SET filesystem_inode=? WHERE worktree_id=?').run('4002', allocation.worktreeId); database.close();
    await assert.rejects(allocationRegistry().onStart(), /physical identity integrity/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses startup when a durable quota-project lease is inconsistent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-project-lease-integrity-')); process.env.KOGG_STATE_DIR = root; const first = allocationRegistry(); await first.onStart();
  let allocation = await first.reserve(allocationRequest()); allocation = await first.recordPhysicalAllocation(await physicalAllocationProof(first, allocation, '39500000-0000-4000-8000-000000000001')); first.onStop();
  try {
    const database = new DatabaseSync(path.join(root, 'execution', 'registry.sqlite3')); database.prepare("UPDATE quota_project_leases SET phase='released' WHERE worktree_id=?").run(allocation.worktreeId); database.close();
    await assert.rejects(allocationRegistry().onStart(), /quota project lease integrity/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('allows only one durable import mutation lease per repository until terminal completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-repository-lease-')); process.env.KOGG_STATE_DIR = root; const registry = allocationRegistry(); await registry.onStart();
  try {
    const first = await advanceToStopping(registry); const base = allocationRequest().binding;
    const firstCandidate = candidateFor(first, '40000000-0000-4000-8000-000000000001');
    await registry.recordSeal({ requestId: '40000000-0000-4000-8000-000000000002', worktreeId: first.worktreeId, expectedRevision: first.revision, bindingDigest: first.bindingDigest, candidate: firstCandidate });
    await registry.prepareCandidateImport({ requestId: '40000000-0000-4000-8000-000000000003', worktreeId: first.worktreeId, expectedRevision: String(Number(first.revision) + 1), bindingDigest: first.bindingDigest, candidateId: firstCandidate.candidateId, expectedSourceIdentityDigest: `sha256:${'1'.repeat(64)}` });

    const secondRequest: ReserveExecutionAllocationV1 = { ...allocationRequest(), requestId: '40000000-0000-4000-8000-000000000004', binding: { ...base, runId: '40000000-0000-4000-8000-000000000005', attemptId: '40000000-0000-4000-8000-000000000006' } };
    const second = await advanceRequestToStopping(registry, secondRequest, '41000000');
    const secondCandidate = candidateFor(second, '40000000-0000-4000-8000-000000000007');
    await registry.recordSeal({ requestId: '40000000-0000-4000-8000-000000000008', worktreeId: second.worktreeId, expectedRevision: second.revision, bindingDigest: second.bindingDigest, candidate: secondCandidate });
    await assert.rejects(() => registry.prepareCandidateImport({ requestId: '40000000-0000-4000-8000-000000000009', worktreeId: second.worktreeId, expectedRevision: String(Number(second.revision) + 1), bindingDigest: second.bindingDigest, candidateId: secondCandidate.candidateId, expectedSourceIdentityDigest: `sha256:${'1'.repeat(64)}` }),
      (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REPOSITORY_LEASE_CONFLICT');
    assert.equal(registry.diagnostics().activeRepositoryLeaseCount, 1); assert.equal(registry.diagnostics().pendingImportIntentCount, 1);
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('atomically quarantines a failed import intent and blocks admission without deleting evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-import-failure-')); process.env.KOGG_STATE_DIR = root; const registry = allocationRegistry(); await registry.onStart();
  try {
    const allocation = await advanceToStopping(registry); const base = allocationRequest().binding;
    const candidate = { schemaVersion: 1 as const, candidateId: '30000000-0000-4000-8000-000000000021', worktreeId: allocation.worktreeId, runId: base.runId, attemptId: base.attemptId, baseCommit: base.baseCommit, baseTree: base.baseTree, candidateCommit: 'd'.repeat(40), candidateTree: 'e'.repeat(40), objectClosureDigest: `sha256:${'f'.repeat(64)}`, mutationPolicyDigest: CANDIDATE_MUTATION_POLICY_DIGEST, sealedAt: new Date().toISOString(), retentionClass: 'pending-evidence' as const, retentionUntil: '9999-12-31T23:59:59.999Z', safeCode: 'SEAL_OK' as const };
    await registry.recordSeal({ requestId: '30000000-0000-4000-8000-000000000022', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, candidate });
    const expectedRevision = String(Number(allocation.revision) + 1); const intent = await registry.prepareCandidateImport({ requestId: '30000000-0000-4000-8000-000000000023', worktreeId: allocation.worktreeId, expectedRevision, bindingDigest: allocation.bindingDigest, candidateId: candidate.candidateId, expectedSourceIdentityDigest: `sha256:${'1'.repeat(64)}` });
    const failure = { requestId: '30000000-0000-4000-8000-000000000024', intentId: intent.intentId, worktreeId: allocation.worktreeId, expectedRevision, bindingDigest: allocation.bindingDigest, candidateId: candidate.candidateId, fencingToken: intent.fencingToken, safeCode: 'IMPORT_SOURCE_INTEGRITY_FAILED' as const };
    const quarantined = await registry.failCandidateImport(failure); assert.equal(quarantined.state, 'quarantined'); assert.equal(quarantined.safeCode, 'IMPORT_SOURCE_INTEGRITY_FAILED'); assert.deepEqual(await registry.failCandidateImport(failure), quarantined);
    const diagnostics = registry.diagnostics(); assert.equal(diagnostics.admission, 'blocked'); assert.equal(diagnostics.quarantinedCount, 1); assert.equal(diagnostics.pendingImportIntentCount, 0); assert.equal(diagnostics.candidateCount, 1); assert.equal(diagnostics.activeRepositoryLeaseCount, 0); assert.equal(diagnostics.quarantinedRepositoryLeaseCount, 1);
    await assert.rejects(() => registry.failCandidateImport({ ...failure, safeCode: 'IMPORT_FAILED' }), (error: unknown) => error instanceof AllocationRegistryError && error.code === 'ALLOCATION_REQUEST_REPLAY_MISMATCH');
  } finally { registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('startup retains an ambiguous import intent and quarantines its allocation without replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-allocation-import-recovery-')); process.env.KOGG_STATE_DIR = root; const first = allocationRegistry(); await first.onStart();
  const allocation = await advanceToStopping(first); const base = allocationRequest().binding;
  const candidate = { schemaVersion: 1 as const, candidateId: '30000000-0000-4000-8000-000000000011', worktreeId: allocation.worktreeId, runId: base.runId, attemptId: base.attemptId, baseCommit: base.baseCommit, baseTree: base.baseTree, candidateCommit: 'd'.repeat(40), candidateTree: 'e'.repeat(40), objectClosureDigest: `sha256:${'f'.repeat(64)}`, mutationPolicyDigest: CANDIDATE_MUTATION_POLICY_DIGEST, sealedAt: new Date().toISOString(), retentionClass: 'pending-evidence' as const, retentionUntil: '9999-12-31T23:59:59.999Z', safeCode: 'SEAL_OK' as const };
  await first.recordSeal({ requestId: '30000000-0000-4000-8000-000000000012', worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, candidate });
  await first.prepareCandidateImport({ requestId: '30000000-0000-4000-8000-000000000013', worktreeId: allocation.worktreeId, expectedRevision: String(Number(allocation.revision) + 1), bindingDigest: allocation.bindingDigest, candidateId: candidate.candidateId, expectedSourceIdentityDigest: `sha256:${'1'.repeat(64)}` }); first.onStop();
  const recovered = allocationRegistry(); await recovered.onStart();
  try { const diagnostics = recovered.diagnostics(); assert.equal(diagnostics.admission, 'blocked'); assert.equal(diagnostics.quarantinedCount, 1); assert.equal(diagnostics.pendingImportIntentCount, 1); assert.equal(diagnostics.candidateCount, 1); assert.equal(diagnostics.activeRepositoryLeaseCount, 0); assert.equal(diagnostics.quarantinedRepositoryLeaseCount, 1); }
  finally { recovered.onStop(); await rm(root, { recursive: true, force: true }); }
});

function allocationRequest(): ReserveExecutionAllocationV1 {
  return { requestId: '10000000-0000-4000-8000-00000000000b', binding: binding(), quotaBytes: '1073741824', quotaInodes: '100000' };
}
function allocationRegistry(authorize: (binding: ExecutionBindingV1) => Promise<boolean> = async () => true): ExecutionAllocationRegistry {
  return new ExecutionAllocationRegistry({ authorize, authorizePhysicalAllocation: async (binding: ExecutionBindingV1) => authorize(binding) } as never);
}
async function advanceToStopping(registry: ExecutionAllocationRegistry) {
  return advanceRequestToStopping(registry, allocationRequest());
}
async function advanceRequestToStopping(registry: ExecutionAllocationRegistry, request: ReserveExecutionAllocationV1, requestNamespace = '20000000') {
  let allocation = await registry.reserve(request);
  allocation = await registry.recordPhysicalAllocation(await physicalAllocationProof(registry, allocation, `${requestNamespace}-0000-4000-8000-0000000000fe`));
  const states = ['seeding', 'verified', 'ready', 'leased', 'executing', 'stopping'] as const;
  for (let index = 0; index < states.length; index++) allocation = await registry.advance({ requestId: `${requestNamespace}-0000-4000-8000-00000000000${index}`, worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, nextState: states[index]!, safeCode: 'ALLOCATION_OK' });
  return allocation;
}
async function physicalAllocationProof(registry: ExecutionAllocationRegistry, allocation: ExecutionAllocationSummaryV1, requestId: string): Promise<RecordPhysicalAllocationV1> {
  const helperDigest = `sha256:${'8'.repeat(64)}`; const mountQuotaDigest = `sha256:${'9'.repeat(64)}`;
  const intent = await registry.preparePhysicalAllocation({ requestId: randomUUID(), worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, helperDigest, mountQuotaDigest });
  return {
    requestId, intentId: intent.intentId, fencingToken: intent.fencingToken, worktreeId: allocation.worktreeId, expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest,
    allocationName: intent.allocationName, allocationNonceDigest: allocation.allocationNonceDigest,
    filesystemDevice: '2049', filesystemInode: '4001', ownerUid: '1000', mode: '0700', mountId: '55', quotaProjectId: intent.quotaProjectId,
    quotaBytes: intent.quotaBytes, quotaInodes: intent.quotaInodes, helperDigest, mountQuotaDigest
  };
}
function candidateFor(allocation: Awaited<ReturnType<typeof advanceToStopping>>, candidateId: string) {
  const base = allocationRequest().binding;
  return { schemaVersion: 1 as const, candidateId, worktreeId: allocation.worktreeId, runId: allocation.runId, attemptId: allocation.attemptId, baseCommit: base.baseCommit, baseTree: base.baseTree, candidateCommit: 'd'.repeat(40), candidateTree: 'e'.repeat(40), objectClosureDigest: `sha256:${'f'.repeat(64)}`, mutationPolicyDigest: CANDIDATE_MUTATION_POLICY_DIGEST, sealedAt: new Date().toISOString(), retentionClass: 'pending-evidence' as const, retentionUntil: '9999-12-31T23:59:59.999Z', safeCode: 'SEAL_OK' as const };
}
function cleanupProof(value: { expectedIdentityDigest: string; fencingToken: string; helperDigest: string; intentId: string; mountQuotaDigest: string; worktreeId: string }): string {
  return `sha256:${createHash('sha256').update(`kogg-execution-cleanup-absence-v1\0${JSON.stringify({ expectedIdentityDigest: value.expectedIdentityDigest, fencingToken: value.fencingToken, helperDigest: value.helperDigest, intentId: value.intentId, mountQuotaDigest: value.mountQuotaDigest, worktreeId: value.worktreeId })}`).digest('hex')}`;
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
