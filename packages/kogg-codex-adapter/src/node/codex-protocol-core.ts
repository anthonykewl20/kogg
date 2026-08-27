import { TextDecoder } from 'node:util';
import type { CodexSafeCode } from '../common/codex-protocol';
import { codexLog } from './codex-logger';

// Logs only closed phase and safe-code fields through codexLog. Raw frames, content, methods, and correlations never enter logs.
// diagnostic-coverage: codex.protocol, codex.cleanup, codex.source-maps
export const CODEX_PROTOCOL_LIMITS = Object.freeze({ frameBytes: 8 * 1024 * 1024, incompleteBytes: 8 * 1024 * 1024, queuedCount: 256, queuedBytes: 16 * 1024 * 1024, outstandingRequests: 64, contentBytes: 16 * 1024 * 1024 });
const OUTBOUND_REQUESTS = new Set(['initialize', 'thread/start', 'turn/start', 'turn/interrupt', 'shutdown']);
const OUTBOUND_NOTIFICATIONS = new Set(['initialized']);
const DECODER = new TextDecoder('utf-8', { fatal: true });

export type CodexProtocolPhase = 'spawned' | 'initializing' | 'initialize-replied' | 'initialized' | 'thread-starting' | 'thread-ready' | 'turn-starting' | 'turn-active' | 'interrupting' | 'turn-terminal-observed' | 'cleaning' | 'faulted';
export type CodexValidatedFrame =
  | { readonly kind: 'response'; readonly id: number; readonly outcome: 'result' | 'error'; readonly content?: unknown; readonly contentBytes?: number }
  | { readonly kind: 'notification'; readonly method: string; readonly lifecycle: 'turn-started' | 'activity' | 'turn-completed'; readonly content?: unknown; readonly contentBytes?: number }
  | { readonly kind: 'server-request'; readonly id: number; readonly method: string; readonly lifecycle: 'authority-request'; readonly content?: unknown; readonly contentBytes?: number };
export type CodexSafeObservation =
  | { readonly kind: 'response'; readonly requestMethod: string; readonly outcome: 'result' | 'error' }
  | { readonly kind: 'notification'; readonly lifecycle: 'turn-started' | 'activity' | 'turn-completed' }
  | { readonly kind: 'server-request'; readonly lifecycle: 'authority-request' };
export interface CodexFrameSchema { validate(frame: Readonly<Record<string, unknown>>, expectedRequestMethod?: string): CodexValidatedFrame | undefined; }
export interface CodexContentRouter { accept(content: unknown, byteCount: number): Promise<boolean>; }

export class CodexProtocolFault extends Error { constructor(readonly code: Extract<CodexSafeCode, 'CODEX_PROTOCOL_VIOLATION' | 'CODEX_PROTOCOL_UNSUPPORTED' | 'CODEX_FRAME_TOO_LARGE' | 'CODEX_QUEUE_OVERFLOW' | 'CODEX_STDIN_BACKPRESSURE' | 'CODEX_STDERR_LIMIT' | 'CODEX_CONTENT_BACKPRESSURE' | 'CODEX_TRANSPORT_LOST'>) { super(code); } }

export class CodexProtocolCore {
  private bytes = Buffer.alloc(0); private phaseValue: CodexProtocolPhase = 'spawned'; private queuedBytes = 0;
  private readonly queue: Array<{ readonly bytes: number; readonly value: CodexSafeObservation }> = [];
  private readonly requests = new Map<number, string>(); private readonly serverRequests = new Set<number>();
  private threadCount = 0; private turnCount = 0; private terminalCount = 0; private shutdownCount = 0; private failed = false;
  constructor(private readonly schema: CodexFrameSchema, private readonly acceptedInboundMethods: Pick<ReadonlySet<string>, 'has'>, private readonly content: CodexContentRouter) {}
  phase(): CodexProtocolPhase { return this.phaseValue; }
  outstanding(): { readonly client: number; readonly server: number } { return { client: this.requests.size, server: this.serverRequests.size }; }

  request(id: number, method: string): void {
    this.guard(); if (!validId(id)) this.fault('CODEX_PROTOCOL_VIOLATION'); if (!OUTBOUND_REQUESTS.has(method)) this.fault('CODEX_PROTOCOL_UNSUPPORTED');
    if (this.requests.has(id) || this.serverRequests.has(id) || this.requests.size >= CODEX_PROTOCOL_LIMITS.outstandingRequests) this.fault('CODEX_PROTOCOL_VIOLATION');
    if (method === 'initialize' && this.phaseValue === 'spawned') this.transition('initializing');
    else if (method === 'thread/start' && this.phaseValue === 'initialized' && this.threadCount === 0) { this.threadCount++; this.transition('thread-starting'); }
    else if (method === 'turn/start' && this.phaseValue === 'thread-ready' && this.turnCount === 0) { this.turnCount++; this.transition('turn-starting'); }
    else if (method === 'turn/interrupt' && ['turn-starting', 'turn-active'].includes(this.phaseValue)) this.transition('interrupting');
    else if (method !== 'shutdown' || this.phaseValue !== 'cleaning' || ++this.shutdownCount !== 1) this.fault('CODEX_PROTOCOL_VIOLATION');
    this.requests.set(id, method);
  }

  notification(method: string): void {
    this.guard(); if (!OUTBOUND_NOTIFICATIONS.has(method)) this.fault('CODEX_PROTOCOL_UNSUPPORTED');
    if (method !== 'initialized' || this.phaseValue !== 'initialize-replied') this.fault('CODEX_PROTOCOL_VIOLATION'); this.transition('initialized');
  }

  beginCleanup(): void { this.guard(); this.transition('cleaning'); }
  resolveServerRequest(id: number): void { this.guard(); if (!validId(id) || !this.serverRequests.delete(id)) this.fault('CODEX_PROTOCOL_VIOLATION'); }

  async push(chunk: Uint8Array): Promise<void> {
    this.guard(); if (!chunk.byteLength) return; this.bytes = Buffer.concat([this.bytes, Buffer.from(chunk)]);
    if (this.bytes.length > CODEX_PROTOCOL_LIMITS.incompleteBytes && this.bytes.indexOf(0x0a) < 0) this.fault('CODEX_FRAME_TOO_LARGE');
    while (true) {
      const newline = this.bytes.indexOf(0x0a); if (newline < 0) break;
      const size = newline + 1; if (size > CODEX_PROTOCOL_LIMITS.frameBytes) this.fault('CODEX_FRAME_TOO_LARGE');
      const line = this.bytes.subarray(0, newline); this.bytes = this.bytes.subarray(size); if (!line.length) this.fault('CODEX_PROTOCOL_VIOLATION');
      await this.decode(line, size);
    }
  }

  end(): void { this.guard(); if (this.bytes.length) this.fault('CODEX_PROTOCOL_VIOLATION'); }
  drain(maximum = CODEX_PROTOCOL_LIMITS.queuedCount): readonly CodexSafeObservation[] { if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid drain maximum'); const items = this.queue.splice(0, maximum); this.queuedBytes -= items.reduce((total, item) => total + item.bytes, 0); return items.map(item => item.value); }

  private async decode(line: Buffer, frameBytes: number): Promise<void> {
    let parsed: unknown; try { parsed = JSON.parse(DECODER.decode(line)); } catch { // observability-exempt: fault emits the closed refusal code and intentionally discards invalid UTF-8/JSON bytes.
      this.fault('CODEX_PROTOCOL_VIOLATION'); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') this.fault('CODEX_PROTOCOL_VIOLATION');
    const candidate = parsed as Readonly<Record<string, unknown>>; const expectedRequest = typeof candidate.id === 'number' ? this.requests.get(candidate.id) : undefined;
    let validated: CodexValidatedFrame | undefined; try { validated = this.schema.validate(candidate, expectedRequest); } catch { // observability-exempt: The closed protocol refusal below replaces schema-validator details without echoing frame content.
      this.fault('CODEX_PROTOCOL_VIOLATION'); } if (!validated) this.fault('CODEX_PROTOCOL_VIOLATION');
    if (validated.kind !== 'response' && !this.acceptedInboundMethods.has(validated.method)) this.fault('CODEX_PROTOCOL_UNSUPPORTED');
    const contentBytes = validated.contentBytes ?? 0; if (!Number.isSafeInteger(contentBytes) || contentBytes < 0 || contentBytes > CODEX_PROTOCOL_LIMITS.contentBytes || (contentBytes === 0) !== (validated.content === undefined)) this.fault('CODEX_PROTOCOL_VIOLATION');
    if (this.queue.length >= CODEX_PROTOCOL_LIMITS.queuedCount || this.queuedBytes + frameBytes > CODEX_PROTOCOL_LIMITS.queuedBytes) this.fault('CODEX_QUEUE_OVERFLOW');
    const observation = this.reduce(validated);
    if (contentBytes) { let accepted = false; try { accepted = await this.content.accept(validated.content, contentBytes); } catch { // observability-exempt: Content-router errors are normalized below and raw content/error data is intentionally discarded.
        this.fault('CODEX_CONTENT_BACKPRESSURE'); } if (!accepted) this.fault('CODEX_CONTENT_BACKPRESSURE'); }
    this.queue.push({ bytes: frameBytes, value: observation }); this.queuedBytes += frameBytes;
  }

  private reduce(frame: CodexValidatedFrame): CodexSafeObservation {
    if (frame.kind === 'response') {
      if (!validId(frame.id)) this.fault('CODEX_PROTOCOL_VIOLATION'); const method = this.requests.get(frame.id); if (!method) this.fault('CODEX_PROTOCOL_VIOLATION'); this.requests.delete(frame.id);
      if (frame.outcome === 'error' && ['initialize', 'thread/start', 'turn/start'].includes(method)) this.fault('CODEX_PROTOCOL_VIOLATION');
      if (method === 'initialize') { if (this.phaseValue !== 'initializing') this.fault('CODEX_PROTOCOL_VIOLATION'); this.transition('initialize-replied'); }
      else if (method === 'thread/start') { if (this.phaseValue !== 'thread-starting') this.fault('CODEX_PROTOCOL_VIOLATION'); this.transition('thread-ready'); }
      return { kind: 'response', requestMethod: method, outcome: frame.outcome };
    }
    if (frame.kind === 'server-request') { if (!['turn-active', 'interrupting'].includes(this.phaseValue) || !validId(frame.id) || this.serverRequests.has(frame.id) || this.requests.has(frame.id) || this.serverRequests.size >= CODEX_PROTOCOL_LIMITS.outstandingRequests || frame.lifecycle !== 'authority-request') this.fault('CODEX_PROTOCOL_VIOLATION'); this.serverRequests.add(frame.id); return { kind: 'server-request', lifecycle: frame.lifecycle }; }
    if (frame.lifecycle === 'turn-started') { if (this.phaseValue !== 'turn-starting') this.fault('CODEX_PROTOCOL_VIOLATION'); this.transition('turn-active'); }
    else if (frame.lifecycle === 'activity') { if (this.phaseValue !== 'turn-active') this.fault('CODEX_PROTOCOL_VIOLATION'); }
    else { if (!['turn-active', 'interrupting'].includes(this.phaseValue) || ++this.terminalCount !== 1) this.fault('CODEX_PROTOCOL_VIOLATION'); this.transition('turn-terminal-observed'); }
    return { kind: 'notification', lifecycle: frame.lifecycle };
  }

  private guard(): void { if (this.failed) throw new CodexProtocolFault('CODEX_PROTOCOL_VIOLATION'); }
  private transition(phase: CodexProtocolPhase): void { this.phaseValue = phase; codexLog('protocol.phase.changed', { phase }); }
  private fault(code: CodexProtocolFault['code']): never { this.failed = true; this.phaseValue = 'faulted'; this.bytes = Buffer.alloc(0); this.queue.length = 0; this.queuedBytes = 0; codexLog('protocol.frame.refused', { safeCode: code }); throw new CodexProtocolFault(code); }
}

function validId(id: number): boolean { return Number.isSafeInteger(id) && id >= 1; }
