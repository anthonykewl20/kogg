import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationsReadModelDiagnosticContributor } from './operations-read-model-diagnostic-contributor';
import type { OperationsReadModel } from './operations-read-model';
import type { OperationsSupportExporter } from './operations-support-export';
import type { OperationsActionRouter } from './operations-action-router';

test('fails closed with every read-model diagnostic when projection inspection fails', async () => {
  const projection = { diagnostics(): never { throw new Error('calibration failure'); } } as unknown as OperationsReadModel;
  const support = { diagnostics: async () => ({ permissions: true, expired: true }) } as unknown as OperationsSupportExporter;
  const checks = await new OperationsReadModelDiagnosticContributor(projection, support, actions()).diagnose();
  assert.deepEqual(checks.map(check => [check.id, check.status]), [
    ['operations.projection', 'fail'], ['operations.owners', 'fail'], ['operations.correlations', 'fail'],
    ['operations.timeline', 'fail'], ['operations.stream', 'fail'],
    ['operations.metrics', 'fail'], ['operations.retention', 'fail'], ['operations.support', 'fail'], ['operations.actions', 'fail'],
    ['operations.source-maps', 'fail']
  ]);
});

test('reports current owner actions and debugger source maps from runtime evidence', async () => {
  const projection = {
    diagnostics: () => ({ integrity: true, foreignKeys: true, lifecycle: 'current', ownerCount: 11, acceptedEventCount: 0, faultCount: 0, causalGapCount: 0, processAbnormalCount: 0, metricViolationCount: 0, retainedMetricEpochCount: 0, activeRetentionHoldCount: 0, retentionViolationCount: 0 }),
    streamDiagnostics: () => ({ clientCount: 1, cursorRoundTrip: true, resyncRecovery: true, bounded: true }),
    storagePermissionsValid: () => true
  } as unknown as OperationsReadModel;
  const support = { diagnostics: async () => ({ permissions: true, expired: true }) } as unknown as OperationsSupportExporter;
  const checks = await new OperationsReadModelDiagnosticContributor(projection, support, actions()).diagnose();
  assert.equal(checks.find(check => check.id === 'operations.actions')?.status, 'pass');
  assert.equal(checks.find(check => check.id === 'operations.source-maps')?.status, 'pass');
});

function actions(): OperationsActionRouter {
  return { diagnostics: () => ({ cancelRouteAvailable: true, unsynchronizedOutcomeCount: 0 }) } as OperationsActionRouter;
}
