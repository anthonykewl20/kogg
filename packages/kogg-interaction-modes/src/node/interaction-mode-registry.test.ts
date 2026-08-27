import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { TaskProjection } from '@kogg/tasks/lib/common/tasks-protocol';
import { InteractionModeError, InteractionModeRegistry } from './interaction-mode-registry';
import { ModeTransitionAuthority, transitionScopeDigest } from './mode-transition-authority';
import type { ModeTransitionConfigurationV1, ModeTransitionOwnerContribution } from '../common/interaction-modes-protocol';

// diagnostic-coverage: interaction-modes.registry, interaction-modes.authority, interaction-modes.operations, interaction-modes.restoration
test('persists Plan as the task default and enforces the closed operation ceiling across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-modes-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const authority = new TaskAuthority(); const first = registry(authority); await first.onStart();
  try {
    const projection = await first.get({ requestId: '10000000-0000-4000-8000-000000000001', taskId: TASK.taskId });
    assert.equal(projection.selectedMode, 'plan'); assert.equal(projection.state, 'ready'); assert.equal(projection.sequence, '0');
    assert.deepEqual(projection.effectiveCapabilities, ['research.read', 'plan.write', 'plan.approval-request', 'provider.invoke-advisory']);
    const read = await first.authorizeOperation({ requestId: '10000000-0000-4000-8000-000000000002', taskId: TASK.taskId, operation: 'research' });
    assert.equal(read.allowed, true); assert.equal(read.safeCode, 'MODE_OK');
    const mutationRequest = { requestId: '10000000-0000-4000-8000-000000000003', taskId: TASK.taskId, operation: 'private-mutate' as const };
    const refused = await first.authorizeOperation(mutationRequest); assert.equal(refused.allowed, false); assert.equal(refused.safeCode, 'PLAN_MUTATION_REFUSED');
    assert.deepEqual(await first.authorizeOperation(mutationRequest), refused);
    await assert.rejects(() => first.authorizeOperation({ ...mutationRequest, operation: 'merge-controlled' }), error => error instanceof InteractionModeError && error.code === 'MODE_REQUEST_CONFLICT');
    assert.equal(first.diagnostics().modeCount, 1); assert.equal(first.diagnostics().eventChain, true); assert.equal(first.diagnostics().modeStateConsistent, true); assert.equal(first.diagnostics().immutableRequestLedgers, true); first.onStop();
    const restored = registry(authority); await restored.onStart();
    try { assert.equal((await restored.get({ requestId: '10000000-0000-4000-8000-000000000004', taskId: TASK.taskId })).selectedMode, 'plan'); assert.equal(restored.diagnostics().eventChain, true); }
    finally { restored.onStop(); }
  } finally { first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('blocks startup when the selected mode and effective authority digest diverge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-mode-state-integrity-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const first = registry(new TaskAuthority()); await first.onStart();
  try {
    await first.get({ requestId: '41000000-0000-4000-8000-000000000001', taskId: TASK.taskId }); first.onStop();
    const database = new DatabaseSync(path.join(root, 'interaction-modes', 'registry.sqlite3')); database.prepare("UPDATE task_modes SET selected_mode='build' WHERE task_id=?").run(TASK.taskId); database.close();
    const recovered = registry(new TaskAuthority()); await assert.rejects(() => recovered.onStart(), error => error instanceof InteractionModeError && error.code === 'MODE_REGISTRY_INTEGRITY_FAILED'); recovered.onStop();
  } finally { first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('makes operation and transition request receipts immutable and requires every guard at startup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-request-integrity-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const first = registry(new TaskAuthority()); await first.onStart();
  try {
    await first.get({ requestId: '42000000-0000-4000-8000-000000000001', taskId: TASK.taskId }); await first.authorizeOperation({ requestId: '42000000-0000-4000-8000-000000000002', taskId: TASK.taskId, operation: 'research' }); first.onStop();
    const database = new DatabaseSync(path.join(root, 'interaction-modes', 'registry.sqlite3'));
    assert.throws(() => database.prepare("UPDATE requests SET request_digest='tampered'").run(), /immutable mode request/u); database.exec('DROP TRIGGER mode_requests_no_update'); database.prepare("UPDATE requests SET request_digest='tampered'").run(); database.close();
    const recovered = registry(new TaskAuthority()); await assert.rejects(() => recovered.onStart(), error => error instanceof InteractionModeError && error.code === 'MODE_REGISTRY_INTEGRITY_FAILED'); recovered.onStop();
  } finally { first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('safely rebinds least-privilege Plan authority after an exact task revision advances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-drift-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const authority = new TaskAuthority(); const registry = createRegistry(authority); await registry.onStart();
  try {
    await registry.get({ requestId: '20000000-0000-4000-8000-000000000001', taskId: TASK.taskId });
    const priorAllowedRequest = { requestId: '20000000-0000-4000-8000-000000000004', taskId: TASK.taskId, operation: 'research' as const };
    assert.equal((await registry.authorizeOperation(priorAllowedRequest)).allowed, true); authority.revision = '2';
    const restored = await registry.get({ requestId: '20000000-0000-4000-8000-000000000002', taskId: TASK.taskId });
    assert.equal(restored.state, 'ready'); assert.equal(restored.safeCode, 'MODE_OK'); assert.equal(restored.taskRevision, '2'); assert.equal(restored.sequence, '0');
    const allowed = await registry.authorizeOperation({ requestId: '20000000-0000-4000-8000-000000000003', taskId: TASK.taskId, operation: 'research' });
    assert.equal(allowed.allowed, true); assert.equal(allowed.safeCode, 'MODE_OK');
    const replayAfterDrift = await registry.authorizeOperation(priorAllowedRequest); assert.equal(replayAfterDrift.allowed, false); assert.equal(replayAfterDrift.safeCode, 'MODE_TASK_STALE');
    registry.onStop(); await registry.onStart(); assert.equal((await registry.get({ requestId: '20000000-0000-4000-8000-000000000005', taskId: TASK.taskId })).state, 'ready');
  } finally { registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('blocks startup when the immutable mode event chain is corrupted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-integrity-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const first = registry(new TaskAuthority()); await first.onStart();
  try {
    await first.get({ requestId: '40000000-0000-4000-8000-000000000001', taskId: TASK.taskId }); first.onStop();
    const database = new DatabaseSync(path.join(root, 'interaction-modes', 'registry.sqlite3'));
    database.exec('DROP TRIGGER mode_events_no_update'); database.prepare('UPDATE mode_events SET event_digest=? WHERE sequence=1').run(`sha256:${'f'.repeat(64)}`); database.close();
    const recovered = registry(new TaskAuthority());
    await assert.rejects(() => recovered.onStart(), error => error instanceof InteractionModeError && error.code === 'MODE_REGISTRY_INTEGRITY_FAILED'); recovered.onStop();
  } finally { first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('durably freezes admission for an authenticated expansion intent and permits explicit cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-transition-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const tasks = new TaskAuthority(); const transitionAuthority = new ModeTransitionAuthority(); const first = new InteractionModeRegistry(tasks, transitionAuthority); await first.onStart();
  const request = { transitionId: '50000000-0000-4000-8000-000000000001', requestId: '50000000-0000-4000-8000-000000000002', taskId: TASK.taskId, expectedSequence: '0', fromMode: 'plan' as const, toMode: 'build' as const, requestedConfigurationDigest: `sha256:${'a'.repeat(64)}` };
  const actor = { sessionId: 'test-session', actorAuthorityDigest: `sha256:${'b'.repeat(64)}`, role: 'owner' as const, originVerified: true as const, csrfVerified: true as const };
  try {
    await first.get({ requestId: '50000000-0000-4000-8000-000000000003', taskId: TASK.taskId });
    await assert.rejects(() => first.requestTransition(request, { scopeDigest: transitionScopeDigest('request', request) }), error => error instanceof InteractionModeError && error.code === 'MODE_AUTHORITY_REFUSED');
    assert.equal(first.diagnostics().transitionCount, 0);
    const context = transitionAuthority.mint(actor, transitionScopeDigest('request', request)); const pending = await first.requestTransition(request, context);
    assert.equal(pending.direction, 'expand'); assert.equal(pending.state, 'awaiting-confirmation'); assert.equal(pending.safeCode, 'MODE_EXPANSION_CONFIRMATION_REQUIRED'); assert.match(pending.challengeDigest ?? '', /^sha256:/); assert.equal(pending.mode.state, 'transition-pending'); assert.deepEqual(pending.mode.effectiveCapabilities, []);
    assert.deepEqual(await first.requestTransition(request, context), pending);
    const blocked = await first.authorizeOperation({ requestId: '50000000-0000-4000-8000-000000000004', taskId: TASK.taskId, operation: 'research' }); assert.equal(blocked.allowed, false); assert.equal(blocked.safeCode, 'MODE_ACTIVE_OPERATION');
    assert.equal(first.diagnostics().pendingTransitionCount, 1); first.onStop();

    const restoredAuthority = new ModeTransitionAuthority(); const restored = new InteractionModeRegistry(tasks, restoredAuthority); await restored.onStart();
    try {
      const restoredMode = await restored.get({ requestId: '50000000-0000-4000-8000-000000000005', taskId: TASK.taskId }); assert.equal(restoredMode.state, 'transition-pending'); assert.deepEqual(restoredMode.effectiveCapabilities, []);
      const restoredTransition = await restored.getPendingTransition({ requestId: '50000000-0000-4000-8000-000000000008', taskId: TASK.taskId });
      assert.equal(restoredTransition?.transitionId, request.transitionId); assert.equal(restoredTransition?.state, 'awaiting-confirmation'); assert.deepEqual(restoredTransition?.mode.effectiveCapabilities, []);
      const cancel = { requestId: '50000000-0000-4000-8000-000000000006', transitionId: request.transitionId, taskId: TASK.taskId }; const cancelContext = restoredAuthority.mint(actor, transitionScopeDigest('cancel', cancel));
      const cancelled = await restored.cancelTransition(cancel, cancelContext); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.mode.state, 'ready'); assert.deepEqual(await restored.cancelTransition(cancel, cancelContext), cancelled);
      assert.equal((await restored.authorizeOperation({ requestId: '50000000-0000-4000-8000-000000000007', taskId: TASK.taskId, operation: 'research' })).allowed, true);
      assert.equal(restored.diagnostics().pendingTransitionCount, 0); assert.equal(restored.diagnostics().eventChain, true);
    } finally { restored.onStop(); }
  } finally { first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('expires an unconfirmed expansion after restart without granting authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-expiry-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const tasks = new TaskAuthority(); const authority = new ModeTransitionAuthority(); let now = Date.parse('2026-08-27T00:00:00.000Z'); const clock = (): Date => new Date(now); const first = new InteractionModeRegistry(tasks, authority, clock); await first.onStart();
  const request = { transitionId: '60000000-0000-4000-8000-000000000001', requestId: '60000000-0000-4000-8000-000000000002', taskId: TASK.taskId, expectedSequence: '0', fromMode: 'plan' as const, toMode: 'kogg' as const, requestedConfigurationDigest: `sha256:${'c'.repeat(64)}` };
  const actor = { sessionId: 'expiry-session', actorAuthorityDigest: `sha256:${'d'.repeat(64)}`, role: 'owner' as const, originVerified: true as const, csrfVerified: true as const };
  try {
    await first.get({ requestId: '60000000-0000-4000-8000-000000000003', taskId: TASK.taskId }); await first.requestTransition(request, authority.mint(actor, transitionScopeDigest('request', request))); first.onStop(); now += 120_001;
    const restored = new InteractionModeRegistry(tasks, new ModeTransitionAuthority(), clock); await restored.onStart();
    try { const mode = await restored.get({ requestId: '60000000-0000-4000-8000-000000000004', taskId: TASK.taskId }); assert.equal(mode.state, 'ready'); assert.equal(mode.selectedMode, 'plan'); assert.equal(mode.safeCode, 'MODE_OK'); assert.equal(restored.diagnostics().pendingTransitionCount, 0); assert.equal(restored.diagnostics().eventChain, true); }
    finally { restored.onStop(); }
  } finally { first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('commits only after exact challenge-bound owner qualification and replays without repeating owners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-confirm-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const tasks = new TaskAuthority(); const authority = new ModeTransitionAuthority(); const model = new InteractionModeRegistry(tasks, authority); await model.onStart(); let ownerCalls = 0;
  const actor = { sessionId: 'confirm-session', actorAuthorityDigest: `sha256:${'9'.repeat(64)}`, role: 'owner' as const, originVerified: true as const, csrfVerified: true as const };
  const configuration = { schemaVersion: 1, kind: 'build', roleRevisionId: '90000000-0000-4000-8000-000000000001', providerId: 'fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'standard', targetId: 'qualified-linux' } as const;
  const owners = (['operations', 'agent-binding', 'execution-target'] as const).map(owner => ({ owner, async qualifyTransition() { ownerCalls++; const value = owner === 'operations' ? 'a' : owner === 'agent-binding' ? 'b' : 'c'; return { owner, qualified: true, safeCode: 'MODE_OK', proofDigest: `sha256:${value.repeat(64)}` }; } })) satisfies readonly ModeTransitionOwnerContribution[];
  try {
    await model.get({ requestId: '90000000-0000-4000-8000-000000000002', taskId: TASK.taskId });
    const transition = { transitionId: '90000000-0000-4000-8000-000000000003', requestId: '90000000-0000-4000-8000-000000000004', taskId: TASK.taskId, expectedSequence: '0', fromMode: 'plan' as const, toMode: 'build' as const, requestedConfigurationDigest: configDigest(configuration) };
    const pending = await model.requestTransition(transition, authority.mint(actor, transitionScopeDigest('request', transition)));
    const confirm = { requestId: '90000000-0000-4000-8000-000000000005', transitionId: transition.transitionId, taskId: TASK.taskId, challengeDigest: pending.challengeDigest!, explicitGesture: true as const, configuration };
    const committed = await model.confirmTransition(confirm, authority.mint(actor, transitionScopeDigest('confirm', confirm)), owners);
    assert.equal(committed.state, 'committed'); assert.equal(committed.mode.selectedMode, 'build'); assert.equal(committed.mode.sequence, '1'); assert.equal(ownerCalls, 3);
    assert.deepEqual(await model.confirmTransition(confirm, authority.mint(actor, transitionScopeDigest('confirm', confirm)), owners), committed); assert.equal(ownerCalls, 3);
    assert.equal(model.diagnostics().eventChain, true); assert.equal(model.diagnostics().pendingTransitionCount, 0);

    const planConfiguration = { schemaVersion: 1, kind: 'plan' } as const;
    const reduction = { transitionId: '90000000-0000-4000-8000-000000000006', requestId: '90000000-0000-4000-8000-000000000007', taskId: TASK.taskId, expectedSequence: '1', fromMode: 'build' as const, toMode: 'plan' as const, requestedConfigurationDigest: configDigest(planConfiguration) };
    await model.requestTransition(reduction, authority.mint(actor, transitionScopeDigest('request', reduction)));
    const reduce = { requestId: '90000000-0000-4000-8000-000000000008', transitionId: reduction.transitionId, taskId: TASK.taskId, explicitGesture: true as const, configuration: planConfiguration };
    const reduced = await model.confirmTransition(reduce, authority.mint(actor, transitionScopeDigest('confirm', reduce)), [owners[0]!]);
    assert.equal(reduced.mode.selectedMode, 'plan'); assert.equal(reduced.mode.sequence, '2');
  } finally { model.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('refuses an expansion without every required real owner and never widens mode authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-owner-refusal-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const authority = new ModeTransitionAuthority(); const model = new InteractionModeRegistry(new TaskAuthority(), authority); await model.onStart();
  const actor = { sessionId: 'refusal-session', actorAuthorityDigest: `sha256:${'8'.repeat(64)}`, role: 'owner' as const, originVerified: true as const, csrfVerified: true as const };
  const configuration = { schemaVersion: 1, kind: 'build', roleRevisionId: '91000000-0000-4000-8000-000000000001', providerId: 'fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'standard', targetId: 'qualified-linux' } as const;
  try {
    await model.get({ requestId: '91000000-0000-4000-8000-000000000002', taskId: TASK.taskId });
    const transition = { transitionId: '91000000-0000-4000-8000-000000000003', requestId: '91000000-0000-4000-8000-000000000004', taskId: TASK.taskId, expectedSequence: '0', fromMode: 'plan' as const, toMode: 'build' as const, requestedConfigurationDigest: configDigest(configuration) };
    const pending = await model.requestTransition(transition, authority.mint(actor, transitionScopeDigest('request', transition)));
    const confirm = { requestId: '91000000-0000-4000-8000-000000000005', transitionId: transition.transitionId, taskId: TASK.taskId, challengeDigest: pending.challengeDigest!, explicitGesture: true as const, configuration };
    const refused = await model.confirmTransition(confirm, authority.mint(actor, transitionScopeDigest('confirm', confirm)), []);
    assert.equal(refused.state, 'quarantined'); assert.equal(refused.safeCode, 'MODE_CLEANUP_FAILED'); assert.equal(refused.mode.selectedMode, 'plan'); assert.equal(refused.mode.sequence, '0'); assert.equal(refused.mode.state, 'ready'); assert.equal(model.diagnostics().eventChain, true);
  } finally { model.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('refuses the final CAS when the task binding changes during owner qualification', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-owner-race-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const tasks = new TaskAuthority(); const authority = new ModeTransitionAuthority(); const model = new InteractionModeRegistry(tasks, authority); await model.onStart();
  const actor = { sessionId: 'race-session', actorAuthorityDigest: `sha256:${'7'.repeat(64)}`, role: 'owner' as const, originVerified: true as const, csrfVerified: true as const };
  const configuration = { schemaVersion: 1, kind: 'build', roleRevisionId: '92000000-0000-4000-8000-000000000001', providerId: 'fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'standard', targetId: 'qualified-linux' } as const;
  const owners = (['operations', 'agent-binding', 'execution-target'] as const).map(owner => ({ owner, async qualifyTransition() { if (owner === 'execution-target') tasks.revision = '2'; return { owner, qualified: true, safeCode: 'MODE_OK', proofDigest: `sha256:${'6'.repeat(64)}` }; } })) satisfies readonly ModeTransitionOwnerContribution[];
  try {
    await model.get({ requestId: '92000000-0000-4000-8000-000000000002', taskId: TASK.taskId });
    const transition = { transitionId: '92000000-0000-4000-8000-000000000003', requestId: '92000000-0000-4000-8000-000000000004', taskId: TASK.taskId, expectedSequence: '0', fromMode: 'plan' as const, toMode: 'build' as const, requestedConfigurationDigest: configDigest(configuration) };
    const pending = await model.requestTransition(transition, authority.mint(actor, transitionScopeDigest('request', transition)));
    const confirm = { requestId: '92000000-0000-4000-8000-000000000005', transitionId: transition.transitionId, taskId: TASK.taskId, challengeDigest: pending.challengeDigest!, explicitGesture: true as const, configuration };
    await assert.rejects(() => model.confirmTransition(confirm, authority.mint(actor, transitionScopeDigest('confirm', confirm)), owners), error => error instanceof InteractionModeError && error.code === 'MODE_TRANSITION_CONFLICT');
    const stored = await model.getPendingTransition({ requestId: '92000000-0000-4000-8000-000000000006', taskId: TASK.taskId });
    assert.equal(stored?.state, 'awaiting-confirmation'); assert.equal(stored?.mode.selectedMode, 'plan'); assert.equal(stored?.mode.sequence, '0');
  } finally { model.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('blocks startup when a transition intent is altered outside its event-chain binding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-transition-integrity-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const tasks = new TaskAuthority(); const authority = new ModeTransitionAuthority(); const first = new InteractionModeRegistry(tasks, authority); await first.onStart();
  const request = { transitionId: '70000000-0000-4000-8000-000000000001', requestId: '70000000-0000-4000-8000-000000000002', taskId: TASK.taskId, expectedSequence: '0', fromMode: 'plan' as const, toMode: 'build' as const, requestedConfigurationDigest: `sha256:${'e'.repeat(64)}` };
  const actor = { sessionId: 'integrity-session', actorAuthorityDigest: `sha256:${'f'.repeat(64)}`, role: 'owner' as const, originVerified: true as const, csrfVerified: true as const };
  try {
    await first.get({ requestId: '70000000-0000-4000-8000-000000000003', taskId: TASK.taskId }); await first.requestTransition(request, authority.mint(actor, transitionScopeDigest('request', request))); first.onStop();
    const database = new DatabaseSync(path.join(root, 'interaction-modes', 'registry.sqlite3')); database.prepare("UPDATE mode_transitions SET to_mode='kogg' WHERE transition_id=?").run(request.transitionId); database.close();
    const recovered = registry(tasks); await assert.rejects(() => recovered.onStart(), error => error instanceof InteractionModeError && error.code === 'MODE_REGISTRY_INTEGRITY_FAILED'); recovered.onStop();
  } finally { first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

class TaskAuthority {
  revision = '1'; async get(taskId: string): Promise<TaskProjection> { return { ...TASK, taskId, taskRevision: this.revision }; }
}
function registry(authority: TaskAuthority): InteractionModeRegistry { return new InteractionModeRegistry(authority, new ModeTransitionAuthority()); }
function createRegistry(authority: TaskAuthority): InteractionModeRegistry { return registry(authority); }
const TASK: TaskProjection = { taskId: '30000000-0000-4000-8000-000000000001', projectId: '30000000-0000-4000-8000-000000000002', repositoryId: '30000000-0000-4000-8000-000000000003', bindingRevision: '1', taskRevision: '1', registryRevision: '1', lifecycle: 'active', currentSpecification: { specificationId: '30000000-0000-4000-8000-000000000004', sequence: '1', lifecycle: 'draft', content: 'canary', byteLength: 6, lineEnding: 'none', createdAt: '2026-08-27T00:00:00.000Z' } };
function configDigest(configuration: ModeTransitionConfigurationV1): string { return `sha256:${createHash('sha256').update(JSON.stringify(configuration)).digest('hex')}`; }
