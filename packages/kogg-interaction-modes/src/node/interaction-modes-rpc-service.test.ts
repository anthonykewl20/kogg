import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TaskProjection } from '@kogg/tasks/lib/common/tasks-protocol';
import { InteractionModeError, InteractionModeRegistry } from './interaction-mode-registry';
import { ModeTransitionAuthority } from './mode-transition-authority';
import { InteractionModesRpcService } from './interaction-modes-rpc-service';
import { ModeTransitionCoordinator } from './mode-transition-coordinator';
import type { ModeTransitionOwnerContribution } from '../common/interaction-modes-protocol';

// diagnostic-coverage: interaction-modes.authority, interaction-modes.transitions
test('admits desktop transition intent only in Electron and preserves disabled authority until cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-interaction-desktop-'));
  const prior = { runtime: process.env.KOGG_RUNTIME, state: process.env.KOGG_STATE_DIR };
  process.env.KOGG_RUNTIME = 'electron'; process.env.KOGG_STATE_DIR = root;
  const authority = new ModeTransitionAuthority(); const registry = new InteractionModeRegistry(new TaskAuthority(), authority);
  const configuration = { schemaVersion: 1, kind: 'build', roleRevisionId: '81000000-0000-4000-8000-000000000009', providerId: 'fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'standard', targetId: 'qualified-linux' } as const;
  const owners = [
    { owner: 'operations', async qualifyTransition() { return { owner: 'operations', qualified: true, safeCode: 'MODE_OK', proofDigest: `sha256:${'1'.repeat(64)}` }; } },
    { owner: 'agent-binding', async configurationCandidates() { return [{ owner: 'agent-binding', roleRevisionId: configuration.roleRevisionId, providerId: configuration.providerId, modelId: configuration.modelId, adapterKey: configuration.adapterKey, adapterVersion: configuration.adapterVersion, deadlinePolicyId: configuration.deadlinePolicyId }]; }, async qualifyTransition() { return { owner: 'agent-binding', qualified: true, safeCode: 'MODE_OK', proofDigest: `sha256:${'2'.repeat(64)}` }; } },
    { owner: 'execution-target', async configurationCandidates() { return [{ owner: 'execution-target', targetId: configuration.targetId }]; }, async qualifyTransition() { return { owner: 'execution-target', qualified: true, safeCode: 'MODE_OK', proofDigest: `sha256:${'3'.repeat(64)}` }; } }
  ] satisfies readonly ModeTransitionOwnerContribution[];
  const service = new InteractionModesRpcService(registry, authority, new ModeTransitionCoordinator(registry, owners)); await registry.onStart();
  const request = {
    transitionId: '81000000-0000-4000-8000-000000000001', requestId: '81000000-0000-4000-8000-000000000002',
    taskId: TASK.taskId, expectedSequence: '0', fromMode: 'plan' as const, toMode: 'build' as const,
    requestedConfigurationDigest: digest(configuration)
  };
  try {
    await service.get({ requestId: '81000000-0000-4000-8000-000000000003', taskId: TASK.taskId });
    const pending = await service.requestDesktopTransition(request);
    assert.equal(pending.state, 'awaiting-confirmation'); assert.equal(pending.mode.state, 'transition-pending');
    assert.deepEqual(pending.mode.effectiveCapabilities, []);
    const cancel = await service.cancelDesktopTransition({ requestId: '81000000-0000-4000-8000-000000000004', transitionId: request.transitionId, taskId: TASK.taskId });
    assert.equal(cancel.state, 'cancelled'); assert.equal(cancel.mode.state, 'ready');
    assert.deepEqual((await service.transitionConfigurations({ requestId: '81000000-0000-4000-8000-000000000005', taskId: TASK.taskId, toMode: 'build' })).options, [configuration]);
    const secondRequest = { ...request, requestId: '81000000-0000-4000-8000-000000000006', transitionId: '81000000-0000-4000-8000-000000000007' };
    const secondPending = await service.requestDesktopTransition(secondRequest);
    const committed = await service.confirmDesktopTransition({ requestId: '81000000-0000-4000-8000-000000000008', transitionId: secondRequest.transitionId, taskId: TASK.taskId, challengeDigest: secondPending.challengeDigest!, explicitGesture: true, configuration });
    assert.equal(committed.state, 'committed'); assert.equal(committed.mode.selectedMode, 'build'); assert.equal(committed.mode.sequence, '1');
    process.env.KOGG_RUNTIME = 'browser';
    assert.throws(() => service.requestDesktopTransition({ ...request, expectedSequence: '1', fromMode: 'build', toMode: 'plan', requestId: '81000000-0000-4000-8000-000000000010', transitionId: '81000000-0000-4000-8000-000000000011', requestedConfigurationDigest: digest({ schemaVersion: 1, kind: 'plan' }) }),
      error => error instanceof InteractionModeError && error.code === 'MODE_AUTHORITY_REFUSED');
  } finally {
    registry.onStop(); restore('KOGG_RUNTIME', prior.runtime); restore('KOGG_STATE_DIR', prior.state); await rm(root, { recursive: true, force: true });
  }
});

class TaskAuthority { async get(taskId: string): Promise<TaskProjection> { return { ...TASK, taskId }; } }
function restore(key: string, value: string | undefined): void { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
function digest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
const TASK: TaskProjection = {
  taskId: '82000000-0000-4000-8000-000000000001', projectId: '82000000-0000-4000-8000-000000000002',
  repositoryId: '82000000-0000-4000-8000-000000000003', bindingRevision: '1', taskRevision: '1', registryRevision: '1', lifecycle: 'active',
  currentSpecification: { specificationId: '82000000-0000-4000-8000-000000000004', sequence: '1', lifecycle: 'draft', content: 'canary', byteLength: 6, lineEnding: 'none', createdAt: '2026-08-27T00:00:00.000Z' }
};
