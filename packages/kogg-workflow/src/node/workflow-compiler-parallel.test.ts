import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditableWorkflowEdgeV1, EditableWorkflowGraphV1, EditableWorkflowNodeV1 } from '../common/workflow-protocol';
import { WorkflowCompiler } from './workflow-compiler';
import { WorkflowExecutorRegistry } from './workflow-executor-registry';
import { WorkflowNodeCatalog } from './workflow-node-catalog';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const compiler = new WorkflowCompiler(new WorkflowNodeCatalog(new WorkflowExecutorRegistry()));

test('accepts one exact two-branch fork/join and rejects unmatched or shared joins', () => {
  assert.equal(compiler.validate(parallelGraph()).code, 'WORKFLOW_OK');
  const missingBranch = parallelGraph(); missingBranch.edges.splice(2, 1); assert.equal(compiler.validate(missingBranch).code, 'WORKFLOW_JOIN_AMBIGUOUS');
  const unmatched = parallelGraph(); unmatched.nodes[1] = node(unmatched.nodes[1]!.nodeId, 'control.group'); assert.equal(compiler.validate(unmatched).code, 'WORKFLOW_JOIN_AMBIGUOUS');
  const secondFork = node('30000000-0000-4000-8000-000000000006', 'control.parallel'); const shared = parallelGraph(); shared.nodes.push(secondFork); shared.edges.push(edge('40000000-0000-4000-8000-000000000006', shared.nodes[0]!.nodeId, secondFork.nodeId), edge('40000000-0000-4000-8000-000000000007', secondFork.nodeId, shared.nodes[2]!.nodeId), edge('40000000-0000-4000-8000-000000000008', secondFork.nodeId, shared.nodes[3]!.nodeId)); assert.equal(compiler.validate(shared).code, 'WORKFLOW_JOIN_AMBIGUOUS');
});

test('accepts explicit visual groups but rejects hidden or overlapping members', () => {
  const graph = parallelGraph(); const group = { groupId: '50000000-0000-4000-8000-000000000001', memberNodeIds: [graph.nodes[2]!.nodeId, graph.nodes[3]!.nodeId], displayOrder: [graph.nodes[3]!.nodeId, graph.nodes[2]!.nodeId] }; assert.equal(compiler.validate({ ...graph, groups: [group] }).valid, true);
  assert.equal(compiler.validate({ ...graph, groups: [{ ...group, memberNodeIds: [graph.nodes[2]!.nodeId, '50000000-0000-4000-8000-000000000099'] }] }).code, 'WORKFLOW_GRAPH_INVALID');
  assert.equal(compiler.validate({ ...graph, groups: [group, { groupId: '50000000-0000-4000-8000-000000000002', memberNodeIds: [graph.nodes[3]!.nodeId, graph.nodes[4]!.nodeId], displayOrder: [graph.nodes[3]!.nodeId, graph.nodes[4]!.nodeId] }] }).code, 'WORKFLOW_GRAPH_INVALID');
});

function parallelGraph(): EditableWorkflowGraphV1 & { nodes: EditableWorkflowNodeV1[]; edges: EditableWorkflowEdgeV1[] } {
  const root = node('30000000-0000-4000-8000-000000000001', 'control.group'); const fork = node('30000000-0000-4000-8000-000000000002', 'control.parallel'); const left = node('30000000-0000-4000-8000-000000000003', 'control.group'); const right = node('30000000-0000-4000-8000-000000000004', 'control.group'); const join = node('30000000-0000-4000-8000-000000000005', 'control.join');
  return { schemaVersion: '1', projectId: PROJECT, nodes: [root, fork, left, right, join], edges: [edge('40000000-0000-4000-8000-000000000001', root.nodeId, fork.nodeId), edge('40000000-0000-4000-8000-000000000002', fork.nodeId, left.nodeId), edge('40000000-0000-4000-8000-000000000003', fork.nodeId, right.nodeId), edge('40000000-0000-4000-8000-000000000004', left.nodeId, join.nodeId), edge('40000000-0000-4000-8000-000000000005', right.nodeId, join.nodeId)] };
}
function node(nodeId: string, kind: EditableWorkflowNodeV1['kind']): EditableWorkflowNodeV1 { return { nodeId, kind, kindVersion: '1', configurationDigest: 'a'.repeat(64), requestedEffects: [], retry: { maxAttempts: 1, backoffMs: 0, sideEffectPolicy: 'none' } }; }
function edge(edgeId: string, sourceNodeId: string, targetNodeId: string): EditableWorkflowEdgeV1 { return { edgeId, sourceNodeId, sourcePort: 'success', targetNodeId, targetPort: 'in' }; }
