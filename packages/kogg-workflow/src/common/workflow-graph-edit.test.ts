import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditableWorkflowNodeV1 } from './workflow-protocol';
import { allowedSourceOutcomes, connectWorkflowNodes, detachWorkflowNode, disconnectWorkflowEdge } from './workflow-graph-edit';

const first = node('10000000-0000-4000-8000-000000000001', 'research.agent');
const condition = node('10000000-0000-4000-8000-000000000002', 'control.condition');
const target = node('10000000-0000-4000-8000-000000000003', 'control.join');
const edgeId = '20000000-0000-4000-8000-000000000001';

test('connects and disconnects exact accessible graph edges without changing node order', () => {
  const edges = connectWorkflowNodes([first, condition, target], [], edgeId, condition.nodeId, 'true', target.nodeId);
  assert.deepEqual(edges, [{ edgeId, sourceNodeId: condition.nodeId, sourcePort: 'true', targetNodeId: target.nodeId, targetPort: 'in' }]);
  assert.deepEqual(disconnectWorkflowEdge(edges, edgeId), []);
  assert.deepEqual(allowedSourceOutcomes(condition.kind), ['true', 'false', 'finally']);
});

test('refuses self, duplicate, missing-node, and invalid-port connections', () => {
  assert.throws(() => connectWorkflowNodes([first, target], [], edgeId, first.nodeId, 'success', first.nodeId), /WORKFLOW_PORT_INVALID/u);
  assert.throws(() => connectWorkflowNodes([first, target], [], edgeId, first.nodeId, 'true', target.nodeId), /WORKFLOW_PORT_INVALID/u);
  assert.throws(() => connectWorkflowNodes([first, target], [], edgeId, first.nodeId, 'success', '10000000-0000-4000-8000-000000000099'), /WORKFLOW_PORT_INVALID/u);
  const edges = connectWorkflowNodes([first, target], [], edgeId, first.nodeId, 'success', target.nodeId);
  assert.throws(() => connectWorkflowNodes([first, target], edges, '20000000-0000-4000-8000-000000000002', first.nodeId, 'success', target.nodeId), /WORKFLOW_PORT_INVALID/u);
  assert.throws(() => disconnectWorkflowEdge([], edgeId), /WORKFLOW_PORT_INVALID/u);
});

test('detaches only edges incident to a removed node', () => {
  const firstEdge = connectWorkflowNodes([first, condition, target], [], edgeId, first.nodeId, 'success', condition.nodeId);
  const edges = connectWorkflowNodes([first, condition, target], firstEdge, '20000000-0000-4000-8000-000000000002', condition.nodeId, 'true', target.nodeId);
  assert.deepEqual(detachWorkflowNode(edges, condition.nodeId), []);
  assert.deepEqual(detachWorkflowNode(edges, target.nodeId), [firstEdge[0]]);
});

function node(nodeId: string, kind: EditableWorkflowNodeV1['kind']): EditableWorkflowNodeV1 {
  return { nodeId, kind, kindVersion: '1', configurationDigest: 'a'.repeat(64), requestedEffects: [], retry: { maxAttempts: 1, backoffMs: 0, sideEffectPolicy: 'none' } };
}
