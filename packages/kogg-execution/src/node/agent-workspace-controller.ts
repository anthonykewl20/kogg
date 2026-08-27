import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import type { AgentWorkspaceAuthority, AgentWorkspaceAuthorizationRequestV1, AgentWorkspaceAuthorizationResultV1 } from '@kogg/agents/lib/common/agents-protocol';
import { ProjectSourceBindingAuthority, type ProjectSourceBindingAuthority as SourceAuthority } from '@kogg/projects/lib/common/projects-protocol';
import { ExecutionTargetBindingAuthority, type ExecutionAllocationSummaryV1, type ExecutionBindingV1, type ExecutionLifecycleCode, type ExecutionTargetBindingAuthority as TargetAuthority } from '../common/execution-protocol';
import { AllocationRegistryError, ExecutionAllocationRegistry } from './execution-allocation-registry';
import { executionLog } from './execution-logger';
import { NativeAllocationController, NativeAllocationError, NativeCleanupError } from './native-allocation-controller';
import { ProductionPrivateGitSeeder } from './production-private-git-seeder';
import { GitRunError } from './controller-git-runner';
import { SeedError, type PrivateGitSeedAuthority } from './private-git-seeder';

// This is the only production bridge from an admitted mutating agent to a qualified, private, verified workspace; events route through [kogg:execution:workspace].
// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.git-independence, execution.source-integrity, execution.process-cleanup, execution.capacity, execution.recovery
@injectable()
export class AgentWorkspaceController implements AgentWorkspaceAuthority {
  constructor(
    @inject(ProjectSourceBindingAuthority) private readonly sources: SourceAuthority,
    @inject(ExecutionTargetBindingAuthority) private readonly targets: TargetAuthority,
    @inject(NativeAllocationController) private readonly native: Pick<NativeAllocationController, 'allocate' | 'cleanup' | 'privateGitPaths'>,
    @inject(ExecutionAllocationRegistry) private readonly allocations: Pick<ExecutionAllocationRegistry, 'advance'>,
    @inject(ProductionPrivateGitSeeder) private readonly seeder: PrivateGitSeedAuthority,
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
        repositoryId: request.repositoryId, repositoryBindingRevision: String(source.bindingRevision),
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
      executionLog('workspace.ready', { ...fields, worktreeId: current.worktreeId });
      return { allowed: true, code: 'AGENT_OK', worktreeId: current.worktreeId, workspaceGrantDigest: grantDigest(request, current) };
    } catch (error) { // observability-exempt: The closed workspace.prepare.refused event below records the classified failure and intentionally returns a denial.
      if (current) await this.cleanupAfterFailure(request.requestId, current, lifecycleCode(error));
      executionLog('workspace.prepare.refused', { ...fields, safeCode: lifecycleCode(error), errorType: error instanceof Error ? error.name : 'UnknownError' });
      return { allowed: false, code: 'WORKSPACE_UNTRUSTED' };
    }
  }

  private advance(current: ExecutionAllocationSummaryV1, nextState: 'seeding' | 'verified' | 'ready' | 'failed', safeCode: ExecutionLifecycleCode): Promise<ExecutionAllocationSummaryV1> {
    return this.allocations.advance({ requestId: stageRequestId(`state-${nextState}`, current.worktreeId), worktreeId: current.worktreeId, expectedRevision: current.revision,
      bindingDigest: current.bindingDigest, nextState, safeCode });
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
function grantDigest(request: AgentWorkspaceAuthorizationRequestV1, allocation: ExecutionAllocationSummaryV1): string {
  return createHash('sha256').update(`kogg-workspace-grant-v1\0${JSON.stringify({ allocationBindingDigest: allocation.bindingDigest,
    attemptId: request.attemptId, projectId: request.projectId, repositoryId: request.repositoryId, runId: request.runId,
    taskRevisionDigest: request.taskRevisionDigest, worktreeId: allocation.worktreeId })}`).digest('hex');
}
function stageRequestId(stage: string, ownerId: string): string {
  const hex = createHash('sha256').update(`kogg-workspace-stage-request-v1\0${stage}\0${ownerId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = '8';
  const value = hex.join(''); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
