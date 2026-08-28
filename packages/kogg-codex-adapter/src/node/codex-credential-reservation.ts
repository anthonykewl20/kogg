import type { OpaqueCredentialLease } from '@kogg/agents/lib/common/agents-protocol';
import type { CodexSafeCode, GovernedCodexAttemptV1 } from '../common/codex-protocol';
import { codexLog } from './codex-logger';

// The shared lease and broker secret remain behind this gate. The runtime owner receives frozen binding metadata and opaque reservation identity, never a credential, bearer, or shared lease.
// diagnostic-coverage: codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u; const SHA256 = /^[0-9a-f]{64}$/u; const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u; const MAX_REQUESTS = 64;
export interface CodexCredentialBinding {
  readonly schemaVersion: '1'; readonly attemptId: string; readonly authorityDigest: string; readonly taskRevisionDigest: string; readonly repositoryBindingDigest: string;
  readonly privateRepoObjectId: string | null; readonly worktreePolicy: GovernedCodexAttemptV1['worktreePolicy']; readonly releaseId: string; readonly target: GovernedCodexAttemptV1['target']; readonly qualificationProfileId: string;
  readonly provider: 'openai'; readonly model: string; readonly requestDirection: 'openai-outbound'; readonly credentialLeaseId: string; readonly maximumRequestCount: 64;
  readonly inputTokenCeiling: string; readonly outputTokenCeiling: string; readonly toolCallCeiling: string; readonly bytesInCeiling: string; readonly bytesOutCeiling: string; readonly expiresAt: string;
}
export interface CodexCredentialActivation { readonly reservationId: string; readonly processRegistrationId: string; readonly cgroupIdentityDigest: string; }
export interface CodexCredentialBrokerAuthority { reserve(binding: CodexCredentialBinding): Promise<{ readonly reservationId: string }>; activate(value: CodexCredentialActivation): Promise<void>; revoke(reservationId: string): Promise<void>; }
export interface CodexCredentialDiagnostics { readonly reserved: boolean; readonly active: boolean; readonly revoked: boolean; readonly failed: boolean; }
export class CodexCredentialFault extends Error { constructor(readonly code: Extract<CodexSafeCode, 'CODEX_CREDENTIAL_LEASE_REFUSED' | 'CODEX_CREDENTIAL_REVOKED'>) { super(code); } }

export class CodexCredentialReservation {
  private reservationId: string | undefined; private reserved = false; private active = false; private revoked = false; private failed = false; private activationStarted = false; private reserving: Promise<void> | undefined; private revoking: Promise<void> | undefined; private disposed = false;
  readonly binding: CodexCredentialBinding;
  constructor(attempt: GovernedCodexAttemptV1, private readonly lease: OpaqueCredentialLease, private readonly authority: CodexCredentialBrokerAuthority, private readonly now: () => number = Date.now) {
    try { this.binding = binding(attempt, lease, now()); }
    catch { // observability-exempt: Invalid opaque lease or governed-attempt data is classified without logging identities or contents.
      this.dispose(); codexLog('broker.reservation.failed', { attemptId: attempt.attemptId, providerId: attempt.provider, modelId: attempt.model, requestCount: MAX_REQUESTS, safeCode: 'CODEX_CREDENTIAL_LEASE_REFUSED' }); throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED'); }
  }
  reserve(): Promise<void> { if (this.revoked || this.failed || this.revoking) return Promise.reject(new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED')); return this.reserving ??= this.reserveOnce(); }
  async activate(processRegistrationId: string, cgroupIdentityDigest: string): Promise<void> {
    if (!this.reserved || !this.reservationId || this.activationStarted || this.revoked || this.failed || !ID.test(processRegistrationId) || !SHA256.test(cgroupIdentityDigest) || Date.parse(this.binding.expiresAt) <= this.now()) return this.refuse();
    this.activationStarted = true; codexLog('broker.activation.requested', { ...fields(this.binding), processId: processRegistrationId });
    try { this.lease.consume(); await this.authority.activate({ reservationId: this.reservationId, processRegistrationId, cgroupIdentityDigest }); this.active = true; codexLog('broker.activation.completed', { ...fields(this.binding), processId: processRegistrationId }); }
    catch { // observability-exempt: Private lease and broker errors are discarded behind closed activation and revocation events.
      this.failed = true; codexLog('broker.activation.failed', { ...fields(this.binding), processId: processRegistrationId, safeCode: 'CODEX_CREDENTIAL_LEASE_REFUSED' }); await this.revokeAfterFailure(); throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED'); }
  }
  revoke(): Promise<void> { if (this.revoked) return Promise.resolve(); return this.revoking ??= this.revokeOnce(); }
  abandon(): void { if (this.revoked || this.reserved || this.active) return; if (this.reserving) { void this.revoke().catch(() => { /* observability-exempt: revokeOnce emits the closed asynchronous failure and disposes the lease. */ return; }); return; } this.revoked = true; this.dispose(); codexLog('broker.revoked', fields(this.binding)); }
  diagnostics(): CodexCredentialDiagnostics { return { reserved: this.reserved, active: this.active, revoked: this.revoked, failed: this.failed }; }
  private async reserveOnce(): Promise<void> { codexLog('broker.reservation.requested', fields(this.binding)); try { const result = await this.authority.reserve(this.binding); if (!result || Object.keys(result).join(',') !== 'reservationId' || !ID.test(result.reservationId)) throw new Error('invalid reservation'); this.reservationId = result.reservationId; this.reserved = true; codexLog('broker.reservation.completed', fields(this.binding)); } catch { // observability-exempt: Broker errors and credential material are discarded behind the closed refusal.
      this.failed = true; this.revoked = true; this.dispose(); codexLog('broker.reservation.failed', { ...fields(this.binding), safeCode: 'CODEX_CREDENTIAL_LEASE_REFUSED' }); throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED'); } }
  private async revokeOnce(): Promise<void> { try { if (this.reserving) await this.reserving; if (this.reservationId) await this.authority.revoke(this.reservationId); this.revoked = true; this.active = false; codexLog('broker.revoked', fields(this.binding)); } catch (error) { // observability-exempt: Broker errors are normalized and the shared lease is disposed in finally; an earlier reserve refusal retains its primary classification.
      if (error instanceof CodexCredentialFault && error.code === 'CODEX_CREDENTIAL_LEASE_REFUSED') throw error; this.failed = true; codexLog('broker.revoke.failed', { ...fields(this.binding), safeCode: 'CODEX_CREDENTIAL_REVOKED' }); throw new CodexCredentialFault('CODEX_CREDENTIAL_REVOKED'); } finally { this.dispose(); } }
  private async refuse(): Promise<never> { this.failed = true; await this.revokeAfterFailure(); throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED'); }
  private async revokeAfterFailure(): Promise<void> { try { await this.revoke(); } catch { /* observability-exempt: Revocation emitted the secondary closed failure; activation refusal remains primary. */ return; } }
  private dispose(): void { if (!this.disposed) { this.disposed = true; this.lease.dispose(); } }
}
function binding(attempt: GovernedCodexAttemptV1, lease: OpaqueCredentialLease, now: number): CodexCredentialBinding {
  const leaseExpiry = Date.parse(lease.expiresAt); if (!ID.test(lease.leaseId) || !Number.isFinite(leaseExpiry) || leaseExpiry <= now || !Number.isSafeInteger(attempt.deadlines.absoluteMs) || attempt.deadlines.absoluteMs < 1 || !UUID.test(attempt.attemptId)) throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED');
  const expiresAt = new Date(Math.min(leaseExpiry, now + attempt.deadlines.absoluteMs)).toISOString(); return Object.freeze({ schemaVersion: '1', attemptId: attempt.attemptId, authorityDigest: attempt.authorityDigest, taskRevisionDigest: attempt.taskRevisionDigest, repositoryBindingDigest: attempt.repositoryBindingDigest, privateRepoObjectId: attempt.privateRepoObjectId, worktreePolicy: attempt.worktreePolicy, releaseId: attempt.releaseId, target: attempt.target, qualificationProfileId: attempt.qualificationProfileId, provider: attempt.provider, model: attempt.model, requestDirection: 'openai-outbound', credentialLeaseId: lease.leaseId, maximumRequestCount: MAX_REQUESTS, inputTokenCeiling: attempt.budgets.inputTokens, outputTokenCeiling: attempt.budgets.outputTokens, toolCallCeiling: attempt.budgets.toolCalls, bytesInCeiling: attempt.budgets.bytesIn, bytesOutCeiling: attempt.budgets.bytesOut, expiresAt });
}
function fields(value: CodexCredentialBinding): { attemptId: string; providerId: string; modelId: string; requestCount: number } { return { attemptId: value.attemptId, providerId: value.provider, modelId: value.model, requestCount: value.maximumRequestCount }; }
