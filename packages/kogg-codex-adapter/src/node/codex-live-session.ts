import type { Readable, Writable } from 'node:stream';
import type { CodexSafeCode } from '../common/codex-protocol';
import { codexLog } from './codex-logger';
import { CodexClientFault, CodexProtocolClient } from './codex-protocol-client';
import { CodexCredentialFault } from './codex-credential-reservation';
import type { CodexSafeObservation } from './codex-protocol-core';
import { CodexProtocolFault } from './codex-protocol-core';
import { CodexProcessHostFault } from './codex-process-host';
import { CodexSessionCleanupCoordinator, type CodexCleanupResult } from './codex-session-cleanup';
import { CodexStdioDrainer } from './codex-stdio-drainer';

// This attempt-local composition logs only opaque lifecycle correlations. Protocol params, content, credentials, stdio, and owner errors remain private.
// diagnostic-coverage: codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const MAX_START_MS = 60_000;
export interface CodexLiveSessionHost {
  readonly processId: string;
  start(): Promise<{ readonly stdin: Writable; readonly stdout: Readable; readonly stderr: Readable }>;
  terminateOwnedHost(): Promise<void>;
  enumerateResiduals(): Promise<number>;
}
export interface CodexLiveSessionInput {
  readonly attemptId: string; readonly operationId: string; readonly host: CodexLiveSessionHost;
  readonly createClient: (stdin: Writable, onObservation: (sequence: number, observation: CodexSafeObservation) => void) => CodexProtocolClient;
  readonly initializeParams: Readonly<Record<string, unknown>>; readonly initializedParams?: Readonly<Record<string, unknown>>;
  readonly threadParams: Readonly<Record<string, unknown>>; readonly turnParams: Readonly<Record<string, unknown>>;
  readonly activateCredentials: (processRegistrationId: string) => void | Promise<void>; readonly revokeCredentials: () => void | Promise<void>; readonly onObservation: (sequence: number, observation: CodexSafeObservation) => void;
  readonly onFault: (code: CodexSafeCode) => void | Promise<void>; readonly startTimeoutMs?: number; readonly cleanupTimeoutMs?: number; readonly resourceCount?: number;
}
export class CodexLiveSessionFault extends Error { constructor(readonly code: CodexSafeCode, readonly cleanup: CodexCleanupResult) { super(code); } }

export class CodexLiveSession {
  private client: CodexProtocolClient | undefined; private stdin: Writable | undefined; private draining: Promise<{ readonly stderrBytes: number; readonly faulted: boolean }> | undefined; private started = false;
  private readonly cleanupCoordinator: CodexSessionCleanupCoordinator;
  constructor(private readonly input: CodexLiveSessionInput) {
    validate(input); this.cleanupCoordinator = new CodexSessionCleanupCoordinator({ attemptId: input.attemptId, operationId: input.operationId, processId: input.host.processId, resourceCount: input.resourceCount ?? 5, stageTimeoutMs: input.cleanupTimeoutMs,
      boundary: { closeContentInput: () => this.client?.closeContentInput(), revokeCredentials: async () => input.revokeCredentials(), interruptTurn: () => this.interrupt(), settleProtocol: () => this.settleProtocol(), terminateOwnedHost: () => input.host.terminateOwnedHost(), enumerateResiduals: () => this.enumerate() } });
  }
  async start(): Promise<void> {
    if (this.started) throw new Error('Codex live session already started'); this.started = true; codexLog('session.start.requested', this.fields());
    try {
      await this.input.activateCredentials(this.input.host.processId); const stdio = await this.input.host.start(); this.stdin = stdio.stdin;
      let active!: () => void; const turnActive = new Promise<void>(resolve => { active = resolve; });
      this.client = this.input.createClient(stdio.stdin, (sequence, observation) => { if (observation.kind === 'notification' && observation.lifecycle === 'turn-started') active(); if (observation.kind === 'notification' && observation.lifecycle === 'turn-completed') this.cleanupCoordinator.observeTerminal('CODEX_OK'); this.input.onObservation(sequence, observation); });
      this.draining = new CodexStdioDrainer(this.client, async code => { this.cleanupCoordinator.observeTerminal(code); await this.safeFault(code); }).run(stdio.stdout, stdio.stderr);
      await this.client.request('initialize', this.input.initializeParams); await this.client.initialized(this.input.initializedParams); await this.client.request('thread/start', this.input.threadParams); await this.client.request('turn/start', this.input.turnParams); await bounded(turnActive, this.startTimeout());
      codexLog('session.start.completed', this.fields());
    } catch (error) { // observability-exempt: The closed session failure and cleanup result below discard protocol params, stdio, owner errors, and private response details.
      const code = codeOf(error); this.cleanupCoordinator.observeTerminal(code); codexLog('session.start.failed', { ...this.fields(), safeCode: code }); const cleanup = await this.cleanupCoordinator.cleanup('failure', this.turnActive()); await this.safeFault(cleanup.terminalCode); throw new CodexLiveSessionFault(cleanup.terminalCode, cleanup);
    }
  }
  cleanup(): Promise<CodexCleanupResult> { return this.cleanupCoordinator.cleanup('terminal', this.turnActive()); }
  cancel(): Promise<CodexCleanupResult> { return this.cleanupCoordinator.cleanup('cancel', this.turnActive()); }
  timeout(): Promise<CodexCleanupResult> { return this.cleanupCoordinator.cleanup('timeout', this.turnActive()); }
  private turnActive(): boolean { return ['turn-starting', 'turn-active', 'interrupting'].includes(this.client?.phase() ?? ''); }
  private async interrupt(): Promise<void> { if (this.client && this.turnActive() && !this.client.faulted()) await this.client.request('turn/interrupt', {}); }
  private async settleProtocol(): Promise<void> {
    if (!this.client || !this.stdin) return;
    try { this.client.beginCleanup(); await this.client.drainContent(); if (!this.client.faulted()) await this.client.request('shutdown', {}); }
    finally { this.stdin.end(); }
  }
  private async enumerate(): Promise<number> { if (this.draining) await this.draining; return this.input.host.enumerateResiduals(); }
  private async safeFault(code: CodexSafeCode): Promise<void> { try { await this.input.onFault(code); } catch { // observability-exempt: The closed fault has already been classified; callback errors cannot prevent cleanup.
      return; } }
  private fields(): { attemptId: string; operationId: string; processId: string } { return { attemptId: this.input.attemptId, operationId: this.input.operationId, processId: this.input.host.processId }; }
  private startTimeout(): number { return this.input.startTimeoutMs ?? MAX_START_MS; }
}
function validate(input: CodexLiveSessionInput): void { for (const id of [input.attemptId, input.operationId, input.host.processId]) if (!id || id.length > 128) throw new Error('Invalid live session correlation'); const timeout = input.startTimeoutMs ?? MAX_START_MS; if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_START_MS) throw new Error('Invalid live session timeout'); }
function codeOf(error: unknown): CodexSafeCode { return error instanceof StartTimeout ? 'CODEX_FIRST_ACTIVITY_TIMEOUT' : error instanceof CodexClientFault || error instanceof CodexCredentialFault || error instanceof CodexProtocolFault || error instanceof CodexProcessHostFault ? error.code : 'CODEX_INTERNAL_FAILURE'; }
class StartTimeout extends Error {}
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new StartTimeout()), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
