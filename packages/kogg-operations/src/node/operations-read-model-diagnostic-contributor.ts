import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { OperationsReadModel } from './operations-read-model';
import { OperationsSupportExporter } from './operations-support-export';
import { OWNER_KINDS } from '../common/operations-read-model-protocol';

// diagnostic-coverage: operations.projection, operations.owners, operations.correlations, operations.timeline, operations.processes, operations.stream, operations.metrics, operations.support, operations.actions, operations.source-maps

@injectable()
export class OperationsReadModelDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'operations-read-model';
  constructor(@inject(OperationsReadModel) private readonly projection: OperationsReadModel,
    @inject(OperationsSupportExporter) private readonly support: OperationsSupportExporter) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const result = this.projection.diagnostics();
      const stream = this.projection.streamDiagnostics();
      const support = await this.support.diagnostics();
      const projectionReady = result.integrity && result.foreignKeys && this.projection.storagePermissionsValid() && result.lifecycle !== 'failed';
      const ownersReady = result.ownerCount === OWNER_KINDS.length && result.lifecycle === 'current';
      const streamReady = stream.clientCount > 0 && stream.cursorRoundTrip && stream.resyncRecovery && stream.bounded;
      return [
        { id: 'operations.projection', status: projectionReady ? 'pass' : 'fail', summary: projectionReady ? 'The disposable operations projection is structurally valid.' : 'The operations projection store or lifecycle failed verification.' },
        { id: 'operations.owners', status: ownersReady ? 'pass' : 'fail', summary: ownersReady ? 'Owner cursors are verified and current.' : 'No current verified owner projection is available.', details: { ownerCount: result.ownerCount, faultCount: result.faultCount } },
        { id: 'operations.correlations', status: result.causalGapCount ? 'fail' : 'pass', summary: result.causalGapCount ? 'A causal owner-event gap requires resynchronization.' : 'Accepted causal references are complete.', details: { causalGapCount: result.causalGapCount } },
        { id: 'operations.timeline', status: result.causalGapCount ? 'fail' : 'pass', summary: result.causalGapCount ? 'Timeline ordering is degraded by a causal gap.' : 'Timeline entries retain verified owner order.' },
        { id: 'operations.stream', status: streamReady ? 'pass' : 'fail', summary: streamReady ? 'Authenticated bounded streaming, cursor resume, and safe resync are active.' : 'Authenticated operations streaming is not active.', details: { clientCount: stream.clientCount } },
        { id: 'operations.metrics', status: result.metricViolationCount ? 'fail' : 'pass', summary: result.metricViolationCount ? 'A closed metric contract failed validation.' : 'Closed local metric cardinality is valid.' },
        { id: 'operations.support', status: support.permissions && support.expired ? 'pass' : 'fail', summary: support.permissions && support.expired ? 'Private bounded operations support export storage is valid.' : 'Private operations support export storage failed its safety checks.' },
        { id: 'operations.actions', status: 'fail', summary: 'No authoritative owner action routes are active.' },
        { id: 'operations.source-maps', status: 'fail', summary: 'Visible browser and Electron debugger breakpoint qualification is pending.' }
      ];
    } catch (error) {
      console.error('[kogg:operations:projection] failed', { safeCode: 'PROJECTION_DIAGNOSTICS_FAILED', errorType: error instanceof Error ? error.name : 'UnknownError' });
      return ['projection', 'owners', 'correlations', 'timeline', 'stream', 'metrics', 'support', 'actions', 'source-maps'].map(id => ({ id: `operations.${id}`, status: 'fail' as const, summary: 'Operations read-model diagnostics could not run.' }));
    }
  }
}
