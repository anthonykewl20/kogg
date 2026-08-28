import type { Readable, Writable } from 'node:stream';
import type { OperationLease, ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import type { CodexSafeCode } from '../common/codex-protocol';
import { codexLog } from './codex-logger';

// The qualified owner receives only an opaque process-registration ID. Paths, argv, environment, and scope internals never cross this seam or enter logs.
// diagnostic-coverage: codex.confinement, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const MAX_SPAWN_MS = 20_000; const MAX_CLEANUP_MS = 10_000;
export interface CodexOwnedHost {
  readonly pid: number; readonly identityVerified: boolean; readonly stdin: Writable; readonly stdout: Readable; readonly stderr: Readable;
  readonly closed: Promise<{ readonly exitClass: 'zero' | 'nonzero' | 'signal' }>;
}
export interface QualifiedCodexExecutionOwner {
  spawn(input: { readonly processRegistrationId: string }): Promise<CodexOwnedHost>;
  terminate(processRegistrationId: string): Promise<void>;
  enumerateResiduals(processRegistrationId: string): Promise<number>;
}
export interface CodexProcessHostInput {
  readonly attemptId: string; readonly operation: OperationLease; readonly owner: QualifiedCodexExecutionOwner;
  readonly onFault: (code: 'CODEX_HOST_EXITED') => void | Promise<void>; readonly spawnTimeoutMs?: number; readonly cleanupTimeoutMs?: number;
}
export class CodexProcessHostFault extends Error { constructor(readonly code: CodexSafeCode) { super(code); } }

export class CodexProcessHost {
  private exitMonitor: Promise<void> | undefined; private expectedExit = false; private cleaned = false; private started = false;
  private constructor(private readonly input: CodexProcessHostInput, private readonly process: ProcessLease) {}
  static register(input: CodexProcessHostInput): CodexProcessHost {
    validate(input); let processId: string | undefined;
    try {
      const process = input.operation.registerProcess({ kind: 'provider-cli', owner: 'kogg-supervisor', cancel: async () => { if (processId) await input.owner.terminate(processId); } }); processId = process.id;
      codexLog('process.registered', { attemptId: input.attemptId, operationId: input.operation.id, processId, ownerKind: 'kogg-supervisor' }); return new CodexProcessHost(input, process);
    } catch { // observability-exempt: The closed failure below discards registry details and no spawn can have been requested.
      codexLog('process.registration.failed', { attemptId: input.attemptId, operationId: input.operation.id, safeCode: 'CODEX_PROCESS_REGISTRATION_FAILED' }); throw new CodexProcessHostFault('CODEX_PROCESS_REGISTRATION_FAILED');
    }
  }
  get processId(): string { return this.process.id; }
  async start(): Promise<Pick<CodexOwnedHost, 'stdin' | 'stdout' | 'stderr'>> {
    if (this.started) throw new CodexProcessHostFault('CODEX_PROCESS_START_FAILED'); this.started = true;
    codexLog('host.start.requested', this.fields()); this.process.spawning();
    try {
      const host = await bounded(this.input.owner.spawn({ processRegistrationId: this.process.id }), this.spawnTimeout()); if (!validHost(host)) throw new CodexProcessHostFault('CODEX_CONFINEMENT_UNVERIFIED');
      this.process.started(host.pid); this.process.ready(); codexLog('host.start.completed', this.fields()); this.exitMonitor = this.monitor(host); return { stdin: host.stdin, stdout: host.stdout, stderr: host.stderr };
    } catch (error) { // observability-exempt: failStart emits the closed code and performs mandatory termination/enumeration without exposing spawn details.
      const code = error instanceof HostTimeout ? 'CODEX_SPAWN_TIMEOUT' : error instanceof CodexProcessHostFault ? error.code : 'CODEX_PROCESS_START_FAILED'; if (error instanceof HostTimeout) codexLog('timeout.expired', { attemptId: this.input.attemptId, deadlineClass: 'spawn', generation: 1, configuredMs: this.spawnTimeout() }); throw await this.failStart(code);
    }
  }
  async terminateOwnedHost(): Promise<void> { this.expectedExit = true; await bounded(this.input.owner.terminate(this.process.id), this.cleanupTimeout()); if (this.exitMonitor) await bounded(this.exitMonitor, this.cleanupTimeout()); }
  async enumerateResiduals(): Promise<number> {
    const count = await bounded(this.input.owner.enumerateResiduals(this.process.id), this.cleanupTimeout()); if (!Number.isSafeInteger(count) || count < 0) throw new CodexProcessHostFault('CODEX_CLEANUP_FAILED');
    if (count === 0 && !this.cleaned) { this.process.cleanup(); this.cleaned = true; } return count;
  }
  private async monitor(host: CodexOwnedHost): Promise<void> {
    let exitClass: 'zero' | 'nonzero' | 'signal'; try { ({ exitClass } = await host.closed); } catch { // observability-exempt: A rejected close observation is safely classified as signal; external enumeration remains authoritative.
      exitClass = 'signal'; }
    this.process.exited(exitClass); codexLog('host.exited', { ...this.fields(), exitClass });
    if (!this.expectedExit) { codexLog('host.failed', { ...this.fields(), safeCode: 'CODEX_HOST_EXITED' }); try { await this.input.onFault('CODEX_HOST_EXITED'); } catch { // observability-exempt: The attempt owner already received the closed fault and cleanup remains mandatory.
        return; } }
  }
  private async failStart(code: CodexSafeCode): Promise<CodexProcessHostFault> {
    this.process.failed('PROCESS_SPAWN_FAILED', 'CodexProcessHostFault'); codexLog('host.failed', { ...this.fields(), safeCode: code });
    try { this.expectedExit = true; await bounded(this.input.owner.terminate(this.process.id), this.cleanupTimeout()); const residuals = await bounded(this.input.owner.enumerateResiduals(this.process.id), this.cleanupTimeout()); if (residuals !== 0) return new CodexProcessHostFault('CODEX_CLEANUP_FAILED'); this.process.cleanup(); this.cleaned = true; return new CodexProcessHostFault(code); }
    catch { // observability-exempt: Start-failure cleanup errors normalize to CODEX_CLEANUP_FAILED without logging owner identities or raw errors.
      return new CodexProcessHostFault('CODEX_CLEANUP_FAILED'); }
  }
  private fields(): { attemptId: string; operationId: string; processId: string } { return { attemptId: this.input.attemptId, operationId: this.input.operation.id, processId: this.process.id }; }
  private spawnTimeout(): number { return this.input.spawnTimeoutMs ?? MAX_SPAWN_MS; } private cleanupTimeout(): number { return this.input.cleanupTimeoutMs ?? MAX_CLEANUP_MS; }
}
function validate(input: CodexProcessHostInput): void {
  if (!input.attemptId || input.attemptId.length > 128 || !input.operation.id || input.operation.id.length > 128) throw new Error('Invalid process host correlation');
  const spawn = input.spawnTimeoutMs ?? MAX_SPAWN_MS; const cleanup = input.cleanupTimeoutMs ?? MAX_CLEANUP_MS; if (!Number.isSafeInteger(spawn) || spawn < 1 || spawn > MAX_SPAWN_MS || !Number.isSafeInteger(cleanup) || cleanup < 1 || cleanup > MAX_CLEANUP_MS) throw new Error('Invalid process host timeout');
}
function validHost(host: CodexOwnedHost): boolean { return Number.isSafeInteger(host.pid) && host.pid > 0 && host.identityVerified === true && Boolean(host.stdin) && Boolean(host.stdout) && Boolean(host.stderr) && typeof host.closed?.then === 'function'; }
class HostTimeout extends Error {}
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new HostTimeout()), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
