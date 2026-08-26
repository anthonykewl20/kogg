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

// diagnostic-coverage: agents.adapters, agents.attempts, agents.processes, agents.recovery, agents.logging, agents.source-maps

const ADMISSION: TaskAdmissionSnapshot = { taskAdmissionId: '10000000-0000-4000-8000-000000000001', taskId: '10000000-0000-4000-8000-000000000002', specificationId: '10000000-0000-4000-8000-000000000003', approvalId: '10000000-0000-4000-8000-000000000004', projectId: '10000000-0000-4000-8000-000000000005', repositoryId: '10000000-0000-4000-8000-000000000006', bindingRevision: '1', registryRevision: '1', taskRevision: '1', runId: '10000000-0000-4000-8000-000000000007' };

test('runs a real supervised fixture host through completion and proves cleanup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const authority: TaskAdmissionAuthority = { resolveAdmission: async id => id === ADMISSION.taskAdmissionId ? ADMISSION : undefined };
  const registry = new AgentRegistry(authority, operations, adapters); const fixture = new FixtureAdapter(adapters);
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
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters);
  try {
    await registry.onStart(); const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000002', '0')); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000002', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'missing.adapter', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' });
    assert.equal(result.kind, 'refused'); assert.equal(result.code, 'ADAPTER_UNAVAILABLE'); assert.equal(result.attempt?.state, 'cleaned'); assert.equal(operations.started, 0);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('expires the persisted first-activity generation and cleans the host', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const priorState = process.env.KOGG_STATE_DIR; const priorDeadline = process.env.KOGG_AGENT_TEST_DEADLINES; process.env.KOGG_STATE_DIR = directory; process.env.KOGG_AGENT_TEST_DEADLINES = '1';
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000003', '0', 'fixture.hang')); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000003', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.hang', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(result.attempt);
    const terminal = await poll(() => registry.getAttempt(result.attempt!.attemptId), value => value.state === 'cleaned');
    assert.equal(terminal.terminalCode, 'FIRST_ACTIVITY_TIMEOUT'); assert.equal(terminal.ownedResourceCount, '0'); assert.equal(operations.processes.every(process => process.cleaned), true);
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
