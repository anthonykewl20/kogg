import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TaskProjection } from '@kogg/tasks/lib/common/tasks-protocol';
import { InteractionModeError, InteractionModeRegistry } from './interaction-mode-registry';
import { ModeTransitionAuthority } from './mode-transition-authority';
import { InteractionModesRpcService } from './interaction-modes-rpc-service';

// diagnostic-coverage: interaction-modes.authority, interaction-modes.transitions
test('admits desktop transition intent only in Electron and preserves disabled authority until cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-desktop-'));
  const prior = { runtime: process.env.KOGG_RUNTIME, state: process.env.KOGG_STATE_DIR };
  process.env.KOGG_RUNTIME = 'electron'; process.env.KOGG_STATE_DIR = root;
  const authority = new ModeTransitionAuthority(); const registry = new InteractionModeRegistry(new TaskAuthority(), authority);
  const service = new InteractionModesRpcService(registry, authority); await registry.onStart();
  const request = {
    transitionId: '81000000-0000-4000-8000-000000000001', requestId: '81000000-0000-4000-8000-000000000002',
    taskId: TASK.taskId, expectedSequence: '0', fromMode: 'plan' as const, toMode: 'build' as const,
    requestedConfigurationDigest: `sha256:${'a'.repeat(64)}`
  };
  try {
    await service.get({ requestId: '81000000-0000-4000-8000-000000000003', taskId: TASK.taskId });
    const pending = await service.requestDesktopTransition(request);
    assert.equal(pending.state, 'awaiting-confirmation'); assert.equal(pending.mode.state, 'transition-pending');
    assert.deepEqual(pending.mode.effectiveCapabilities, []);
    const cancel = await service.cancelDesktopTransition({ requestId: '81000000-0000-4000-8000-000000000004', transitionId: request.transitionId, taskId: TASK.taskId });
    assert.equal(cancel.state, 'cancelled'); assert.equal(cancel.mode.state, 'ready');
    process.env.KOGG_RUNTIME = 'browser';
    assert.throws(() => service.requestDesktopTransition({ ...request, requestId: '81000000-0000-4000-8000-000000000005', transitionId: '81000000-0000-4000-8000-000000000006' }),
      error => error instanceof InteractionModeError && error.code === 'MODE_AUTHORITY_REFUSED');
  } finally {
    registry.onStop(); restore('KOGG_RUNTIME', prior.runtime); restore('KOGG_STATE_DIR', prior.state); await rm(root, { recursive: true, force: true });
  }
});

class TaskAuthority { async get(taskId: string): Promise<TaskProjection> { return { ...TASK, taskId }; } }
function restore(key: string, value: string | undefined): void { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
const TASK: TaskProjection = {
  taskId: '82000000-0000-4000-8000-000000000001', projectId: '82000000-0000-4000-8000-000000000002',
  repositoryId: '82000000-0000-4000-8000-000000000003', bindingRevision: '1', taskRevision: '1', registryRevision: '1', lifecycle: 'active',
  currentSpecification: { specificationId: '82000000-0000-4000-8000-000000000004', sequence: '1', lifecycle: 'draft', content: 'canary', byteLength: 6, lineEnding: 'none', createdAt: '2026-08-27T00:00:00.000Z' }
};
