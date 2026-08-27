import { createHash } from 'node:crypto';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { OperationsActionReceiptV1, OperationsActionRequestV1 } from '../common/operations-read-model-protocol';
import { KoggOperationRegistry, type OperationRegistryApi } from '../common/operations-protocol';
import { OperationsReadModel, ProjectionFault } from './operations-read-model';

// diagnostic-coverage: operations.actions, operations.projection, operations.processes

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SEQUENCE = /^(0|[1-9][0-9]{0,19})$/u;

@injectable()
export class OperationsActionRouter {
  constructor(@inject(OperationsReadModel) private readonly projection: OperationsReadModel,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi) {}

  diagnostics(): { readonly cancelRouteAvailable: boolean; readonly unsynchronizedOutcomeCount: number } {
    const projection = this.projection.actionDiagnostics();
    return { cancelRouteAvailable: typeof this.operations.cancel === 'function', unsynchronizedOutcomeCount: projection.unsynchronizedOutcomeCount };
  }

  async request(request: OperationsActionRequestV1): Promise<OperationsActionReceiptV1> {
    validate(request); const digest = createHash('sha256').update(JSON.stringify([request.action, request.runId, request.operationId ?? null, request.expectedProjectionSequence])).digest('hex');
    const replay = this.projection.actionReceipt(request.requestId);
    if (replay) {
      const verified = this.projection.recordAction(request, digest, replay.status, replay.safeCode);
      console.info('[kogg:operations:actions] owner-result', { requestId: request.requestId, runId: request.runId, actionKind: request.action, status: verified.status, replay: true }); return verified;
    }
    console.info('[kogg:operations:actions] requested', { requestId: request.requestId, runId: request.runId, actionKind: request.action });
    const snapshot = this.projection.snapshot();
    if (snapshot.lifecycle !== 'current' || snapshot.changeSequence !== request.expectedProjectionSequence) return this.refuse(request, digest, 'ACTION_PROJECTION_STALE');
    if (request.action !== 'cancel' || !request.operationId) return this.refuse(request, digest, 'ACTION_OWNER_UNAVAILABLE');
    if (!this.projection.operationBelongsToRun(request.runId, request.operationId)) return this.refuse(request, digest, 'ACTION_OWNER_MISMATCH');
    this.projection.recordAction(request, digest, 'unknown', 'ACTION_FORWARDING');
    try {
      console.info('[kogg:operations:actions] forwarded', { requestId: request.requestId, runId: request.runId, actionKind: request.action });
      await this.operations.cancel({ requestId: request.requestId, operationId: request.operationId });
      const receipt = this.projection.recordAction(request, digest, 'forwarded', 'ACTION_OWNER_ACCEPTED');
      console.info('[kogg:operations:actions] owner-result', { requestId: request.requestId, runId: request.runId, actionKind: request.action, status: receipt.status }); return receipt;
    } catch (error) {
      this.projection.recordAction(request, digest, 'unknown', 'ACTION_OUTCOME_UNKNOWN');
      console.error('[kogg:operations:actions] failed', { requestId: request.requestId, runId: request.runId, actionKind: request.action, safeCode: 'ACTION_OUTCOME_UNKNOWN', errorType: errorType(error) });
      throw error;
    }
  }

  private refuse(request: OperationsActionRequestV1, digest: string, safeCode: string): OperationsActionReceiptV1 {
    const receipt = this.projection.recordAction(request, digest, 'refused', safeCode);
    console.warn('[kogg:operations:actions] refused', { requestId: request.requestId, runId: request.runId, actionKind: request.action, safeCode }); return receipt;
  }
}

function validate(request: OperationsActionRequestV1): void { if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['requestId', 'action', 'runId', 'operationId', 'expectedProjectionSequence'].includes(key)) || !UUID.test(request.requestId) || !['cancel', 'pause', 'resume', 'retry', 'diagnose', 'open-owner-view'].includes(request.action) || !SAFE_ID.test(request.runId) || !SEQUENCE.test(request.expectedProjectionSequence) || (request.operationId !== undefined && !SAFE_ID.test(request.operationId))) throw new ProjectionFault('ACTION_REQUEST_INVALID'); }
function errorType(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
