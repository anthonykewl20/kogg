import { inject, injectable, optional } from '@theia/core/shared/inversify';
import type { TaskAdmissionSnapshot } from '@kogg/tasks/lib/common/tasks-protocol';
import { WORKFLOW_SAFE_CODES, type EditableNodeKind, type EditableWorkflowNodeV1, type EdgeOutcome, type WorkflowSafeCode } from '../common/workflow-protocol';
import { workflowDigest } from '../common/workflow-canonical';
import { workflowLog } from './workflow-logger';

// Attests deterministic controls, exact task-approval witnesses, and supervised agent dispatch.
// diagnostic-coverage: workflow.catalog, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.source-maps

export interface WorkflowExecutorAttestationV1 {
  readonly schemaVersion: '1'; readonly executorId: 'kogg.workflow.control' | 'kogg.tasks.admission' | 'kogg.workflow.continuation' | 'kogg.agents.registry' | 'kogg.execution.catalog' | 'kogg.kernel.checks'; readonly executorVersion: '1.0.0';
  readonly executionKind: 'in-process-deterministic' | 'task-admission-witness' | 'human-continuation-receipt' | 'supervised-registry' | 'external-catalog'; readonly ownerKind: 'workflow' | 'task' | 'kogg' | 'execution' | 'kernel'; readonly artifactDigest: string;
  readonly supportedKinds: readonly EditableNodeKind[];
  readonly supportedBindingIds?: Readonly<Record<string, readonly string[]>>;
}
export interface WorkflowExecutorBindingV1 { readonly executorId: string; readonly executorVersion: string; readonly artifactDigest: string; }
export interface WorkflowControlExecutionRequestV1 { readonly runId: string; readonly node: EditableWorkflowNodeV1; readonly attempt: number; readonly predecessorOutcomes: readonly ('success' | 'failure' | 'skipped')[]; }
export interface WorkflowTaskApprovalExecutionRequestV1 extends WorkflowControlExecutionRequestV1 { readonly taskAdmission: TaskAdmissionSnapshot; readonly taskAdmissionDigest: string; }
export interface WorkflowContinuationExecutionRequestV1 extends WorkflowControlExecutionRequestV1 { readonly receiptDigest: string; }
export interface WorkflowControlExecutionResultV1 { readonly kind: 'completed' | 'refused'; readonly code: WorkflowSafeCode; readonly output?: EdgeOutcome; readonly processCount: 0; readonly residualProcessCount: 0; }
export type WorkflowExternalExecutorKind = 'tool.git' | 'tool.build' | 'check.deterministic';
export interface WorkflowExternalExecutorContractV1 extends WorkflowExecutorAttestationV1 {
  readonly executorId: 'kogg.execution.catalog' | 'kogg.kernel.checks'; readonly executionKind: 'external-catalog'; readonly ownerKind: 'execution' | 'kernel';
  readonly supportedKinds: readonly WorkflowExternalExecutorKind[]; readonly supportedBindingIds: Readonly<Partial<Record<WorkflowExternalExecutorKind, readonly string[]>>>;
}
export interface WorkflowExternalExecutionRequestV1 extends WorkflowControlExecutionRequestV1 {
  readonly planDigest: string; readonly taskAdmissionId: string; readonly repositoryId: string; readonly bindingId: string; readonly externalConfigurationDigest: string;
}
export interface WorkflowExternalExecutionResultV1 { readonly kind: 'completed' | 'refused'; readonly code: WorkflowSafeCode; readonly output?: 'success'; readonly processCount: number; readonly residualProcessCount: number; }
export interface WorkflowExternalCancellationResultV1 { readonly code: WorkflowSafeCode; readonly processCount: number; readonly residualProcessCount: number; }
export const WorkflowExternalExecutorAuthority = Symbol('WorkflowExternalExecutorAuthority');
export interface WorkflowExternalExecutorAuthority {
  readiness(): { readonly ready: boolean; readonly recoveryComplete: boolean; readonly residualProcessCount: number };
  attestations(): readonly WorkflowExternalExecutorContractV1[];
  execute(request: WorkflowExternalExecutionRequestV1): Promise<WorkflowExternalExecutionResultV1>;
  cancel(request: WorkflowExternalExecutionRequestV1): Promise<WorkflowExternalCancellationResultV1>;
}

const CONTROL_KINDS: readonly EditableNodeKind[] = Object.freeze(['control.condition','control.parallel','control.join','control.group','control.finally']);
const APPROVAL_KINDS: readonly EditableNodeKind[] = Object.freeze(['approval.specification']);
const CONTINUATION_KINDS: readonly EditableNodeKind[] = Object.freeze(['approval.continue']);
const AGENT_KINDS: readonly EditableNodeKind[] = Object.freeze(['research.agent','pseudocode.agent','probe.agent','implementation.agent']);
const CONTROL_CONTRACT = { schemaVersion: '1', executorId: 'kogg.workflow.control', executorVersion: '1.0.0', executionKind: 'in-process-deterministic', ownerKind: 'workflow', supportedKinds: CONTROL_KINDS, semantics: { condition: ['always','prior-success','prior-failure'], passiveOutput: 'success', joinMinimumPredecessors: 2, processCount: 0 } } as const;
const APPROVAL_CONTRACT = { schemaVersion: '1', executorId: 'kogg.tasks.admission', executorVersion: '1.0.0', executionKind: 'task-admission-witness', ownerKind: 'task', supportedKinds: APPROVAL_KINDS, semantics: { approvalKind: 'specification', authority: 'exact-current-task-admission', executionRevalidation: 'required', processCount: 0 } } as const;
const CONTINUATION_CONTRACT = { schemaVersion: '1', executorId: 'kogg.workflow.continuation', executorVersion: '1.0.0', executionKind: 'human-continuation-receipt', ownerKind: 'workflow', supportedKinds: CONTINUATION_KINDS, semantics: { approvalKind: 'continue', receipt: 'durable-explicit-review', replay: 'exact', processCount: 0 } } as const;
const AGENT_CONTRACT = { schemaVersion: '1', executorId: 'kogg.agents.registry', executorVersion: '1.0.0', executionKind: 'supervised-registry', ownerKind: 'kogg', supportedKinds: AGENT_KINDS, semantics: { taskAdmission: 'exact', roleBinding: 'exact', ownership: 'agent-registry', terminalCleanup: 'required' } } as const;
const BUILTIN_ATTESTATIONS: readonly WorkflowExecutorAttestationV1[] = Object.freeze([
  Object.freeze({ ...CONTROL_CONTRACT, artifactDigest: workflowDigest('executor-artifact', CONTROL_CONTRACT) }),
  Object.freeze({ ...APPROVAL_CONTRACT, artifactDigest: workflowDigest('executor-artifact', APPROVAL_CONTRACT) }),
  Object.freeze({ ...CONTINUATION_CONTRACT, artifactDigest: workflowDigest('executor-artifact', CONTINUATION_CONTRACT) }),
  Object.freeze({ ...AGENT_CONTRACT, artifactDigest: workflowDigest('executor-artifact', AGENT_CONTRACT) })
]);

@injectable()
export class WorkflowExecutorRegistry {
  private readonly all: readonly WorkflowExecutorAttestationV1[];
  constructor(@inject(WorkflowExternalExecutorAuthority) @optional() private readonly external?: WorkflowExternalExecutorAuthority) {
    let externalAttestations: readonly WorkflowExternalExecutorContractV1[] = [];
    if (external) {
      workflowLog('executor.catalog.verification.started', {});
      try { const readiness = external.readiness(); if (!validReadiness(readiness)) throw new Error('external executor owner unavailable'); externalAttestations = validateExternalAttestations(external.attestations()); workflowLog('executor.catalog.verification.completed', { contractCount: externalAttestations.length, bindingCount: externalAttestations.reduce((count, item) => count + item.supportedKinds.length, 0) }); }
      catch (error) { // observability-exempt: The closed refusal log excludes owner contracts and binding IDs while preserving the normalized failure type.
        externalAttestations = []; workflowLog('executor.catalog.verification.refused', { safeCode: 'WORKFLOW_EXECUTOR_INCOMPATIBLE', errorType: error instanceof Error ? error.name : 'UnknownError' });
      }
    }
    this.all = Object.freeze([...BUILTIN_ATTESTATIONS, ...externalAttestations]);
  }
  attestations(): readonly WorkflowExecutorAttestationV1[] { return this.all; }
  binding(kind: EditableNodeKind): WorkflowExecutorBindingV1 | undefined { const attestation = this.all.find(item => item.supportedKinds.includes(kind)); return attestation ? pickBinding(attestation) : undefined; }
  resolveExact(kind: EditableNodeKind, binding: WorkflowExecutorBindingV1): WorkflowExecutorAttestationV1 {
    const attestation = this.all.find(item => item.supportedKinds.includes(kind));
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
  externalConfigurationAvailable(node: EditableWorkflowNodeV1): boolean {
    if (!isExternalKind(node.kind)) return false; const attestation = this.all.find(item => item.supportedKinds.includes(node.kind)); const configuration = node.configuration;
    if (!attestation || attestation.executionKind !== 'external-catalog' || !configuration || !configuration.externalConfigurationDigest || !/^[0-9a-f]{64}$/u.test(configuration.externalConfigurationDigest)) return false;
    const bindingId = node.kind === 'check.deterministic' ? configuration.checkId : configuration.operationId;
    return typeof bindingId === 'string' && (attestation.supportedBindingIds?.[node.kind] ?? []).includes(bindingId);
  }
  async executeExternal(request: WorkflowExternalExecutionRequestV1, binding: WorkflowExecutorBindingV1): Promise<WorkflowExternalExecutionResultV1> {
    const fields = { runId: safeId(request.runId), nodeId: safeId(request.node.nodeId), nodeKind: request.node.kind, attempt: safeAttempt(request.attempt), executorId: binding.executorId }; workflowLog('node.execution.started', fields);
    try {
      const attestation = this.resolveExact(request.node.kind, binding);
      if (!this.external || attestation.executionKind !== 'external-catalog' || !this.externalConfigurationAvailable(request.node) || fields.runId === 'invalid' || fields.nodeId === 'invalid' || fields.attempt === 0 || !/^[0-9a-f]{64}$/u.test(request.planDigest) || !/^[0-9a-f]{64}$/u.test(request.externalConfigurationDigest) || !safeSymbol(request.taskAdmissionId) || !safeSymbol(request.repositoryId) || !safeSymbol(request.bindingId)) throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_INCOMPATIBLE');
      const expectedBinding = request.node.kind === 'check.deterministic' ? request.node.configuration?.checkId : request.node.configuration?.operationId;
      if (expectedBinding !== request.bindingId || request.node.configuration?.externalConfigurationDigest !== request.externalConfigurationDigest || request.node.configuration && workflowDigest('node-configuration', request.node.configuration) !== request.node.configurationDigest) throw new WorkflowExecutorError('WORKFLOW_STORE_INTEGRITY');
      const result = await executeWithinDeadline(this.external, Object.freeze({ ...request }), request.node.configuration!.absoluteDeadlineMs); validateExternalResult(result);
      if (result.kind === 'completed') { workflowLog('node.execution.completed', { ...fields, output: 'success', safeCode: result.code, processCount: result.processCount, residualProcessCount: result.residualProcessCount }); return result; }
      workflowLog('node.execution.refused', { ...fields, safeCode: result.code, processCount: result.processCount, residualProcessCount: result.residualProcessCount }); return result;
    } catch (error) { // observability-exempt: node.execution.refused discards owner errors and external configuration while retaining closed lifecycle facts.
      const code = error instanceof WorkflowExecutorError ? error.code : 'WORKFLOW_EXTERNAL_FAILURE'; workflowLog('node.execution.refused', { ...fields, safeCode: code, processCount: 0, residualProcessCount: 0 }); return { kind: 'refused', code, processCount: 0, residualProcessCount: 0 };
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
function isExternalKind(value: EditableNodeKind): value is WorkflowExternalExecutorKind { return value === 'tool.git' || value === 'tool.build' || value === 'check.deterministic'; }
function safeSymbol(value: string): boolean { return /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value); }
function validateExternalAttestations(input: readonly WorkflowExternalExecutorContractV1[]): readonly WorkflowExternalExecutorContractV1[] {
  if (!Array.isArray(input) || input.length !== 2) throw new Error('external executor catalog incomplete'); const seen = new Set<WorkflowExternalExecutorKind>();
  for (const value of input) {
    const expectedKinds: readonly WorkflowExternalExecutorKind[] = value.executorId === 'kogg.execution.catalog' ? ['tool.git','tool.build'] : value.executorId === 'kogg.kernel.checks' ? ['check.deterministic'] : [];
    const unsigned = { schemaVersion: value.schemaVersion, executorId: value.executorId, executorVersion: value.executorVersion, executionKind: value.executionKind, ownerKind: value.ownerKind, supportedKinds: value.supportedKinds, supportedBindingIds: value.supportedBindingIds };
    if (Object.keys(value).sort().join(',') !== ['artifactDigest','executionKind','executorId','executorVersion','ownerKind','schemaVersion','supportedBindingIds','supportedKinds'].sort().join(',') || value.schemaVersion !== '1' || value.executorVersion !== '1.0.0' || value.executionKind !== 'external-catalog' || (value.executorId === 'kogg.execution.catalog' ? value.ownerKind !== 'execution' : value.ownerKind !== 'kernel') || [...value.supportedKinds].sort().join(',') !== [...expectedKinds].sort().join(',') || Object.keys(value.supportedBindingIds).sort().join(',') !== [...expectedKinds].sort().join(',') || value.artifactDigest !== workflowDigest('executor-artifact', unsigned)) throw new Error('external executor attestation invalid');
    for (const kind of expectedKinds) { const ids = value.supportedBindingIds[kind]; if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 || ids.some(id => !safeSymbol(id)) || new Set(ids).size !== ids.length || [...ids].sort().join(',') !== ids.join(',') || seen.has(kind)) throw new Error('external executor binding catalog invalid'); seen.add(kind); }
  }
  if (seen.size !== 3) throw new Error('external executor catalog incomplete'); return Object.freeze(input.map(value => Object.freeze({ ...value, supportedKinds: Object.freeze([...value.supportedKinds]), supportedBindingIds: Object.freeze(Object.fromEntries(Object.entries(value.supportedBindingIds).map(([kind, ids]) => [kind, Object.freeze([...((ids as readonly string[] | undefined) ?? [])])]))) })));
}
function validateExternalResult(value: WorkflowExternalExecutionResultV1): void {
  const expectedKeys = value?.kind === 'completed' ? ['code','kind','output','processCount','residualProcessCount'] : ['code','kind','processCount','residualProcessCount'];
  if (!value || Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',') || !['completed','refused'].includes(value.kind) || !WORKFLOW_SAFE_CODES.includes(value.code) || !Number.isSafeInteger(value.processCount) || value.processCount < 0 || !Number.isSafeInteger(value.residualProcessCount) || value.residualProcessCount < 0 || (value.kind === 'completed' ? value.code !== 'WORKFLOW_OK' || value.output !== 'success' || value.residualProcessCount !== 0 : value.code === 'WORKFLOW_OK' || value.output !== undefined)) throw new WorkflowExecutorError('WORKFLOW_EXTERNAL_FAILURE');
}
function validReadiness(value: ReturnType<WorkflowExternalExecutorAuthority['readiness']>): boolean { return !!value && Object.keys(value).sort().join(',') === 'ready,recoveryComplete,residualProcessCount' && value.ready === true && value.recoveryComplete === true && value.residualProcessCount === 0; }
async function executeWithinDeadline(authority: WorkflowExternalExecutorAuthority, request: WorkflowExternalExecutionRequestV1, deadlineMs: number): Promise<WorkflowExternalExecutionResultV1> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1_000) throw new WorkflowExecutorError('WORKFLOW_DEADLINE'); let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([authority.execute(request).then(result => ({ type: 'result' as const, result })), new Promise<{ readonly type: 'deadline' }>(resolve => { timer = setTimeout(() => resolve({ type: 'deadline' }), deadlineMs); })]);
    if (outcome.type === 'result') return outcome.result;
    try { const cancelled = await authority.cancel(request); if (!cancelled || Object.keys(cancelled).sort().join(',') !== 'code,processCount,residualProcessCount' || !WORKFLOW_SAFE_CODES.includes(cancelled.code) || cancelled.code === 'WORKFLOW_OK' || !Number.isSafeInteger(cancelled.processCount) || cancelled.processCount < 0 || !Number.isSafeInteger(cancelled.residualProcessCount) || cancelled.residualProcessCount < 0) throw new Error('invalid cancellation result'); return { kind: 'refused', code: cancelled.residualProcessCount ? 'WORKFLOW_RESIDUAL_PROCESS' : 'WORKFLOW_DEADLINE', processCount: cancelled.processCount, residualProcessCount: cancelled.residualProcessCount }; }
    catch { // observability-exempt: The caller emits the closed residual-process refusal and never exposes cancellation owner details.
      return { kind: 'refused', code: 'WORKFLOW_RESIDUAL_PROCESS', processCount: 0, residualProcessCount: 1 };
    }
  } finally { if (timer) clearTimeout(timer); }
}
