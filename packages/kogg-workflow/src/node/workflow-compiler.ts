import { randomUUID } from 'node:crypto';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { EditableNodeKind, EditableWorkflowGraphV1, WorkflowAuthorityEffect, WorkflowCompiledPlanProjection, WorkflowValidationProjection } from '../common/workflow-protocol';
import { decodeGraph, WorkflowValidationError, workflowDigest } from '../common/workflow-canonical';
import { WorkflowNodeCatalog } from './workflow-node-catalog';

// observability-exempt: Pure deterministic compilation performs no I/O; WorkflowRegistry logs every external validation and compile boundary.
// diagnostic-coverage: workflow.schema, workflow.catalog, workflow.graph, workflow.anchors, workflow.authority, workflow.source-maps

const ANCHORS = ['anchor.spec-frozen','anchor.spec-approved','anchor.producer-separated','anchor.checks-complete','anchor.evidence-admitted','anchor.ranex-pass-current','anchor.merge-preflight','anchor.controlled-merge','anchor.cleanup-complete'] as const;
@injectable()
export class WorkflowCompiler {
  constructor(@inject(WorkflowNodeCatalog) private readonly catalog: WorkflowNodeCatalog) {}
  catalogStatus(): { readonly digest: string; readonly valid: boolean; readonly entryCount: number; readonly availableExecutorCount: number; readonly unavailableExecutorCount: number } { return { digest: this.catalog.digest, ...this.catalog.diagnostics() }; }
  catalogEntry(kind: EditableNodeKind) { return this.catalog.entry(kind); }
  executeControl(request: Parameters<WorkflowNodeCatalog['executeControl']>[0]) { return this.catalog.executeControl(request); }
  executeTaskApproval(request: Parameters<WorkflowNodeCatalog['executeTaskApproval']>[0]) { return this.catalog.executeTaskApproval(request); }
  executeContinuation(request: Parameters<WorkflowNodeCatalog['executeContinuation']>[0]) { return this.catalog.executeContinuation(request); }
  executeExternal(request: Parameters<WorkflowNodeCatalog['executeExternal']>[0]) { return this.catalog.executeExternal(request); }
  validate(input: unknown): WorkflowValidationProjection {
    try { const graph = decodeGraph(input); const checked = this.check(graph); return { valid: true, code: 'WORKFLOW_OK', graphDigest: workflowDigest('template', graph), ...checked }; }
    catch (error) { /* observability-exempt: the RPC-owning registry logs the sanitized validation outcome; this pure projection retains no input. */ return { valid: false, code: error instanceof WorkflowValidationError ? error.code : 'WORKFLOW_INTERNAL', nodeCount: count(input, 'nodes'), edgeCount: count(input, 'edges'), rootCount: 0 }; }
  }

  decodeAndValidate(input: unknown): EditableWorkflowGraphV1 {
    const graph = decodeGraph(input); this.check(graph); return graph;
  }

  compile(versionId: string, graph: EditableWorkflowGraphV1): WorkflowCompiledPlanProjection {
    this.check(graph);
    const graphDigest = workflowDigest('template', graph);
    const trustSpineDigest = workflowDigest('trust-spine', { schemaVersion: '1', anchors: ANCHORS });
    const catalogDigest = this.catalog.digest;
    const planBody = this.planBody(versionId, graphDigest, catalogDigest, trustSpineDigest, graph);
    return { planId: randomUUID(), versionId, planDigest: workflowDigest('compiled-plan', planBody), graphDigest, catalogDigest, trustSpineDigest, editableNodeCount: graph.nodes.length, injectedAnchorCount: ANCHORS.length };
  }

  assertPlanIntegrity(plan: WorkflowCompiledPlanProjection, graph: EditableWorkflowGraphV1): void {
    const graphDigest = workflowDigest('template', graph); const catalogDigest = this.catalog.digest;
    const trustSpineDigest = workflowDigest('trust-spine', { schemaVersion: '1', anchors: ANCHORS });
    const planDigest = workflowDigest('compiled-plan', this.planBody(plan.versionId, graphDigest, catalogDigest, trustSpineDigest, graph));
    if (plan.graphDigest !== graphDigest || plan.catalogDigest !== catalogDigest || plan.trustSpineDigest !== trustSpineDigest || plan.planDigest !== planDigest || plan.editableNodeCount !== graph.nodes.length || plan.injectedAnchorCount !== ANCHORS.length) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY');
  }

  private planBody(versionId: string, graphDigest: string, catalogDigest: string, trustSpineDigest: string, graph: EditableWorkflowGraphV1) {
    return { schemaVersion: '1', versionId, graphDigest, catalogDigest, trustSpineDigest, editableNodeIds: graph.nodes.map(node => node.nodeId), anchors: ANCHORS };
  }

  private check(graph: EditableWorkflowGraphV1): { nodeCount: number; edgeCount: number; rootCount: number } {
    const nodes = new Map(graph.nodes.map(node => [node.nodeId, node]));
    if (nodes.size !== graph.nodes.length) throw new WorkflowValidationError('WORKFLOW_GRAPH_INVALID');
    const edgeIds = new Set<string>(); const incoming = new Map<string, number>(); const outgoing = new Map<string, string[]>();
    for (const node of graph.nodes) {
      const entry = this.catalog.entry(node.kind); const allowed = new Set<WorkflowAuthorityEffect>(entry.grantCeiling); if (node.requestedEffects.some(effect => !allowed.has(effect))) throw new WorkflowValidationError('WORKFLOW_AUTHORITY_EXPANSION');
      if (entry.executor.status === 'available' && ['tool.git','tool.build','check.deterministic'].includes(node.kind) && !this.catalog.externalConfigurationAvailable(node)) throw new WorkflowValidationError('WORKFLOW_EXECUTOR_INCOMPATIBLE');
      if (node.configuration && node.configuration.absoluteDeadlineMs > entry.absoluteDeadlineMs) throw new WorkflowValidationError('WORKFLOW_DEADLINE');
      if (node.configuration?.target === 'project-read-only' && node.requestedEffects.includes('mutate-private-repository')) throw new WorkflowValidationError('WORKFLOW_TARGET_MISMATCH');
      if (node.retry.maxAttempts > 1 && node.retry.sideEffectPolicy === 'none' && node.requestedEffects.some(effect => effect !== 'read-repository')) throw new WorkflowValidationError('WORKFLOW_AUTHORITY_EXPANSION');
      incoming.set(node.nodeId, 0); outgoing.set(node.nodeId, []);
    }
    for (const edge of graph.edges) {
      if (edgeIds.has(edge.edgeId) || edge.sourceNodeId === edge.targetNodeId || !nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) throw new WorkflowValidationError('WORKFLOW_PORT_INVALID');
      edgeIds.add(edge.edgeId); const source = nodes.get(edge.sourceNodeId)!; const ports = new Set(this.catalog.entry(source.kind).outputPorts);
      if (!ports.has(edge.sourcePort)) throw new WorkflowValidationError('WORKFLOW_PORT_INVALID');
      incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1); outgoing.get(edge.sourceNodeId)!.push(edge.targetNodeId);
    }
    for (const node of graph.nodes) { const count = incoming.get(node.nodeId) ?? 0; if (count > 1 && node.kind !== 'control.join' && node.kind !== 'control.finally') throw new WorkflowValidationError('WORKFLOW_JOIN_AMBIGUOUS'); if (node.kind === 'control.join' && count < 2) throw new WorkflowValidationError('WORKFLOW_JOIN_AMBIGUOUS'); }
    if (cycle(graph)) throw new WorkflowValidationError('WORKFLOW_CYCLE');
    validateForkJoins(graph, outgoing);
    const roots = graph.nodes.filter(node => (incoming.get(node.nodeId) ?? 0) === 0); if (roots.length !== 1) throw new WorkflowValidationError('WORKFLOW_UNREACHABLE');
    const queue = [roots[0]!.nodeId]; const visited = new Set<string>();
    while (queue.length) { const id = queue.shift()!; if (visited.has(id)) continue; visited.add(id); for (const target of outgoing.get(id) ?? []) queue.push(target); }
    if (visited.size !== graph.nodes.length) throw new WorkflowValidationError('WORKFLOW_UNREACHABLE');
    return { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, rootCount: roots.length };
  }
}

function cycle(graph: EditableWorkflowGraphV1): boolean { const degree = new Map(graph.nodes.map(node => [node.nodeId, 0])); const edges = new Map(graph.nodes.map(node => [node.nodeId, [] as string[]])); for (const edge of graph.edges) { degree.set(edge.targetNodeId, (degree.get(edge.targetNodeId) ?? 0) + 1); edges.get(edge.sourceNodeId)?.push(edge.targetNodeId); } const queue = [...degree].filter(([, value]) => value === 0).map(([id]) => id); let count = 0; while (queue.length) { const id = queue.shift()!; count++; for (const target of edges.get(id) ?? []) { const next = (degree.get(target) ?? 0) - 1; degree.set(target, next); if (next === 0) queue.push(target); } } return count !== graph.nodes.length; }
function validateForkJoins(graph: EditableWorkflowGraphV1, outgoing: ReadonlyMap<string, readonly string[]>): void {
  const joins = graph.nodes.filter(node => node.kind === 'control.join'); const matched = new Set<string>();
  for (const fork of graph.nodes.filter(node => node.kind === 'control.parallel' || (node.kind === 'control.condition' && graph.edges.some(edge => edge.sourceNodeId === node.nodeId && (edge.sourcePort === 'true' || edge.sourcePort === 'false'))))) {
    const branchEdges = graph.edges.filter(edge => edge.sourceNodeId === fork.nodeId && (fork.kind === 'control.parallel' ? edge.sourcePort === 'success' : edge.sourcePort === 'true' || edge.sourcePort === 'false'));
    const branches = branchEdges.map(edge => edge.targetNodeId);
    const portCounts = new Map<string, number>(); for (const edge of graph.edges.filter(edge => edge.sourceNodeId === fork.nodeId)) portCounts.set(edge.sourcePort, (portCounts.get(edge.sourcePort) ?? 0) + 1);
    const invalidCondition = fork.kind === 'control.condition' && (branches.length !== 2 || !branchEdges.some(edge => edge.sourcePort === 'true') || !branchEdges.some(edge => edge.sourcePort === 'false'));
    if (invalidCondition || (fork.kind === 'control.parallel' && (branches.length < 2 || branches.length > 8)) || [...portCounts].some(([port, value]) => !(fork.kind === 'control.parallel' && port === 'success') && value > 1)) throw new WorkflowValidationError('WORKFLOW_JOIN_AMBIGUOUS');
    const candidates = joins.filter(join => branches.every(branch => reachable(branch, join.nodeId, outgoing)));
    const nearest = candidates.filter(candidate => !candidates.some(other => other.nodeId !== candidate.nodeId && reachable(other.nodeId, candidate.nodeId, outgoing)));
    if (nearest.length !== 1 || matched.has(nearest[0]!.nodeId)) throw new WorkflowValidationError('WORKFLOW_JOIN_AMBIGUOUS'); matched.add(nearest[0]!.nodeId);
  }
  if (matched.size !== joins.length) throw new WorkflowValidationError('WORKFLOW_JOIN_AMBIGUOUS');
}
function reachable(source: string, target: string, outgoing: ReadonlyMap<string, readonly string[]>): boolean { const queue = [source]; const visited = new Set<string>(); while (queue.length) { const id = queue.shift()!; if (id === target) return true; if (visited.has(id)) continue; visited.add(id); queue.push(...(outgoing.get(id) ?? [])); } return false; }
function count(input: unknown, key: string): number { if (!input || typeof input !== 'object') return 0; const value = (input as Record<string, unknown>)[key]; return Array.isArray(value) ? value.length : 0; }
