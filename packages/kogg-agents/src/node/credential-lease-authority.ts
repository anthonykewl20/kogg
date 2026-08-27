import { injectable } from '@theia/core/shared/inversify';
import { agentLog } from '../common/agent-logger';
import type { CredentialLeaseAuthority, OpaqueCredentialLease } from '../common/agents-protocol';

// Logs through the closed [kogg:agents:adapter] agentLog schema.
// diagnostic-coverage: agents.adapters, agents.logging

@injectable()
export class LocalCredentialLeaseAuthority implements CredentialLeaseAuthority {
  async issue(input: Parameters<CredentialLeaseAuthority['issue']>[0]): Promise<OpaqueCredentialLease> {
    const fields = new Set(['attemptId', 'providerId', 'modelId', 'adapterKey', 'adapterVersion', 'capabilityIds']);
    if (Object.keys(input).some(key => !fields.has(key)) || !UUID.test(input.attemptId) || !SEMVER.test(input.adapterVersion) || !Array.isArray(input.capabilityIds) || input.capabilityIds.length > 64 || new Set(input.capabilityIds).size !== input.capabilityIds.length || [input.providerId, input.modelId, input.adapterKey, ...input.capabilityIds].some(value => !SYMBOLIC.test(value))) throw new CredentialLeaseError();
    if (input.providerId !== 'kogg.fixture' || input.adapterKey !== 'kogg.fixture') throw new CredentialLeaseError();
    const leaseId = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 60_000).toISOString(); let remaining = 1; let disposed = false;
    agentLog('credential.lease.issued', { attemptId: input.attemptId, adapterKey: input.adapterKey, adapterVersion: input.adapterVersion, providerId: input.providerId, modelId: input.modelId });
    return { leaseId, expiresAt, consume: () => { if (disposed || remaining !== 1 || Date.now() >= Date.parse(expiresAt)) throw new CredentialLeaseError(); remaining = 0; }, dispose: () => { disposed = true; remaining = 0; } };
  }
}
export class CredentialLeaseError extends Error { readonly code = 'CREDENTIAL_LEASE_REFUSED' as const; constructor() { super('CREDENTIAL_LEASE_REFUSED'); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u; const SYMBOLIC = /^[a-z0-9][a-z0-9._:-]{0,127}$/u; const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
