import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { OperationLease, OperationRegistryApi, ProcessLease, StartOperation, StartProcess } from '@kogg/operations/lib/common/operations-protocol';
import type { TaskAdmissionAuthority, TaskAdmissionSnapshot } from '@kogg/tasks/lib/common/tasks-protocol';
import { AdapterRegistry } from './adapter-registry';
import { AgentRegistry } from './agent-registry';
import { FixtureAdapter } from './fixture-adapter';
import { LocalCredentialLeaseAuthority } from './credential-lease-authority';

// diagnostic-coverage: agents.adapters, agents.attempts, agents.processes, agents.recovery, agents.logging, agents.source-maps

const ADMISSION: TaskAdmissionSnapshot = { taskAdmissionId: '10000000-0000-4000-8000-000000000001', taskId: '10000000-0000-4000-8000-000000000002', specificationId: '10000000-0000-4000-8000-000000000003', approvalId: '10000000-0000-4000-8000-000000000004', projectId: '10000000-0000-4000-8000-000000000005', repositoryId: '10000000-0000-4000-8000-000000000006', bindingRevision: '1', registryRevision: '1', taskRevision: '1', runId: '10000000-0000-4000-8000-000000000007' };

test('runs a real supervised fixture host through completion and proves cleanup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const authority: TaskAdmissionAuthority = { resolveAdmission: async id => id === ADMISSION.taskAdmissionId ? ADMISSION : undefined };
  const registry = new AgentRegistry(authority, operations, adapters, new LocalCredentialLeaseAuthority()); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart();
    const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000001', '0'));
    assert.equal(role.kind, 'completed'); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000001', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' });
    assert.equal(result.kind, 'completed'); assert.ok(result.attempt);
    const terminal = await poll(() => registry.getAttempt(result.attempt!.attemptId), value => value.state === 'cleaned');
    assert.equal(terminal.terminalCode, 'AGENT_OK'); assert.equal(terminal.ownedResourceCount, '0'); assert.deepEqual(terminal.usage, { status: 'complete', source: 'provider-cumulative', inputTokens: '1', outputTokens: '1', totalTokens: '2' });
    assert.equal(registry.diagnostics().residualCount, 0); assert.equal(operations.processes.every(process => process.cleaned), true);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('refuses an absent exact adapter before creating an operation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority());
  try {
    await registry.onStart(); const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000002', '0')); assert.ok(role.role);
    const request = { schemaVersion: '1' as const, requestId: '30000000-0000-4000-8000-000000000002', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'missing.adapter', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' };
    const result = await registry.startAttempt(request);
    assert.equal(result.kind, 'refused'); assert.equal(result.code, 'ADAPTER_UNAVAILABLE'); assert.equal(result.attempt?.state, 'cleaned'); assert.equal(operations.started, 0);
    const replay = await registry.startAttempt(request); assert.equal(replay.kind, 'refused'); assert.equal(replay.code, 'ADAPTER_UNAVAILABLE'); assert.equal(replay.replay, true); assert.equal(replay.attempt?.attemptId, result.attempt?.attemptId); assert.equal(operations.started, 0);
    const collision = await registry.startAttempt({ ...request, adapterVersion: '2.0.0' }); assert.equal(collision.kind, 'refused'); assert.equal(collision.code, 'REQUEST_ID_REUSED'); assert.equal(operations.started, 0);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('expires the persisted first-activity generation and cleans the host', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const priorState = process.env.KOGG_STATE_DIR; const priorDeadline = process.env.KOGG_AGENT_TEST_DEADLINES; process.env.KOGG_STATE_DIR = directory; process.env.KOGG_AGENT_TEST_DEADLINES = '1';
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority()); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000003', '0', 'fixture.hang')); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000003', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.hang', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(result.attempt);
    const terminal = await poll(() => registry.getAttempt(result.attempt!.attemptId), value => value.state === 'cleaned');
    assert.equal(terminal.terminalCode, 'FIRST_ACTIVITY_TIMEOUT'); assert.equal(terminal.ownedResourceCount, '0'); assert.equal(operations.processes.every(process => process.cleaned), true);
  } finally { await registry.onStop(); if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState; if (priorDeadline === undefined) delete process.env.KOGG_AGENT_TEST_DEADLINES; else process.env.KOGG_AGENT_TEST_DEADLINES = priorDeadline; await rm(directory, { recursive: true, force: true }); }
});

test('reconciles a durable nonterminal attempt without replay when no resource exists', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const authority: TaskAdmissionAuthority = { resolveAdmission: async () => ADMISSION }; const first = new AgentRegistry(authority, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority()); let second: AgentRegistry | undefined;
  try {
    await first.onStart(); const role = await first.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000004', '0')); assert.ok(role.role);
    const refused = await first.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000004', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'missing.adapter', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(refused.attempt);
    const seam = first as unknown as { transition(id: string, state: 'active'): void; database?: { close(): void } }; seam.transition(refused.attempt.attemptId, 'active'); seam.database?.close();
    second = new AgentRegistry(authority, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority()); await second.onStart(); const recovered = await second.getAttempt(refused.attempt.attemptId);
    assert.equal(recovered.state, 'recovered_terminal'); assert.equal(recovered.terminalCode, 'RECOVERY_REQUIRED'); assert.equal((await second.snapshot()).admission, 'enabled');
  } finally { await second?.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('classifies adapter, provider, usage, model, and deadline failures with zero residuals', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const priorState = process.env.KOGG_STATE_DIR; const priorDeadline = process.env.KOGG_AGENT_TEST_DEADLINES; process.env.KOGG_STATE_DIR = directory; process.env.KOGG_AGENT_TEST_DEADLINES = '1';
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority()); const fixture = new FixtureAdapter(adapters);
  const cases = [
    ['fixture.refuse', 'PROVIDER_REFUSED'],
    ['fixture.transport', 'TRANSPORT_LOST'],
    ['fixture.invalid', 'ADAPTER_OBSERVATION_INVALID'],
    ['fixture.model-mismatch', 'MODEL_MISMATCH'],
    ['fixture.handshake', 'HANDSHAKE_TIMEOUT'],
    ['fixture.idle', 'IDLE_TIMEOUT'],
    ['fixture.provider-request', 'PROVIDER_REQUEST_TIMEOUT'],
    ['fixture.absolute', 'ABSOLUTE_TIMEOUT'],
    ['fixture.usage-decrease', 'AGENT_OK']
  ] as const;
  try {
    await registry.onStart(); fixture.onStart();
    for (const [index, [model, code]] of cases.entries()) {
      const role = await registry.createRoleRevision(roleRequest(`21000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, (await registry.snapshot()).registryRevision, model)); assert.ok(role.role);
      const result = await registry.startAttempt({ schemaVersion: '1', requestId: `31000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: model, adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(result.attempt);
      const terminal = await poll(() => registry.getAttempt(result.attempt!.attemptId), value => value.state === 'cleaned'); assert.equal(terminal.terminalCode, code, model); assert.equal(terminal.ownedResourceCount, '0', model);
      if (model === 'fixture.usage-decrease') assert.equal(terminal.usage.status, 'invalid');
    }
    assert.equal(registry.diagnostics().residualCount, 0); assert.equal(operations.processes.every(process => process.cleaned), true);
  } finally { await registry.onStop(); if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState; if (priorDeadline === undefined) delete process.env.KOGG_AGENT_TEST_DEADLINES; else process.env.KOGG_AGENT_TEST_DEADLINES = priorDeadline; await rm(directory, { recursive: true, force: true }); }
});

test('cancels a ready streaming host and commits zero-resource cleanup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority()); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('22000000-0000-4000-8000-000000000001', '0', 'fixture.hang')); assert.ok(role.role);
    const started = await registry.startAttempt({ schemaVersion: '1', requestId: '32000000-0000-4000-8000-000000000001', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.hang', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(started.attempt);
    const ready = await poll(() => registry.getAttempt(started.attempt!.attemptId), value => value.state === 'ready');
    const cancelled = await registry.cancelAttempt({ schemaVersion: '1', requestId: '42000000-0000-4000-8000-000000000001', expectedRegistryRevision: ready.registryRevision, expectedAttemptRevision: ready.attemptRevision, attemptId: ready.attemptId, reason: 'user' });
    assert.equal(cancelled.kind, 'completed'); assert.equal(cancelled.code, 'CANCELLED'); assert.equal(cancelled.attempt?.state, 'cleaned'); assert.equal(cancelled.attempt?.terminalCode, 'CANCELLED'); assert.equal(cancelled.attempt?.ownedResourceCount, '0'); assert.equal(operations.processes.every(process => process.cleaned), true);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('escalates an unacknowledged cancel at its persisted grace deadline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const priorState = process.env.KOGG_STATE_DIR; const priorDeadline = process.env.KOGG_AGENT_TEST_DEADLINES; process.env.KOGG_STATE_DIR = directory; process.env.KOGG_AGENT_TEST_DEADLINES = '1';
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority()); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('22000000-0000-4000-8000-000000000002', '0', 'fixture.cancel-grace')); assert.ok(role.role);
    const started = await registry.startAttempt({ schemaVersion: '1', requestId: '32000000-0000-4000-8000-000000000002', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.cancel-grace', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(started.attempt);
    const ready = await poll(() => registry.getAttempt(started.attempt!.attemptId), value => value.state === 'ready');
    const cancelled = await registry.cancelAttempt({ schemaVersion: '1', requestId: '42000000-0000-4000-8000-000000000002', expectedRegistryRevision: ready.registryRevision, expectedAttemptRevision: ready.attemptRevision, attemptId: ready.attemptId, reason: 'user' });
    assert.equal(cancelled.kind, 'completed'); assert.equal(cancelled.code, 'CANCEL_GRACE_EXPIRED'); assert.equal(cancelled.attempt?.state, 'cleaned'); assert.equal(cancelled.attempt?.terminalCode, 'CANCEL_GRACE_EXPIRED'); assert.equal(cancelled.attempt?.ownedResourceCount, '0'); assert.equal(operations.processes.every(process => process.cleaned), true);
  } finally { await registry.onStop(); if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState; if (priorDeadline === undefined) delete process.env.KOGG_AGENT_TEST_DEADLINES; else process.env.KOGG_AGENT_TEST_DEADLINES = priorDeadline; await rm(directory, { recursive: true, force: true }); }
});

test('blocks admission when the persisted cleanup deadline expires', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const priorState = process.env.KOGG_STATE_DIR; const priorDeadline = process.env.KOGG_AGENT_TEST_DEADLINES; process.env.KOGG_STATE_DIR = directory; process.env.KOGG_AGENT_TEST_DEADLINES = '1';
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority()); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('22000000-0000-4000-8000-000000000003', '0', 'fixture.cleanup-hang')); assert.ok(role.role);
    const started = await registry.startAttempt({ schemaVersion: '1', requestId: '32000000-0000-4000-8000-000000000003', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.cleanup-hang', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(started.attempt);
    const terminal = await poll(() => registry.getAttempt(started.attempt!.attemptId), value => value.state === 'cleanup_failed');
    assert.equal(terminal.terminalCode, 'CLEANUP_FAILED'); assert.equal(terminal.ownedResourceCount, '1'); assert.equal((await registry.snapshot()).admission, 'blocked'); assert.equal(registry.diagnostics().residualCount, 1);
  } finally { await registry.onStop(); if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState; if (priorDeadline === undefined) delete process.env.KOGG_AGENT_TEST_DEADLINES; else process.env.KOGG_AGENT_TEST_DEADLINES = priorDeadline; await rm(directory, { recursive: true, force: true }); }
});

function roleRequest(requestId: string, expectedRegistryRevision: string, model = 'fixture.echo') { return { schemaVersion: '1' as const, requestId, expectedRegistryRevision, roleKey: 'implementer', displayName: 'Implementer', authority: { capabilityIds: ['provider-turn'], toolPolicyIds: ['read-only'], mayCreateChildren: false, permittedChildRoleKeys: [], maxChildDepth: '0', maxDirectChildren: '0' }, providerPolicy: { permittedProviderIds: ['kogg.fixture'], permittedModelIds: [model], requiredAdapterCapabilities: ['provider-turn'] }, budgetPolicyId: 'fixture-budget' }; }
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 5_000; while (Date.now() < deadline) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Timed out polling attempt'); }

class TestOperations implements OperationRegistryApi {
  started = 0; readonly processes: TestProcess[] = [];
  async startOperation(operation: StartOperation): Promise<OperationLease> { this.started++; const id = operation.id ?? crypto.randomUUID(); return { id, cancellable: true, start: () => undefined, active: () => undefined, waiting: () => undefined, activity: () => undefined, refuse: () => undefined, complete: () => undefined, fail: () => undefined, timeout: () => undefined, cancel: async () => undefined, cleanup: async run => { await run?.(); }, registerProcess: process => { const lease = new TestProcess(process); this.processes.push(lease); return lease; } }; }
  async snapshot() { return { schemaVersion: 1 as const, revision: 1, admission: 'enabled' as const, active: [], recent: [] }; }
  async cancel() { return this.snapshot(); }
  diagnostics() { return { integrity: true, foreignKeys: true, permissions: true, recoveryComplete: true, activeCount: 0, stalledCount: 0, residualCount: 0, cleanupFailureCount: 0, admission: 'enabled' as const }; }
}
class TestProcess implements ProcessLease { cleaned = false; constructor(readonly input: StartProcess) {} readonly id = crypto.randomUUID(); spawning(): void {} started(): void {} ready(): void {} activity(): void {} failed(): void {} exited(): void {} cleanup(): void { this.cleaned = true; } }
