import type { CodexSafeCode } from '../common/codex-protocol';
import { codexLog } from './codex-logger';

// Consumes only release-schema-normalized authority claims. Raw app-server replies, content, and configuration never enter logs or diagnostics.
// diagnostic-coverage: codex.protocol, codex.confinement, codex.source-maps
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
type AttestationCode = Extract<CodexSafeCode, 'CODEX_PROTOCOL_VIOLATION' | 'CODEX_PROVIDER_MISMATCH' | 'CODEX_MODEL_MISMATCH' | 'CODEX_SANDBOX_MISMATCH' | 'CODEX_CAPABILITY_UNEXPECTED'>;
export interface CodexInitializeClaimsV1 { readonly schemaVersion: '1'; readonly externalSandbox: true; readonly approvalPolicy: 'never'; readonly capabilityIds: readonly string[]; }
export interface CodexThreadClaimsV1 { readonly schemaVersion: '1'; readonly ephemeral: true; readonly providerId: string; readonly modelId: string; readonly sandboxMode: 'workspace-write'; }
export interface CodexSessionClaimMapper { initialize(value: unknown): unknown; thread(value: unknown): unknown; }
export interface CodexSessionAttestationInput { readonly attemptId: string; readonly providerId: string; readonly modelId: string; readonly capabilityIds: readonly string[]; readonly mapper: CodexSessionClaimMapper; }
export class CodexSessionAttestationFault extends Error { constructor(readonly code: AttestationCode) { super(code); } }

export class CodexSessionAttestation {
  private readonly capabilities: readonly string[];
  constructor(private readonly input: CodexSessionAttestationInput) {
    if (![input.attemptId, input.providerId, input.modelId, ...input.capabilityIds].every(value => ID.test(value)) || new Set(input.capabilityIds).size !== input.capabilityIds.length || !ordered(input.capabilityIds)) throw new Error('Invalid Codex session attestation binding');
    this.capabilities = Object.freeze([...input.capabilityIds]);
  }
  verifyInitialize(raw: unknown): void { this.verify('initialize', () => { const value = this.input.mapper.initialize(raw);
    if (!record(value) || !exact(value, ['schemaVersion', 'externalSandbox', 'approvalPolicy', 'capabilityIds']) || value.schemaVersion !== '1' || !Array.isArray(value.capabilityIds) || !value.capabilityIds.every(item => typeof item === 'string' && ID.test(item)) || new Set(value.capabilityIds).size !== value.capabilityIds.length || !ordered(value.capabilityIds)) fault('CODEX_PROTOCOL_VIOLATION');
    if (value.externalSandbox !== true || value.approvalPolicy !== 'never') fault('CODEX_SANDBOX_MISMATCH');
    if (!same(value.capabilityIds, this.capabilities)) fault('CODEX_CAPABILITY_UNEXPECTED');
  }); }
  verifyThread(raw: unknown): void { this.verify('thread', () => { const value = this.input.mapper.thread(raw);
    if (!record(value) || !exact(value, ['schemaVersion', 'ephemeral', 'providerId', 'modelId', 'sandboxMode']) || value.schemaVersion !== '1' || typeof value.providerId !== 'string' || typeof value.modelId !== 'string') fault('CODEX_PROTOCOL_VIOLATION');
    if (value.ephemeral !== true || value.sandboxMode !== 'workspace-write') fault('CODEX_SANDBOX_MISMATCH');
    if (value.providerId !== this.input.providerId) fault('CODEX_PROVIDER_MISMATCH'); if (value.modelId !== this.input.modelId) fault('CODEX_MODEL_MISMATCH');
  }); }
  private verify(attestationClass: 'initialize' | 'thread', run: () => void): void {
    codexLog('protocol.attestation.started', { attemptId: this.input.attemptId, attestationClass });
    try { run(); codexLog('protocol.attestation.completed', { attemptId: this.input.attemptId, attestationClass }); }
    catch (error) { // observability-exempt: Normalized claim details and release-mapper errors are discarded; only the closed mismatch class is logged.
      const code = error instanceof CodexSessionAttestationFault ? error.code : 'CODEX_PROTOCOL_VIOLATION'; codexLog('protocol.attestation.failed', { attemptId: this.input.attemptId, attestationClass, safeCode: code }); throw new CodexSessionAttestationFault(code); }
  }
}
function fault(code: AttestationCode): never { throw new CodexSessionAttestationFault(code); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...fields].sort().join(','); }
function ordered(values: readonly string[]): boolean { return values.every((value, index) => index === 0 || values[index - 1]! < value); }
function same(left: readonly unknown[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
