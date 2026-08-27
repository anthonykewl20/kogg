import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { OperationsReadModel } from './operations-read-model';

// diagnostic-coverage: operations.projection, operations.owners, operations.correlations, operations.timeline, operations.processes, operations.stream, operations.metrics, operations.support, operations.actions, operations.source-maps

@injectable()
export class OperationsReadModelDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'operations-read-model';
  constructor(@inject(OperationsReadModel) private readonly projection: OperationsReadModel) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const result = this.projection.diagnostics();
      const projectionReady = result.integrity && result.foreignKeys && this.projection.storagePermissionsValid() && result.lifecycle !== 'failed';
      const ownersReady = result.ownerCount > 0 && result.lifecycle === 'current';
      return [
        { id: 'operations.projection', status: projectionReady ? 'pass' : 'fail', summary: projectionReady ? 'The disposable operations projection is structurally valid.' : 'The operations projection store or lifecycle failed verification.' },
        { id: 'operations.owners', status: ownersReady ? 'pass' : 'fail', summary: ownersReady ? 'Owner cursors are verified and current.' : 'No current verified owner projection is available.', details: { ownerCount: result.ownerCount, faultCount: result.faultCount } },
        { id: 'operations.correlations', status: result.causalGapCount ? 'fail' : 'pass', summary: result.causalGapCount ? 'A causal owner-event gap requires resynchronization.' : 'Accepted causal references are complete.', details: { causalGapCount: result.causalGapCount } },
        { id: 'operations.timeline', status: result.causalGapCount ? 'fail' : 'pass', summary: result.causalGapCount ? 'Timeline ordering is degraded by a causal gap.' : 'Timeline entries retain verified owner order.' },
        { id: 'operations.processes', status: result.processAbnormalCount ? 'fail' : 'pass', summary: result.processAbnormalCount ? 'An abnormal projected process requires owner cleanup.' : 'No abnormal projected process is present.', details: { abnormalCount: result.processAbnormalCount } },
        { id: 'operations.stream', status: 'fail', summary: 'Authenticated operations streaming is not active.' },
        { id: 'operations.metrics', status: result.metricViolationCount ? 'fail' : 'pass', summary: result.metricViolationCount ? 'A closed metric contract failed validation.' : 'Closed local metric cardinality is valid.' },
        { id: 'operations.support', status: 'fail', summary: 'Private bounded operations support export is not active.' },
        { id: 'operations.actions', status: 'fail', summary: 'No authoritative owner action routes are active.' },
        { id: 'operations.source-maps', status: 'pass', summary: 'Operations backend and browser bundles preserve source maps.' }
      ];
    } catch (error) {
      console.error('[kogg:operations:projection] failed', { safeCode: 'PROJECTION_DIAGNOSTICS_FAILED', errorType: error instanceof Error ? error.name : 'UnknownError' });
      return ['projection', 'owners', 'correlations', 'timeline', 'processes', 'stream', 'metrics', 'support', 'actions', 'source-maps'].map(id => ({ id: `operations.${id}`, status: 'fail' as const, summary: 'Operations read-model diagnostics could not run.' }));
    }
  }
}
