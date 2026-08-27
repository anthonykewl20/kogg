import { injectable } from '@theia/core/shared/inversify';
import type { EditableNodeKind, EditableWorkflowNodeV1, EdgeOutcome, WorkflowSafeCode } from '../common/workflow-protocol';
import { workflowDigest } from '../common/workflow-canonical';
import { workflowLog } from './workflow-logger';

// Attests deterministic controls and supervised agent dispatch; direct execution here remains limited to process-free controls.
// diagnostic-coverage: workflow.catalog, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.source-maps

export interface WorkflowExecutorAttestationV1 {
  readonly schemaVersion: '1'; readonly executorId: 'kogg.workflow.control' | 'kogg.agents.registry'; readonly executorVersion: '1.0.0';
  readonly executionKind: 'in-process-deterministic' | 'supervised-registry'; readonly ownerKind: 'workflow' | 'kogg'; readonly artifactDigest: string;
  readonly supportedKinds: readonly EditableNodeKind[];
}
export interface WorkflowExecutorBindingV1 { readonly executorId: string; readonly executorVersion: string; readonly artifactDigest: string; }
export interface WorkflowControlExecutionRequestV1 { readonly runId: string; readonly node: EditableWorkflowNodeV1; readonly attempt: number; readonly predecessorOutcomes: readonly ('success' | 'failure' | 'skipped')[]; }
export interface WorkflowControlExecutionResultV1 { readonly kind: 'completed' | 'refused'; readonly code: WorkflowSafeCode; readonly output?: EdgeOutcome; readonly processCount: 0; readonly residualProcessCount: 0; }

const CONTROL_KINDS: readonly EditableNodeKind[] = Object.freeze(['control.condition','control.parallel','control.join','control.group','control.finally']);
const AGENT_KINDS: readonly EditableNodeKind[] = Object.freeze(['research.agent','pseudocode.agent','probe.agent','implementation.agent']);
const CONTROL_CONTRACT = { schemaVersion: '1', executorId: 'kogg.workflow.control', executorVersion: '1.0.0', executionKind: 'in-process-deterministic', ownerKind: 'workflow', supportedKinds: CONTROL_KINDS, semantics: { condition: ['always','prior-success','prior-failure'], passiveOutput: 'success', joinMinimumPredecessors: 2, processCount: 0 } } as const;
const AGENT_CONTRACT = { schemaVersion: '1', executorId: 'kogg.agents.registry', executorVersion: '1.0.0', executionKind: 'supervised-registry', ownerKind: 'kogg', supportedKinds: AGENT_KINDS, semantics: { taskAdmission: 'exact', roleBinding: 'exact', ownership: 'agent-registry', terminalCleanup: 'required' } } as const;
const ATTESTATIONS: readonly WorkflowExecutorAttestationV1[] = Object.freeze([
  Object.freeze({ ...CONTROL_CONTRACT, artifactDigest: workflowDigest('executor-artifact', CONTROL_CONTRACT) }),
  Object.freeze({ ...AGENT_CONTRACT, artifactDigest: workflowDigest('executor-artifact', AGENT_CONTRACT) })
]);

@injectable()
export class WorkflowExecutorRegistry {
  attestations(): readonly WorkflowExecutorAttestationV1[] { return ATTESTATIONS; }
  binding(kind: EditableNodeKind): WorkflowExecutorBindingV1 | undefined { const attestation = ATTESTATIONS.find(item => item.supportedKinds.includes(kind)); return attestation ? pickBinding(attestation) : undefined; }
  resolveExact(kind: EditableNodeKind, binding: WorkflowExecutorBindingV1): WorkflowExecutorAttestationV1 {
    const attestation = ATTESTATIONS.find(item => item.supportedKinds.includes(kind));
    if (!attestation || binding.executorId !== attestation.executorId || binding.executorVersion !== attestation.executorVersion || binding.artifactDigest !== attestation.artifactDigest) throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_INCOMPATIBLE');
    return attestation;
  }
  execute(request: WorkflowControlExecutionRequestV1, binding: WorkflowExecutorBindingV1): WorkflowControlExecutionResultV1 {
    const fields = { runId: safeId(request.runId), nodeId: safeId(request.node.nodeId), nodeKind: request.node.kind, attempt: safeAttempt(request.attempt), executorId: binding.executorId };
    workflowLog('node.execution.started', fields);
    try {
      if (fields.runId === 'invalid' || fields.nodeId === 'invalid' || fields.attempt === 0) throw new WorkflowExecutorError('WORKFLOW_SCHEMA_INVALID');
      const attestation = this.resolveExact(request.node.kind, binding); if (attestation.executionKind !== 'in-process-deterministic') throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_INCOMPATIBLE');
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
