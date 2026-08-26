import { injectable } from '@theia/core/shared/inversify';
import type { CredentialLeaseAuthority, OpaqueCredentialLease } from '../common/agents-protocol';

// diagnostic-coverage: agents.adapters, agents.logging

@injectable()
export class LocalCredentialLeaseAuthority implements CredentialLeaseAuthority {
  async issue(input: Parameters<CredentialLeaseAuthority['issue']>[0]): Promise<OpaqueCredentialLease> {
    if (input.providerId !== 'kogg.fixture' || input.adapterKey !== 'kogg.fixture') throw new CredentialLeaseError();
    const leaseId = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 60_000).toISOString(); let remaining = 1; let disposed = false;
    console.debug('[kogg:agents:adapter] credential-lease.issued', { attemptId: input.attemptId, adapterKey: input.adapterKey, adapterVersion: input.adapterVersion, providerId: input.providerId, modelId: input.modelId, leaseId });
    return { leaseId, expiresAt, consume: () => { if (disposed || remaining !== 1 || Date.now() >= Date.parse(expiresAt)) throw new CredentialLeaseError(); remaining = 0; }, dispose: () => { disposed = true; remaining = 0; } };
  }
}
export class CredentialLeaseError extends Error { readonly code = 'CREDENTIAL_LEASE_REFUSED' as const; constructor() { super('CREDENTIAL_LEASE_REFUSED'); } }
