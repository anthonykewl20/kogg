import assert from 'node:assert/strict'; import test from 'node:test';
import { CodexSessionCleanupCoordinator, type CodexCleanupBoundary } from './codex-session-cleanup';

// diagnostic-coverage: codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
function fixture(overrides: Partial<CodexCleanupBoundary> = {}, resourceCount = 5): { coordinator: CodexSessionCleanupCoordinator; events: string[] } {
  const events: string[] = []; const boundary: CodexCleanupBoundary = {
    closeContentInput: () => { events.push('content.closed'); }, revokeCredentials: async () => { events.push('credentials.revoked'); },
    interruptTurn: async () => { events.push('turn.interrupted'); }, settleProtocol: async () => { events.push('protocol.settled'); },
    terminateOwnedHost: async () => { events.push('host.terminated'); }, enumerateResiduals: async () => { events.push('residuals.enumerated'); return 0; }, ...overrides
  };
  return { coordinator: new CodexSessionCleanupCoordinator({ attemptId: 'attempt-1', operationId: 'operation-1', processId: 'process-1', resourceCount, boundary, stageTimeoutMs: 20 }), events };
}
test('cancellation closes authority, interrupts once, and commits only after empty residual proof', async () => {
  const { coordinator, events } = fixture(); coordinator.observeTerminal('CODEX_PROVIDER_REFUSED');
  const one = coordinator.cleanup('cancel', true); const two = coordinator.cleanup('cancel', true); assert.deepEqual(await one, { terminalCode: 'CODEX_PROVIDER_REFUSED', residualCount: 0, cleaned: true }); assert.deepEqual(await two, await one);
  assert.deepEqual(events, ['content.closed', 'credentials.revoked', 'turn.interrupted', 'protocol.settled', 'host.terminated', 'residuals.enumerated']);
});
test('terminal cleanup skips interrupt and preserves the first terminal classification', async () => {
  const { coordinator, events } = fixture(); assert.equal(coordinator.observeTerminal('CODEX_OK'), 'CODEX_OK'); assert.equal(coordinator.observeTerminal('CODEX_TRANSPORT_LOST'), 'CODEX_OK');
  assert.deepEqual(await coordinator.cleanup('terminal', true), { terminalCode: 'CODEX_OK', residualCount: 0, cleaned: true }); assert.equal(events.includes('turn.interrupted'), false);
});
test('stage failure still terminates and enumerates, and residuals fail cleanup closed', async () => {
  const failed = fixture({ revokeCredentials: async () => { failed.events.push('credentials.failed'); throw new Error('private failure'); } }); failed.coordinator.observeTerminal('CODEX_OK');
  assert.deepEqual(await failed.coordinator.cleanup('terminal', false), { terminalCode: 'CODEX_CLEANUP_FAILED', residualCount: 0, cleaned: false }); assert.deepEqual(failed.events, ['content.closed', 'credentials.failed', 'protocol.settled', 'host.terminated', 'residuals.enumerated']);
  const residual = fixture({ enumerateResiduals: async () => 2 }, 5); residual.coordinator.observeTerminal('CODEX_OK'); assert.deepEqual(await residual.coordinator.cleanup('terminal', false), { terminalCode: 'CODEX_CLEANUP_FAILED', residualCount: 2, cleaned: false });
});
test('a stalled stage times out but still terminates and enumerates', async () => {
  const stalled = fixture({ settleProtocol: async () => new Promise<void>(() => undefined), terminateOwnedHost: async () => { stalled.events.push('host.terminated'); }, enumerateResiduals: async () => { stalled.events.push('residuals.enumerated'); return 0; } });
  stalled.coordinator.observeTerminal('CODEX_TRANSPORT_LOST'); assert.deepEqual(await stalled.coordinator.cleanup('terminal', false), { terminalCode: 'CODEX_CLEANUP_TIMEOUT', residualCount: 0, cleaned: false });
  assert.deepEqual(stalled.events, ['content.closed', 'credentials.revoked', 'host.terminated', 'residuals.enumerated']);
});
test('cleanup failures never expose private error text in logs', async () => {
  const canary = `codex-cleanup-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try { const failed = fixture({ settleProtocol: async () => { throw new Error(canary); } }); failed.coordinator.observeTerminal('CODEX_OK'); assert.equal((await failed.coordinator.cleanup('terminal', false)).terminalCode, 'CODEX_CLEANUP_FAILED'); assert.equal(logs.join('\n').includes(canary), false); }
  finally { console.error = original; }
});
