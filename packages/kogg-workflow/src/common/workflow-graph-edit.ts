import type { EdgeOutcome, EditableWorkflowEdgeV1, EditableWorkflowNodeV1 } from './workflow-protocol';

// observability-exempt: Pure graph-edit transformations perform no operational I/O.
// diagnostic-coverage: workflow.graph, workflow.accessibility

export function allowedSourceOutcomes(kind: EditableWorkflowNodeV1['kind']): readonly EdgeOutcome[] {
  return kind === 'control.condition' ? ['true', 'false', 'finally'] : ['success', 'failure', 'finally'];
}

export function connectWorkflowNodes(
  nodes: readonly EditableWorkflowNodeV1[], edges: readonly EditableWorkflowEdgeV1[], edgeId: string,
  sourceNodeId: string, sourcePort: EdgeOutcome, targetNodeId: string
): readonly EditableWorkflowEdgeV1[] {
  const source = nodes.find(node => node.nodeId === sourceNodeId);
  if (!source || !nodes.some(node => node.nodeId === targetNodeId) || sourceNodeId === targetNodeId
    || !allowedSourceOutcomes(source.kind).includes(sourcePort)
    || edges.some(edge => edge.edgeId === edgeId || (edge.sourceNodeId === sourceNodeId && edge.sourcePort === sourcePort && edge.targetNodeId === targetNodeId))) {
    throw new Error('WORKFLOW_PORT_INVALID');
  }
  return [...edges, { edgeId, sourceNodeId, sourcePort, targetNodeId, targetPort: 'in' }];
}

export function disconnectWorkflowEdge(edges: readonly EditableWorkflowEdgeV1[], edgeId: string): readonly EditableWorkflowEdgeV1[] {
  if (!edges.some(edge => edge.edgeId === edgeId)) throw new Error('WORKFLOW_PORT_INVALID');
  return edges.filter(edge => edge.edgeId !== edgeId);
}

export function detachWorkflowNode(edges: readonly EditableWorkflowEdgeV1[], nodeId: string): readonly EditableWorkflowEdgeV1[] {
  return edges.filter(edge => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId);
}
