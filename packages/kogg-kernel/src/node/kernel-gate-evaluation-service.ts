import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type GateEvaluationExpectationV1, type GateEvaluationProjectionV1, type KernelBridge, KernelBridgeToken,
  type KernelResultV2, KOGG_RANEX_PROTOCOL
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { TaskKernelBindingAuthority, type TaskAdmissionSnapshot, type TaskKernelBindingAuthority as TaskAuthority } from '@kogg/tasks/lib/common/tasks-protocol';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { GitFailure, KernelRepositoryStateAuthority, RepositoryRefusal } from './kernel-repository-state-authority';
import { RanexOperationsOwner, RanexOwnerIntegrityError } from './ranex-operations-owner';

// diagnostic-coverage: kernel.verdicts, kernel.cleanup

@injectable()
export class KernelGateEvaluationService {
  constructor(
    @inject(TaskKernelBindingAuthority) private readonly tasks: TaskAuthority,
    @inject(KernelBridgeToken) private readonly kernel: KernelBridge,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @inject(KernelRepositoryStateAuthority) private readonly repositories: KernelRepositoryStateAuthority,
    @inject(ILogger) @named('kogg:kernel:verdict') private readonly logger: ILogger,
    @inject(RanexOperationsOwner) private readonly ranexOwner: RanexOperationsOwner
  ) {}

  async evaluate(admission: TaskAdmissionSnapshot, expectation: GateEvaluationExpectationV1): Promise<KernelResultV2<GateEvaluationProjectionV1>> {
    const operation = await this.operations.startOperation({ kind: 'verdict', cancellable: true, absoluteTimeoutMs: 30_000, correlations: { taskId: admission.taskId, runId: admission.runId } });
    operation.start(); this.logger.info('gate.evaluate.started', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId });
    try {
      const authority = await this.tasks.resolveAdmission(admission);
      const facts = await this.repositories.stable(fileURLToPath(authority.rootUri), operation.registerProcess.bind(operation));
      const expectedRepositoryIdentity = createHash('sha256').update(`kogg-git-dir-v1\0${pathToFileURL(facts.gitDirectory).href}`, 'utf8').digest('hex');
      if (expectedRepositoryIdentity !== authority.repositoryIdentityDigest || !facts.state.isClean || Date.parse(authority.expiresAt) <= Date.now()) throw new GateRefusal('KERNEL_VERDICT_STALE');
      operation.active(); const result = await this.kernel.evaluateGate(expectation, facts.state); this.ranexOwner.refresh(); await operation.cleanup();
      if (result.status === 'succeeded') {
        operation.complete(); this.logger.info(result.projection?.decision === 'blocked' ? 'gate.evaluate.blocked' : 'gate.evaluate.completed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode: result.safeCode, decision: result.projection?.decision });
      } else {
        operation.fail('OPERATIONS_REFUSED', 'GateRefusal'); this.logger.warn('gate.evaluate.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode: result.safeCode });
      }
      return result;
    } catch (error) {
      await operation.cleanup().catch(() => undefined); operation.fail(error instanceof RanexOwnerIntegrityError ? 'OPERATIONS_INTEGRITY_FAILED' : error instanceof GitFailure ? 'PROCESS_EXIT_NONZERO' : 'OPERATIONS_REFUSED', errorName(error));
      if (error instanceof RanexOwnerIntegrityError) {
        this.logger.warn('gate.evaluate.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode: 'KERNEL_OUTCOME_UNKNOWN', errorType: errorName(error) });
        return unknownOutcome();
      }
      const safeCode = error instanceof GateRefusal ? error.safeCode : error instanceof RepositoryRefusal ? 'KERNEL_VERDICT_STALE' : 'KERNEL_AUTHORITY_INVALID';
      this.logger.warn('gate.evaluate.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode, errorType: errorName(error) });
      return refused(safeCode);
    }
  }
}

class GateRefusal extends Error { constructor(readonly safeCode: 'KERNEL_VERDICT_STALE') { super(safeCode); } }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function refused(safeCode: 'KERNEL_VERDICT_STALE' | 'KERNEL_AUTHORITY_INVALID'): KernelResultV2<GateEvaluationProjectionV1> {
  return { protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'refused', safeCode, resultDigest: null, journal: null, projection: null };
}
function unknownOutcome(): KernelResultV2<GateEvaluationProjectionV1> { return { protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'unknown', safeCode: 'KERNEL_OUTCOME_UNKNOWN', resultDigest: null, journal: null, projection: null }; }
