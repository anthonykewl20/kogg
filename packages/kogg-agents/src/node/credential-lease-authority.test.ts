import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialLeaseError, LocalCredentialLeaseAuthority } from './credential-lease-authority';

// diagnostic-coverage: agents.adapters, agents.logging

const INPUT = { attemptId: '10000000-0000-4000-8000-000000000001', providerId: 'kogg.fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', capabilityIds: ['provider-turn', 'private.canary'] };

test('issues one-use opaque leases without logging capability or credential material', async () => {
  const captured: string[] = []; const original = console.debug; console.debug = (...values: unknown[]) => { captured.push(JSON.stringify(values)); };
  try { const lease = await new LocalCredentialLeaseAuthority().issue(INPUT); assert.match(lease.leaseId, /^[0-9a-f-]{36}$/u); assert.doesNotThrow(() => lease.consume()); assert.throws(() => lease.consume(), CredentialLeaseError); assert.equal(captured.join('\n').includes('private.canary'), false); }
  finally { console.debug = original; }
});

test('refuses expired, disposed, mismatched, open, and malformed lease requests', async () => {
  const authority = new LocalCredentialLeaseAuthority(); const disposed = await authority.issue(INPUT); disposed.dispose(); assert.throws(() => disposed.consume(), CredentialLeaseError);
  const expired = await authority.issue(INPUT); const originalNow = Date.now; Date.now = () => Date.parse(expired.expiresAt) + 1; try { assert.throws(() => expired.consume(), CredentialLeaseError); } finally { Date.now = originalNow; }
  const invalid: unknown[] = [{ ...INPUT, providerId: 'other' }, { ...INPUT, modelId: 'fixture.echo\nsecret' }, { ...INPUT, capabilityIds: ['provider-turn', 'provider-turn'] }, { ...INPUT, rawCredential: 'forbidden' }];
  for (const input of invalid) await assert.rejects(() => authority.issue(input as typeof INPUT), CredentialLeaseError);
});
