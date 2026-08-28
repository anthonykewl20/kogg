import type { WorkflowGroupV1 } from './workflow-protocol';

// observability-exempt: Pure editor transformation performs no I/O; the widget logs user-visible group operations.
// diagnostic-coverage: workflow.graph, workflow.accessibility, workflow.source-maps
export function createWorkflowGroup(groups: readonly WorkflowGroupV1[], groupId: string, memberNodeIds: readonly string[]): readonly WorkflowGroupV1[] {
  if (groups.some(group => group.groupId === groupId) || memberNodeIds.length < 2 || new Set(memberNodeIds).size !== memberNodeIds.length || groups.some(group => group.memberNodeIds.some(member => memberNodeIds.includes(member)))) throw new Error('WORKFLOW_GRAPH_INVALID');
  return [...groups, { groupId, memberNodeIds: [...memberNodeIds].sort(), displayOrder: [...memberNodeIds] }];
}
export function removeWorkflowGroup(groups: readonly WorkflowGroupV1[], groupId: string): readonly WorkflowGroupV1[] {
  if (!groups.some(group => group.groupId === groupId)) throw new Error('WORKFLOW_GRAPH_INVALID'); return groups.filter(group => group.groupId !== groupId);
}
export function detachNodeFromGroups(groups: readonly WorkflowGroupV1[], nodeId: string): readonly WorkflowGroupV1[] {
  return groups.flatMap(group => { if (!group.memberNodeIds.includes(nodeId)) return [group]; const members = group.memberNodeIds.filter(id => id !== nodeId); return members.length < 2 ? [] : [{ ...group, memberNodeIds: members, displayOrder: group.displayOrder.filter(id => id !== nodeId) }]; });
}
export function reorderWorkflowGroupDisplay(groups: readonly WorkflowGroupV1[], orderedNodeIds: readonly string[]): readonly WorkflowGroupV1[] {
  const order = new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
  return groups.map(group => {
    if (group.memberNodeIds.some(nodeId => !order.has(nodeId))) throw new Error('WORKFLOW_GRAPH_INVALID');
    return { ...group, displayOrder: [...group.memberNodeIds].sort((left, right) => order.get(left)! - order.get(right)!) };
  });
}
