import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationLease, OperationRegistryApi } from '../common/operations-protocol';
import { runOperation } from './run-operation';

test('tracked non-process boundary records success and timeout cleanup in stable order', async () => {
  const success: string[] = [];
  assert.equal(await runOperation(registry(success), 'marketplace', async activity => { activity(); return 42; }), 42);
  assert.deepEqual(success, ['start', 'active', 'activity', 'activity', 'cleanup', 'complete:OPERATIONS_OK']);

  const timeout: string[] = [];
  const failure = new Error('bounded external request expired'); failure.name = 'TimeoutError';
  await assert.rejects(runOperation(registry(timeout), 'provider-session', async () => { throw failure; }), /expired/u);
  assert.deepEqual(timeout, ['start', 'active', 'timeout:OPERATION_ABSOLUTE_TIMEOUT', 'cleanup']);
});

test('tracked negative result is durably failed while preserving the boundary result', async () => {
  const events: string[] = [];
  const result = await runOperation(registry(events), 'provider-connection', async () => ({ ok: false }), {
    failureCode: 'OWNER_UNAVAILABLE', resultFailed: value => !value.ok, resultFailureType: 'ProviderConnectionError'
  });
  assert.deepEqual(result, { ok: false });
  assert.deepEqual(events, ['start', 'active', 'activity', 'cleanup', 'fail:OWNER_UNAVAILABLE:ProviderConnectionError']);
});

function registry(events: string[]): OperationRegistryApi {
  const lease: OperationLease = {
    id: 'tracked-operation-test', cancellable: false,
    start: () => events.push('start'), active: () => events.push('active'), waiting: () => events.push('waiting'),
    activity: () => events.push('activity'), refuse: code => events.push(`refuse:${code}`),
    complete: code => events.push(`complete:${code}`), fail: (code, error) => events.push(`fail:${code}:${error}`),
    timeout: code => events.push(`timeout:${code}`), cancel: async () => { events.push('cancel'); },
    cleanup: async () => { events.push('cleanup'); }, registerProcess: () => { throw new Error('not used'); }
  };
  return { startOperation: async () => lease } as unknown as OperationRegistryApi;
}
