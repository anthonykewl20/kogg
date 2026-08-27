import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import type { AgentWorkspaceAuthority, AgentWorkspaceAuthorizationRequestV1, AgentWorkspaceAuthorizationResultV1, AgentWorkspaceFinalizationRequestV1, AgentWorkspaceLifecycleRequestV1, AgentWorkspaceLifecycleResultV1 } from '@kogg/agents/lib/common/agents-protocol';
import { ProjectSourceBindingAuthority, type ProjectSourceBindingAuthority as SourceAuthority } from '@kogg/projects/lib/common/projects-protocol';
import { ExecutionTargetBindingAuthority, type ExecutionAllocationSummaryV1, type ExecutionBindingV1, type ExecutionLifecycleCode, type ExecutionState, type ExecutionTargetBindingAuthority as TargetAuthority } from '../common/execution-protocol';
import { AllocationRegistryError, ExecutionAllocationRegistry, type ExecutionWorkspaceContextV1 } from './execution-allocation-registry';
import { executionLog } from './execution-logger';
import { NativeAllocationController, NativeAllocationError, NativeCleanupError } from './native-allocation-controller';
import { ProductionPrivateGitSeeder } from './production-private-git-seeder';
import { GitRunError } from './controller-git-runner';
import { SeedError, type PrivateGitSeedAuthority } from './private-git-seeder';
import { ProductionCandidateLifecycle } from './production-candidate-lifecycle';
import { SealError } from './candidate-sealer';

// This is the only production bridge from an admitted mutating agent to a qualified, private, verified workspace; events route through [kogg:execution:workspace].
// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.git-independence, execution.source-integrity, execution.process-cleanup, execution.capacity, execution.recovery
@injectable()
export class AgentWorkspaceController implements AgentWorkspaceAuthority {
  constructor(
    @inject(ProjectSourceBindingAuthority) private readonly sources: SourceAuthority,
    @inject(ExecutionTargetBindingAuthority) private readonly targets: TargetAuthority,
    @inject(NativeAllocationController) private readonly native: Pick<NativeAllocationController, 'allocate' | 'cleanup' | 'privateGitPaths'>,
    @inject(ExecutionAllocationRegistry) private readonly allocations: Pick<ExecutionAllocationRegistry, 'advance' | 'workspaceContext' | 'recordRetention'>,
    @inject(ProductionPrivateGitSeeder) private readonly seeder: PrivateGitSeedAuthority,
    @inject(ProductionCandidateLifecycle) private readonly candidates: Pick<ProductionCandidateLifecycle, 'seal' | 'import'>,
    @unmanaged() private readonly quota = { bytes: '1073741824', inodes: '100000' }
  ) {}

  async prepareWorkspace(request: AgentWorkspaceAuthorizationRequestV1): Promise<AgentWorkspaceAuthorizationResultV1> {
    const fields = { eventVersion: 1 as const, requestId: request.requestId, projectId: request.projectId, runId: request.runId, attemptId: request.attemptId };
    executionLog('workspace.prepare.requested', fields);
    let current: ExecutionAllocationSummaryV1 | undefined;
    try {
      const target = await this.targets.resolveTargetBinding();
      if (!target) throw new WorkspacePreparationError('ALLOCATION_QUALIFICATION_INVALID');
      const source = await this.sources.resolveSourceBinding(request.projectId, request.repositoryId);
      if (!source || source.projectId !== request.projectId || source.repositoryId !== request.repositoryId
        || !source.available || !source.active || String(source.bindingRevision) !== request.repositoryBindingRevision) throw new WorkspacePreparationError('ALLOCATION_QUALIFICATION_INVALID');
      const binding: ExecutionBindingV1 = {
        schemaVersion: 1, projectId: request.projectId, projectRevision: String(source.registryRevision),
        repositoryId: request.repositoryId, repositoryBindingRevision: String(source.bindingRevision), repositoryIdentityDigest: digestValue(source.repositoryIdentityDigest),
        taskId: request.taskId, taskRevisionId: request.taskRevisionId, taskRevisionDigest: request.taskRevisionDigest,
        approvalDigest: request.approvalDigest, runId: request.runId, attemptId: request.attemptId,
        workflowPlanDigest: request.workflowPlanDigest, baseCommit: source.baseCommit, baseTree: source.baseTree,
        gitObjectFormat: source.gitObjectFormat, ...target
      };
      current = await this.native.allocate({ requestId: stageRequestId('allocation', request.requestId), binding, quotaBytes: this.quota.bytes, quotaInodes: this.quota.inodes });
      executionLog('workspace.allocated', { ...fields, worktreeId: current.worktreeId });
      current = await this.advance(current, 'seeding', 'ALLOCATION_OK');
      const paths = this.native.privateGitPaths(current);
      await this.seeder.seed({ projectId: request.projectId, repositoryId: request.repositoryId, runId: request.runId,
        worktreeId: current.worktreeId, sourceRoot: fileURLToPath(source.rootUri), sourceGitDirectory: fileURLToPath(source.gitDirectoryUri),
        ...paths, baseCommit: source.baseCommit, baseTree: source.baseTree, objectFormat: source.gitObjectFormat });
      executionLog('workspace.seeded', { ...fields, worktreeId: current.worktreeId });
      current = await this.advance(current, 'verified', 'ALLOCATION_OK');
      current = await this.advance(current, 'ready', 'ALLOCATION_OK');
      current = await this.advance(current, 'leased', 'ALLOCATION_OK');
      executionLog('workspace.leased', { ...fields, worktreeId: current.worktreeId });
      return { allowed: true, code: 'AGENT_OK', worktreeId: current.worktreeId, workspaceGrantDigest: grantDigest(binding, current) };
    } catch (error) { // observability-exempt: The closed workspace.prepare.refused event below records the classified failure and intentionally returns a denial.
      if (current) await this.cleanupAfterFailure(request.requestId, current, lifecycleCode(error));
      executionLog('workspace.prepare.refused', { ...fields, safeCode: lifecycleCode(error), errorType: error instanceof Error ? error.name : 'UnknownError' });
      return { allowed: false, code: 'WORKSPACE_UNTRUSTED' };
    }
  }

  async activateWorkspace(request: AgentWorkspaceLifecycleRequestV1): Promise<AgentWorkspaceLifecycleResultV1> {
    executionLog('workspace.activation.requested', { eventVersion: 1, requestId: request.requestId, attemptId: request.attemptId, worktreeId: request.worktreeId });
    try {
      const context = await this.authorizeLifecycle(request, 'leased');
      await this.advance(context.allocation, 'executing', 'ALLOCATION_OK');
      executionLog('workspace.activation.completed', { eventVersion: 1, requestId: request.requestId, attemptId: request.attemptId, worktreeId: request.worktreeId });
      return { completed: true, code: 'AGENT_OK' };
    } catch (error) { // observability-exempt: The closed activation refusal contains only safe identifiers and a classified code.
      executionLog('workspace.activation.refused', { eventVersion: 1, requestId: request.requestId, attemptId: request.attemptId, worktreeId: request.worktreeId,
        safeCode: lifecycleCode(error), errorType: error instanceof Error ? error.name : 'UnknownError' });
      return { completed: false, code: 'WORKSPACE_UNTRUSTED' };
    }
  }

  async finalizeWorkspace(request: AgentWorkspaceFinalizationRequestV1): Promise<AgentWorkspaceLifecycleResultV1> {
    executionLog('workspace.finalization.requested', { eventVersion: 1, requestId: request.requestId, attemptId: request.attemptId, worktreeId: request.worktreeId, outcome: request.outcome });
    let context: ExecutionWorkspaceContextV1 | undefined;
    try {
      validateFinalizationRequest(request);
      context = await this.authorizeLifecycle(request, ['leased', 'executing']);
      if (context.allocation.state === 'leased') {
        const cancelled = await this.advance(context.allocation, 'cancelled', 'PROCESS_EXIT_NONZERO');
        await this.native.cleanup({ requestId: stageRequestId('unstarted-cleanup', cancelled.worktreeId), worktreeId: cancelled.worktreeId, expectedRevision: cancelled.revision, bindingDigest: cancelled.bindingDigest });
      } else if (request.outcome === 'completed') await this.finalizeCompleted(request, context);
      else {
        const terminalState = request.outcome === 'cancelled' ? 'cancelled' : request.outcome === 'timed-out' ? 'timed-out' : 'failed';
        const terminal = await this.advance(context.allocation, terminalState, 'PROCESS_EXIT_NONZERO');
        await this.native.cleanup({ requestId: stageRequestId('terminal-cleanup', terminal.worktreeId), worktreeId: terminal.worktreeId, expectedRevision: terminal.revision, bindingDigest: terminal.bindingDigest });
      }
      executionLog('workspace.finalization.completed', { eventVersion: 1, requestId: request.requestId, attemptId: request.attemptId, worktreeId: request.worktreeId, outcome: request.outcome });
      return { completed: true, code: 'AGENT_OK' };
    } catch (error) { // observability-exempt: Cleanup recovery below and the final refusal retain only closed lifecycle codes.
      if (context && request.outcome === 'completed') await this.cleanupCompletionFailure(context.allocation, lifecycleCode(error));
      executionLog('workspace.finalization.failed', { eventVersion: 1, requestId: request.requestId, attemptId: request.attemptId, worktreeId: request.worktreeId,
        outcome: request.outcome, safeCode: lifecycleCode(error), errorType: error instanceof Error ? error.name : 'UnknownError' });
      return { completed: false, code: 'CLEANUP_FAILED' };
    }
  }

  private advance(current: ExecutionAllocationSummaryV1, nextState: Exclude<ExecutionState, 'cleaning' | 'cleaned' | 'cleanup-failed'>, safeCode: ExecutionLifecycleCode): Promise<ExecutionAllocationSummaryV1> {
    return this.allocations.advance({ requestId: stageRequestId(`state-${nextState}`, current.worktreeId), worktreeId: current.worktreeId, expectedRevision: current.revision,
      bindingDigest: current.bindingDigest, nextState, safeCode });
  }

  private async authorizeLifecycle(request: AgentWorkspaceLifecycleRequestV1, expectedState: ExecutionState | readonly ExecutionState[]): Promise<ExecutionWorkspaceContextV1> {
    validateLifecycleRequest(request);
    const context = await this.allocations.workspaceContext(request.worktreeId);
    const expected = Array.isArray(expectedState) ? expectedState : [expectedState];
    if (context.allocation.attemptId !== request.attemptId || !expected.includes(context.allocation.state)
      || grantDigest(context.binding, context.allocation) !== request.workspaceGrantDigest) throw new WorkspacePreparationError('ALLOCATION_BINDING_MISMATCH');
    return context;
  }

  private async finalizeCompleted(request: AgentWorkspaceFinalizationRequestV1, context: ExecutionWorkspaceContextV1): Promise<void> {
    const stopping = await this.advance(context.allocation, 'stopping', 'ALLOCATION_OK');
    const source = await this.sources.resolveSourceBinding(context.binding.projectId, context.binding.repositoryId);
    if (!source || !source.available || !source.active || String(source.registryRevision) !== context.binding.projectRevision
      || String(source.bindingRevision) !== context.binding.repositoryBindingRevision || source.baseCommit !== context.binding.baseCommit
      || digestValue(source.repositoryIdentityDigest) !== context.binding.repositoryIdentityDigest || source.baseTree !== context.binding.baseTree
      || source.gitObjectFormat !== context.binding.gitObjectFormat) throw new WorkspacePreparationError('GIT_SOURCE_INTEGRITY_FAILED');
    const paths = this.native.privateGitPaths(stopping);
    let candidate;
    try {
      candidate = await this.candidates.seal({ requestId: stageRequestId('seal', stopping.worktreeId), expectedRevision: stopping.revision,
        bindingDigest: stopping.bindingDigest, seal: { projectId: context.binding.projectId, runId: context.binding.runId,
          attemptId: context.binding.attemptId, worktreeId: stopping.worktreeId, privateRoot: paths.privateRoot,
          baseCommit: context.binding.baseCommit, baseTree: context.binding.baseTree, objectFormat: context.binding.gitObjectFormat,
          maximumTreeBytes: this.quota.bytes } });
    } catch (error) {
      if (error instanceof SealError && error.code === 'SEAL_NO_CHANGE') {
        await this.native.cleanup({ requestId: stageRequestId('no-change-cleanup', stopping.worktreeId), worktreeId: stopping.worktreeId,
          expectedRevision: stopping.revision, bindingDigest: stopping.bindingDigest });
        return;
      }
      throw error;
    }
    const sealed = (await this.allocations.workspaceContext(stopping.worktreeId)).allocation;
    await this.candidates.import({ intentRequestId: stageRequestId('import-intent', sealed.worktreeId), completionRequestId: stageRequestId('import-complete', sealed.worktreeId),
      failureRequestId: stageRequestId('import-failure', sealed.worktreeId), expectedRevision: sealed.revision, bindingDigest: sealed.bindingDigest,
      expectedSourceIdentityDigest: context.binding.repositoryIdentityDigest, candidateImport: { projectId: context.binding.projectId,
        repositoryId: context.binding.repositoryId, sourceRoot: fileURLToPath(source.rootUri), sourceGitDirectory: fileURLToPath(source.gitDirectoryUri),
        privateRoot: paths.privateRoot, bundlePath: paths.bundlePath, expectedSourceHead: source.baseCommit, expectedSourceTree: source.baseTree,
        objectFormat: context.binding.gitObjectFormat, candidate } });
    const imported = (await this.allocations.workspaceContext(stopping.worktreeId)).allocation;
    await this.allocations.recordRetention({ requestId: stageRequestId('retention', imported.worktreeId), worktreeId: imported.worktreeId,
      expectedRevision: imported.revision, bindingDigest: imported.bindingDigest, candidateId: candidate.candidateId,
      retentionClass: 'completed', authorityDigest: digestValue(createHash('sha256').update(`kogg-completed-retention-authority-v1\0${request.workspaceGrantDigest}\0${candidate.candidateId}`).digest('hex')) });
  }

  private async cleanupCompletionFailure(initial: ExecutionAllocationSummaryV1, safeCode: ExecutionLifecycleCode): Promise<void> {
    try {
      let current = (await this.allocations.workspaceContext(initial.worktreeId)).allocation;
      if (current.state === 'stopping') current = await this.advance(current, 'failed', safeCode);
      if (['failed', 'timed-out', 'cancelled'].includes(current.state)) await this.native.cleanup({ requestId: stageRequestId('completion-failure-cleanup', current.worktreeId),
        worktreeId: current.worktreeId, expectedRevision: current.revision, bindingDigest: current.bindingDigest });
    } catch (cleanupError) { // observability-exempt: The finalization failure event records the original closed code; durable registry state owns recovery.
      executionLog('workspace.cleanup.failed', { eventVersion: 1, requestId: stageRequestId('completion-failure-cleanup', initial.worktreeId), worktreeId: initial.worktreeId, safeCode: lifecycleCode(cleanupError), errorType: cleanupError instanceof Error ? cleanupError.name : 'UnknownError' });
    }
  }

  private async cleanupAfterFailure(requestId: string, current: ExecutionAllocationSummaryV1, safeCode: ExecutionLifecycleCode): Promise<void> {
    executionLog('workspace.cleanup.started', { eventVersion: 1, requestId, worktreeId: current.worktreeId });
    try {
      if (current.state === 'seeding') current = await this.advance(current, 'failed', safeCode);
      await this.native.cleanup({ requestId: stageRequestId('cleanup', current.worktreeId), worktreeId: current.worktreeId, expectedRevision: current.revision, bindingDigest: current.bindingDigest });
      executionLog('workspace.cleanup.completed', { eventVersion: 1, requestId, worktreeId: current.worktreeId });
    } catch (error) { // observability-exempt: The closed workspace.cleanup.failed event below records cleanup ownership loss before the denial returns.
      executionLog('workspace.cleanup.failed', { eventVersion: 1, requestId, worktreeId: current.worktreeId,
        safeCode: lifecycleCode(error), errorType: error instanceof Error ? error.name : 'UnknownError' });
    }
  }
}

class WorkspacePreparationError extends Error { constructor(readonly code: ExecutionLifecycleCode) { super(code); this.name = 'WorkspacePreparationError'; } }
function lifecycleCode(error: unknown): ExecutionLifecycleCode {
  if (error instanceof WorkspacePreparationError || error instanceof AllocationRegistryError || error instanceof NativeAllocationError
    || error instanceof NativeCleanupError || error instanceof SeedError || error instanceof GitRunError) return error.code;
  return 'ALLOCATION_INTEGRITY_FAILED';
}
function grantDigest(binding: ExecutionBindingV1, allocation: ExecutionAllocationSummaryV1): string {
  return createHash('sha256').update(`kogg-workspace-grant-v1\0${JSON.stringify({ allocationBindingDigest: allocation.bindingDigest,
    attemptId: binding.attemptId, projectId: binding.projectId, repositoryId: binding.repositoryId, runId: binding.runId,
    taskRevisionDigest: binding.taskRevisionDigest, worktreeId: allocation.worktreeId })}`).digest('hex');
}
function validateLifecycleRequest(request: AgentWorkspaceLifecycleRequestV1): void {
  if (!request) throw new WorkspacePreparationError('ALLOCATION_PROTOCOL_INVALID');
  const keys = Object.keys(request).filter(key => key !== 'outcome').sort().join(',');
  if (keys !== 'attemptId,requestId,schemaVersion,workspaceGrantDigest,worktreeId' || request.schemaVersion !== '1'
    || ![request.requestId, request.attemptId, request.worktreeId].every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))
    || !/^[0-9a-f]{64}$/u.test(request.workspaceGrantDigest)) throw new WorkspacePreparationError('ALLOCATION_PROTOCOL_INVALID');
}
function validateFinalizationRequest(request: AgentWorkspaceFinalizationRequestV1): void {
  if (!request || Object.keys(request).sort().join(',') !== 'attemptId,outcome,requestId,schemaVersion,workspaceGrantDigest,worktreeId'
    || !['completed', 'failed', 'cancelled', 'timed-out'].includes(request.outcome)) throw new WorkspacePreparationError('ALLOCATION_PROTOCOL_INVALID');
}
function digestValue(value: string): string { return value.startsWith('sha256:') ? value : `sha256:${value}`; }
function stageRequestId(stage: string, ownerId: string): string {
  const hex = createHash('sha256').update(`kogg-workspace-stage-request-v1\0${stage}\0${ownerId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = '8';
  const value = hex.join(''); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
