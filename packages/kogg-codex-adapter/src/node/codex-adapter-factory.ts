import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggAdapterRegistry, type AdapterDescriptorV1, type AdapterRegistryApi, type AgentAdapterFactory, type AgentAdapterSession } from '@kogg/agents/lib/common/agents-protocol';
import { codexLog } from './codex-logger';
import { CodexReleaseRegistry } from './codex-release-registry';
import { CodexRecoveryRegistry } from './codex-recovery-registry';
import { CodexRuntimeAuthorityRegistry } from './codex-runtime-authority';

// Logs through the closed [kogg:agents:codex-release] schema in codex-logger.
// diagnostic-coverage: codex.release, codex.confinement, codex.protocol, codex.credentials, codex.processes, codex.recovery
@injectable()
export class CodexAdapterFactory implements AgentAdapterFactory, BackendApplicationContribution {
  constructor(@inject(KoggAdapterRegistry) private readonly adapters: AdapterRegistryApi,
    @inject(CodexReleaseRegistry) private readonly releases: CodexReleaseRegistry,
    @inject(CodexRecoveryRegistry) private readonly recovery: CodexRecoveryRegistry,
    @inject(CodexRuntimeAuthorityRegistry) private readonly runtimeAuthority: CodexRuntimeAuthorityRegistry) {}
  get descriptor(): AdapterDescriptorV1 { const release = this.releases.projection(); const recovery = this.recovery.projection(); const authority = this.runtimeAuthority.projection(); const attempt = this.runtimeAuthority.attemptProjection(); return { schemaVersion: '1', adapterKey: 'codex-app-server', adapterVersion: '1.0.0', protocolId: 'codex.app-server-v2', protocolVersion: '1.0.0', providerIds: ['openai'], capabilityIds: ['provider-turn'], executionKind: 'supervised-host', cancellation: 'cooperative-and-owned-cleanup', usageModes: ['provider-cumulative'], ownerKind: 'kogg', enabled: release.qualified && authority.ownerReady && authority.confinementVerified && authority.credentialBrokerReady && attempt.ownerReady && recovery.ownerReady && recovery.recoveryComplete }; }
  async onStart(): Promise<void> { await Promise.all([this.runtimeAuthority.onStart(), this.recovery.onStart()]); this.adapters.register(this); }
  create(input: Parameters<AgentAdapterFactory['create']>[0]): AgentAdapterSession { const release = this.releases.projection(); const recovery = this.recovery.projection(); const authority = this.runtimeAuthority.projection(); const attempt = this.runtimeAuthority.attemptProjection(); const runtimeReady = authority.ownerReady && authority.confinementVerified && authority.credentialBrokerReady; const safeCode = !recovery.ownerReady || !recovery.recoveryComplete ? recovery.safeCode : !release.qualified ? release.safeCode : !runtimeReady ? authority.safeCode : !attempt.ownerReady ? attempt.safeCode : 'CODEX_INTERNAL_FAILURE'; if (!this.descriptor.enabled) { codexLog('session.create.failed', { attemptId: input.binding.attemptId, releaseId: authority.releaseId ?? 'unqualified', safeCode }); throw new Error(safeCode); } return this.runtimeAuthority.create(input); }
}
