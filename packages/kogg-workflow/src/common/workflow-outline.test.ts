import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditableWorkflowNodeV1 } from './workflow-protocol';
import { buildLinearGraph, moveOutlineNode } from './workflow-outline';

// diagnostic-coverage: workflow.graph, workflow.accessibility

const first = node('10000000-0000-4000-8000-000000000001', 'research.agent');
const second = node('10000000-0000-4000-8000-000000000002', 'implementation.agent');

test('structured outline reorders the same semantic nodes and rebuilds an accessible linear graph', () => {
  const moved = moveOutlineNode([first, second], 1, -1);
  assert.deepEqual(moved.map(item => item.nodeId), [second.nodeId, first.nodeId]);
  const graph = buildLinearGraph('10000000-0000-4000-8000-000000000003', moved, ['10000000-0000-4000-8000-000000000004']);
  assert.equal(graph.edges[0]?.sourceNodeId, second.nodeId); assert.equal(graph.edges[0]?.targetNodeId, first.nodeId);
  assert.equal(graph.nodes[0], second); assert.equal(graph.nodes[1], first);
  const failure = buildLinearGraph('10000000-0000-4000-8000-000000000003', moved, ['10000000-0000-4000-8000-000000000004'], ['failure']);
  assert.equal(failure.edges[0]?.sourcePort, 'failure');
});

test('structured outline refuses out-of-range moves and ambiguous edge identity counts', () => {
  assert.throws(() => moveOutlineNode([first, second], 0, -1), /WORKFLOW_OUTLINE_MOVE_INVALID/u);
  assert.throws(() => buildLinearGraph('10000000-0000-4000-8000-000000000003', [first, second], []), /WORKFLOW_OUTLINE_EDGE_INVALID/u);
  assert.throws(() => buildLinearGraph('10000000-0000-4000-8000-000000000003', [first, second], ['10000000-0000-4000-8000-000000000004'], []), /WORKFLOW_OUTLINE_EDGE_INVALID/u);
  assert.throws(() => buildLinearGraph('10000000-0000-4000-8000-000000000003', [first, second], ['10000000-0000-4000-8000-000000000004'], ['invalid' as never]), /WORKFLOW_OUTLINE_EDGE_INVALID/u);
});

function node(nodeId: string, kind: EditableWorkflowNodeV1['kind']): EditableWorkflowNodeV1 { return { nodeId, kind, kindVersion: '1', configurationDigest: 'a'.repeat(64), requestedEffects: [], retry: { maxAttempts: 1, backoffMs: 0, sideEffectPolicy: 'none' } }; }
