import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexRecoveryRegistry, type QualifiedCodexRecoveryOwner } from './codex-recovery-registry';

// diagnostic-coverage: codex.processes, codex.cleanup, codex.recovery, codex.source-maps
test('fails closed when no qualified startup-recovery owner is installed', async () => {
  const registry = new CodexRecoveryRegistry(); await registry.onStart();
  assert.deepEqual(registry.projection(), { ownerReady: false, processCount: 0, residualCount: 0, cleanupFailureCount: 0, recoveryBacklog: 1, recoveryComplete: false, safeCode: 'CODEX_RECOVERY_REQUIRED' });
});

test('accepts only a complete zero-residual external reconciliation', async () => {
  let calls = 0; const owner: QualifiedCodexRecoveryOwner = { reconcileStartup: async () => { calls++; return { processCount: 0, residualCount: 0, cleanupFailureCount: 0, recoveryBacklog: 0, recoveryComplete: true }; } };
  const registry = new CodexRecoveryRegistry(owner); await Promise.all([registry.onStart(), registry.onStart()]); assert.equal(calls, 1);
  assert.deepEqual(registry.projection(), { ownerReady: true, processCount: 0, residualCount: 0, cleanupFailureCount: 0, recoveryBacklog: 0, recoveryComplete: true, safeCode: 'CODEX_OK' });
});

test('retains external active counts and blocks residuals, cleanup failures, backlog, and malformed owner results', async () => {
  const residual = new CodexRecoveryRegistry({ reconcileStartup: async () => ({ processCount: 2, residualCount: 1, cleanupFailureCount: 1, recoveryBacklog: 1, recoveryComplete: true }) }); await residual.onStart();
  assert.deepEqual(residual.projection(), { ownerReady: true, processCount: 2, residualCount: 1, cleanupFailureCount: 1, recoveryBacklog: 1, recoveryComplete: false, safeCode: 'CODEX_UNVERIFIED_RESIDUAL' });
  const malformed = new CodexRecoveryRegistry({ reconcileStartup: async () => ({ processCount: -1, residualCount: 0, cleanupFailureCount: 0, recoveryBacklog: 0, recoveryComplete: true }) }); await malformed.onStart(); assert.equal(malformed.projection().ownerReady, false); assert.equal(malformed.projection().recoveryComplete, false);
  const failed = new CodexRecoveryRegistry({ reconcileStartup: async () => { throw new Error('private owner failure'); } }); await failed.onStart(); assert.equal(failed.projection().safeCode, 'CODEX_RECOVERY_REQUIRED');
});
