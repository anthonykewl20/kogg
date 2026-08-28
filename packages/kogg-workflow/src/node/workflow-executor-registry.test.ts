import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditableWorkflowNodeV1 } from '../common/workflow-protocol';
import { workflowDigest } from '../common/workflow-canonical';
import { WorkflowExecutorRegistry, type WorkflowExternalExecutorAuthority, type WorkflowExternalExecutorContractV1 } from './workflow-executor-registry';

// diagnostic-coverage: workflow.catalog, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.source-maps

const RUN = '70000000-0000-4000-8000-000000000001'; const NODE = '70000000-0000-4000-8000-000000000002';

test('resolves the exact attested control artifact and executes deterministic process-free transitions', () => {
  const registry = new WorkflowExecutorRegistry(); const binding = registry.binding('control.condition'); assert.ok(binding); assert.match(binding.artifactDigest, /^[0-9a-f]{64}$/u);
  assert.equal(registry.resolveExact('control.condition', binding).supportedKinds.length, 5);
  const configuration = { schemaVersion: '1' as const, absoluteDeadlineMs: 1_000, target: 'project-read-only' as const, condition: 'prior-success' as const };
  const node: EditableWorkflowNodeV1 = { nodeId: NODE, kind: 'control.condition', kindVersion: '1', configuration, configurationDigest: workflowDigest('node-configuration', configuration), requestedEffects: [], retry: { maxAttempts: 1, backoffMs: 0, sideEffectPolicy: 'none' } };
  assert.deepEqual(registry.execute({ runId: RUN, node, attempt: 1, predecessorOutcomes: ['success'] }, binding), { kind: 'completed', code: 'WORKFLOW_OK', output: 'true', processCount: 0, residualProcessCount: 0 });
  assert.deepEqual(registry.execute({ runId: RUN, node, attempt: 1, predecessorOutcomes: ['skipped','success'] }, binding), { kind: 'completed', code: 'WORKFLOW_OK', output: 'true', processCount: 0, residualProcessCount: 0 });
  assert.deepEqual(registry.execute({ runId: RUN, node, attempt: 1, predecessorOutcomes: ['failure'] }, binding), { kind: 'completed', code: 'WORKFLOW_OK', output: 'false', processCount: 0, residualProcessCount: 0 });
});

test('exact-attests supervised agent dispatch while refusing forged artifacts, digest tampering, and incomplete joins', () => {
  const registry = new WorkflowExecutorRegistry(); const binding = registry.binding('control.join')!;
  assert.throws(() => registry.resolveExact('control.join', { ...binding, artifactDigest: 'f'.repeat(64) }), /WORKFLOW_EXECUTOR_INCOMPATIBLE/u); const approvalBinding = registry.binding('approval.specification'); assert.ok(approvalBinding); assert.equal(registry.resolveExact('approval.specification', approvalBinding).executionKind, 'task-admission-witness'); const continuationBinding = registry.binding('approval.continue'); assert.ok(continuationBinding); assert.equal(registry.resolveExact('approval.continue', continuationBinding).executionKind, 'human-continuation-receipt'); const agentBinding = registry.binding('implementation.agent'); assert.ok(agentBinding); assert.equal(registry.resolveExact('implementation.agent', agentBinding).executionKind, 'supervised-registry'); assert.equal(registry.binding('tool.build'), undefined);
  const join: EditableWorkflowNodeV1 = { nodeId: NODE, kind: 'control.join', kindVersion: '1', configurationDigest: 'a'.repeat(64), requestedEffects: [], retry: { maxAttempts: 1, backoffMs: 0, sideEffectPolicy: 'none' } };
  const approval: EditableWorkflowNodeV1 = { ...join, kind: 'approval.specification', requestedEffects: ['record-approval'] }; assert.deepEqual(registry.execute({ runId: RUN, node: approval, attempt: 1, predecessorOutcomes: [] }, approvalBinding), { kind: 'refused', code: 'WORKFLOW_EXECUTOR_INCOMPATIBLE', processCount: 0, residualProcessCount: 0 });
  const continuation: EditableWorkflowNodeV1 = { ...join, kind: 'approval.continue', requestedEffects: ['record-approval'] }; assert.deepEqual(registry.executeContinuation({ runId: RUN, node: continuation, attempt: 1, predecessorOutcomes: ['success'], receiptDigest: 'f'.repeat(64) }, continuationBinding), { kind: 'completed', code: 'WORKFLOW_OK', output: 'success', processCount: 0, residualProcessCount: 0 }); assert.deepEqual(registry.executeContinuation({ runId: RUN, node: continuation, attempt: 1, predecessorOutcomes: ['success'], receiptDigest: 'invalid' }, continuationBinding), { kind: 'refused', code: 'WORKFLOW_APPROVAL_INVALID', processCount: 0, residualProcessCount: 0 });
  assert.deepEqual(registry.execute({ runId: RUN, node: join, attempt: 1, predecessorOutcomes: ['success','skipped'] }, binding), { kind: 'completed', code: 'WORKFLOW_OK', output: 'success', processCount: 0, residualProcessCount: 0 });
  assert.deepEqual(registry.execute({ runId: RUN, node: join, attempt: 1, predecessorOutcomes: ['success'] }, binding), { kind: 'refused', code: 'WORKFLOW_JOIN_AMBIGUOUS', processCount: 0, residualProcessCount: 0 });
  const condition = { ...join, kind: 'control.condition' as const, configuration: { schemaVersion: '1' as const, absoluteDeadlineMs: 1_000, target: 'project-read-only' as const, condition: 'always' as const } }; const conditionBinding = registry.binding('control.condition')!;
  assert.deepEqual(registry.execute({ runId: RUN, node: condition, attempt: 1, predecessorOutcomes: [] }, conditionBinding), { kind: 'refused', code: 'WORKFLOW_STORE_INTEGRITY', processCount: 0, residualProcessCount: 0 });
});

test('admits only an exact external catalog and normalizes external execution failures', async () => {
  const calls: string[] = []; const authority: WorkflowExternalExecutorAuthority = {
    readiness: () => ({ ready: true, recoveryComplete: true, residualProcessCount: 0 }),
    attestations: () => externalContracts(),
    async execute(request) { calls.push(request.bindingId); return { kind: 'completed', code: 'WORKFLOW_OK', output: 'success', subjectStateDigest: 'd'.repeat(64), factDigest: 'e'.repeat(64), ownerSequence: '1', processCount: 1, residualProcessCount: 0 }; },
    async cancel() { return { code: 'WORKFLOW_CANCELLED', processCount: 1, residualProcessCount: 0 }; }
  };
  const registry = new WorkflowExecutorRegistry(authority); assert.equal(registry.attestations().length, 6);
  const configuration = { schemaVersion: '1' as const, operationId: 'git.status-v1', externalConfigurationDigest: 'b'.repeat(64), absoluteDeadlineMs: 120_000, target: 'private-worktree' as const, condition: 'always' as const };
  const node: EditableWorkflowNodeV1 = { nodeId: NODE, kind: 'tool.git', kindVersion: '1', configuration, configurationDigest: workflowDigest('node-configuration', configuration), requestedEffects: ['read-repository','mutate-private-repository','run-tool'], retry: { maxAttempts: 1, backoffMs: 0, sideEffectPolicy: 'idempotent-exact-key' } };
  const binding = registry.binding(node.kind); assert.ok(binding); assert.equal(registry.externalConfigurationAvailable(node), true);
  const request = { runId: RUN, node, attempt: 1, predecessorOutcomes: ['success'] as const, planDigest: 'c'.repeat(64), taskAdmissionId: 'task-admission-1', repositoryId: 'repository-1', bindingId: configuration.operationId, externalConfigurationDigest: configuration.externalConfigurationDigest };
  assert.deepEqual(await registry.executeExternal(request, binding), { kind: 'completed', code: 'WORKFLOW_OK', output: 'success', subjectStateDigest: 'd'.repeat(64), factDigest: 'e'.repeat(64), ownerSequence: '1', processCount: 1, residualProcessCount: 0 }); assert.deepEqual(calls, ['git.status-v1']);
  const openResult = new WorkflowExecutorRegistry({ ...authority, async execute() { return { kind: 'completed', code: 'WORKFLOW_OK', output: 'success', subjectStateDigest: 'invalid', factDigest: 'e'.repeat(64), ownerSequence: '1', processCount: 1, residualProcessCount: 0 } as never; } });
  assert.deepEqual(await openResult.executeExternal(request, openResult.binding('tool.git')!), { kind: 'refused', code: 'WORKFLOW_EXTERNAL_FAILURE', processCount: 0, residualProcessCount: 0 });
  assert.deepEqual(await registry.executeExternal({ ...request, bindingId: 'git.unknown-v1' }, binding), { kind: 'refused', code: 'WORKFLOW_STORE_INTEGRITY', processCount: 0, residualProcessCount: 0 }); assert.deepEqual(calls, ['git.status-v1']);
  const canary = `private-external-${Date.now()}`; const logs: string[] = []; const originalWarn = console.warn; console.warn = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try { const hostile = new WorkflowExecutorRegistry({ ...authority, async execute() { throw new Error(canary); } }); const hostileBinding = hostile.binding(node.kind)!; assert.deepEqual(await hostile.executeExternal(request, hostileBinding), { kind: 'refused', code: 'WORKFLOW_EXTERNAL_FAILURE', processCount: 0, residualProcessCount: 0 }); }
  finally { console.warn = originalWarn; }
  assert.equal(logs.join('\n').includes(canary), false);
  const forged = externalContracts().map(contract => ({ ...contract, artifactDigest: 'f'.repeat(64) })); const unavailable = new WorkflowExecutorRegistry({ ...authority, attestations: () => forged }); assert.equal(unavailable.binding('tool.git'), undefined); assert.equal(unavailable.binding('check.deterministic'), undefined);
  const unhealthy = new WorkflowExecutorRegistry({ ...authority, readiness: () => ({ ready: false, recoveryComplete: true, residualProcessCount: 0 }) }); assert.equal(unhealthy.binding('tool.git'), undefined);
  let cancellations = 0; const timeoutConfiguration = { ...configuration, absoluteDeadlineMs: 1_000 }; const timeoutNode = { ...node, configuration: timeoutConfiguration, configurationDigest: workflowDigest('node-configuration', timeoutConfiguration) }; const timeout = new WorkflowExecutorRegistry({ ...authority, async execute() { return new Promise(() => undefined); }, async cancel() { cancellations++; return { code: 'WORKFLOW_CANCELLED', processCount: 1, residualProcessCount: 0 }; } });
  assert.deepEqual(await timeout.executeExternal({ ...request, node: timeoutNode }, timeout.binding('tool.git')!), { kind: 'refused', code: 'WORKFLOW_DEADLINE', processCount: 1, residualProcessCount: 0 }); assert.equal(cancellations, 1);
});

function externalContracts(): readonly WorkflowExternalExecutorContractV1[] {
  const execution = { schemaVersion: '1' as const, executorId: 'kogg.execution.catalog' as const, executorVersion: '1.0.0' as const, executionKind: 'external-catalog' as const, ownerKind: 'execution' as const, supportedKinds: ['tool.git','tool.build'] as const, supportedBindingIds: { 'tool.git': ['git.status-v1'], 'tool.build': ['build.repository-v1'] } };
  const kernel = { schemaVersion: '1' as const, executorId: 'kogg.kernel.checks' as const, executorVersion: '1.0.0' as const, executionKind: 'external-catalog' as const, ownerKind: 'kernel' as const, supportedKinds: ['check.deterministic'] as const, supportedBindingIds: { 'check.deterministic': ['suite.required-v1'] } };
  return [{ ...execution, artifactDigest: workflowDigest('executor-artifact', execution) }, { ...kernel, artifactDigest: workflowDigest('executor-artifact', kernel) }];
}
