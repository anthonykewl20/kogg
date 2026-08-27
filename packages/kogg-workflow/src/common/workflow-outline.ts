import type { EditableWorkflowGraphV1, EditableWorkflowNodeV1 } from './workflow-protocol';

// observability-exempt: Pure structured-outline transformations perform no operational I/O.
// diagnostic-coverage: workflow.graph, workflow.accessibility

export function moveOutlineNode(nodes: readonly EditableWorkflowNodeV1[], index: number, offset: -1 | 1): readonly EditableWorkflowNodeV1[] {
  const target = index + offset;
  if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.length || target < 0 || target >= nodes.length) throw new Error('WORKFLOW_OUTLINE_MOVE_INVALID');
  const moved = [...nodes]; [moved[index], moved[target]] = [moved[target]!, moved[index]!]; return moved;
}

export function buildLinearGraph(projectId: string, nodes: readonly EditableWorkflowNodeV1[], edgeIds: readonly string[]): EditableWorkflowGraphV1 {
  if (edgeIds.length !== Math.max(0, nodes.length - 1)) throw new Error('WORKFLOW_OUTLINE_EDGE_INVALID');
  return { schemaVersion: '1', projectId, nodes, edges: nodes.slice(1).map((item, index) => ({ edgeId: edgeIds[index]!, sourceNodeId: nodes[index]!.nodeId, sourcePort: 'success', targetNodeId: item.nodeId, targetPort: 'in' })) };
}
