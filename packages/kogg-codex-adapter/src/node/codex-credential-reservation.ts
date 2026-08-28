import type { OpaqueCredentialLease } from '@kogg/agents/lib/common/agents-protocol';
import type { CodexSafeCode } from '../common/codex-protocol';
import { codexLog } from './codex-logger';

// The adapter owns only opaque reservation identity. Provider credentials and broker bearers never enter this object, logs, diagnostics, or process input.
// diagnostic-coverage: codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u; const MAX_REQUESTS = 64;
export interface CodexCredentialBinding {
  readonly schemaVersion: '1'; readonly attemptId: string; readonly releaseId: string; readonly providerId: string; readonly modelId: string;
  readonly credentialLeaseId: string; readonly maximumRequestCount: number; readonly expiresAt: string;
}
export interface CodexCredentialBrokerAuthority {
  reserve(binding: CodexCredentialBinding): Promise<{ readonly reservationId: string }>;
  activate(reservationId: string, processRegistrationId: string): Promise<void>;
  revoke(reservationId: string): Promise<void>;
}
export interface CodexCredentialReservationInput {
  readonly attemptId: string; readonly releaseId: string; readonly providerId: string; readonly modelId: string; readonly maximumRequestCount: number;
  readonly credentialLease: OpaqueCredentialLease; readonly authority: CodexCredentialBrokerAuthority; readonly now?: () => number;
}
export interface CodexCredentialDiagnostics { readonly reserved: boolean; readonly active: boolean; readonly revoked: boolean; readonly failed: boolean; }
export class CodexCredentialFault extends Error { constructor(readonly code: Extract<CodexSafeCode, 'CODEX_CREDENTIAL_LEASE_REFUSED' | 'CODEX_CREDENTIAL_REVOKED'>) { super(code); } }

export class CodexCredentialReservation {
  private active = false; private revoked = false; private failed = false; private activationStarted = false; private revoking: Promise<void> | undefined;
  private constructor(private readonly input: CodexCredentialReservationInput, private readonly reservationId: string, readonly binding: CodexCredentialBinding) {}
  static async reserve(input: CodexCredentialReservationInput): Promise<CodexCredentialReservation> {
    let binding: CodexCredentialBinding; try { binding = validate(input); } catch { input.credentialLease.dispose(); throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED'); } codexLog('broker.reservation.requested', fields(binding));
    try {
      const result = await input.authority.reserve(binding); if (!result || !ID.test(result.reservationId)) throw new Error('invalid reservation');
      codexLog('broker.reservation.completed', fields(binding)); return new CodexCredentialReservation(input, result.reservationId, binding);
    } catch { // observability-exempt: The closed reservation failure below discards broker errors and always disposes the shared opaque lease.
      input.credentialLease.dispose(); codexLog('broker.reservation.failed', { ...fields(binding), safeCode: 'CODEX_CREDENTIAL_LEASE_REFUSED' }); throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED');
    }
  }
  async activate(processRegistrationId: string): Promise<void> {
    if (this.activationStarted || this.revoked || this.failed || !ID.test(processRegistrationId) || Date.parse(this.binding.expiresAt) <= this.now()) { this.failed = true; await this.revokeAfterFailure(); throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED'); }
    this.activationStarted = true; codexLog('broker.activation.requested', { ...fields(this.binding), processId: processRegistrationId });
    try { this.input.credentialLease.consume(); await this.input.authority.activate(this.reservationId, processRegistrationId); this.active = true; codexLog('broker.activation.completed', { ...fields(this.binding), processId: processRegistrationId }); }
    catch { // observability-exempt: Activation refusal is closed below; revoke disposes the lease and no broker/credential error is exposed.
      this.failed = true; codexLog('broker.activation.failed', { ...fields(this.binding), processId: processRegistrationId, safeCode: 'CODEX_CREDENTIAL_LEASE_REFUSED' }); await this.revokeAfterFailure(); throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED'); }
  }
  revoke(): Promise<void> { return this.revoking ??= this.revokeOnce(); }
  diagnostics(): CodexCredentialDiagnostics { return { reserved: true, active: this.active, revoked: this.revoked, failed: this.failed }; }
  private async revokeOnce(): Promise<void> {
    try { await this.input.authority.revoke(this.reservationId); this.revoked = true; this.active = false; codexLog('broker.revoked', fields(this.binding)); }
    catch { // observability-exempt: Revocation errors normalize to a closed code after the opaque shared lease is disposed in finally.
      this.failed = true; codexLog('broker.revoke.failed', { ...fields(this.binding), safeCode: 'CODEX_CREDENTIAL_REVOKED' }); throw new CodexCredentialFault('CODEX_CREDENTIAL_REVOKED'); }
    finally { this.input.credentialLease.dispose(); }
  }
  private async revokeAfterFailure(): Promise<void> { try { await this.revoke(); } catch { // observability-exempt: Activation remains the primary closed refusal; revoke already emitted its safe failure and disposed the lease.
      return; } }
  private now(): number { return (this.input.now ?? Date.now)(); }
}
function validate(input: CodexCredentialReservationInput): CodexCredentialBinding {
  for (const value of [input.attemptId, input.releaseId, input.providerId, input.modelId, input.credentialLease.leaseId]) if (!ID.test(value)) throw new Error('Invalid credential binding');
  if (!Number.isSafeInteger(input.maximumRequestCount) || input.maximumRequestCount < 1 || input.maximumRequestCount > MAX_REQUESTS || !Number.isFinite(Date.parse(input.credentialLease.expiresAt)) || Date.parse(input.credentialLease.expiresAt) <= (input.now ?? Date.now)()) throw new Error('Invalid credential binding');
  return Object.freeze({ schemaVersion: '1', attemptId: input.attemptId, releaseId: input.releaseId, providerId: input.providerId, modelId: input.modelId, credentialLeaseId: input.credentialLease.leaseId, maximumRequestCount: input.maximumRequestCount, expiresAt: input.credentialLease.expiresAt });
}
function fields(binding: CodexCredentialBinding): { attemptId: string; providerId: string; modelId: string; requestCount: number } { return { attemptId: binding.attemptId, providerId: binding.providerId, modelId: binding.modelId, requestCount: binding.maximumRequestCount }; }
