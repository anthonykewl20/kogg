import type { Readable, Writable } from 'node:stream';
import type { CodexSafeCode } from '../common/codex-protocol';
import { codexLog } from './codex-logger';
import { CodexClientFault, CodexProtocolClient } from './codex-protocol-client';
import { CodexCredentialFault } from './codex-credential-reservation';
import type { CodexSafeObservation } from './codex-protocol-core';
import { CodexProtocolFault } from './codex-protocol-core';
import { CodexProcessHostFault } from './codex-process-host';
import { CodexSessionAttestation, CodexSessionAttestationFault } from './codex-session-attestation';
import { CodexSessionCleanupCoordinator, type CodexCleanupResult } from './codex-session-cleanup';
import { CodexStdioDrainer } from './codex-stdio-drainer';

// This attempt-local composition logs only opaque lifecycle correlations. Protocol params, content, credentials, stdio, and owner errors remain private.
// diagnostic-coverage: codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const MAX_START_MS = 60_000; const MAX_HANDSHAKE_MS = 30_000; const MAX_INTERRUPT_MS = 10_000;
export interface CodexLiveSessionHost {
  readonly processId: string;
  start(): Promise<{ readonly stdin: Writable; readonly stdout: Readable; readonly stderr: Readable }>;
  revokeCredentials(): Promise<void>;
  terminateOwnedHost(): Promise<void>;
  enumerateResiduals(): Promise<number>;
}
export interface CodexLiveSessionInput {
  readonly attemptId: string; readonly operationId: string; readonly host: CodexLiveSessionHost;
  readonly createClient: (stdin: Writable, onObservation: (sequence: number, observation: CodexSafeObservation) => void) => CodexProtocolClient;
  readonly initializeParams: Readonly<Record<string, unknown>>; readonly initializedParams?: Readonly<Record<string, unknown>>;
  readonly threadParams: Readonly<Record<string, unknown>>; readonly turnParams: Readonly<Record<string, unknown>>;
  readonly attestation: CodexSessionAttestation;
  readonly onObservation: (sequence: number, observation: CodexSafeObservation) => void;
  readonly onFault: (code: CodexSafeCode) => void | Promise<void>; readonly initializeTimeoutMs?: number; readonly threadTimeoutMs?: number; readonly startTimeoutMs?: number; readonly interruptTimeoutMs?: number; readonly cleanupTimeoutMs?: number; readonly resourceCount?: number;
}
export class CodexLiveSessionFault extends Error { constructor(readonly code: CodexSafeCode, readonly cleanup: CodexCleanupResult) { super(code); } }

export class CodexLiveSession {
  private client: CodexProtocolClient | undefined; private stdin: Writable | undefined; private draining: Promise<{ readonly stderrBytes: number; readonly faulted: boolean }> | undefined; private started = false;
  private readonly cleanupCoordinator: CodexSessionCleanupCoordinator;
  constructor(private readonly input: CodexLiveSessionInput) {
    validate(input); this.cleanupCoordinator = new CodexSessionCleanupCoordinator({ attemptId: input.attemptId, operationId: input.operationId, processId: input.host.processId, resourceCount: input.resourceCount ?? 5, stageTimeoutMs: input.cleanupTimeoutMs,
      boundary: { closeContentInput: () => this.client?.closeContentInput(), revokeCredentials: () => input.host.revokeCredentials(), interruptTurn: () => this.interrupt(), settleProtocol: () => this.settleProtocol(), terminateOwnedHost: () => input.host.terminateOwnedHost(), enumerateResiduals: () => this.enumerate() } });
  }
  async start(): Promise<void> {
    if (this.started) throw new Error('Codex live session already started'); this.started = true; codexLog('session.start.requested', this.fields());
    try {
      const stdio = await this.input.host.start(); this.stdin = stdio.stdin;
      let active!: () => void; const turnActive = new Promise<void>(resolve => { active = resolve; });
      this.client = this.input.createClient(stdio.stdin, (sequence, observation) => { if (observation.kind === 'notification' && observation.lifecycle === 'turn-started') active(); if (observation.kind === 'notification' && observation.lifecycle === 'turn-completed') this.cleanupCoordinator.observeTerminal('CODEX_OK'); this.input.onObservation(sequence, observation); });
      this.draining = new CodexStdioDrainer(this.client, async code => { this.cleanupCoordinator.observeTerminal(code); await this.safeFault(code); }).run(stdio.stdout, stdio.stderr);
      const initialized = await bounded(this.client.request('initialize', this.input.initializeParams), this.initializeTimeout(), 'CODEX_INITIALIZE_TIMEOUT'); this.input.attestation.verifyInitialize(initialized); await this.client.initialized(this.input.initializedParams); const thread = await bounded(this.client.request('thread/start', this.input.threadParams), this.threadTimeout(), 'CODEX_THREAD_START_TIMEOUT'); this.input.attestation.verifyThread(thread); await this.client.request('turn/start', this.input.turnParams); await bounded(turnActive, this.startTimeout(), 'CODEX_FIRST_ACTIVITY_TIMEOUT');
      codexLog('session.start.completed', this.fields());
    } catch (error) { // observability-exempt: The closed session failure and cleanup result below discard protocol params, stdio, owner errors, and private response details.
      const code = codeOf(error); this.cleanupCoordinator.observeTerminal(code); if (error instanceof SessionPhaseTimeout) codexLog('timeout.expired', { attemptId: this.input.attemptId, deadlineClass: error.deadlineClass, generation: 1, configuredMs: error.configuredMs }); codexLog('session.start.failed', { ...this.fields(), safeCode: code }); const cleanup = await this.cleanupCoordinator.cleanup('failure', this.turnActive()); await this.safeFault(cleanup.terminalCode); throw new CodexLiveSessionFault(cleanup.terminalCode, cleanup);
    }
  }
  cleanup(): Promise<CodexCleanupResult> { return this.cleanupCoordinator.cleanup('terminal', this.turnActive()); }
  cancel(): Promise<CodexCleanupResult> { return this.cleanupCoordinator.cleanup('cancel', this.turnActive()); }
  timeout(): Promise<CodexCleanupResult> { return this.cleanupCoordinator.cleanup('timeout', this.turnActive()); }
  private turnActive(): boolean { return ['turn-starting', 'turn-active', 'interrupting'].includes(this.client?.phase() ?? ''); }
  private async interrupt(): Promise<void> { if (this.client && this.turnActive() && !this.client.faulted()) try { await bounded(this.client.request('turn/interrupt', {}), this.interruptTimeout(), 'CODEX_INTERRUPT_TIMEOUT'); } catch (error) { if (!(error instanceof SessionPhaseTimeout) || error.code !== 'CODEX_INTERRUPT_TIMEOUT') throw error; codexLog('timeout.expired', { attemptId: this.input.attemptId, deadlineClass: 'interrupt', generation: 1, configuredMs: error.configuredMs }); codexLog('cancel.escalated', { ...this.fields(), safeCode: error.code }); } }
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
  private initializeTimeout(): number { return this.input.initializeTimeoutMs ?? MAX_HANDSHAKE_MS; }
  private threadTimeout(): number { return this.input.threadTimeoutMs ?? MAX_HANDSHAKE_MS; }
  private interruptTimeout(): number { return this.input.interruptTimeoutMs ?? MAX_INTERRUPT_MS; }
}
function validate(input: CodexLiveSessionInput): void { for (const id of [input.attemptId, input.operationId, input.host.processId]) if (!id || id.length > 128) throw new Error('Invalid live session correlation'); const deadlines: ReadonlyArray<readonly [number, number]> = [[input.initializeTimeoutMs ?? MAX_HANDSHAKE_MS, MAX_HANDSHAKE_MS], [input.threadTimeoutMs ?? MAX_HANDSHAKE_MS, MAX_HANDSHAKE_MS], [input.startTimeoutMs ?? MAX_START_MS, MAX_START_MS], [input.interruptTimeoutMs ?? MAX_INTERRUPT_MS, MAX_INTERRUPT_MS]]; for (const [timeout, maximum] of deadlines) if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximum) throw new Error('Invalid live session timeout'); }
function codeOf(error: unknown): CodexSafeCode { return error instanceof SessionPhaseTimeout ? error.code : error instanceof CodexClientFault || error instanceof CodexCredentialFault || error instanceof CodexProtocolFault || error instanceof CodexProcessHostFault || error instanceof CodexSessionAttestationFault ? error.code : 'CODEX_INTERNAL_FAILURE'; }
class SessionPhaseTimeout extends Error { constructor(readonly code: Extract<CodexSafeCode, 'CODEX_INITIALIZE_TIMEOUT' | 'CODEX_THREAD_START_TIMEOUT' | 'CODEX_FIRST_ACTIVITY_TIMEOUT' | 'CODEX_INTERRUPT_TIMEOUT'>, readonly deadlineClass: 'initialize' | 'thread-start' | 'first-activity' | 'interrupt', readonly configuredMs: number) { super(code); } }
async function bounded<T>(promise: Promise<T>, timeoutMs: number, code: SessionPhaseTimeout['code']): Promise<T> { let timer: NodeJS.Timeout | undefined; const deadlineClass = code === 'CODEX_INITIALIZE_TIMEOUT' ? 'initialize' : code === 'CODEX_THREAD_START_TIMEOUT' ? 'thread-start' : code === 'CODEX_INTERRUPT_TIMEOUT' ? 'interrupt' : 'first-activity'; try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new SessionPhaseTimeout(code, deadlineClass, timeoutMs)), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
