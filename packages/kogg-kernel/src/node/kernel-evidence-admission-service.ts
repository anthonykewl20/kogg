import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type EvidenceAdmissionProjectionV1, type EvidenceManifestV1, type KernelBridge, KernelBridgeToken,
  type KernelResultV2, KOGG_RANEX_PROTOCOL
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { TaskKernelBindingAuthority, type TaskAdmissionSnapshot, type TaskKernelBindingAuthority as TaskAuthority } from '@kogg/tasks/lib/common/tasks-protocol';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { GitFailure, KernelRepositoryStateAuthority, RepositoryRefusal } from './kernel-repository-state-authority';
import { RanexOperationsOwner, RanexOwnerIntegrityError } from './ranex-operations-owner';

// diagnostic-coverage: kernel.evidence, kernel.cleanup

@injectable()
export class KernelEvidenceAdmissionService {
  constructor(
    @inject(TaskKernelBindingAuthority) private readonly tasks: TaskAuthority,
    @inject(KernelBridgeToken) private readonly kernel: KernelBridge,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @inject(KernelRepositoryStateAuthority) private readonly repositories: KernelRepositoryStateAuthority,
    @inject(ILogger) @named('kogg:kernel:evidence') private readonly logger: ILogger,
    @inject(RanexOperationsOwner) private readonly ranexOwner: RanexOperationsOwner
  ) {}

  async admit(admission: TaskAdmissionSnapshot, evidence: EvidenceManifestV1): Promise<KernelResultV2<EvidenceAdmissionProjectionV1>> {
    const operation = await this.operations.startOperation({
      kind: 'evidence', cancellable: true, absoluteTimeoutMs: 30_000,
      correlations: { taskId: admission.taskId, runId: admission.runId }
    });
    operation.start(); this.logger.info('evidence.admit.started', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId });
    try {
      const authority = await this.tasks.resolveAdmission(admission);
      const facts = await this.repositories.stable(fileURLToPath(authority.rootUri), operation.registerProcess.bind(operation));
      const expectedRepositoryIdentity = createHash('sha256').update(`kogg-git-dir-v1\0${pathToFileURL(facts.gitDirectory).href}`, 'utf8').digest('hex');
      if (expectedRepositoryIdentity !== authority.repositoryIdentityDigest || !facts.state.isClean || Date.parse(authority.expiresAt) <= Date.now()) {
        throw new EvidenceRefusal('KERNEL_SUBJECT_STALE');
      }
      operation.active();
      const result = await this.kernel.admitEvidence(evidence, facts.state);
      this.ranexOwner.refresh();
      await operation.cleanup();
      if (result.status === 'succeeded') {
        operation.complete(); this.logger.info('evidence.admit.verified', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode: result.safeCode });
      } else {
        operation.fail('OPERATIONS_REFUSED', 'EvidenceRefusal'); this.logger.warn('evidence.admit.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode: result.safeCode });
      }
      return result;
    } catch (error) {
      await operation.cleanup().catch(() => undefined);
      operation.fail(error instanceof RanexOwnerIntegrityError ? 'OPERATIONS_INTEGRITY_FAILED' : error instanceof GitFailure ? 'PROCESS_EXIT_NONZERO' : 'OPERATIONS_REFUSED', errorName(error));
      if (error instanceof RanexOwnerIntegrityError) {
        this.logger.warn('evidence.admit.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode: 'KERNEL_OUTCOME_UNKNOWN', errorType: errorName(error) });
        return unknownOutcome();
      }
      const safeCode = error instanceof EvidenceRefusal || error instanceof RepositoryRefusal ? error.safeCode : 'KERNEL_AUTHORITY_INVALID';
      this.logger.warn('evidence.admit.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode, errorType: errorName(error) });
      return refused(safeCode);
    }
  }
}

class EvidenceRefusal extends Error { constructor(readonly safeCode: 'KERNEL_SUBJECT_STALE') { super(safeCode); } }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function refused(safeCode: 'KERNEL_SUBJECT_STALE' | 'KERNEL_REPOSITORY_MISMATCH' | 'KERNEL_AUTHORITY_INVALID'): KernelResultV2<EvidenceAdmissionProjectionV1> {
  return { protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'refused', safeCode, resultDigest: null, journal: null, projection: null };
}
function unknownOutcome(): KernelResultV2<EvidenceAdmissionProjectionV1> { return { protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'unknown', safeCode: 'KERNEL_OUTCOME_UNKNOWN', resultDigest: null, journal: null, projection: null }; }
