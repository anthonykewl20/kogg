import assert from 'node:assert/strict'; import test from 'node:test'; import type { OpaqueCredentialLease } from '@kogg/agents/lib/common/agents-protocol';
import { CodexCredentialFault, CodexCredentialReservation, type CodexCredentialBinding, type CodexCredentialBrokerAuthority } from './codex-credential-reservation';

// diagnostic-coverage: codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
function fixture(overrides: Partial<CodexCredentialBrokerAuthority> = {}) {
  const events: string[] = []; let binding: CodexCredentialBinding | undefined;
  const lease: OpaqueCredentialLease = { leaseId: 'lease-1', expiresAt: new Date(2_000).toISOString(), consume: () => events.push('lease.consumed'), dispose: () => events.push('lease.disposed') };
  const authority: CodexCredentialBrokerAuthority = { reserve: async value => { events.push('broker.reserved'); binding = value; return { reservationId: 'reservation-1' }; }, activate: async (reservation, process) => { events.push(`broker.activated.${reservation}.${process}`); }, revoke: async reservation => { events.push(`broker.revoked.${reservation}`); }, ...overrides };
  return { events, binding: () => binding, reserve: () => CodexCredentialReservation.reserve({ attemptId: 'attempt-1', releaseId: 'release-1', providerId: 'openai', modelId: 'gpt-5', maximumRequestCount: 4, credentialLease: lease, authority, now: () => 1_000 }) };
}
test('reserves an exact frozen bearer-free binding, activates for one registered process, and revokes once', async () => {
  const value = fixture(); const reservation = await value.reserve(); assert.deepEqual(value.binding(), { schemaVersion: '1', attemptId: 'attempt-1', releaseId: 'release-1', providerId: 'openai', modelId: 'gpt-5', credentialLeaseId: 'lease-1', maximumRequestCount: 4, expiresAt: new Date(2_000).toISOString() }); assert.equal(Object.isFrozen(reservation.binding), true); assert.equal(JSON.stringify(reservation).includes('bearer'), false);
  await reservation.activate('process-1'); await reservation.revoke(); await reservation.revoke(); assert.deepEqual(value.events, ['broker.reserved', 'lease.consumed', 'broker.activated.reservation-1.process-1', 'broker.revoked.reservation-1', 'lease.disposed']); assert.deepEqual(reservation.diagnostics(), { reserved: true, active: false, revoked: true, failed: false });
});
test('activation refusal revokes and disposes before any process may start without exposing broker errors', async () => {
  const canary = `codex-broker-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try { const value = fixture({ activate: async () => { throw new Error(canary); } }); const reservation = await value.reserve(); await assert.rejects(reservation.activate('process-1'), error => error instanceof CodexCredentialFault && error.code === 'CODEX_CREDENTIAL_LEASE_REFUSED'); assert.deepEqual(value.events, ['broker.reserved', 'lease.consumed', 'broker.revoked.reservation-1', 'lease.disposed']); assert.deepEqual(reservation.diagnostics(), { reserved: true, active: false, revoked: true, failed: true }); assert.equal(logs.join('\n').includes(canary), false); }
  finally { console.error = original; }
});
test('reservation and revocation failures always dispose the opaque shared lease', async () => {
  const refused = fixture({ reserve: async () => { throw new Error('private reserve failure'); } }); await assert.rejects(refused.reserve(), error => error instanceof CodexCredentialFault && error.code === 'CODEX_CREDENTIAL_LEASE_REFUSED'); assert.deepEqual(refused.events, ['lease.disposed']);
  const revoke = fixture({ revoke: async () => { throw new Error('private revoke failure'); } }); const reservation = await revoke.reserve(); await reservation.activate('process-1'); await assert.rejects(reservation.revoke(), error => error instanceof CodexCredentialFault && error.code === 'CODEX_CREDENTIAL_REVOKED'); assert.equal(revoke.events.at(-1), 'lease.disposed'); assert.equal(reservation.diagnostics().failed, true);
});
