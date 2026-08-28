import type { CodexSafeCode } from '../common/codex-protocol';
import { codexLog } from './codex-logger';

// Cleanup logs use [kogg:agents:codex-supervision] with opaque correlations and resource counts only.
// diagnostic-coverage: codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const MAXIMUM_STAGE_TIMEOUT_MS = 10_000;
export type CodexTerminalCode = CodexSafeCode;
export interface CodexCleanupBoundary {
  closeContentInput(): void;
  revokeCredentials(): Promise<void>;
  interruptTurn(): Promise<void>;
  settleProtocol(): Promise<void>;
  terminateOwnedHost(): Promise<void>;
  enumerateResiduals(): Promise<number>;
}
export interface CodexCleanupResult { readonly terminalCode: CodexSafeCode; readonly residualCount: number; readonly cleaned: boolean; }
export interface CodexSessionCleanupInput {
  readonly attemptId: string; readonly operationId: string; readonly processId: string; readonly resourceCount: number;
  readonly boundary: CodexCleanupBoundary; readonly stageTimeoutMs?: number;
}

export class CodexSessionCleanupCoordinator {
  private terminal: CodexTerminalCode | undefined; private running: Promise<CodexCleanupResult> | undefined;
  constructor(private readonly input: CodexSessionCleanupInput) {
    for (const id of [input.attemptId, input.operationId, input.processId]) if (!id || id.length > 128) throw new Error('Invalid cleanup correlation');
    if (!Number.isSafeInteger(input.resourceCount) || input.resourceCount < 0) throw new Error('Invalid cleanup resource count');
    const timeout = input.stageTimeoutMs ?? MAXIMUM_STAGE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAXIMUM_STAGE_TIMEOUT_MS) throw new Error('Invalid cleanup stage timeout');
  }
  observeTerminal(code: CodexTerminalCode): CodexTerminalCode { return this.terminal ??= code; }
  cleanup(trigger: 'terminal' | 'cancel' | 'timeout' | 'failure', turnActive: boolean): Promise<CodexCleanupResult> {
    if (trigger === 'cancel') this.observeTerminal('CODEX_CANCELLED'); else if (trigger === 'timeout') this.observeTerminal('CODEX_ABSOLUTE_TIMEOUT');
    return this.running ??= this.run(trigger !== 'terminal' && turnActive);
  }
  private async run(interrupt: boolean): Promise<CodexCleanupResult> {
    const fields = { attemptId: this.input.attemptId, operationId: this.input.operationId, processId: this.input.processId, resourceCount: this.input.resourceCount };
    codexLog('cleanup.started', fields); let failed = false; let timedOut = false; let residualCount = this.input.resourceCount;
    try { this.input.boundary.closeContentInput(); } catch { // observability-exempt: Cleanup continues through host termination and residual enumeration, then emits one closed aggregate cleanup failure without raw error details.
      failed = true; }
    ({ failed, timedOut } = await this.stage(() => this.input.boundary.revokeCredentials(), failed, timedOut));
    if (interrupt) ({ failed, timedOut } = await this.stage(() => this.input.boundary.interruptTurn(), failed, timedOut));
    ({ failed, timedOut } = await this.stage(() => this.input.boundary.settleProtocol(), failed, timedOut));
    ({ failed, timedOut } = await this.stage(() => this.input.boundary.terminateOwnedHost(), failed, timedOut));
    try {
      const value = await bounded(this.input.boundary.enumerateResiduals(), this.timeout());
      if (!Number.isSafeInteger(value) || value < 0) failed = true; else residualCount = value;
    } catch (error) { // observability-exempt: Residual inspection failure is retained for the closed aggregate cleanup failure below; inspection errors and identities are never logged.
      failed = true; timedOut ||= error instanceof CleanupTimeout; }
    const cleaned = !failed && residualCount === 0; const terminalCode: CodexSafeCode = cleaned ? this.terminal ?? 'CODEX_INTERNAL_FAILURE' : timedOut ? 'CODEX_CLEANUP_TIMEOUT' : 'CODEX_CLEANUP_FAILED';
    const result = { terminalCode, residualCount, cleaned };
    if (cleaned) codexLog('cleanup.completed', { ...fields, residualCount }); else codexLog('cleanup.failed', { ...fields, residualCount, safeCode: terminalCode });
    return result;
  }
  private async stage(run: () => Promise<void>, failed: boolean, timedOut: boolean): Promise<{ failed: boolean; timedOut: boolean }> {
    try { await bounded(run(), this.timeout()); } catch (error) { // observability-exempt: Stage failures do not stop mandatory later cleanup stages and are emitted once as a closed aggregate cleanup result.
      failed = true; timedOut ||= error instanceof CleanupTimeout; }
    return { failed, timedOut };
  }
  private timeout(): number { return this.input.stageTimeoutMs ?? MAXIMUM_STAGE_TIMEOUT_MS; }
}

class CleanupTimeout extends Error {}
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new CleanupTimeout()), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
