import assert from 'node:assert/strict'; import test from 'node:test';
import { CodexSessionAttestation, CodexSessionAttestationFault } from './codex-session-attestation';

// diagnostic-coverage: codex.protocol, codex.confinement, codex.source-maps
const initialize = { schemaVersion: '1', externalSandbox: true, approvalPolicy: 'never', capabilityIds: ['provider-turn'] } as const;
const thread = { schemaVersion: '1', ephemeral: true, providerId: 'openai', modelId: 'gpt-5', sandboxMode: 'workspace-write' } as const;
const create = (): CodexSessionAttestation => new CodexSessionAttestation({ attemptId: 'attempt-1', providerId: 'openai', modelId: 'gpt-5', capabilityIds: ['provider-turn'], mapper: { initialize: value => value, thread: value => value } });
const code = (expected: string) => (error: unknown): boolean => error instanceof CodexSessionAttestationFault && error.code === expected;
test('accepts only exact external-sandbox, never-approve, capability, ephemeral, provider, model, and workspace-write claims', () => { const value = create(); value.verifyInitialize(initialize); value.verifyThread(thread); });
test('classifies every semantic authority mismatch with its exact closed code', () => {
  assert.throws(() => create().verifyInitialize({ ...initialize, externalSandbox: false }), code('CODEX_SANDBOX_MISMATCH')); assert.throws(() => create().verifyInitialize({ ...initialize, capabilityIds: [] }), code('CODEX_CAPABILITY_UNEXPECTED'));
  assert.throws(() => create().verifyThread({ ...thread, providerId: 'other' }), code('CODEX_PROVIDER_MISMATCH')); assert.throws(() => create().verifyThread({ ...thread, modelId: 'other' }), code('CODEX_MODEL_MISMATCH')); assert.throws(() => create().verifyThread({ ...thread, ephemeral: false }), code('CODEX_SANDBOX_MISMATCH'));
});
test('rejects malformed normalized claims without exposing their values in logs', () => {
  const canary = `codex-attestation-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try { assert.throws(() => create().verifyInitialize({ ...initialize, unexpected: canary }), code('CODEX_PROTOCOL_VIOLATION')); assert.throws(() => create().verifyThread({ ...thread, providerId: canary, raw: canary }), code('CODEX_PROTOCOL_VIOLATION')); assert.equal(logs.join('\n').includes(canary), false); }
  finally { console.error = original; }
});
test('normalizes release-specific raw replies only through the qualified mapper and closes mapper failures', () => {
  const calls: string[] = []; const value = new CodexSessionAttestation({ attemptId: 'attempt-1', providerId: 'openai', modelId: 'gpt-5', capabilityIds: ['provider-turn'], mapper: { initialize: raw => { calls.push(String(raw)); return initialize; }, thread: () => { throw new Error('private mapper failure'); } } });
  value.verifyInitialize('opaque-initialize'); assert.deepEqual(calls, ['opaque-initialize']); assert.throws(() => value.verifyThread('opaque-thread'), code('CODEX_PROTOCOL_VIOLATION'));
});
