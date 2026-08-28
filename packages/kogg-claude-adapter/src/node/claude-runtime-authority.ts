import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import type { AgentAdapterFactory, AgentAdapterSession } from '@kogg/agents/lib/common/agents-protocol';
import type { ClaudeCommercialUseApprovalV1, ClaudeSafeCode } from '../common/claude-protocol';
import { ClaudeArtifactRegistry, type AttestedClaudeArtifactV1 } from './claude-artifact-registry';
import { claudeLog } from './claude-logger';

// The optional owner is the only boundary allowed to probe or execute the attested commercial runtime. Its projection contains identities and booleans only.
// diagnostic-coverage: claude.artifact, claude.confinement, claude.settings, claude.protocol, claude.credentials, claude.processes, claude.cleanup, claude.recovery, claude.source-maps
export const QualifiedClaudeRuntimeAuthority = Symbol('QualifiedClaudeRuntimeAuthority');
export interface QualifiedClaudeRuntimeProjection { readonly artifactManifestDigest: string; readonly legalApprovalDigest: string; readonly bundledCliVersion: string; readonly executionProfileDigest: string; readonly artifactVerified: boolean; readonly confinementVerified: boolean; readonly credentialBrokerReady: boolean; }
export interface QualifiedClaudeRuntimeAuthority {
  qualify(input: { readonly artifact: AttestedClaudeArtifactV1; readonly approval: ClaudeCommercialUseApprovalV1 }): Promise<QualifiedClaudeRuntimeProjection>;
  create(input: Parameters<AgentAdapterFactory['create']>[0] & { readonly artifact: AttestedClaudeArtifactV1; readonly approval: ClaudeCommercialUseApprovalV1 }): AgentAdapterSession;
}
export interface ClaudeRuntimeAuthorityProjection extends Partial<QualifiedClaudeRuntimeProjection> { readonly ownerReady: boolean; readonly safeCode: ClaudeSafeCode; }
const SHA256 = /^[0-9a-f]{64}$/u; const BLOCKED: ClaudeRuntimeAuthorityProjection = { ownerReady: false, artifactVerified: false, confinementVerified: false, credentialBrokerReady: false, safeCode: 'CLAUDE_ARTIFACT_MISMATCH' };

@injectable()
export class ClaudeRuntimeAuthorityRegistry implements BackendApplicationContribution {
  private startup: Promise<void> | undefined; private value: ClaudeRuntimeAuthorityProjection = BLOCKED;
  constructor(@inject(ClaudeArtifactRegistry) private readonly artifacts: ClaudeArtifactRegistry, @inject(QualifiedClaudeRuntimeAuthority) @optional() private readonly authority?: QualifiedClaudeRuntimeAuthority) {}
  onStart(): Promise<void> { return this.startup ??= this.qualify(); }
  projection(): ClaudeRuntimeAuthorityProjection { return this.value; }
  create(input: Parameters<AgentAdapterFactory['create']>[0]): AgentAdapterSession {
    if (!this.authority || !ready(this.value)) throw new ClaudeRuntimeAuthorityFault(this.value.safeCode);
    const artifact = this.artifacts.attestedArtifact(); const approval = this.artifacts.qualifiedApproval(); claudeLog('session.create.requested', { attemptId: input.binding.attemptId, artifactManifestDigest: artifact.manifestDigest });
    try { const session = this.authority.create({ ...input, artifact, approval }); validateSession(session); claudeLog('session.create.completed', { attemptId: input.binding.attemptId, resourceId: session.resourceId }); return session; }
    catch { /* observability-exempt: closed session creation failure discards owner errors and never logs attempt content, paths, credentials, or commercial runtime data. */ claudeLog('session.create.failed', { attemptId: input.binding.attemptId, safeCode: 'CLAUDE_INTERNAL' }); throw new ClaudeRuntimeAuthorityFault('CLAUDE_INTERNAL'); }
  }
  private async qualify(): Promise<void> {
    await this.artifacts.onStart(); let artifact: AttestedClaudeArtifactV1; let approval: ClaudeCommercialUseApprovalV1; try { artifact = this.artifacts.attestedArtifact(); approval = this.artifacts.qualifiedApproval(); }
    catch { /* observability-exempt: artifact registry already emitted the exact closed verification failure. */ this.value = { ...BLOCKED, safeCode: this.artifacts.projection().safeCode }; return; }
    claudeLog('authority.verify.started', { artifactManifestDigest: artifact.manifestDigest });
    if (!this.authority) { this.value = { ...BLOCKED, artifactManifestDigest: artifact.manifestDigest, legalApprovalDigest: artifact.approvalDigest, bundledCliVersion: artifact.manifest.bundledCliVersion, safeCode: 'CLAUDE_CONFINEMENT_UNAVAILABLE' }; claudeLog('authority.verify.failed', { artifactManifestDigest: artifact.manifestDigest, safeCode: this.value.safeCode }); return; }
    try { const inspected = await this.authority.qualify({ artifact, approval }); validateProjection(inspected, artifact); const safeCode: ClaudeSafeCode = !inspected.artifactVerified ? 'CLAUDE_ARTIFACT_MISMATCH' : !inspected.confinementVerified ? 'CLAUDE_CONFINEMENT_UNAVAILABLE' : !inspected.credentialBrokerReady ? 'CLAUDE_CREDENTIAL_BROKER_UNAVAILABLE' : 'CLAUDE_OK'; this.value = { ...inspected, ownerReady: true, safeCode }; if (safeCode === 'CLAUDE_OK') claudeLog('authority.verify.completed', { artifactManifestDigest: inspected.artifactManifestDigest, executionProfileDigest: inspected.executionProfileDigest }); else claudeLog('authority.verify.failed', { artifactManifestDigest: inspected.artifactManifestDigest, safeCode }); }
    catch { /* observability-exempt: qualification errors and private owner state are discarded behind the closed authority failure. */ this.value = { ...BLOCKED, artifactManifestDigest: artifact.manifestDigest, legalApprovalDigest: artifact.approvalDigest, bundledCliVersion: artifact.manifest.bundledCliVersion, safeCode: 'CLAUDE_CONFINEMENT_UNAVAILABLE' }; claudeLog('authority.verify.failed', { artifactManifestDigest: artifact.manifestDigest, safeCode: this.value.safeCode }); }
  }
}
export class ClaudeRuntimeAuthorityFault extends Error { constructor(readonly code: ClaudeSafeCode) { super(code); } }
function ready(value: ClaudeRuntimeAuthorityProjection): boolean { return value.ownerReady && value.artifactVerified === true && value.confinementVerified === true && value.credentialBrokerReady === true && value.safeCode === 'CLAUDE_OK'; }
function validateProjection(value: QualifiedClaudeRuntimeProjection, artifact: AttestedClaudeArtifactV1): void { if (!value || Object.keys(value).sort().join(',') !== ['artifactManifestDigest','artifactVerified','bundledCliVersion','confinementVerified','credentialBrokerReady','executionProfileDigest','legalApprovalDigest'].sort().join(',') || value.artifactManifestDigest !== artifact.manifestDigest || value.legalApprovalDigest !== artifact.approvalDigest || value.bundledCliVersion !== artifact.manifest.bundledCliVersion || !SHA256.test(value.executionProfileDigest) || typeof value.artifactVerified !== 'boolean' || typeof value.confinementVerified !== 'boolean' || typeof value.credentialBrokerReady !== 'boolean') throw new Error('Invalid Claude runtime authority projection'); }
function validateSession(value: AgentAdapterSession): void { if (!value || typeof value.resourceId !== 'string' || !value.resourceId || value.resourceId.length > 128 || !['provider-host','provider-request'].includes(value.resourceKind) || value.ownerKind !== 'kogg' || typeof value.start !== 'function' || typeof value.cancel !== 'function' || typeof value.cleanup !== 'function') throw new Error('Invalid Claude adapter session'); }
