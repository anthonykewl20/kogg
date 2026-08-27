import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AgentWorkspaceAuthorizationRequestV1 } from '@kogg/agents/lib/common/agents-protocol';
import type { ExecutionAllocationSummaryV1, ExecutionBindingV1, ExecutionState } from '../common/execution-protocol';
import { AgentWorkspaceController } from './agent-workspace-controller';
import { SeedError, type PrivateGitSeedRequest } from './private-git-seeder';

const IDS = {
  requestId: '10000000-0000-4000-8000-000000000001', attemptId: '10000000-0000-4000-8000-000000000002',
  admissionId: '10000000-0000-4000-8000-000000000003', taskId: '10000000-0000-4000-8000-000000000004',
  projectId: '10000000-0000-4000-8000-000000000005', repositoryId: '10000000-0000-4000-8000-000000000006',
  specificationId: '10000000-0000-4000-8000-000000000007', taskRevisionId: '10000000-0000-4000-8000-000000000008',
  approvalId: '10000000-0000-4000-8000-000000000009', runId: '10000000-0000-4000-8000-00000000000a',
  roleRevisionId: '10000000-0000-4000-8000-00000000000b', qualificationId: '10000000-0000-4000-8000-00000000000c',
  worktreeId: '10000000-0000-4000-8000-00000000000d'
} as const;
const DIGEST = `sha256:${'a'.repeat(64)}`;

test('orders exact source and target authority through allocation, private seeding, verification, and ready grant', async () => {
  const fixture = controllerFixture();
  const result = await fixture.controller.prepareWorkspace(request());
  assert.equal(result.allowed, true); assert.equal(result.code, 'AGENT_OK'); assert.equal(result.worktreeId, IDS.worktreeId);
  assert.match(result.workspaceGrantDigest ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(fixture.allocationRequestIds.length, 1); assert.notEqual(fixture.allocationRequestIds[0], IDS.requestId);
  assert.deepEqual(fixture.states, ['seeding', 'verified', 'ready']);
  assert.equal(fixture.bindings.length, 1);
  assert.deepEqual(fixture.bindings[0], {
    schemaVersion: 1, projectId: IDS.projectId, projectRevision: '7', repositoryId: IDS.repositoryId,
    repositoryBindingRevision: '3', taskId: IDS.taskId, taskRevisionId: IDS.taskRevisionId,
    taskRevisionDigest: DIGEST, approvalDigest: DIGEST, runId: IDS.runId, attemptId: IDS.attemptId,
    workflowPlanDigest: DIGEST, baseCommit: 'b'.repeat(40), baseTree: 'c'.repeat(40), gitObjectFormat: 'sha1',
    targetId: 'local-qualified-linux', qualificationId: IDS.qualificationId, qualificationDigest: DIGEST,
    profileId: 'kogg-writable-agent-v1', profileDigest: DIGEST
  });
  assert.equal(fixture.seeds[0]?.sourceRoot, '/registered/source');
  assert.equal(fixture.seeds[0]?.privateRoot, '/private/allocation/worktree');
  assert.equal(fixture.cleanups.length, 0);
});

test('refuses before allocation when source or target authority is unavailable', async () => {
  const fixture = controllerFixture({ sourceAvailable: false });
  assert.deepEqual(await fixture.controller.prepareWorkspace(request()), { allowed: false, code: 'WORKSPACE_UNTRUSTED' });
  assert.equal(fixture.bindings.length, 0); assert.equal(fixture.states.length, 0); assert.equal(fixture.seeds.length, 0);
  const unsupported = controllerFixture({ targetAvailable: false });
  assert.deepEqual(await unsupported.controller.prepareWorkspace(request()), { allowed: false, code: 'WORKSPACE_UNTRUSTED' });
  assert.equal(unsupported.sourceCalls(), 0); assert.equal(unsupported.bindings.length, 0);
});

test('durably fails and invokes the fenced native cleanup owner after a seed refusal without leaking paths', async () => {
  const logs: string[] = []; const original = { info: console.info, error: console.error };
  console.info = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  try {
    const fixture = controllerFixture({ seedFailure: true });
    assert.deepEqual(await fixture.controller.prepareWorkspace(request()), { allowed: false, code: 'WORKSPACE_UNTRUSTED' });
    assert.deepEqual(fixture.states, ['seeding', 'failed']); assert.equal(fixture.cleanups.length, 1);
    const trace = logs.join('\n'); assert.match(trace, /workspace\.cleanup\.started/u); assert.match(trace, /workspace\.cleanup\.completed/u);
    assert.equal(trace.includes('/registered/source'), false); assert.equal(trace.includes('/private/allocation'), false); assert.equal(trace.includes(DIGEST), false);
  } finally { console.info = original.info; console.error = original.error; }
});

function controllerFixture(options: { sourceAvailable?: boolean; targetAvailable?: boolean; seedFailure?: boolean } = {}) {
  const bindings: ExecutionBindingV1[] = []; const allocationRequestIds: string[] = []; const states: ExecutionState[] = []; const seeds: PrivateGitSeedRequest[] = []; const cleanups: unknown[] = [];
  let revision = 2; let sourceCallCount = 0;
  const summary = (state: ExecutionState): ExecutionAllocationSummaryV1 => ({ schemaVersion: 1, worktreeId: IDS.worktreeId, runId: IDS.runId,
    attemptId: IDS.attemptId, allocationName: 'r-aeaaaaaaaaaaaaaaaaaaaaaaaa', allocationNonceDigest: DIGEST,
    bindingDigest: DIGEST, state, revision: String(revision), cleanupState: 'required', safeCode: 'ALLOCATION_OK' });
  const sources = { resolveSourceBinding: async () => { sourceCallCount++; return options.sourceAvailable === false ? undefined : ({ projectId: IDS.projectId,
    repositoryId: IDS.repositoryId, registryRevision: 7, bindingRevision: 3, available: true, active: true,
    executionProfileId: 'restricted', rootUri: pathToFileURL('/registered/source').href,
    gitDirectoryUri: pathToFileURL('/registered/source/.git').href, repositoryIdentityDigest: DIGEST,
    baseCommit: 'b'.repeat(40), baseTree: 'c'.repeat(40), gitObjectFormat: 'sha1' as const }); } };
  const targets = { resolveTargetBinding: async () => options.targetAvailable === false ? undefined : ({ targetId: 'local-qualified-linux', qualificationId: IDS.qualificationId,
    qualificationDigest: DIGEST, profileId: 'kogg-writable-agent-v1' as const, profileDigest: DIGEST }) };
  const native = {
    allocate: async (input: { requestId: string; binding: ExecutionBindingV1 }) => { allocationRequestIds.push(input.requestId); bindings.push(input.binding); return summary('allocated'); },
    privateGitPaths: () => ({ privateRoot: '/private/allocation/worktree', bundlePath: '/private/allocation/seed.bundle' }),
    cleanup: async (input: unknown) => { cleanups.push(input); revision++; return summary('cleaned'); }
  };
  const allocations = { advance: async (input: { nextState: ExecutionState }) => { states.push(input.nextState); revision++; return summary(input.nextState); } };
  const seeder = { seed: async (input: PrivateGitSeedRequest) => { seeds.push(input); if (options.seedFailure) throw new SeedError('GIT_BASE_CHANGED'); return { baseCommit: input.baseCommit, baseTree: input.baseTree, branchRefDigest: DIGEST, alternateCount: 0 as const }; } };
  return { controller: new AgentWorkspaceController(sources as never, targets, native as never, allocations as never, seeder, { bytes: '1024', inodes: '100' }), allocationRequestIds, bindings, states, seeds, cleanups, sourceCalls: () => sourceCallCount };
}

function request(): AgentWorkspaceAuthorizationRequestV1 {
  return { schemaVersion: '1', requestId: IDS.requestId, attemptId: IDS.attemptId, taskAdmissionId: IDS.admissionId,
    taskId: IDS.taskId, projectId: IDS.projectId, repositoryId: IDS.repositoryId, repositoryBindingRevision: '3',
    specificationId: IDS.specificationId, taskRevisionId: IDS.taskRevisionId, taskRevisionDigest: DIGEST,
    approvalId: IDS.approvalId, approvalDigest: DIGEST, runId: IDS.runId, roleRevisionId: IDS.roleRevisionId, workflowPlanDigest: DIGEST };
}
