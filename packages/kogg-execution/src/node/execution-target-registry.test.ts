import assert from 'node:assert/strict';
import test from 'node:test';
import { KOGG_RANEX_COMMIT, type KernelBridge, type KernelExecutionQualification } from '@kogg/contracts';
import type { OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { ExecutionBindingV1 } from '../common/execution-protocol';
import type { ExecutionAllocationRegistry } from './execution-allocation-registry';
import { EXECUTION_CHECKS, ExecutionDiagnosticContributor } from './execution-diagnostic-contributor';
import { executionLog, executionLoggingDiagnostics } from './execution-logger';
import { ExecutionTargetRegistry, qualificationDigest } from './execution-target-registry';

// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.git-independence, execution.source-integrity, execution.process-cleanup, execution.capacity, execution.recovery, execution.retention, execution.source-maps
test('refuses non-Linux controllers without contacting the kernel or logging private values', async () => {
  let calls = 0; const canary = `private-target-${Date.now()}`; const logs: string[] = []; const original = { info: console.info, warn: console.warn };
  console.info = (...values: unknown[]) => { logs.push(JSON.stringify(values)); }; console.warn = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  try {
    const registry = new ExecutionTargetRegistry({ capabilities: async () => { calls++; throw new Error(canary); } } as unknown as KernelBridge, { platform: 'darwin', arch: 'arm64' });
    await registry.onStart(); assert.equal(registry.projection().qualified, false); assert.equal(registry.projection().safeCode, 'QUALIFICATION_PLATFORM_UNSUPPORTED'); assert.equal(calls, 0); assert.equal(logs.join('\n').includes(canary), false);
  } finally { console.info = original.info; console.warn = original.warn; }
});

test('refuses the pinned kernel until the exact writable profile exists', async () => {
  const kernel = bridge(async () => ({ ...qualification(), status: 'refused', refusalCodes: ['QUALIFICATION_PROFILE_UNAVAILABLE'] }));
  const registry = new ExecutionTargetRegistry(kernel, { platform: 'linux', arch: 'x64' }); await registry.onStart();
  assert.equal(registry.projection().qualified, false); assert.equal(registry.projection().safeCode, 'QUALIFICATION_PROFILE_UNAVAILABLE');
});

test('accepts only a fresh closed exact qualification and reports every catalog check', async () => {
  const registry = new ExecutionTargetRegistry(bridge(async () => qualification()), { platform: 'linux', arch: 'x64' }); await registry.onStart();
  assert.equal(registry.projection().qualified, true); assert.equal(registry.projection().safeCode, 'EXECUTION_OK');
  const checks = await new ExecutionDiagnosticContributor(registry, healthyAllocations(), healthyOperations()).diagnose(); assert.deepEqual(checks.map(check => check.id), [...EXECUTION_CHECKS]); assert.equal(checks.every(check => check.status === 'pass'), true);
});

test('fails the cleanup diagnostic while a durable physical cleanup intent is pending', async () => {
  const registry = new ExecutionTargetRegistry(bridge(async () => qualification()), { platform: 'linux', arch: 'x64' }); await registry.onStart();
  const healthy = healthyAllocations().diagnostics();
  const allocations = { diagnostics: () => ({ ...healthy, pendingCleanupIntentCount: 1 }) } as ExecutionAllocationRegistry;
  const checks = await new ExecutionDiagnosticContributor(registry, allocations, healthyOperations()).diagnose();
  assert.equal(checks.find(check => check.id === 'execution.process-cleanup')?.status, 'fail');
});

test('requalifies immediately before allocation and authorizes only the exact immutable fact', async () => {
  const fact = qualification(); let calls = 0;
  const registry = new ExecutionTargetRegistry(bridge(async () => { calls++; return fact; }), { platform: 'linux', arch: 'x64' });
  await registry.onStart();
  assert.equal(await registry.authorize(bindingFor(fact)), true);
  assert.equal(await registry.authorize({ ...bindingFor(fact), qualificationDigest: `sha256:${'f'.repeat(64)}` }), false);
  assert.equal(await registry.authorizePhysicalAllocation(bindingFor(fact), fact.launcherDigest, fact.mountQuotaDigest), true);
  assert.equal(await registry.authorizePhysicalAllocation(bindingFor(fact), `sha256:${'f'.repeat(64)}`, fact.mountQuotaDigest), false);
  assert.equal(calls, 5);
});

test('invalid, expired, and failed owner results remain unqualified with closed failures', async () => {
  const invalid = new ExecutionTargetRegistry(bridge(async () => ({ ...qualification(), extra: 'private' } as never)), { platform: 'linux', arch: 'x64' }); await invalid.onStart(); assert.equal(invalid.projection().safeCode, 'QUALIFICATION_PROTOCOL_INVALID');
  const unknownRefusal = new ExecutionTargetRegistry(bridge(async () => ({ ...qualification(), status: 'refused', refusalCodes: ['PRIVATE_REASON'] } as never)), { platform: 'linux', arch: 'x64' }); await unknownRefusal.onStart(); assert.equal(unknownRefusal.projection().safeCode, 'QUALIFICATION_PROTOCOL_INVALID');
  const futureKernel = new ExecutionTargetRegistry(bridge(async () => ({ ...qualification(), kernelRelease: '7.0.0' })), { platform: 'linux', arch: 'x64' }); await futureKernel.onStart(); assert.equal(futureKernel.projection().qualified, true);
  const expiredValue = qualification(); const expired = new ExecutionTargetRegistry(bridge(async () => ({ ...expiredValue, checkedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:05:00.000Z' })), { platform: 'linux', arch: 'x64' }); await expired.onStart(); assert.equal(expired.projection().safeCode, 'QUALIFICATION_EXPIRED');
  const failed = new ExecutionTargetRegistry(bridge(async () => { throw new Error('private kernel body'); }), { platform: 'linux', arch: 'x64' }); await failed.onStart(); assert.equal(failed.projection().safeCode, 'QUALIFICATION_FAILED');
});

test('closed execution logging rejects undeclared fields without echoing values', () => {
  const canary = `execution-secret-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  try { executionLog('qualification.failed', { targetId: 'local-qualified-linux', safeCode: 'QUALIFICATION_FAILED', errorType: 'Error', credential: canary } as never); assert.equal(logs.join('\n').includes(canary), false); assert.equal(executionLoggingDiagnostics().violationCount > 0, true); }
  finally { console.error = original; }
});

function bridge(qualify: () => Promise<KernelExecutionQualification>): KernelBridge {
  const digest = `sha256:${'0'.repeat(64)}` as const;
  return { capabilities: async () => ({ protocol: 'kogg.ranex/v2', protocolVersion: 2, ranexCommit: KOGG_RANEX_COMMIT, ranexTree: '581ce66c54116d4be48b96c3a0359fbdd9d3077f', adapterArtifactDigest: digest, schemaSetDigest: digest, operations: [{ operation: 'execution.qualify', version: 1, requestSchemaDigest: digest, resultSchemaDigest: digest }], maxFrameBytes: 1024 * 1024, maxPendingRequests: 64, maxPendingResponseBytes: 4 * 1024 * 1024, confinement: 'unavailable', degradationCodes: ['KERNEL_HOST_UNQUALIFIED'] }), qualifyExecution: async () => qualify() } as unknown as KernelBridge;
}
function qualification(): KernelExecutionQualification {
  const checkedAt = new Date(Date.now() - 1_000).toISOString(); const expiresAt = new Date(Date.now() + 4 * 60_000).toISOString(); const digest = `sha256:${'a'.repeat(64)}`;
  return { schemaVersion: 1, qualificationId: '10000000-0000-4000-8000-000000000001', targetId: 'local-qualified-linux', architecture: 'amd64', profileId: 'kogg-writable-agent-v1', profileDigest: digest, bootIdDigest: digest, kernelRelease: '6.6.1', landlockAbi: '4', cgroupProfileDigest: digest, mountQuotaDigest: digest, launcherDigest: digest, bubblewrapDigest: digest, seccompDigest: digest, brokerDigest: digest, ranexCommit: KOGG_RANEX_COMMIT, checkedAt, expiresAt, status: 'qualified', refusalCodes: [] };
}
function bindingFor(value: KernelExecutionQualification): ExecutionBindingV1 {
  const digest = `sha256:${'b'.repeat(64)}`;
  return { schemaVersion: 1, projectId: '10000000-0000-4000-8000-000000000011', projectRevision: '1', repositoryId: '10000000-0000-4000-8000-000000000012', repositoryBindingRevision: '1', taskId: '10000000-0000-4000-8000-000000000013', taskRevisionId: '10000000-0000-4000-8000-000000000014', taskRevisionDigest: digest, approvalDigest: digest, runId: '10000000-0000-4000-8000-000000000015', attemptId: '10000000-0000-4000-8000-000000000016', workflowPlanDigest: digest, baseCommit: 'b'.repeat(40), baseTree: 'c'.repeat(40), gitObjectFormat: 'sha1', targetId: value.targetId, qualificationId: value.qualificationId, qualificationDigest: qualificationDigest(value), profileId: value.profileId, profileDigest: value.profileDigest };
}
function healthyAllocations(): ExecutionAllocationRegistry { return { diagnostics: () => ({ integrity: true, foreignKeys: true, permissions: true, admission: 'enabled', activeCount: 0, quarantinedCount: 0, recoveryRequiredCount: 0, unverifiedCount: 0, cleanupFailureCount: 0, reservationCount: 0, candidateCount: 0, pendingImportIntentCount: 0, activeRepositoryLeaseCount: 0, quarantinedRepositoryLeaseCount: 0, pendingCleanupIntentCount: 0, retentionViolationCount: 0, loggingViolationCount: 0 }) } as ExecutionAllocationRegistry; }
function healthyOperations(): OperationRegistryApi { return { diagnostics: () => ({ integrity: true, foreignKeys: true, permissions: true, recoveryComplete: true, activeCount: 0, stalledCount: 0, residualCount: 0, cleanupFailureCount: 0, admission: 'enabled' }) } as OperationRegistryApi; }
