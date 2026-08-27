import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { OperationLease, OperationRegistryApi, ProcessLease, StartOperation, StartProcess } from '@kogg/operations/lib/common/operations-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';
import type { TaskAdmissionAuthority, TaskAdmissionSnapshot } from '@kogg/tasks/lib/common/tasks-protocol';
import type { ModeOperationAuthorizer } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import type { AdapterAttemptBindingV1, AgentAdapterFactory, AgentWorkspaceAuthority } from '../common/agents-protocol';
import { AdapterRegistry } from './adapter-registry';
import { AgentRegistry } from './agent-registry';
import { FixtureAdapter } from './fixture-adapter';
import { LocalCredentialLeaseAuthority } from './credential-lease-authority';

// diagnostic-coverage: agents.adapters, agents.attempts, agents.processes, agents.recovery, agents.logging, agents.source-maps

const ADMISSION: TaskAdmissionSnapshot = { taskAdmissionId: '10000000-0000-4000-8000-000000000001', taskId: '10000000-0000-4000-8000-000000000002', specificationId: '10000000-0000-4000-8000-000000000003', taskRevisionId: '10000000-0000-4000-8000-000000000003', taskRevisionDigest: `sha256:${'1'.repeat(64)}`, approvalId: '10000000-0000-4000-8000-000000000004', approvalDigest: `sha256:${'2'.repeat(64)}`, projectId: '10000000-0000-4000-8000-000000000005', repositoryId: '10000000-0000-4000-8000-000000000006', bindingRevision: '1', registryRevision: '1', taskRevision: '1', runId: '10000000-0000-4000-8000-000000000007', authorizedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2099-08-27T00:00:00.000Z' };
const MODE_AUTHORITY = { authorizeOperation: async () => ({ allowed: true, safeCode: 'MODE_OK' }) } as unknown as ModeOperationAuthorizer;

test('runs a real supervised fixture host through completion and proves cleanup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const authority: TaskAdmissionAuthority = { resolveAdmission: async id => id === ADMISSION.taskAdmissionId ? ADMISSION : undefined };
  const registry = new AgentRegistry(authority, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters); let adapterBinding: AdapterAttemptBindingV1 | undefined;
  const create = fixture.create.bind(fixture); fixture.create = (input: Parameters<AgentAdapterFactory['create']>[0]) => { adapterBinding = input.binding; return create(input); };
  try {
    await registry.onStart(); fixture.onStart();
    const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000001', '0'));
    assert.equal(role.kind, 'completed'); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000001', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' });
    assert.equal(result.kind, 'completed'); assert.ok(result.attempt);
    assert.deepEqual(adapterBinding, {
      schemaVersion: '1', attemptId: result.attempt.attemptId, taskId: ADMISSION.taskId, projectId: ADMISSION.projectId,
      repositoryId: ADMISSION.repositoryId, repositoryBindingRevision: ADMISSION.bindingRevision,
      specificationId: ADMISSION.specificationId, approvalId: ADMISSION.approvalId, runId: ADMISSION.runId,
      roleRevisionId: role.role.roleRevisionId, deadlinePolicyId: 'interactive-v1', providerId: 'kogg.fixture', modelId: 'fixture.echo'
    });
    const terminal = await poll(() => registry.getAttempt(result.attempt!.attemptId), value => value.state === 'cleaned');
    assert.equal(terminal.terminalCode, 'AGENT_OK'); assert.equal(terminal.ownedResourceCount, '0'); assert.deepEqual(terminal.usage, { status: 'complete', source: 'provider-cumulative', inputTokens: '1', outputTokens: '1', totalTokens: '2' });
    assert.equal(registry.diagnostics().residualCount, 0); assert.equal(operations.processes.every(process => process.cleaned), true);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('authoritatively resolves exact immutable workflow role/provider/adapter bindings without dispatch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-binding-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory; const adapters = new AdapterRegistry(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, new TestOperations(), adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters);
  try { await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000090', '0')); assert.ok(role.role); const request = { roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }; assert.deepEqual(await registry.authorizeBinding(request), { allowed: true, code: 'AGENT_OK', registryRevision: role.registryRevision }); assert.equal((await registry.snapshot()).attempts.length, 0); assert.equal((await registry.authorizeBinding({ ...request, modelId: 'fixture.other' })).code, 'MODEL_MISMATCH'); assert.equal((await registry.authorizeBinding({ ...request, roleRevisionId: '60000000-0000-4000-8000-000000000099' })).code, 'ROLE_NOT_FOUND'); }
  finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('refuses agent dispatch by durable mode authority before creating an attempt or external operation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-mode-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const operations = new TestOperations(); const modeOperations: string[] = [];
  const modes: ModeOperationAuthorizer = { async authorizeOperation(request) { modeOperations.push(request.operation); assert.equal(request.taskId, ADMISSION.taskId); return { schemaVersion: 1, allowed: false, safeCode: request.operation === 'research' ? 'MODE_AUTHORITY_REFUSED' : 'PLAN_MUTATION_REFUSED', projection: {} as never }; } };
  const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, new AdapterRegistry(), new LocalCredentialLeaseAuthority(), modes);
  try {
    await registry.onStart(); const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000091', '0')); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000091', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' });
    assert.equal(result.kind, 'refused'); assert.equal(result.code, 'POLICY_REFUSED');
    const mutatingRole = await registry.createRoleRevision(childRoleRequest('20000000-0000-4000-8000-000000000092', role.registryRevision, 'mutator', ['write'], false, [], ['fixture.echo'])); assert.ok(mutatingRole.role);
    const mutatingResult = await registry.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000092', expectedRegistryRevision: mutatingRole.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: mutatingRole.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' });
    assert.equal(mutatingResult.kind, 'refused'); assert.deepEqual(modeOperations, ['research', 'private-mutate']); assert.equal(operations.started, 0); assert.equal((await registry.listAttempts()).length, 0);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('refuses a mutating attempt without governed workspace authority before external effects', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-workspace-refused-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters); let adapterCreates = 0;
  const create = fixture.create.bind(fixture); fixture.create = input => { adapterCreates++; return create(input); };
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(childRoleRequest('21000000-0000-4000-8000-000000000001', '0', 'workspace-mutator', ['write'], false, [], ['fixture.echo'])); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '31000000-0000-4000-8000-000000000001', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1', workflowPlanDigest: 'a'.repeat(64) });
    assert.equal(result.kind, 'refused'); assert.equal(result.code, 'WORKSPACE_UNTRUSTED'); assert.equal(result.attempt?.state, 'cleaned'); assert.equal(result.attempt?.worktreeId, undefined); assert.equal(operations.started, 0); assert.equal(operations.processes.length, 0); assert.equal(adapterCreates, 0);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('persists and binds a validated governed workspace grant for a mutating attempt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-workspace-approved-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const worktreeId = '41000000-0000-4000-8000-000000000001'; const requests: Parameters<AgentWorkspaceAuthority['prepareWorkspace']>[0][] = []; const authority: AgentWorkspaceAuthority = { async prepareWorkspace(request) { requests.push(request); return { allowed: true, code: 'AGENT_OK', worktreeId, workspaceGrantDigest: 'b'.repeat(64) }; } };
  const adapters = new AdapterRegistry(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, new TestOperations(), adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY, authority); const fixture = new FixtureAdapter(adapters); let adapterBinding: AdapterAttemptBindingV1 | undefined; let restarted: AgentRegistry | undefined;
  const create = fixture.create.bind(fixture); fixture.create = input => { adapterBinding = input.binding; return create(input); };
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(childRoleRequest('21000000-0000-4000-8000-000000000002', '0', 'workspace-mutator', ['write'], false, [], ['fixture.echo'])); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '31000000-0000-4000-8000-000000000002', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1', workflowPlanDigest: 'a'.repeat(64) });
    assert.equal(result.kind, 'completed'); assert.equal(result.attempt?.worktreeId, worktreeId); assert.equal(adapterBinding?.worktreeId, worktreeId); assert.equal(requests.length, 1); assert.deepEqual(requests[0], { schemaVersion: '1', requestId: '31000000-0000-4000-8000-000000000002', attemptId: result.attempt?.attemptId, taskAdmissionId: ADMISSION.taskAdmissionId, taskId: ADMISSION.taskId, projectId: ADMISSION.projectId, repositoryId: ADMISSION.repositoryId, repositoryBindingRevision: ADMISSION.bindingRevision, specificationId: ADMISSION.specificationId, taskRevisionId: ADMISSION.taskRevisionId, taskRevisionDigest: ADMISSION.taskRevisionDigest, approvalId: ADMISSION.approvalId, approvalDigest: ADMISSION.approvalDigest, runId: ADMISSION.runId, roleRevisionId: role.role.roleRevisionId, workflowPlanDigest: 'a'.repeat(64) });
    await poll(() => registry.getAttempt(result.attempt!.attemptId), value => value.state === 'cleaned'); await registry.onStop(); restarted = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); await restarted.onStart(); assert.equal((await restarted.getAttempt(result.attempt!.attemptId)).worktreeId, worktreeId);
  } finally { await restarted?.onStop(); await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('publishes restart-safe adapter owner facts into the operations projection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-owner-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const authority: TaskAdmissionAuthority = { resolveAdmission: async () => ADMISSION }; const adapters = new AdapterRegistry(); const projection = new OperationsReadModel(path.join(directory, 'operations.sqlite3')); projection.onStart(); projection.registerOwner('adapter');
  const first = new AgentRegistry(authority, new TestOperations(), adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters); let second: AgentRegistry | undefined;
  try {
    await first.onStart(); first.setOwnerSink(projection); fixture.onStart(); const role = await first.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000021', '0')); assert.ok(role.role);
    const started = await first.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000021', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(started.attempt);
    await poll(() => first.getAttempt(started.attempt!.attemptId), value => value.state === 'cleaned');
    const timeline = projection.timeline(ADMISSION.runId); assert.deepEqual(timeline.map(event => event.eventKind), ['attempt.started', 'attempt.completed']); assert.equal(timeline.every(event => event.attemptId === started.attempt?.attemptId), true);
    assert.equal(projection.diagnostics().ownerCount, 1); assert.equal(projection.diagnostics().faultCount, 0); const accepted = projection.diagnostics().acceptedEventCount;
    await first.onStop(); second = new AgentRegistry(authority, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); await second.onStart(); second.setOwnerSink(projection);
    assert.equal(projection.diagnostics().acceptedEventCount, accepted); assert.equal(projection.diagnostics().faultCount, 0); assert.deepEqual(projection.timeline(ADMISSION.runId), timeline);
  } finally { await second?.onStop(); await first.onStop(); projection.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('refuses startup when a durable adapter owner source fact is altered', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-owner-integrity-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory; const first = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY);
  try {
    await first.onStart(); const role = await first.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000022', '0')); assert.ok(role.role); await first.onStop();
    const database = new DatabaseSync(path.join(directory, 'agents', 'registry.sqlite3')); database.exec('DROP TRIGGER agents_events_update'); database.prepare("UPDATE events SET safe_code='PROVIDER_REFUSED' WHERE event_kind='role.revision.created'").run(); database.close();
    await assert.rejects(new AgentRegistry({ resolveAdmission: async () => ADMISSION }, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY).onStart(), /AGENT_REGISTRY_INTEGRITY_FAILED/u);
  } finally { await first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('refuses an absent exact adapter before creating an operation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY);
  try {
    await registry.onStart(); const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000002', '0')); assert.ok(role.role);
    const request = { schemaVersion: '1' as const, requestId: '30000000-0000-4000-8000-000000000002', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'missing.adapter', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' };
    const result = await registry.startAttempt(request);
    assert.equal(result.kind, 'refused'); assert.equal(result.code, 'ADAPTER_UNAVAILABLE'); assert.equal(result.attempt?.state, 'cleaned'); assert.equal(operations.started, 0);
    const replay = await registry.startAttempt(request); assert.equal(replay.kind, 'refused'); assert.equal(replay.code, 'ADAPTER_UNAVAILABLE'); assert.equal(replay.replay, true); assert.equal(replay.attempt?.attemptId, result.attempt?.attemptId); assert.equal(operations.started, 0);
    const collision = await registry.startAttempt({ ...request, adapterVersion: '2.0.0' }); assert.equal(collision.kind, 'refused'); assert.equal(collision.code, 'REQUEST_ID_REUSED'); assert.equal(operations.started, 0);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('rechecks the immutable admission binding before credentials or process activity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); let resolves = 0;
  const authority: TaskAdmissionAuthority = { resolveAdmission: async () => ++resolves === 1 ? ADMISSION : { ...ADMISSION, bindingRevision: '2' } };
  const registry = new AgentRegistry(authority, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000012', '0')); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000012', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' });
    assert.equal(result.kind, 'refused'); assert.equal(result.code, 'PROJECT_BINDING_CHANGED'); assert.equal(result.attempt?.state, 'cleaned'); assert.equal(operations.started, 0); assert.equal(operations.processes.length, 0);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('expires the persisted first-activity generation and cleans the host', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const priorState = process.env.KOGG_STATE_DIR; const priorDeadline = process.env.KOGG_AGENT_TEST_DEADLINES; process.env.KOGG_STATE_DIR = directory; process.env.KOGG_AGENT_TEST_DEADLINES = '1';
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000003', '0', 'fixture.hang')); assert.ok(role.role);
    const result = await registry.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000003', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.hang', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(result.attempt);
    const terminal = await poll(() => registry.getAttempt(result.attempt!.attemptId), value => value.state === 'cleaned');
    assert.equal(terminal.terminalCode, 'FIRST_ACTIVITY_TIMEOUT'); assert.equal(terminal.ownedResourceCount, '0'); assert.equal(operations.processes.every(process => process.cleaned), true);
  } finally { await registry.onStop(); if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState; if (priorDeadline === undefined) delete process.env.KOGG_AGENT_TEST_DEADLINES; else process.env.KOGG_AGENT_TEST_DEADLINES = priorDeadline; await rm(directory, { recursive: true, force: true }); }
});

test('reconciles a durable nonterminal attempt without replay when no resource exists', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const authority: TaskAdmissionAuthority = { resolveAdmission: async () => ADMISSION }; const first = new AgentRegistry(authority, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); let second: AgentRegistry | undefined;
  try {
    await first.onStart(); const role = await first.createRoleRevision(roleRequest('20000000-0000-4000-8000-000000000004', '0')); assert.ok(role.role);
    const refused = await first.startAttempt({ schemaVersion: '1', requestId: '30000000-0000-4000-8000-000000000004', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'missing.adapter', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(refused.attempt);
    const seam = first as unknown as { transition(id: string, state: 'active'): void; database?: { close(): void } }; seam.transition(refused.attempt.attemptId, 'active'); seam.database?.close();
    second = new AgentRegistry(authority, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); await second.onStart(); const recovered = await second.getAttempt(refused.attempt.attemptId);
    assert.equal(recovered.state, 'recovered_terminal'); assert.equal(recovered.terminalCode, 'RECOVERY_REQUIRED'); assert.equal((await second.snapshot()).admission, 'enabled');
  } finally { await second?.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('accepts only an exact operations-owner cleanup proof during startup recovery', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const authority: TaskAdmissionAuthority = { resolveAdmission: async () => ADMISSION }; const first = new AgentRegistry(authority, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); let second: AgentRegistry | undefined;
  try {
    await first.onStart(); const role = await first.createRoleRevision(roleRequest('25000000-0000-4000-8000-000000000001', '0')); assert.ok(role.role);
    const refused = await first.startAttempt({ schemaVersion: '1', requestId: '35000000-0000-4000-8000-000000000001', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'missing.adapter', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(refused.attempt);
    const seam = first as unknown as { transition(id: string, state: 'active'): void; database?: DatabaseSync }; seam.transition(refused.attempt.attemptId, 'active'); const resourceId = crypto.randomUUID(); const operationId = crypto.randomUUID(); seam.database?.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?)').run(resourceId, refused.attempt.attemptId, operationId, 'kogg', 'provider-host', 'registered'); seam.database?.prepare('UPDATE attempts SET owned_resource_count=1 WHERE attempt_id=?').run(refused.attempt.attemptId); seam.database?.close();
    second = new AgentRegistry(authority, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); await second.onStart(); const recovered = await second.getAttempt(refused.attempt.attemptId);
    assert.equal(recovered.state, 'recovered_terminal'); assert.equal(recovered.terminalCode, 'RECOVERY_REQUIRED'); assert.equal(recovered.ownedResourceCount, '0'); assert.equal((await second.snapshot()).admission, 'enabled');
  } finally { await second?.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('blocks startup admission when the operations owner cannot verify a persisted resource', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const authority: TaskAdmissionAuthority = { resolveAdmission: async () => ADMISSION }; const first = new AgentRegistry(authority, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); let second: AgentRegistry | undefined;
  try {
    await first.onStart(); const role = await first.createRoleRevision(roleRequest('25000000-0000-4000-8000-000000000002', '0')); assert.ok(role.role);
    const refused = await first.startAttempt({ schemaVersion: '1', requestId: '35000000-0000-4000-8000-000000000002', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'missing.adapter', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(refused.attempt);
    const seam = first as unknown as { transition(id: string, state: 'active'): void; database?: DatabaseSync }; seam.transition(refused.attempt.attemptId, 'active'); seam.database?.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), refused.attempt.attemptId, crypto.randomUUID(), 'kogg', 'provider-host', 'registered'); seam.database?.prepare('UPDATE attempts SET owned_resource_count=1 WHERE attempt_id=?').run(refused.attempt.attemptId); seam.database?.close();
    const operations = new TestOperations(); operations.recoveryStatus = 'unverified'; second = new AgentRegistry(authority, operations, new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); await second.onStart(); const recovered = await second.getAttempt(refused.attempt.attemptId);
    assert.equal(recovered.state, 'unverified_residual'); assert.equal(recovered.terminalCode, 'RESOURCE_IDENTITY_UNVERIFIED'); assert.equal(recovered.ownedResourceCount, '1'); assert.equal((await second.snapshot()).admission, 'blocked');
  } finally { await second?.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('fails startup with a closed integrity code and never echoes a corrupt registry path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-corrupt-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory; const databasePath = path.join(directory, 'agents', 'registry.sqlite3'); await mkdir(path.dirname(databasePath), { recursive: true }); await writeFile(databasePath, 'not-a-sqlite-database');
  const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const captured: string[] = []; const original = console.error; console.error = (...values: unknown[]) => { captured.push(JSON.stringify(values)); };
  try { await assert.rejects(() => registry.onStart(), error => error instanceof Error && error.message === 'AGENT_REGISTRY_INTEGRITY_FAILED'); assert.equal(captured.join('\n').includes(directory), false); assert.match(captured.join('\n'), /AGENT_REGISTRY_INTEGRITY_FAILED/u); }
  finally { console.error = original; if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('returns a typed busy failure without mutation and succeeds after lock release', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-busy-')); const priorState = process.env.KOGG_STATE_DIR; const priorDeadline = process.env.KOGG_AGENT_TEST_DEADLINES; process.env.KOGG_STATE_DIR = directory; process.env.KOGG_AGENT_TEST_DEADLINES = '1'; const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); let blocker: DatabaseSync | undefined;
  try {
    await registry.onStart(); blocker = new DatabaseSync(path.join(directory, 'agents', 'registry.sqlite3')); blocker.exec('PRAGMA busy_timeout=50; BEGIN IMMEDIATE;');
    const busy = await registry.createRoleRevision(roleRequest('24000000-0000-4000-8000-000000000001', '0')); assert.equal(busy.kind, 'failed'); assert.equal(busy.code, 'AGENT_REGISTRY_BUSY'); assert.equal((await registry.snapshot()).roles.length, 0);
    blocker.exec('ROLLBACK'); blocker.close(); blocker = undefined; const completed = await registry.createRoleRevision(roleRequest('24000000-0000-4000-8000-000000000002', '0')); assert.equal(completed.kind, 'completed');
  } finally { try { blocker?.exec('ROLLBACK'); } catch { /* observability-exempt: test teardown handles an already released SQLite lock. */ } blocker?.close(); await registry.onStop(); if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState; if (priorDeadline === undefined) delete process.env.KOGG_AGENT_TEST_DEADLINES; else process.env.KOGG_AGENT_TEST_DEADLINES = priorDeadline; await rm(directory, { recursive: true, force: true }); }
});

test('fails startup with a closed permission code when the registry file is unreadable', async () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-permission-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory; const databasePath = path.join(directory, 'agents', 'registry.sqlite3'); await mkdir(path.dirname(databasePath), { recursive: true }); await writeFile(databasePath, ''); await chmod(databasePath, 0o000); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, new TestOperations(), new AdapterRegistry(), new LocalCredentialLeaseAuthority(), MODE_AUTHORITY);
  try { await assert.rejects(() => registry.onStart(), error => error instanceof Error && error.message === 'AGENT_REGISTRY_PERMISSION_FAILED'); }
  finally { await chmod(databasePath, 0o600); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('classifies adapter, provider, usage, model, and deadline failures with zero residuals', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const priorState = process.env.KOGG_STATE_DIR; const priorDeadline = process.env.KOGG_AGENT_TEST_DEADLINES; process.env.KOGG_STATE_DIR = directory; process.env.KOGG_AGENT_TEST_DEADLINES = '1';
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters);
  const cases = [
    ['fixture.refuse', 'PROVIDER_REFUSED'],
    ['fixture.auth', 'PROVIDER_AUTH_REFUSED'],
    ['fixture.rate', 'PROVIDER_RATE_LIMITED'],
    ['fixture.transport', 'TRANSPORT_LOST'],
    ['fixture.invalid', 'ADAPTER_OBSERVATION_INVALID'],
    ['fixture.model-mismatch', 'MODEL_MISMATCH'],
    ['fixture.stdin-close', 'MODEL_MISMATCH'],
    ['fixture.handshake', 'HANDSHAKE_TIMEOUT'],
    ['fixture.idle', 'IDLE_TIMEOUT'],
    ['fixture.provider-request', 'PROVIDER_REQUEST_TIMEOUT'],
    ['fixture.absolute', 'ABSOLUTE_TIMEOUT'],
    ['fixture.usage-decrease', 'AGENT_OK'],
    ['fixture.usage-mode-switch', 'AGENT_OK'],
    ['fixture.usage-overflow', 'AGENT_OK']
  ] as const;
  try {
    await registry.onStart(); fixture.onStart();
    for (const [index, [model, code]] of cases.entries()) {
      const role = await registry.createRoleRevision(roleRequest(`21000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, (await registry.snapshot()).registryRevision, model)); assert.ok(role.role);
      const result = await registry.startAttempt({ schemaVersion: '1', requestId: `31000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: model, adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(result.attempt);
      const terminal = await poll(() => registry.getAttempt(result.attempt!.attemptId), value => value.state === 'cleaned'); assert.equal(terminal.terminalCode, code, model); assert.equal(terminal.ownedResourceCount, '0', model);
      if (model.startsWith('fixture.usage-')) assert.equal(terminal.usage.status, 'invalid');
    }
    assert.equal(registry.diagnostics().residualCount, 0); assert.equal(operations.processes.every(process => process.cleaned), true);
  } finally { await registry.onStop(); if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState; if (priorDeadline === undefined) delete process.env.KOGG_AGENT_TEST_DEADLINES; else process.env.KOGG_AGENT_TEST_DEADLINES = priorDeadline; await rm(directory, { recursive: true, force: true }); }
});

test('cancels a ready streaming host and commits zero-resource cleanup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('22000000-0000-4000-8000-000000000001', '0', 'fixture.hang')); assert.ok(role.role);
    const started = await registry.startAttempt({ schemaVersion: '1', requestId: '32000000-0000-4000-8000-000000000001', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.hang', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(started.attempt);
    const ready = await poll(() => registry.getAttempt(started.attempt!.attemptId), value => value.state === 'ready');
    const cancelled = await registry.cancelAttempt({ schemaVersion: '1', requestId: '42000000-0000-4000-8000-000000000001', expectedRegistryRevision: ready.registryRevision, expectedAttemptRevision: ready.attemptRevision, attemptId: ready.attemptId, reason: 'user' });
    assert.equal(cancelled.kind, 'completed'); assert.equal(cancelled.code, 'CANCELLED'); assert.equal(cancelled.attempt?.state, 'cleaned'); assert.equal(cancelled.attempt?.terminalCode, 'CANCELLED'); assert.equal(cancelled.attempt?.ownedResourceCount, '0'); assert.equal(operations.processes.every(process => process.cleaned), true);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('uses durable event order for cancellation and completion races', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart();
    const completionRole = await registry.createRoleRevision(roleRequest('24000000-0000-4000-8000-000000000001', '0', 'fixture.completion-race')); assert.ok(completionRole.role);
    const completionStarted = await registry.startAttempt({ schemaVersion: '1', requestId: '34000000-0000-4000-8000-000000000001', expectedRegistryRevision: completionRole.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: completionRole.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.completion-race', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(completionStarted.attempt);
    const completedFirst = await poll(() => registry.getAttempt(completionStarted.attempt!.attemptId), value => value.state === 'completed_observed');
    const afterLateCancel = await registry.cancelAttempt({ schemaVersion: '1', requestId: '44000000-0000-4000-8000-000000000001', expectedRegistryRevision: completedFirst.registryRevision, expectedAttemptRevision: completedFirst.attemptRevision, attemptId: completedFirst.attemptId, reason: 'user' });
    assert.equal(afterLateCancel.kind, 'completed'); assert.equal(afterLateCancel.code, 'AGENT_OK'); assert.equal(afterLateCancel.attempt?.state, 'cleaned'); assert.equal(afterLateCancel.attempt?.terminalCode, 'AGENT_OK');

    const cancelRole = await registry.createRoleRevision(roleRequest('24000000-0000-4000-8000-000000000002', (await registry.snapshot()).registryRevision, 'fixture.cancel-race')); assert.ok(cancelRole.role);
    const cancelStarted = await registry.startAttempt({ schemaVersion: '1', requestId: '34000000-0000-4000-8000-000000000002', expectedRegistryRevision: cancelRole.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: cancelRole.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.cancel-race', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(cancelStarted.attempt);
    const ready = await poll(() => registry.getAttempt(cancelStarted.attempt!.attemptId), value => value.state === 'ready');
    const afterLateCompletion = await registry.cancelAttempt({ schemaVersion: '1', requestId: '44000000-0000-4000-8000-000000000002', expectedRegistryRevision: ready.registryRevision, expectedAttemptRevision: ready.attemptRevision, attemptId: ready.attemptId, reason: 'user' });
    assert.equal(afterLateCompletion.kind, 'completed'); assert.equal(afterLateCompletion.code, 'CANCELLED'); assert.equal(afterLateCompletion.attempt?.state, 'cleaned'); assert.equal(afterLateCompletion.attempt?.terminalCode, 'CANCELLED'); assert.equal(operations.processes.every(process => process.cleaned), true); assert.equal(registry.diagnostics().residualCount, 0);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('escalates an unacknowledged cancel at its persisted grace deadline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const priorState = process.env.KOGG_STATE_DIR; const priorDeadline = process.env.KOGG_AGENT_TEST_DEADLINES; process.env.KOGG_STATE_DIR = directory; process.env.KOGG_AGENT_TEST_DEADLINES = '1';
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters);
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
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart(); const role = await registry.createRoleRevision(roleRequest('22000000-0000-4000-8000-000000000003', '0', 'fixture.cleanup-hang')); assert.ok(role.role);
    const started = await registry.startAttempt({ schemaVersion: '1', requestId: '32000000-0000-4000-8000-000000000003', expectedRegistryRevision: role.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: role.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.cleanup-hang', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(started.attempt);
    const terminal = await poll(() => registry.getAttempt(started.attempt!.attemptId), value => value.state === 'cleanup_failed');
    assert.equal(terminal.terminalCode, 'CLEANUP_FAILED'); assert.equal(terminal.ownedResourceCount, '1'); assert.equal((await registry.snapshot()).admission, 'blocked'); assert.equal(registry.diagnostics().residualCount, 1);
  } finally { await registry.onStop(); if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState; if (priorDeadline === undefined) delete process.env.KOGG_AGENT_TEST_DEADLINES; else process.env.KOGG_AGENT_TEST_DEADLINES = priorDeadline; await rm(directory, { recursive: true, force: true }); }
});

test('refuses child authority expansion before spawn and joins descendants on parent cancellation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-agents-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = directory;
  const adapters = new AdapterRegistry(); const operations = new TestOperations(); const registry = new AgentRegistry({ resolveAdmission: async () => ADMISSION }, operations, adapters, new LocalCredentialLeaseAuthority(), MODE_AUTHORITY); const fixture = new FixtureAdapter(adapters);
  try {
    await registry.onStart(); fixture.onStart();
    const parentRole = await registry.createRoleRevision(childRoleRequest('23000000-0000-4000-8000-000000000001', '0', 'coordinator', ['read-only'], true, ['implementer'], ['fixture.hang', 'fixture.echo'])); assert.ok(parentRole.role);
    const childRole = await registry.createRoleRevision(childRoleRequest('23000000-0000-4000-8000-000000000002', parentRole.registryRevision, 'implementer', ['read-only'], false, [], ['fixture.hang'])); assert.ok(childRole.role);
    const expandedRole = await registry.createRoleRevision(childRoleRequest('23000000-0000-4000-8000-000000000003', childRole.registryRevision, 'implementer', ['read-only', 'write'], false, [], ['fixture.echo'])); assert.ok(expandedRole.role);
    const parentStarted = await registry.startAttempt({ schemaVersion: '1', requestId: '33000000-0000-4000-8000-000000000001', expectedRegistryRevision: expandedRole.registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: parentRole.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.hang', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1' }); assert.ok(parentStarted.attempt);
    const parentReady = await poll(() => registry.getAttempt(parentStarted.attempt!.attemptId), value => value.state === 'ready');
    const expanded = await registry.startAttempt({ schemaVersion: '1', requestId: '33000000-0000-4000-8000-000000000002', expectedRegistryRevision: (await registry.snapshot()).registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: expandedRole.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1', parentAttemptId: parentReady.attemptId });
    assert.equal(expanded.kind, 'refused'); assert.equal(expanded.code, 'CHILD_AUTHORITY_EXPANSION'); assert.equal(expanded.attempt?.state, 'cleaned'); assert.equal(expanded.attempt?.taskId, ADMISSION.taskId); assert.equal(expanded.attempt?.projectId, ADMISSION.projectId); assert.equal(expanded.attempt?.ownedResourceCount, '0'); assert.equal(operations.started, 1);
    const childStarted = await registry.startAttempt({ schemaVersion: '1', requestId: '33000000-0000-4000-8000-000000000003', expectedRegistryRevision: (await registry.snapshot()).registryRevision, taskAdmissionId: ADMISSION.taskAdmissionId, roleRevisionId: childRole.role.roleRevisionId, providerId: 'kogg.fixture', modelId: 'fixture.hang', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'interactive-v1', parentAttemptId: parentReady.attemptId }); assert.ok(childStarted.attempt);
    const childReady = await poll(() => registry.getAttempt(childStarted.attempt!.attemptId), value => value.state === 'ready'); assert.equal(childReady.parentAttemptId, parentReady.attemptId); assert.equal(childReady.rootAttemptId, parentReady.attemptId);
    const currentParent = await registry.getAttempt(parentReady.attemptId); assert.equal(currentParent.childCount, '1');
    const cancelled = await registry.cancelAttempt({ schemaVersion: '1', requestId: '43000000-0000-4000-8000-000000000001', expectedRegistryRevision: (await registry.snapshot()).registryRevision, expectedAttemptRevision: currentParent.attemptRevision, attemptId: currentParent.attemptId, reason: 'user' });
    assert.equal(cancelled.kind, 'completed'); assert.equal(cancelled.attempt?.state, 'cleaned'); assert.equal(cancelled.attempt?.terminalCode, 'CANCELLED'); const childTerminal = await registry.getAttempt(childReady.attemptId); assert.equal(childTerminal.state, 'cleaned'); assert.equal(childTerminal.terminalCode, 'CANCELLED'); assert.equal(operations.started, 2); assert.equal(operations.processes.every(process => process.cleaned), true); assert.equal(registry.diagnostics().residualCount, 0);
  } finally { await registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

function roleRequest(requestId: string, expectedRegistryRevision: string, model = 'fixture.echo') { return { schemaVersion: '1' as const, requestId, expectedRegistryRevision, roleKey: 'implementer', displayName: 'Implementer', authority: { capabilityIds: ['provider-turn'], toolPolicyIds: ['read-only'], mayCreateChildren: false, permittedChildRoleKeys: [], maxChildDepth: '0', maxDirectChildren: '0' }, providerPolicy: { permittedProviderIds: ['kogg.fixture'], permittedModelIds: [model], requiredAdapterCapabilities: ['provider-turn'] }, budgetPolicyId: 'fixture-budget' }; }
function childRoleRequest(requestId: string, expectedRegistryRevision: string, roleKey: string, toolPolicyIds: string[], mayCreateChildren: boolean, permittedChildRoleKeys: string[], models: string[]) { return { schemaVersion: '1' as const, requestId, expectedRegistryRevision, roleKey, displayName: roleKey, authority: { capabilityIds: ['provider-turn'], toolPolicyIds, mayCreateChildren, permittedChildRoleKeys, maxChildDepth: mayCreateChildren ? '2' : '0', maxDirectChildren: mayCreateChildren ? '2' : '0' }, providerPolicy: { permittedProviderIds: ['kogg.fixture'], permittedModelIds: models, requiredAdapterCapabilities: ['provider-turn'] }, budgetPolicyId: 'fixture-budget' }; }
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 120_000; while (Date.now() < deadline) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Timed out polling attempt'); }

class TestOperations implements OperationRegistryApi {
  started = 0; readonly processes: TestProcess[] = []; recoveryStatus: 'cleaned' | 'unverified' | 'active' | 'missing' = 'cleaned';
  async startOperation(operation: StartOperation): Promise<OperationLease> { this.started++; const id = operation.id ?? crypto.randomUUID(); return { id, cancellable: true, start: () => undefined, active: () => undefined, waiting: () => undefined, activity: () => undefined, refuse: () => undefined, complete: () => undefined, fail: () => undefined, timeout: () => undefined, cancel: async () => undefined, cleanup: async run => { await run?.(); }, registerProcess: process => { const lease = new TestProcess(process); this.processes.push(lease); return lease; } }; }
  async snapshot() { return { schemaVersion: 1 as const, revision: 1, admission: 'enabled' as const, active: [], recent: [] }; }
  async cancel() { return this.snapshot(); }
  async recoveryResult() { return { status: this.recoveryStatus }; }
  async processExecutionAttestation() { return undefined; }
  diagnostics() { return { integrity: true, foreignKeys: true, permissions: true, recoveryComplete: true, activeCount: 0, stalledCount: 0, residualCount: 0, cleanupFailureCount: 0, admission: 'enabled' as const }; }
}
class TestProcess implements ProcessLease { cleaned = false; constructor(readonly input: StartProcess) {} readonly id = crypto.randomUUID(); spawning(): void {} started(): void {} ready(): void {} activity(): void {} failed(): void {} exited(): void {} cleanup(): void { this.cleaned = true; } }
