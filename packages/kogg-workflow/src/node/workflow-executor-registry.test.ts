import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditableWorkflowNodeV1 } from '../common/workflow-protocol';
import { workflowDigest } from '../common/workflow-canonical';
import { WorkflowExecutorRegistry } from './workflow-executor-registry';

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

test('refuses forged artifacts, digest tampering, incomplete joins, and unavailable side-effecting nodes', () => {
  const registry = new WorkflowExecutorRegistry(); const binding = registry.binding('control.join')!;
  assert.throws(() => registry.resolveExact('control.join', { ...binding, artifactDigest: 'f'.repeat(64) }), /WORKFLOW_EXECUTOR_INCOMPATIBLE/u); assert.equal(registry.binding('implementation.agent'), undefined);
  const join: EditableWorkflowNodeV1 = { nodeId: NODE, kind: 'control.join', kindVersion: '1', configurationDigest: 'a'.repeat(64), requestedEffects: [], retry: { maxAttempts: 1, backoffMs: 0, sideEffectPolicy: 'none' } };
  assert.deepEqual(registry.execute({ runId: RUN, node: join, attempt: 1, predecessorOutcomes: ['success','skipped'] }, binding), { kind: 'completed', code: 'WORKFLOW_OK', output: 'success', processCount: 0, residualProcessCount: 0 });
  assert.deepEqual(registry.execute({ runId: RUN, node: join, attempt: 1, predecessorOutcomes: ['success'] }, binding), { kind: 'refused', code: 'WORKFLOW_JOIN_AMBIGUOUS', processCount: 0, residualProcessCount: 0 });
  const condition = { ...join, kind: 'control.condition' as const, configuration: { schemaVersion: '1' as const, absoluteDeadlineMs: 1_000, target: 'project-read-only' as const, condition: 'always' as const } }; const conditionBinding = registry.binding('control.condition')!;
  assert.deepEqual(registry.execute({ runId: RUN, node: condition, attempt: 1, predecessorOutcomes: [] }, conditionBinding), { kind: 'refused', code: 'WORKFLOW_STORE_INTEGRITY', processCount: 0, residualProcessCount: 0 });
});
