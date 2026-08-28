import type { Readable, Writable } from 'node:stream';
import type { OperationLease, ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import type { CodexSafeCode, GovernedCodexAttemptV1 } from '../common/codex-protocol';
import { CodexCredentialFault, CodexCredentialReservation } from './codex-credential-reservation';
import { codexLog } from './codex-logger';
import type { QualifiedCodexRuntimeV1 } from './codex-release-registry';

// The qualified owner retains OS scope and process handles. Kogg receives only exact opaque identity digests, bounded stdio, and aggregate inventory; never argv, environment, paths, credentials, or owner errors.
// diagnostic-coverage: codex.confinement, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const MAX_SPAWN_MS = 20_000; const MAX_CLEANUP_MS = 10_000; const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u; const SHA256 = /^[0-9a-f]{64}$/u;
export interface CodexProcessReservationV1 {
  readonly schemaVersion: '1'; readonly attemptId: string; readonly authorityDigest: string; readonly taskRevisionDigest: string; readonly repositoryBindingDigest: string;
  readonly privateRepoObjectId: string | null; readonly worktreePolicy: GovernedCodexAttemptV1['worktreePolicy']; readonly releaseId: string; readonly target: GovernedCodexAttemptV1['target'];
  readonly binarySha256: string; readonly linuxHelperSha256: string; readonly qualificationProfileId: string; readonly spawnDeadlineMs: number; readonly cleanupDeadlineMs: number;
}
export interface CodexProcessIdentityV1 { readonly processRegistrationId: string; readonly cgroupIdentityDigest: string; }
export interface CodexOwnedHost {
  readonly pid: number; readonly processRegistrationId: string; readonly cgroupIdentityDigest: string; readonly startTimeTokenDigest: string; readonly identityVerified: boolean;
  readonly stdin: Writable; readonly stdout: Readable; readonly stderr: Readable; readonly closed: Promise<{ readonly exitClass: 'zero' | 'nonzero' | 'signal' }>;
}
export interface QualifiedCodexExecutionOwner {
  prepare(input: { readonly binding: CodexProcessReservationV1; readonly processRegistrationId: string }): Promise<CodexProcessIdentityV1>;
  spawn(identity: CodexProcessIdentityV1): Promise<CodexOwnedHost>;
  terminate(input: { readonly processRegistrationId: string; readonly identity?: CodexProcessIdentityV1 }): Promise<void>;
  enumerateResiduals(input: { readonly processRegistrationId: string; readonly identity?: CodexProcessIdentityV1 }): Promise<number>;
}
export interface CodexProcessHostInput {
  readonly attempt: GovernedCodexAttemptV1; readonly runtime: QualifiedCodexRuntimeV1; readonly operation: OperationLease; readonly credentials: CodexCredentialReservation; readonly owner: QualifiedCodexExecutionOwner;
  readonly spawnTimeoutMs?: number; readonly cleanupTimeoutMs?: number;
}
export class CodexProcessHostFault extends Error { constructor(readonly code: CodexSafeCode) { super(code); } }

export class CodexProcessHostGate {
  private host: CodexProcessHost | undefined; private armed = false; private registered = false; private cleaning: Promise<{ readonly residualCount: number }> | undefined;
  constructor(private readonly input: CodexProcessHostInput) {}
  arm(): void { if (this.armed || this.registered || this.cleaning) throw new CodexProcessHostFault('CODEX_PROCESS_REGISTRATION_FAILED'); this.armed = true; }
  register(): CodexProcessHost { if (!this.armed || this.registered || this.cleaning) throw new CodexProcessHostFault('CODEX_PROCESS_REGISTRATION_FAILED'); this.registered = true; return this.host = CodexProcessHost.register(this.input); }
  cleanup(): Promise<{ readonly residualCount: number }> { return this.cleaning ??= this.cleanupOnce(); }
  private async cleanupOnce(): Promise<{ readonly residualCount: number }> { if (!this.host) { this.input.credentials.abandon(); return { residualCount: 0 }; } await this.host.terminateOwnedHost(); return { residualCount: await this.host.enumerateResiduals() }; }
}

export class CodexProcessHost {
  private exitMonitor: Promise<void> | undefined; private expectedExit = false; private cleaned = false; private logicalFailure = false; private started = false; private identity: CodexProcessIdentityV1 | undefined; private terminating: Promise<void> | undefined; private onFault: ((code: 'CODEX_HOST_EXITED') => void | Promise<void>) | undefined;
  readonly binding: CodexProcessReservationV1;
  private constructor(private readonly input: CodexProcessHostInput, private readonly process: ProcessLease) { this.binding = processBinding(input.attempt, input.runtime); }
  static register(input: CodexProcessHostInput): CodexProcessHost {
    validate(input); let result: CodexProcessHost | undefined;
    try {
      const process = input.operation.registerProcess({ kind: 'provider-cli', owner: 'kogg-supervisor', cancel: async () => { if (result) await result.terminateOwnedHost(); } }); result = new CodexProcessHost(input, process);
      codexLog('process.registered', { attemptId: input.attempt.attemptId, operationId: input.operation.id, processId: process.id, ownerKind: 'kogg-supervisor' }); return result;
    } catch { // observability-exempt: The closed failure below discards registry details and no scope preparation or spawn can have been requested.
      input.credentials.abandon(); codexLog('process.registration.failed', { attemptId: input.attempt.attemptId, operationId: input.operation.id, safeCode: 'CODEX_PROCESS_REGISTRATION_FAILED' }); throw new CodexProcessHostFault('CODEX_PROCESS_REGISTRATION_FAILED');
    }
  }
  get processId(): string { return this.process.id; }
  start(onFault: (code: 'CODEX_HOST_EXITED') => void | Promise<void>): Promise<Pick<CodexOwnedHost, 'stdin' | 'stdout' | 'stderr'>> {
    if (this.started || typeof onFault !== 'function') return Promise.reject(new CodexProcessHostFault('CODEX_PROCESS_START_FAILED')); this.started = true; this.onFault = onFault; return this.startOnce();
  }
  revokeCredentials(): Promise<void> { return this.input.credentials.revoke(); }
  terminateOwnedHost(): Promise<void> { return this.terminating ??= this.terminateOnce(); }
  async enumerateResiduals(): Promise<number> {
    const count = await bounded(this.input.owner.enumerateResiduals(this.ownerIdentity()), this.cleanupTimeout()); if (!Number.isSafeInteger(count) || count < 0) throw new CodexProcessHostFault('CODEX_CLEANUP_FAILED');
    if (count === 0 && !this.cleaned && !this.logicalFailure) { try { this.process.cleanup(); this.cleaned = true; } catch { // observability-exempt: The logical registry error is discarded behind the closed cleanup failure after external zero-residual proof.
        this.logicalFailure = true; this.markLogicalFailed('PROCESS_SIGNALLED'); } } if (this.logicalFailure) throw new CodexProcessHostFault('CODEX_CLEANUP_FAILED'); return count;
  }
  private async startOnce(): Promise<Pick<CodexOwnedHost, 'stdin' | 'stdout' | 'stderr'>> {
    codexLog('host.start.requested', this.fields());
    try {
      this.process.spawning();
      const identity = await bounded(this.input.owner.prepare({ binding: this.binding, processRegistrationId: this.process.id }), this.spawnTimeout()); if (!validIdentity(identity, this.process.id)) throw new CodexProcessHostFault('CODEX_CONFINEMENT_UNVERIFIED'); this.identity = Object.freeze({ ...identity });
      await this.input.credentials.reserve(); await this.input.credentials.activate(identity.processRegistrationId, identity.cgroupIdentityDigest);
      const host = await bounded(this.input.owner.spawn(identity), this.spawnTimeout()); if (!validHost(host, identity)) throw new CodexProcessHostFault('CODEX_CONFINEMENT_UNVERIFIED');
      this.process.started(host.pid); this.process.ready(); codexLog('host.start.completed', this.fields()); this.exitMonitor = this.monitor(host); return { stdin: host.stdin, stdout: host.stdout, stderr: host.stderr };
    } catch (error) { // observability-exempt: failStart emits the closed code and performs mandatory revoke/termination/enumeration without exposing owner, process, or credential details.
      const code = error instanceof HostTimeout ? 'CODEX_SPAWN_TIMEOUT' : error instanceof CodexCredentialFault ? error.code : error instanceof CodexProcessHostFault ? error.code : 'CODEX_PROCESS_START_FAILED'; if (error instanceof HostTimeout) codexLog('timeout.expired', { attemptId: this.input.attempt.attemptId, deadlineClass: 'spawn', generation: 1, configuredMs: this.spawnTimeout() }); throw await this.failStart(code);
    }
  }
  private async terminateOnce(): Promise<void> { this.expectedExit = true; let failure: unknown; try { await this.revokeCredentials(); } catch (error) { /* observability-exempt: Credential revocation emitted its closed failure; owned process termination remains mandatory. */ failure = error; } try { await bounded(this.input.owner.terminate(this.ownerIdentity()), this.cleanupTimeout()); if (this.exitMonitor) await bounded(this.exitMonitor, this.cleanupTimeout()); } catch (error) { /* observability-exempt: Owner errors are discarded behind the closed cleanup failure after revocation was attempted. */ failure ??= error; } if (failure) throw new CodexProcessHostFault('CODEX_CLEANUP_FAILED'); }
  private async monitor(host: CodexOwnedHost): Promise<void> {
    let exitClass: 'zero' | 'nonzero' | 'signal'; try { ({ exitClass } = await host.closed); } catch { // observability-exempt: A rejected close observation is safely classified as signal; external enumeration remains authoritative.
      exitClass = 'signal'; }
    try { this.process.exited(exitClass); } catch { // observability-exempt: External exit remains known, but the logical registry refusal is retained as a closed cleanup failure.
      this.logicalFailure = true; this.markLogicalFailed('PROCESS_SIGNALLED'); } codexLog('host.exited', { ...this.fields(), exitClass });
    if (!this.expectedExit) { codexLog('host.failed', { ...this.fields(), safeCode: 'CODEX_HOST_EXITED' }); try { await this.onFault?.('CODEX_HOST_EXITED'); } catch { // observability-exempt: The attempt owner already received the closed fault and cleanup remains mandatory.
        return; } }
  }
  private async failStart(code: CodexSafeCode): Promise<CodexProcessHostFault> {
    this.markLogicalFailed('PROCESS_SPAWN_FAILED'); codexLog('host.failed', { ...this.fields(), safeCode: code }); let cleanupFailed = false;
    try { await this.input.credentials.revoke(); } catch { /* observability-exempt: Credential revocation emitted its closed failure; process cleanup continues. */ cleanupFailed = true; }
    try { this.expectedExit = true; await bounded(this.input.owner.terminate(this.ownerIdentity()), this.cleanupTimeout()); const residuals = await bounded(this.input.owner.enumerateResiduals(this.ownerIdentity()), this.cleanupTimeout()); if (residuals !== 0) cleanupFailed = true; }
    catch { // observability-exempt: Start-failure cleanup errors normalize to CODEX_CLEANUP_FAILED without logging identities or raw errors.
      cleanupFailed = true; }
    if (!cleanupFailed) { try { this.process.cleanup(); this.cleaned = true; } catch { // observability-exempt: External cleanup succeeded but logical cleanup refusal must remain a closed cleanup failure.
        cleanupFailed = true; this.logicalFailure = true; this.markLogicalFailed('PROCESS_SIGNALLED'); } } if (cleanupFailed) return new CodexProcessHostFault('CODEX_CLEANUP_FAILED'); return new CodexProcessHostFault(code);
  }
  private markLogicalFailed(code: 'PROCESS_SIGNALLED' | 'PROCESS_SPAWN_FAILED'): void { try { this.process.failed(code, 'CodexProcessHostFault'); } catch { // observability-exempt: The adapter safe code remains authoritative when the logical registry refuses its failure transition.
      return; } }
  private ownerIdentity(): { readonly processRegistrationId: string; readonly identity?: CodexProcessIdentityV1 } { return { processRegistrationId: this.process.id, ...(this.identity ? { identity: this.identity } : {}) }; }
  private fields(): { attemptId: string; operationId: string; processId: string } { return { attemptId: this.input.attempt.attemptId, operationId: this.input.operation.id, processId: this.process.id }; }
  private spawnTimeout(): number { return this.input.spawnTimeoutMs ?? this.input.attempt.deadlines.spawnMs; } private cleanupTimeout(): number { return this.input.cleanupTimeoutMs ?? this.input.attempt.deadlines.cleanupMs; }
}
function processBinding(attempt: GovernedCodexAttemptV1, runtime: QualifiedCodexRuntimeV1): CodexProcessReservationV1 { return Object.freeze({ schemaVersion: '1', attemptId: attempt.attemptId, authorityDigest: attempt.authorityDigest, taskRevisionDigest: attempt.taskRevisionDigest, repositoryBindingDigest: attempt.repositoryBindingDigest, privateRepoObjectId: attempt.privateRepoObjectId, worktreePolicy: attempt.worktreePolicy, releaseId: attempt.releaseId, target: attempt.target, binarySha256: runtime.release.binarySha256, linuxHelperSha256: runtime.release.linuxHelperSha256, qualificationProfileId: attempt.qualificationProfileId, spawnDeadlineMs: attempt.deadlines.spawnMs, cleanupDeadlineMs: attempt.deadlines.cleanupMs }); }
function validate(input: CodexProcessHostInput): void { if (!input.attempt.attemptId || input.attempt.releaseId !== input.runtime.release.releaseId || input.attempt.target !== input.runtime.release.target || input.attempt.qualificationProfileId !== input.runtime.release.qualificationProfileId || !input.operation.id || input.operation.id.length > 128) throw new Error('Invalid process host authority'); const spawn = input.spawnTimeoutMs ?? input.attempt.deadlines.spawnMs; const cleanup = input.cleanupTimeoutMs ?? input.attempt.deadlines.cleanupMs; if (!Number.isSafeInteger(spawn) || spawn < 1 || spawn > MAX_SPAWN_MS || !Number.isSafeInteger(cleanup) || cleanup < 1 || cleanup > MAX_CLEANUP_MS) throw new Error('Invalid process host timeout'); }
function validIdentity(value: CodexProcessIdentityV1, processId: string): boolean { return Boolean(value) && Object.keys(value).sort().join(',') === ['cgroupIdentityDigest','processRegistrationId'].sort().join(',') && value.processRegistrationId === processId && ID.test(value.processRegistrationId) && SHA256.test(value.cgroupIdentityDigest); }
function validHost(host: CodexOwnedHost, identity: CodexProcessIdentityV1): boolean { return Boolean(host) && Number.isSafeInteger(host.pid) && host.pid > 0 && host.identityVerified === true && host.processRegistrationId === identity.processRegistrationId && host.cgroupIdentityDigest === identity.cgroupIdentityDigest && SHA256.test(host.startTimeTokenDigest) && Boolean(host.stdin) && Boolean(host.stdout) && Boolean(host.stderr) && typeof host.closed?.then === 'function'; }
class HostTimeout extends Error {}
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HostTimeout()), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
