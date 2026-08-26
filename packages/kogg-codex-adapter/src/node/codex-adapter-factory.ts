import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggAdapterRegistry, type AdapterDescriptorV1, type AdapterRegistryApi, type AgentAdapterFactory, type AgentAdapterSession } from '@kogg/agents/lib/common/agents-protocol';
import { codexLog } from './codex-logger';
import { CodexReleaseRegistry } from './codex-release-registry';

// Logs through the closed [kogg:agents:codex-release] schema in codex-logger.
// diagnostic-coverage: codex.release, codex.confinement, codex.protocol, codex.credentials, codex.processes
@injectable()
export class CodexAdapterFactory implements AgentAdapterFactory, BackendApplicationContribution {
  constructor(@inject(KoggAdapterRegistry) private readonly adapters: AdapterRegistryApi,
    @inject(CodexReleaseRegistry) private readonly releases: CodexReleaseRegistry) {}
  get descriptor(): AdapterDescriptorV1 { const release = this.releases.projection(); return { schemaVersion: '1', adapterKey: 'codex-app-server', adapterVersion: '1.0.0', protocolId: 'codex.app-server-v2', protocolVersion: '1.0.0', providerIds: ['openai'], capabilityIds: ['provider-turn'], executionKind: 'supervised-host', cancellation: 'cooperative-and-owned-cleanup', usageModes: ['provider-cumulative'], ownerKind: 'kogg', enabled: release.qualified && release.confinementVerified && release.credentialBrokerReady }; }
  async onStart(): Promise<void> { await this.releases.onStart(); this.adapters.register(this); }
  create(): AgentAdapterSession { const projection = this.releases.projection(); codexLog('release.verification.failed', { adapterVersion: projection.adapterVersion, safeCode: projection.safeCode }); throw new Error(projection.safeCode); }
}
