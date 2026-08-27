import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { TaskProjection } from '@kogg/tasks/lib/common/tasks-protocol';
import { InteractionModeError, InteractionModeRegistry } from './interaction-mode-registry';

// diagnostic-coverage: interaction-modes.registry, interaction-modes.authority, interaction-modes.operations, interaction-modes.restoration
test('persists Plan as the task default and enforces the closed operation ceiling across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-modes-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const authority = new TaskAuthority(); const first = new InteractionModeRegistry(authority); await first.onStart();
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
    assert.equal(first.diagnostics().modeCount, 1); assert.equal(first.diagnostics().eventChain, true); first.onStop();
    const restored = new InteractionModeRegistry(authority); await restored.onStart();
    try { assert.equal((await restored.get({ requestId: '10000000-0000-4000-8000-000000000004', taskId: TASK.taskId })).selectedMode, 'plan'); assert.equal(restored.diagnostics().eventChain, true); }
    finally { restored.onStop(); }
  } finally { first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('removes effective authority when the exact task binding drifts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-drift-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const authority = new TaskAuthority(); const registry = new InteractionModeRegistry(authority); await registry.onStart();
  try {
    await registry.get({ requestId: '20000000-0000-4000-8000-000000000001', taskId: TASK.taskId });
    const priorAllowedRequest = { requestId: '20000000-0000-4000-8000-000000000004', taskId: TASK.taskId, operation: 'research' as const };
    assert.equal((await registry.authorizeOperation(priorAllowedRequest)).allowed, true); authority.revision = '2';
    const degraded = await registry.get({ requestId: '20000000-0000-4000-8000-000000000002', taskId: TASK.taskId });
    assert.equal(degraded.state, 'restore-degraded'); assert.equal(degraded.safeCode, 'MODE_RESTORE_DEGRADED'); assert.deepEqual(degraded.effectiveCapabilities, []);
    const refused = await registry.authorizeOperation({ requestId: '20000000-0000-4000-8000-000000000003', taskId: TASK.taskId, operation: 'research' });
    assert.equal(refused.allowed, false); assert.equal(refused.safeCode, 'MODE_RESTORE_DEGRADED');
    const replayAfterDrift = await registry.authorizeOperation(priorAllowedRequest); assert.equal(replayAfterDrift.allowed, false); assert.equal(replayAfterDrift.safeCode, 'MODE_RESTORE_DEGRADED');
  } finally { registry.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

test('blocks startup when the immutable mode event chain is corrupted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-integrity-')); const prior = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = root;
  const first = new InteractionModeRegistry(new TaskAuthority()); await first.onStart();
  try {
    await first.get({ requestId: '40000000-0000-4000-8000-000000000001', taskId: TASK.taskId }); first.onStop();
    const database = new DatabaseSync(path.join(root, 'interaction-modes', 'registry.sqlite3'));
    database.exec('DROP TRIGGER mode_events_no_update'); database.prepare('UPDATE mode_events SET event_digest=? WHERE sequence=1').run(`sha256:${'f'.repeat(64)}`); database.close();
    const recovered = new InteractionModeRegistry(new TaskAuthority());
    await assert.rejects(() => recovered.onStart(), error => error instanceof InteractionModeError && error.code === 'MODE_REGISTRY_INTEGRITY_FAILED'); recovered.onStop();
  } finally { first.onStop(); if (prior === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); }
});

class TaskAuthority {
  revision = '1'; async get(taskId: string): Promise<TaskProjection> { return { ...TASK, taskId, taskRevision: this.revision }; }
}
const TASK: TaskProjection = { taskId: '30000000-0000-4000-8000-000000000001', projectId: '30000000-0000-4000-8000-000000000002', repositoryId: '30000000-0000-4000-8000-000000000003', bindingRevision: '1', taskRevision: '1', registryRevision: '1', lifecycle: 'active', currentSpecification: { specificationId: '30000000-0000-4000-8000-000000000004', sequence: '1', lifecycle: 'draft', content: 'canary', byteLength: 6, lineEnding: 'none', createdAt: '2026-08-27T00:00:00.000Z' } };
