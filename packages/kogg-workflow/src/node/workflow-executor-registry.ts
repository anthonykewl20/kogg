import { injectable } from '@theia/core/shared/inversify';
import type { TaskAdmissionSnapshot } from '@kogg/tasks/lib/common/tasks-protocol';
import type { EditableNodeKind, EditableWorkflowNodeV1, EdgeOutcome, WorkflowSafeCode } from '../common/workflow-protocol';
import { workflowDigest } from '../common/workflow-canonical';
import { workflowLog } from './workflow-logger';

// Attests deterministic controls, exact task-approval witnesses, and supervised agent dispatch.
// diagnostic-coverage: workflow.catalog, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.source-maps

export interface WorkflowExecutorAttestationV1 {
  readonly schemaVersion: '1'; readonly executorId: 'kogg.workflow.control' | 'kogg.tasks.admission' | 'kogg.workflow.continuation' | 'kogg.agents.registry'; readonly executorVersion: '1.0.0';
  readonly executionKind: 'in-process-deterministic' | 'task-admission-witness' | 'human-continuation-receipt' | 'supervised-registry'; readonly ownerKind: 'workflow' | 'task' | 'kogg'; readonly artifactDigest: string;
  readonly supportedKinds: readonly EditableNodeKind[];
}
export interface WorkflowExecutorBindingV1 { readonly executorId: string; readonly executorVersion: string; readonly artifactDigest: string; }
export interface WorkflowControlExecutionRequestV1 { readonly runId: string; readonly node: EditableWorkflowNodeV1; readonly attempt: number; readonly predecessorOutcomes: readonly ('success' | 'failure' | 'skipped')[]; }
export interface WorkflowTaskApprovalExecutionRequestV1 extends WorkflowControlExecutionRequestV1 { readonly taskAdmission: TaskAdmissionSnapshot; readonly taskAdmissionDigest: string; }
export interface WorkflowContinuationExecutionRequestV1 extends WorkflowControlExecutionRequestV1 { readonly receiptDigest: string; }
export interface WorkflowControlExecutionResultV1 { readonly kind: 'completed' | 'refused'; readonly code: WorkflowSafeCode; readonly output?: EdgeOutcome; readonly processCount: 0; readonly residualProcessCount: 0; }

const CONTROL_KINDS: readonly EditableNodeKind[] = Object.freeze(['control.condition','control.parallel','control.join','control.group','control.finally']);
const APPROVAL_KINDS: readonly EditableNodeKind[] = Object.freeze(['approval.specification']);
const CONTINUATION_KINDS: readonly EditableNodeKind[] = Object.freeze(['approval.continue']);
const AGENT_KINDS: readonly EditableNodeKind[] = Object.freeze(['research.agent','pseudocode.agent','probe.agent','implementation.agent']);
const CONTROL_CONTRACT = { schemaVersion: '1', executorId: 'kogg.workflow.control', executorVersion: '1.0.0', executionKind: 'in-process-deterministic', ownerKind: 'workflow', supportedKinds: CONTROL_KINDS, semantics: { condition: ['always','prior-success','prior-failure'], passiveOutput: 'success', joinMinimumPredecessors: 2, processCount: 0 } } as const;
const APPROVAL_CONTRACT = { schemaVersion: '1', executorId: 'kogg.tasks.admission', executorVersion: '1.0.0', executionKind: 'task-admission-witness', ownerKind: 'task', supportedKinds: APPROVAL_KINDS, semantics: { approvalKind: 'specification', authority: 'exact-current-task-admission', executionRevalidation: 'required', processCount: 0 } } as const;
const CONTINUATION_CONTRACT = { schemaVersion: '1', executorId: 'kogg.workflow.continuation', executorVersion: '1.0.0', executionKind: 'human-continuation-receipt', ownerKind: 'workflow', supportedKinds: CONTINUATION_KINDS, semantics: { approvalKind: 'continue', receipt: 'durable-explicit-review', replay: 'exact', processCount: 0 } } as const;
const AGENT_CONTRACT = { schemaVersion: '1', executorId: 'kogg.agents.registry', executorVersion: '1.0.0', executionKind: 'supervised-registry', ownerKind: 'kogg', supportedKinds: AGENT_KINDS, semantics: { taskAdmission: 'exact', roleBinding: 'exact', ownership: 'agent-registry', terminalCleanup: 'required' } } as const;
const ATTESTATIONS: readonly WorkflowExecutorAttestationV1[] = Object.freeze([
  Object.freeze({ ...CONTROL_CONTRACT, artifactDigest: workflowDigest('executor-artifact', CONTROL_CONTRACT) }),
  Object.freeze({ ...APPROVAL_CONTRACT, artifactDigest: workflowDigest('executor-artifact', APPROVAL_CONTRACT) }),
  Object.freeze({ ...CONTINUATION_CONTRACT, artifactDigest: workflowDigest('executor-artifact', CONTINUATION_CONTRACT) }),
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
  executeTaskApproval(request: WorkflowTaskApprovalExecutionRequestV1, binding: WorkflowExecutorBindingV1): WorkflowControlExecutionResultV1 {
    const fields = { runId: safeId(request.runId), nodeId: safeId(request.node.nodeId), nodeKind: request.node.kind, attempt: safeAttempt(request.attempt), executorId: binding.executorId }; workflowLog('node.execution.started', fields);
    try {
      const attestation = this.resolveExact(request.node.kind, binding); const admission = request.taskAdmission; const authorizedAt = Date.parse(admission.authorizedAt); const expiresAt = Date.parse(admission.expiresAt);
      if (attestation.executionKind !== 'task-admission-witness' || request.node.kind !== 'approval.specification' || fields.runId === 'invalid' || fields.nodeId === 'invalid' || fields.attempt === 0 || admission.taskAdmissionId !== admission.runId || admission.runId !== request.runId || !Number.isFinite(authorizedAt) || !Number.isFinite(expiresAt) || authorizedAt > Date.now() || expiresAt <= Date.now() || workflowDigest('run-snapshot', { schemaVersion: '1', taskAdmission: admission }) !== request.taskAdmissionDigest) throw new WorkflowExecutorError('WORKFLOW_AUTHORITY_EXPANSION');
      const result = { kind: 'completed', code: 'WORKFLOW_OK', output: 'success', processCount: 0, residualProcessCount: 0 } as const; workflowLog('node.execution.completed', { ...fields, output: 'success', safeCode: result.code, processCount: 0, residualProcessCount: 0 }); return result;
    } catch (error) { // observability-exempt: node.execution.refused records only the closed code and opaque execution identifiers.
      const code = error instanceof WorkflowExecutorError ? error.code : 'WORKFLOW_INTERNAL'; workflowLog('node.execution.refused', { ...fields, safeCode: code, processCount: 0, residualProcessCount: 0 }); return { kind: 'refused', code, processCount: 0, residualProcessCount: 0 };
    }
  }
  executeContinuation(request: WorkflowContinuationExecutionRequestV1, binding: WorkflowExecutorBindingV1): WorkflowControlExecutionResultV1 {
    const fields = { runId: safeId(request.runId), nodeId: safeId(request.node.nodeId), nodeKind: request.node.kind, attempt: safeAttempt(request.attempt), executorId: binding.executorId }; workflowLog('node.execution.started', fields);
    try {
      const attestation = this.resolveExact(request.node.kind, binding); if (attestation.executionKind !== 'human-continuation-receipt' || request.node.kind !== 'approval.continue' || fields.runId === 'invalid' || fields.nodeId === 'invalid' || fields.attempt === 0 || !/^[0-9a-f]{64}$/u.test(request.receiptDigest)) throw new WorkflowExecutorError('WORKFLOW_APPROVAL_INVALID');
      const result = { kind: 'completed', code: 'WORKFLOW_OK', output: 'success', processCount: 0, residualProcessCount: 0 } as const; workflowLog('node.execution.completed', { ...fields, output: 'success', safeCode: result.code, processCount: 0, residualProcessCount: 0 }); return result;
    } catch (error) { // observability-exempt: node.execution.refused records the closed approval code and opaque execution identifiers without the receipt.
      const code = error instanceof WorkflowExecutorError ? error.code : 'WORKFLOW_INTERNAL'; workflowLog('node.execution.refused', { ...fields, safeCode: code, processCount: 0, residualProcessCount: 0 }); return { kind: 'refused', code, processCount: 0, residualProcessCount: 0 }; }
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
