import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { inject, injectable } from '@theia/core/shared/inversify';
import { OperationsReadModel } from './operations-read-model';
import { OperationsSupportExporter } from './operations-support-export';
import { OWNER_KINDS } from '../common/operations-read-model-protocol';
import { OperationsActionRouter } from './operations-action-router';

// diagnostic-coverage: operations.projection, operations.owners, operations.correlations, operations.timeline, operations.processes, operations.stream, operations.metrics, operations.retention, operations.support, operations.actions, operations.source-maps

@injectable()
export class OperationsReadModelDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'operations-read-model';
  constructor(@inject(OperationsReadModel) private readonly projection: OperationsReadModel,
    @inject(OperationsSupportExporter) private readonly support: OperationsSupportExporter,
    @inject(OperationsActionRouter) private readonly actions: OperationsActionRouter) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const result = this.projection.diagnostics();
      const stream = this.projection.streamDiagnostics();
      const support = await this.support.diagnostics();
      const actions = this.actions.diagnostics();
      const projectionReady = result.integrity && result.foreignKeys && this.projection.storagePermissionsValid() && result.lifecycle !== 'failed';
      const ownersReady = result.ownerCount === OWNER_KINDS.length && result.lifecycle === 'current';
      const streamReady = stream.clientCount > 0 && stream.cursorRoundTrip && stream.resyncRecovery && stream.bounded;
      const actionsReady = actions.cancelRouteAvailable && actions.diagnoseRouteAvailable && actions.unsynchronizedOutcomeCount === 0;
      const sourceMapsPresent = operationsSourceMapsPresent();
      return [
        { id: 'operations.projection', status: projectionReady ? 'pass' : 'fail', summary: projectionReady ? 'The disposable operations projection is structurally valid.' : 'The operations projection store or lifecycle failed verification.' },
        { id: 'operations.owners', status: ownersReady ? 'pass' : 'fail', summary: ownersReady ? 'Owner cursors are verified and current.' : 'No current verified owner projection is available.', details: { ownerCount: result.ownerCount, faultCount: result.faultCount } },
        { id: 'operations.correlations', status: result.causalGapCount ? 'fail' : 'pass', summary: result.causalGapCount ? 'A causal owner-event gap requires resynchronization.' : 'Accepted causal references are complete.', details: { causalGapCount: result.causalGapCount } },
        { id: 'operations.timeline', status: result.causalGapCount || result.activityAggregateViolationCount ? 'fail' : 'pass', summary: result.causalGapCount ? 'Timeline ordering is degraded by a causal gap.' : result.activityAggregateViolationCount ? 'A bounded activity aggregate failed validation.' : 'Timeline entries and exact activity aggregates retain verified owner order.', details: { activityAggregateViolationCount: result.activityAggregateViolationCount } },
        { id: 'operations.stream', status: streamReady ? 'pass' : 'fail', summary: streamReady ? 'Authenticated bounded streaming, cursor resume, and safe resync are active.' : 'Authenticated operations streaming is not active.', details: { clientCount: stream.clientCount } },
        { id: 'operations.metrics', status: result.metricViolationCount ? 'fail' : 'pass', summary: result.metricViolationCount ? 'A closed metric contract failed validation.' : 'Closed local metric cardinality is valid.' },
        { id: 'operations.retention', status: result.retentionViolationCount || result.activityAggregateViolationCount ? 'fail' : 'pass', summary: result.retentionViolationCount ? 'A retained hold lost its detailed projection.' : result.activityAggregateViolationCount ? 'An activity aggregate violated its 90-day retention contract.' : 'Detailed, activity-aggregate, and metric-epoch retention honors every active owner hold.', details: { activeRetentionHoldCount: result.activeRetentionHoldCount, retainedMetricEpochCount: result.retainedMetricEpochCount, retainedActivityAggregateCount: result.retainedActivityAggregateCount } },
        { id: 'operations.support', status: support.permissions && support.expired ? 'pass' : 'fail', summary: support.permissions && support.expired ? 'Private bounded operations support export storage is valid.' : 'Private operations support export storage failed its safety checks.' },
        { id: 'operations.actions', status: actionsReady ? 'pass' : 'fail', summary: actionsReady ? 'Cancel and diagnose actions revalidate current projection authority and synchronize owner results.' : 'An authoritative action route is unavailable or has an unsynchronized outcome.', details: { cancelRouteAvailable: actions.cancelRouteAvailable, diagnoseRouteAvailable: actions.diagnoseRouteAvailable, unsynchronizedOutcomeCount: actions.unsynchronizedOutcomeCount } },
        { id: 'operations.source-maps', status: sourceMapsPresent ? 'pass' : 'fail', summary: sourceMapsPresent ? 'Operations browser and backend debugger source maps are present.' : 'Operations browser or backend source maps are unavailable.' }
      ];
    } catch (error) {
      console.error('[kogg:operations:projection] failed', { safeCode: 'PROJECTION_DIAGNOSTICS_FAILED', errorType: error instanceof Error ? error.name : 'UnknownError' });
      return ['projection', 'owners', 'correlations', 'timeline', 'stream', 'metrics', 'retention', 'support', 'actions', 'source-maps'].map(id => ({ id: `operations.${id}`, status: 'fail' as const, summary: 'Operations read-model diagnostics could not run.' }));
    }
  }
}

function operationsSourceMapsPresent(): boolean {
  const runtime = process.env.KOGG_RUNTIME;
  const maps = runtime === 'browser' || runtime === 'electron'
    ? [`${__filename}.map`, path.join(__dirname, '..', 'frontend', 'bundle.js.map'), ...(runtime === 'electron' ? [path.join(__dirname, 'electron-main.js.map')] : [])]
    : [`${__filename}.map`, path.join(__dirname, '..', 'browser', 'operations-widget.js.map')];
  return maps.every(file => existsSync(file));
}
