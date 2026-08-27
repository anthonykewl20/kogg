import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type KernelBridge, KernelBridgeToken, type KernelResultV2, KOGG_RANEX_PROTOCOL,
  type VerdictReadExpectationV1, type VerdictReadProjectionV1
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { TaskKernelBindingAuthority, type TaskAdmissionSnapshot, type TaskKernelBindingAuthority as TaskAuthority } from '@kogg/tasks/lib/common/tasks-protocol';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { GitFailure, KernelRepositoryStateAuthority, RepositoryRefusal } from './kernel-repository-state-authority';

// diagnostic-coverage: kernel.verdicts, kernel.cleanup

@injectable()
export class KernelVerdictReadService {
  constructor(
    @inject(TaskKernelBindingAuthority) private readonly tasks: TaskAuthority,
    @inject(KernelBridgeToken) private readonly kernel: KernelBridge,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @inject(KernelRepositoryStateAuthority) private readonly repositories: KernelRepositoryStateAuthority,
    @inject(ILogger) @named('kogg:kernel:verdict') private readonly logger: ILogger
  ) {}

  async read(admission: TaskAdmissionSnapshot, expectation: VerdictReadExpectationV1): Promise<KernelResultV2<VerdictReadProjectionV1>> {
    const operation = await this.operations.startOperation({ kind: 'verdict', cancellable: true, absoluteTimeoutMs: 30_000, correlations: { taskId: admission.taskId, runId: admission.runId } });
    operation.start(); this.logger.info('verdict.read.started', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId });
    try {
      const authority = await this.tasks.resolveAdmission(admission);
      const facts = await this.repositories.stable(fileURLToPath(authority.rootUri), operation.registerProcess.bind(operation));
      const identity = createHash('sha256').update(`kogg-git-dir-v1\0${pathToFileURL(facts.gitDirectory).href}`, 'utf8').digest('hex');
      if (identity !== authority.repositoryIdentityDigest) throw new VerdictReadRefusal();
      operation.active(); const result = await this.kernel.readVerdict(expectation, facts.state); await operation.cleanup();
      if (result.status === 'succeeded') {
        operation.complete(); this.logger.info(result.projection?.currentness === 'stale' ? 'verdict.read.stale' : 'verdict.read.completed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode: result.safeCode, currentness: result.projection?.currentness });
      } else {
        operation.fail('OPERATIONS_REFUSED', 'VerdictReadRefusal'); this.logger.warn('verdict.read.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode: result.safeCode });
      }
      return result;
    } catch (error) {
      await operation.cleanup().catch(() => undefined); operation.fail(error instanceof GitFailure ? 'PROCESS_EXIT_NONZERO' : 'OPERATIONS_REFUSED', errorName(error));
      const safeCode = error instanceof RepositoryRefusal || error instanceof VerdictReadRefusal ? 'KERNEL_VERDICT_STALE' : 'KERNEL_AUTHORITY_INVALID';
      this.logger.warn('verdict.read.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode, errorType: errorName(error) });
      return refused(safeCode);
    }
  }
}

class VerdictReadRefusal extends Error { constructor() { super('KERNEL_VERDICT_STALE'); } }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function refused(safeCode: 'KERNEL_VERDICT_STALE' | 'KERNEL_AUTHORITY_INVALID'): KernelResultV2<VerdictReadProjectionV1> {
  return { protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'refused', safeCode, resultDigest: null, journal: null, projection: null };
}
