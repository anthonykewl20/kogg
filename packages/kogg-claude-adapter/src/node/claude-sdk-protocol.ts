import type { ClaudeInitializationProjectionV1, ClaudeSafeCode } from '../common/claude-protocol';
import { claudeLog } from './claude-logger';

// Raw SDK observations and content remain attempt-local and volatile. Logs use the closed [kogg:claude:protocol] claudeLog schema only.
// diagnostic-coverage: claude.settings, claude.protocol, claude.cleanup, claude.source-maps
export const CLAUDE_PROTOCOL_LIMITS = Object.freeze({ queuedMessages: 256, queuedBytes: 4 * 1024 * 1024, frameBytes: 1024 * 1024, contentBytes: 4 * 1024 * 1024 });
const TOOLS = ['Bash','Edit','Glob','Grep','Read','Write'] as const;
export type ClaudeProtocolPhase = 'initializing' | 'running' | 'terminal-observed' | 'cleaning' | 'faulted';
export type ClaudeSafeProtocolObservation = { readonly kind: 'initialized' } | { readonly kind: 'progress'; readonly progressClass: 'assistant' | 'command-started' | 'command-completed' | 'command-failed' } | { readonly kind: 'result'; readonly outcome: 'success' | 'error' };
export interface ClaudeContentDelivery { readonly sequence: number; readonly content: unknown; readonly byteCount: number; }
export type ClaudeAuthorizedContentConsumer = (delivery: ClaudeContentDelivery) => Promise<void>;
export class ClaudeProtocolFault extends Error { constructor(readonly code: Extract<ClaudeSafeCode, 'CLAUDE_INITIALIZATION_MISMATCH' | 'CLAUDE_PROTOCOL_OVERFLOW' | 'CLAUDE_PROTOCOL_INVALID' | 'CLAUDE_MODEL_MISMATCH'>) { super(code); } }

export class ClaudeSdkProtocolGate {
  private phaseValue: ClaudeProtocolPhase = 'initializing'; private tail: Promise<void> = Promise.resolve(); private failed = false;
  private queuedCount = 0; private queuedBytes = 0; private contentBytes = 0; private contentSequence = 0; private terminalCount = 0;
  constructor(private readonly attemptId: string, private readonly model: string, private readonly cliVersion: string, private readonly content: ClaudeAuthorizedContentConsumer) {
    if (!attemptId || attemptId.length > 128 || !model || model.length > 128 || !cliVersion || cliVersion.length > 64) throw new Error('Invalid Claude protocol configuration');
  }
  phase(): ClaudeProtocolPhase { return this.phaseValue; }
  pending(): { readonly count: number; readonly bytes: number; readonly contentBytes: number } { return { count: this.queuedCount, bytes: this.queuedBytes, contentBytes: this.contentBytes }; }
  accept(message: unknown, frameBytes: number): Promise<ClaudeSafeProtocolObservation> {
    this.guard(); if (!Number.isSafeInteger(frameBytes) || frameBytes < 1 || frameBytes > CLAUDE_PROTOCOL_LIMITS.frameBytes || this.queuedCount >= CLAUDE_PROTOCOL_LIMITS.queuedMessages || this.queuedBytes + frameBytes > CLAUDE_PROTOCOL_LIMITS.queuedBytes) return Promise.reject(this.fault('CLAUDE_PROTOCOL_OVERFLOW'));
    this.queuedCount++; this.queuedBytes += frameBytes; let resolve!: (value: ClaudeSafeProtocolObservation) => void; let reject!: (reason: unknown) => void; const result = new Promise<ClaudeSafeProtocolObservation>((accepted, refused) => { resolve = accepted; reject = refused; });
    this.tail = this.tail.then(async () => { try { resolve(await this.process(message)); } catch (error) { /* observability-exempt: process() already emitted the closed protocol failure before this queue handoff rejects its caller. */ reject(error); } }).finally(() => { this.queuedCount--; this.queuedBytes -= frameBytes; }); return result;
  }
  async drain(): Promise<void> { await this.tail; this.guard(); }
  end(): void { this.guard(); if (this.phaseValue !== 'terminal-observed' && this.phaseValue !== 'cleaning') this.fault('CLAUDE_PROTOCOL_INVALID'); }
  beginCleanup(): void { if (this.failed || this.phaseValue === 'cleaning') return; this.phaseValue = 'cleaning'; claudeLog('protocol.phase.changed', { attemptId: this.attemptId, phase: this.phaseValue }); }
  private async process(message: unknown): Promise<ClaudeSafeProtocolObservation> {
    this.guard(); if (!record(message) || typeof message.type !== 'string') this.fault('CLAUDE_PROTOCOL_INVALID');
    if (message.type === 'system') return this.initialize(message);
    if (message.type === 'assistant') {
      if (this.phaseValue !== 'running' || !exact(message, ['type','content','contentBytes']) || !Number.isSafeInteger(message.contentBytes) || (message.contentBytes as number) < 1) this.fault('CLAUDE_PROTOCOL_INVALID'); if (this.contentBytes + (message.contentBytes as number) > CLAUDE_PROTOCOL_LIMITS.contentBytes) this.fault('CLAUDE_PROTOCOL_OVERFLOW');
      const byteCount = message.contentBytes as number; this.contentBytes += byteCount; const sequence = ++this.contentSequence; try { await this.content({ sequence, content: message.content, byteCount }); } catch { /* observability-exempt: fault emits the safe overflow code and intentionally discards private content-router errors. */ this.fault('CLAUDE_PROTOCOL_OVERFLOW'); } finally { this.contentBytes -= byteCount; }
      claudeLog('protocol.progress', { attemptId: this.attemptId, progressClass: 'assistant' }); return { kind: 'progress', progressClass: 'assistant' };
    }
    if (message.type === 'command_lifecycle') {
      if (this.phaseValue !== 'running' || !exact(message, ['type','state']) || !['started','completed','failed'].includes(String(message.state))) this.fault('CLAUDE_PROTOCOL_INVALID'); const progressClass = `command-${message.state}` as 'command-started' | 'command-completed' | 'command-failed'; claudeLog('protocol.progress', { attemptId: this.attemptId, progressClass }); return { kind: 'progress', progressClass };
    }
    if (message.type === 'result') {
      if (this.phaseValue !== 'running' || !exact(message, ['type','outcome','model']) || !['success','error'].includes(String(message.outcome)) || ++this.terminalCount !== 1) this.fault('CLAUDE_PROTOCOL_INVALID'); if (message.model !== this.model) this.fault('CLAUDE_MODEL_MISMATCH'); this.phaseValue = 'terminal-observed'; const outcome = message.outcome as 'success' | 'error'; claudeLog('protocol.result', { attemptId: this.attemptId, outcome }); return { kind: 'result', outcome };
    }
    return this.fault('CLAUDE_PROTOCOL_INVALID');
  }
  private initialize(message: Readonly<Record<string, unknown>>): ClaudeSafeProtocolObservation {
    if (this.phaseValue !== 'initializing' || !exact(message, ['type','subtype','model','permissionMode','tools','mcpServers','plugins','slashCommands','agents','accountOrganizationPresent','cliVersion']) || message.subtype !== 'init') this.fault('CLAUDE_PROTOCOL_INVALID');
    const expected: ClaudeInitializationProjectionV1 = { model: this.model, permissionMode: 'default', tools: TOOLS, mcpServers: [], plugins: [], slashCommands: [], agents: [], accountOrganizationPresent: false, cliVersion: this.cliVersion };
    const projection = Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'type' && key !== 'subtype')); if (canonical(projection) !== canonical(expected)) this.fault('CLAUDE_INITIALIZATION_MISMATCH'); this.phaseValue = 'running'; claudeLog('protocol.initialize', { attemptId: this.attemptId, outcome: 'accepted' }); return { kind: 'initialized' };
  }
  private guard(): void { if (this.failed) throw new ClaudeProtocolFault('CLAUDE_PROTOCOL_INVALID'); }
  private fault(code: ClaudeProtocolFault['code']): never { this.failed = true; this.phaseValue = 'faulted'; claudeLog('protocol.failure', { attemptId: this.attemptId, safeCode: code }); throw new ClaudeProtocolFault(code); }
}
function record(value: unknown): value is Readonly<Record<string, unknown>> { return Boolean(value) && !Array.isArray(value) && typeof value === 'object'; }
function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...fields].sort().join(','); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
