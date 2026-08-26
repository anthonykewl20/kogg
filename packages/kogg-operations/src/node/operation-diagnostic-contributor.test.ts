import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationDiagnosticContributor } from './operation-diagnostic-contributor';
import type { OperationRegistry } from './operation-registry';

test('fails closed with every operations diagnostic when registry inspection fails', async () => {
  const registry = { diagnostics(): never { throw new Error('calibration failure'); } } as unknown as OperationRegistry;
  const checks = await new OperationDiagnosticContributor(registry).diagnose();
  assert.deepEqual(checks.map(check => [check.id, check.status]), [
    ['operations.registry', 'fail'], ['operations.recovery', 'fail'], ['operations.processes', 'fail'],
    ['operations.cleanup', 'fail'], ['operations.admission', 'fail']
  ]);
});
