import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalKernelJson,
  type KernelBridge,
  KernelBridgeToken,
  type KernelJson,
  type KernelResultV2,
  KOGG_RANEX_PROTOCOL,
  type TaskBindingProjectionV1,
  type TaskExecutionBindingV1
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { TaskKernelBindingAuthority, type TaskAdmissionSnapshot, type TaskKernelBindingAuthority as TaskAuthority } from '@kogg/tasks/lib/common/tasks-protocol';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { GitFailure, KernelRepositoryStateAuthority, RepositoryRefusal } from './kernel-repository-state-authority';

// diagnostic-coverage: kernel.bindings, kernel.cleanup

@injectable()
export class KernelTaskBindingService {
  constructor(
    @inject(TaskKernelBindingAuthority) private readonly tasks: TaskAuthority,
    @inject(KernelBridgeToken) private readonly kernel: KernelBridge,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @inject(KernelRepositoryStateAuthority) private readonly repositories: KernelRepositoryStateAuthority,
    @inject(ILogger) @named('kogg:kernel:binding') private readonly logger: ILogger
  ) {}

  async bind(admission: TaskAdmissionSnapshot): Promise<KernelResultV2<TaskBindingProjectionV1>> {
    const operation = await this.operations.startOperation({
      kind: 'task', cancellable: true, absoluteTimeoutMs: 30_000,
      correlations: { taskId: admission.taskId, runId: admission.runId }
    });
    operation.start();
    this.logger.info('binding.started', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId });
    try {
      const authority = await this.tasks.resolveAdmission(admission);
      const root = fileURLToPath(authority.rootUri);
      const facts = await this.repositories.stable(root, operation.registerProcess.bind(operation));
      const expectedRepositoryIdentity = createHash('sha256')
        .update(`kogg-git-dir-v1\0${pathToFileURL(facts.gitDirectory).href}`, 'utf8').digest('hex');
      if (expectedRepositoryIdentity !== authority.repositoryIdentityDigest || !facts.state.isClean) {
        throw new BindingRefusal('KERNEL_REPOSITORY_MISMATCH');
      }
      const authorityDigest = domainDigest('authority', {
        approvalCreatedAt: authority.approvalCreatedAt, approvalDigest: authority.approvalDigest,
        approvalId: authority.approvalId, bindingRevision: authority.bindingRevision,
        projectId: authority.projectId, repositoryId: authority.repositoryId, runId: authority.runId,
        specificationDigest: authority.specificationDigest, taskId: authority.taskId, taskRevision: authority.taskRevision,
        authorizedAt: authority.authorizedAt, expiresAt: authority.expiresAt
      });
      if (Date.parse(authority.expiresAt) <= Date.now()) throw new BindingRefusal('KERNEL_AUTHORITY_INVALID');
      const binding: TaskExecutionBindingV1 = {
        taskId: authority.taskId, taskRevision: authority.taskRevision,
        specificationDigest: digest(authority.specificationDigest), approvalId: authority.approvalId,
        approvalDigest: digest(authority.approvalDigest), authorityDigest,
        projectId: authority.projectId, repositoryId: authority.repositoryId,
        repositoryIdentityDigest: digest(authority.repositoryIdentityDigest), protectedSource: facts.state,
        worktreeId: uuidFromDigest(facts.state.worktreeIdentity), worktreeIdentityDigest: facts.state.worktreeIdentity,
        baseState: facts.state, executionProfileDigest: sha256(Buffer.from(canonicalKernelJson(authority.executionProfileId), 'utf8')),
        expiresAt: authority.expiresAt
      };
      operation.active();
      const result = await this.kernel.bindTask(binding);
      await operation.cleanup();
      if (result.status === 'succeeded') {
        operation.complete();
        this.logger.info('binding.completed', { operationId: operation.id, taskId: authority.taskId, runId: authority.runId, safeCode: result.safeCode });
      } else {
        operation.fail('OPERATIONS_REFUSED', 'BindingRefusal');
        this.logger.warn('binding.failed', { operationId: operation.id, taskId: authority.taskId, runId: authority.runId, safeCode: result.safeCode });
      }
      return result;
    } catch (error) {
      await operation.cleanup().catch(() => undefined);
      operation.fail(error instanceof GitFailure ? 'PROCESS_EXIT_NONZERO' : 'OPERATIONS_REFUSED', errorName(error));
      const safeCode = error instanceof BindingRefusal || error instanceof RepositoryRefusal ? error.safeCode : 'KERNEL_AUTHORITY_INVALID';
      this.logger.warn('binding.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode, errorType: errorName(error) });
      return refused(safeCode);
    }
  }

}

class BindingRefusal extends Error { constructor(readonly safeCode: 'KERNEL_REPOSITORY_MISMATCH' | 'KERNEL_SUBJECT_STALE' | 'KERNEL_AUTHORITY_INVALID') { super(safeCode); } }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function sha256(value: Uint8Array): `sha256:${string}` { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function domainDigest(domain: string, value: KernelJson): `sha256:${string}` { return sha256(Buffer.concat([Buffer.from(`kogg:${domain}:v1\n`, 'utf8'), Buffer.from(canonicalKernelJson(value), 'utf8')])); }
function digest(value: string): `sha256:${string}` { return value.startsWith('sha256:') ? value as `sha256:${string}` : `sha256:${value}`; }
function uuidFromDigest(value: `sha256:${string}`): string {
  const hex = value.slice(7, 39).split(''); hex[12] = '5'; hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}
function refused(safeCode: 'KERNEL_REPOSITORY_MISMATCH' | 'KERNEL_SUBJECT_STALE' | 'KERNEL_AUTHORITY_INVALID'): KernelResultV2<TaskBindingProjectionV1> {
  return { protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'refused', safeCode, resultDigest: null, journal: null, projection: null };
}
