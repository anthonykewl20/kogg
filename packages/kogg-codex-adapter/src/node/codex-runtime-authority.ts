import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import type { AgentAdapterFactory, AgentAdapterSession } from '@kogg/agents/lib/common/agents-protocol';
import type { CodexSafeCode } from '../common/codex-protocol';
import { codexLog } from './codex-logger';
import { CodexReleaseRegistry, type QualifiedCodexRuntimeV1 } from './codex-release-registry';

// The authority receives the exact verified runtime and opaque attempt binding. It must not expose paths, credentials, protocol content, or owner internals through its projection.
// diagnostic-coverage: codex.release, codex.confinement, codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
export const QualifiedCodexRuntimeAuthority = Symbol('QualifiedCodexRuntimeAuthority');
export interface QualifiedCodexRuntimeProjection {
  readonly releaseId: string; readonly target: QualifiedCodexRuntimeV1['release']['target']; readonly qualificationProfileId: string;
  readonly confinementVerified: boolean; readonly credentialBrokerReady: boolean;
}
export interface QualifiedCodexRuntimeAuthority {
  qualify(runtime: QualifiedCodexRuntimeV1): Promise<QualifiedCodexRuntimeProjection>;
  create(input: Parameters<AgentAdapterFactory['create']>[0] & { readonly runtime: QualifiedCodexRuntimeV1 }): AgentAdapterSession;
}
export interface CodexRuntimeAuthorityProjection {
  readonly releaseId?: string; readonly target?: QualifiedCodexRuntimeV1['release']['target']; readonly qualificationProfileId?: string;
  readonly confinementVerified: boolean; readonly credentialBrokerReady: boolean; readonly ownerReady: boolean; readonly safeCode: CodexSafeCode;
}
const BLOCKED: CodexRuntimeAuthorityProjection = { confinementVerified: false, credentialBrokerReady: false, ownerReady: false, safeCode: 'CODEX_CONFINEMENT_UNVERIFIED' };

@injectable()
export class CodexRuntimeAuthorityRegistry implements BackendApplicationContribution {
  private startup: Promise<void> | undefined; private value: CodexRuntimeAuthorityProjection = BLOCKED;
  constructor(@inject(CodexReleaseRegistry) private readonly releases: CodexReleaseRegistry,
    @inject(QualifiedCodexRuntimeAuthority) @optional() private readonly authority?: QualifiedCodexRuntimeAuthority) {}
  onStart(): Promise<void> { return this.startup ??= this.qualify(); }
  projection(): CodexRuntimeAuthorityProjection { return this.value; }
  create(input: Parameters<AgentAdapterFactory['create']>[0]): AgentAdapterSession {
    if (!this.authority || !this.value.ownerReady || !this.value.confinementVerified || !this.value.credentialBrokerReady) throw new CodexRuntimeAuthorityFault(this.value.safeCode);
    const runtime = this.releases.qualifiedRuntime(); codexLog('session.create.requested', { attemptId: input.binding.attemptId, releaseId: runtime.release.releaseId });
    try { const session = this.authority.create({ ...input, runtime }); validateSession(session); codexLog('session.create.completed', { attemptId: input.binding.attemptId, releaseId: runtime.release.releaseId, resourceId: session.resourceId }); return session; }
    catch { // observability-exempt: The closed creation failure discards authority errors and never logs the attempt payload, runtime paths, or credential lease.
      codexLog('session.create.failed', { attemptId: input.binding.attemptId, releaseId: runtime.release.releaseId, safeCode: 'CODEX_INTERNAL_FAILURE' }); throw new CodexRuntimeAuthorityFault('CODEX_INTERNAL_FAILURE'); }
  }
  private async qualify(): Promise<void> {
    await this.releases.onStart(); let runtime: QualifiedCodexRuntimeV1; try { runtime = this.releases.qualifiedRuntime(); }
    catch { // observability-exempt: Release verification already emitted the exact closed failure; no runtime authority is called.
      return; }
    codexLog('authority.verification.started', { releaseId: runtime.release.releaseId, target: runtime.release.target });
    if (!this.authority) { codexLog('authority.verification.failed', { releaseId: runtime.release.releaseId, safeCode: 'CODEX_CONFINEMENT_UNVERIFIED' }); return; }
    try {
      const inspected = await this.authority.qualify(runtime); validateProjection(inspected, runtime); const ready = inspected.confinementVerified && inspected.credentialBrokerReady;
      this.value = { ...inspected, ownerReady: true, safeCode: ready ? 'CODEX_OK' : inspected.confinementVerified ? 'CODEX_CREDENTIAL_LEASE_REFUSED' : 'CODEX_CONFINEMENT_UNVERIFIED' };
      if (ready) codexLog('authority.verification.completed', { releaseId: inspected.releaseId, target: inspected.target, qualificationProfileId: inspected.qualificationProfileId });
      else codexLog('authority.verification.failed', { releaseId: inspected.releaseId, safeCode: this.value.safeCode });
    } catch { // observability-exempt: Qualification errors and private owner state are discarded behind the closed authority failure.
      this.value = { ...BLOCKED, releaseId: runtime.release.releaseId, target: runtime.release.target, qualificationProfileId: runtime.release.qualificationProfileId }; codexLog('authority.verification.failed', { releaseId: runtime.release.releaseId, safeCode: 'CODEX_CONFINEMENT_UNVERIFIED' });
    }
  }
}
export class CodexRuntimeAuthorityFault extends Error { constructor(readonly code: CodexSafeCode) { super(code); } }
function validateProjection(value: QualifiedCodexRuntimeProjection, runtime: QualifiedCodexRuntimeV1): void {
  if (!value || value.releaseId !== runtime.release.releaseId || value.target !== runtime.release.target || value.qualificationProfileId !== runtime.release.qualificationProfileId || typeof value.confinementVerified !== 'boolean' || typeof value.credentialBrokerReady !== 'boolean' || Object.keys(value).sort().join(',') !== ['confinementVerified', 'credentialBrokerReady', 'qualificationProfileId', 'releaseId', 'target'].sort().join(',')) throw new Error('Invalid runtime authority projection');
}
function validateSession(value: AgentAdapterSession): void {
  if (!value || typeof value.resourceId !== 'string' || !value.resourceId || value.resourceId.length > 128 || !['provider-host', 'provider-request'].includes(value.resourceKind) || value.ownerKind !== 'kogg' || typeof value.start !== 'function' || typeof value.cancel !== 'function' || typeof value.cleanup !== 'function') throw new Error('Invalid Codex adapter session');
}
