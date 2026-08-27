import { injectable } from '@theia/core/shared/inversify';
import type { EditableNodeKind, EditableWorkflowNodeV1, EdgeOutcome, WorkflowSafeCode } from '../common/workflow-protocol';
import { workflowDigest } from '../common/workflow-canonical';
import { workflowLog } from './workflow-logger';

// Executes only process-free control transitions; external and state-changing nodes remain unavailable in the closed catalog.
// diagnostic-coverage: workflow.catalog, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.source-maps

export interface WorkflowExecutorAttestationV1 {
  readonly schemaVersion: '1'; readonly executorId: 'kogg.workflow.control'; readonly executorVersion: '1.0.0';
  readonly executionKind: 'in-process-deterministic'; readonly ownerKind: 'workflow'; readonly artifactDigest: string;
  readonly supportedKinds: readonly EditableNodeKind[];
}
export interface WorkflowExecutorBindingV1 { readonly executorId: string; readonly executorVersion: string; readonly artifactDigest: string; }
export interface WorkflowControlExecutionRequestV1 { readonly runId: string; readonly node: EditableWorkflowNodeV1; readonly attempt: number; readonly predecessorOutcomes: readonly ('success' | 'failure' | 'skipped')[]; }
export interface WorkflowControlExecutionResultV1 { readonly kind: 'completed' | 'refused'; readonly code: WorkflowSafeCode; readonly output?: EdgeOutcome; readonly processCount: 0; readonly residualProcessCount: 0; }

const SUPPORTED: readonly EditableNodeKind[] = Object.freeze(['control.condition','control.parallel','control.join','control.group','control.finally']);
const CONTRACT = { schemaVersion: '1', executorId: 'kogg.workflow.control', executorVersion: '1.0.0', executionKind: 'in-process-deterministic', ownerKind: 'workflow', supportedKinds: SUPPORTED, semantics: { condition: ['always','prior-success','prior-failure'], passiveOutput: 'success', joinMinimumPredecessors: 2, processCount: 0 } } as const;
const ATTESTATION: WorkflowExecutorAttestationV1 = Object.freeze({ ...CONTRACT, artifactDigest: workflowDigest('executor-artifact', CONTRACT) });

@injectable()
export class WorkflowExecutorRegistry {
  attestations(): readonly WorkflowExecutorAttestationV1[] { return [ATTESTATION]; }
  binding(kind: EditableNodeKind): WorkflowExecutorBindingV1 | undefined { return SUPPORTED.includes(kind) ? pickBinding(ATTESTATION) : undefined; }
  resolveExact(kind: EditableNodeKind, binding: WorkflowExecutorBindingV1): WorkflowExecutorAttestationV1 {
    if (!SUPPORTED.includes(kind) || binding.executorId !== ATTESTATION.executorId || binding.executorVersion !== ATTESTATION.executorVersion || binding.artifactDigest !== ATTESTATION.artifactDigest) throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_INCOMPATIBLE');
    return ATTESTATION;
  }
  execute(request: WorkflowControlExecutionRequestV1, binding: WorkflowExecutorBindingV1): WorkflowControlExecutionResultV1 {
    const fields = { runId: safeId(request.runId), nodeId: safeId(request.node.nodeId), nodeKind: request.node.kind, attempt: safeAttempt(request.attempt), executorId: binding.executorId };
    workflowLog('node.execution.started', fields);
    try {
      if (fields.runId === 'invalid' || fields.nodeId === 'invalid' || fields.attempt === 0) throw new WorkflowExecutorError('WORKFLOW_SCHEMA_INVALID');
      this.resolveExact(request.node.kind, binding);
      if (request.node.configuration && workflowDigest('node-configuration', request.node.configuration) !== request.node.configurationDigest) throw new WorkflowExecutorError('WORKFLOW_STORE_INTEGRITY');
      const output = transition(request);
      const result = { kind: 'completed', code: 'WORKFLOW_OK', output, processCount: 0, residualProcessCount: 0 } as const;
      workflowLog('node.execution.completed', { ...fields, output, safeCode: result.code, processCount: 0, residualProcessCount: 0 }); return result;
    } catch (error) { // observability-exempt: node.execution.refused records only the closed code and opaque execution identifiers.
      const code = error instanceof WorkflowExecutorError ? error.code : 'WORKFLOW_INTERNAL'; workflowLog('node.execution.refused', { ...fields, safeCode: code, processCount: 0, residualProcessCount: 0 }); return { kind: 'refused', code, processCount: 0, residualProcessCount: 0 };
    }
  }
}

class WorkflowExecutorError extends Error { constructor(readonly code: WorkflowSafeCode) { super(code); } }
function pickBinding(value: WorkflowExecutorAttestationV1): WorkflowExecutorBindingV1 { return { executorId: value.executorId, executorVersion: value.executorVersion, artifactDigest: value.artifactDigest }; }
function transition(request: WorkflowControlExecutionRequestV1): EdgeOutcome {
  if (request.node.kind === 'control.join' && request.predecessorOutcomes.length < 2) throw new WorkflowExecutorError('WORKFLOW_JOIN_AMBIGUOUS');
  if (request.node.kind !== 'control.condition') return 'success';
  const condition = request.node.configuration?.condition ?? 'always'; if (condition === 'always') return 'true';
  const prior = [...request.predecessorOutcomes].reverse().find(outcome => outcome !== 'skipped'); if (!prior) throw new WorkflowExecutorError('WORKFLOW_CONDITION_INVALID');
  return condition === 'prior-success' ? prior === 'success' ? 'true' : 'false' : prior === 'failure' ? 'true' : 'false';
}
function safeId(value: string): string { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value) ? value : 'invalid'; }
function safeAttempt(value: number): number { return Number.isSafeInteger(value) && value > 0 ? value : 0; }
