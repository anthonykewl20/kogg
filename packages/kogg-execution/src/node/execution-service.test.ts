import assert from 'node:assert/strict';
import test from 'node:test';
import type { GetExecutionRunV1, ListExecutionRunsV1 } from '../common/execution-protocol';
import { ExecutionService, ExecutionServiceError } from './execution-service';

// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.source-maps
test('serves the closed qualification projection and delegates only safe run reads', async () => {
  const calls: string[] = [];
  const service = new ExecutionService({
    getRun: async (request: GetExecutionRunV1) => { calls.push(`get:${request.runId}`); return undefined; },
    listRuns: async (request: ListExecutionRunsV1) => { calls.push(`list:${request.projectId}`); return { schemaVersion: 1, projectId: request.projectId, runs: [], truncated: false }; }
  } as never, { projection: () => ({ qualified: false, targetId: 'local-qualified-linux', profileId: 'kogg-writable-agent-v1', safeCode: 'QUALIFICATION_PROFILE_UNAVAILABLE', sourceMapsPresent: true }) } as never);
  const requestId = '10000000-0000-4000-8000-000000000001';
  assert.deepEqual(await service.qualification({ requestId }), { qualified: false, targetId: 'local-qualified-linux', profileId: 'kogg-writable-agent-v1', safeCode: 'QUALIFICATION_PROFILE_UNAVAILABLE', sourceMapsPresent: true });
  await service.getRun({ requestId, runId: '10000000-0000-4000-8000-000000000002' });
  await service.listRuns({ requestId, projectId: '10000000-0000-4000-8000-000000000003' });
  assert.deepEqual(calls, ['get:10000000-0000-4000-8000-000000000002', 'list:10000000-0000-4000-8000-000000000003']);
  await assert.rejects(() => service.qualification({ requestId, privateRoot: '/private/canary' } as never),
    (error: unknown) => error instanceof ExecutionServiceError && error.code === 'QUALIFICATION_PROTOCOL_INVALID');
});
