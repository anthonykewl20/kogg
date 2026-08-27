import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationsReadModelDiagnosticContributor } from './operations-read-model-diagnostic-contributor';
import type { OperationsReadModel } from './operations-read-model';
import type { OperationsSupportExporter } from './operations-support-export';

test('fails closed with every read-model diagnostic when projection inspection fails', async () => {
  const projection = { diagnostics(): never { throw new Error('calibration failure'); } } as unknown as OperationsReadModel;
  const support = { diagnostics: async () => ({ permissions: true, expired: true }) } as unknown as OperationsSupportExporter;
  const checks = await new OperationsReadModelDiagnosticContributor(projection, support).diagnose();
  assert.deepEqual(checks.map(check => [check.id, check.status]), [
    ['operations.projection', 'fail'], ['operations.owners', 'fail'], ['operations.correlations', 'fail'],
    ['operations.timeline', 'fail'], ['operations.stream', 'fail'],
    ['operations.metrics', 'fail'], ['operations.support', 'fail'], ['operations.actions', 'fail'],
    ['operations.source-maps', 'fail']
  ]);
});
