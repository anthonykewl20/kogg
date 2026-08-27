import { createHash, randomUUID } from 'node:crypto';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { ModeTransitionOwnerContribution, ModeTransitionOwnerRequestV1, ModeTransitionOwnerResultV1 } from '../common/interaction-modes-protocol';

// Cancels the exact task's active work and proves global process cleanup before any mode commit.
// diagnostic-coverage: interaction-modes.transitions, interaction-modes.operations, interaction-modes.restoration
@injectable()
export class OperationsTransitionOwner implements ModeTransitionOwnerContribution {
  readonly owner = 'operations' as const;
  constructor(@inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi) {}

  async qualifyTransition(request: ModeTransitionOwnerRequestV1): Promise<ModeTransitionOwnerResultV1> {
    console.info('[kogg:interaction-modes:operations-owner] cleanup.started', { transitionId: request.transitionId, taskId: request.taskId });
    const before = await this.operations.snapshot(); const active = before.active.filter(operation => operation.correlations.taskId === request.taskId);
    if (active.some(operation => !operation.canCancel)) return this.refused(request, 'MODE_CLEANUP_FAILED');
    try {
      for (const operation of active) await this.operations.cancel({ requestId: randomUUID(), operationId: operation.id });
      const after = await this.operations.snapshot(); const diagnostics = this.operations.diagnostics();
      if (after.active.some(operation => operation.correlations.taskId === request.taskId) || diagnostics.cleanupFailureCount) return this.refused(request, 'MODE_CLEANUP_FAILED');
      if (diagnostics.residualCount) return this.refused(request, 'MODE_PROCESS_RESIDUAL');
      const proofDigest = `sha256:${createHash('sha256').update(`kogg:interaction-modes:operations-cleanup:v1\0${JSON.stringify({ cancelledCount: active.length, taskId: request.taskId, transitionId: request.transitionId })}`).digest('hex')}`;
      console.info('[kogg:interaction-modes:operations-owner] cleanup.completed', { transitionId: request.transitionId, taskId: request.taskId, cancelledCount: active.length, residualCount: 0 });
      return { owner: this.owner, qualified: true, safeCode: 'MODE_OK', proofDigest };
    } catch (error) { // observability-exempt: the refusal log emits only a normalized error type and safe classification.
      console.error('[kogg:interaction-modes:operations-owner] cleanup.failed', { transitionId: request.transitionId, taskId: request.taskId, safeCode: 'MODE_CLEANUP_FAILED', errorType: error instanceof Error ? error.name : 'UnknownError' });
      return { owner: this.owner, qualified: false, safeCode: 'MODE_CLEANUP_FAILED' };
    }
  }

  private refused(request: ModeTransitionOwnerRequestV1, safeCode: 'MODE_CLEANUP_FAILED' | 'MODE_PROCESS_RESIDUAL'): ModeTransitionOwnerResultV1 {
    console.error('[kogg:interaction-modes:operations-owner] cleanup.failed', { transitionId: request.transitionId, taskId: request.taskId, safeCode, errorType: 'CleanupQualificationError' });
    return { owner: this.owner, qualified: false, safeCode };
  }
}
