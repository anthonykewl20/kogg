import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { TaskProjection } from '@kogg/tasks/lib/common/tasks-protocol';
import { InteractionModeError, InteractionModeRegistry } from './interaction-mode-registry';
import { ModeTransitionAuthority, transitionScopeDigest } from './mode-transition-authority';

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
