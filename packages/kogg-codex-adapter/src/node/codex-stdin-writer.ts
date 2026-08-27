import type { Writable } from 'node:stream';
import { CODEX_PROTOCOL_LIMITS, CodexProtocolFault } from './codex-protocol-core';
import { codexLog } from './codex-logger';

// Payload bytes are owned by stdio and never logged, inspected, or returned on failure.
// diagnostic-coverage: codex.protocol, codex.cleanup, codex.source-maps
const MAX_PENDING_BYTES = 4 * 1024 * 1024; const DEFAULT_DRAIN_MS = 10_000;
type WritableBoundary = Pick<Writable, 'destroyed' | 'writableLength' | 'write' | 'once' | 'off'>;
export class CodexStdinWriter {
  private tail: Promise<void> = Promise.resolve(); private failed = false;
  constructor(private readonly stream: WritableBoundary, private readonly drainTimeoutMs = DEFAULT_DRAIN_MS) { if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > DEFAULT_DRAIN_MS) throw new Error('Invalid stdin drain timeout'); }
  send(frame: Readonly<Record<string, unknown>>): Promise<void> { const current = this.tail.then(() => this.write(frame)); this.tail = current.catch(() => undefined); return current; }
  private async write(frame: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.failed || this.stream.destroyed) this.refuse('CODEX_STDIN_BACKPRESSURE');
    let bytes: Buffer; try { bytes = Buffer.from(`${JSON.stringify(frame)}\n`); } catch { // observability-exempt: The closed refusal below discards cyclic/unserializable payloads without echoing them.
      this.refuse('CODEX_PROTOCOL_VIOLATION'); }
    if (bytes.length > CODEX_PROTOCOL_LIMITS.frameBytes) this.refuse('CODEX_FRAME_TOO_LARGE');
    if (bytes.length + this.stream.writableLength > MAX_PENDING_BYTES) this.refuse('CODEX_STDIN_BACKPRESSURE');
    let accepted = false; try { accepted = this.stream.write(bytes); } catch { // observability-exempt: The closed refusal below replaces stream errors without exposing payload or runtime details.
      this.refuse('CODEX_STDIN_BACKPRESSURE'); }
    if (!accepted) await this.drain();
  }
  private drain(): Promise<void> { return new Promise((resolve, reject) => { let timer: NodeJS.Timeout | undefined; const done = (): void => { if (timer) clearTimeout(timer); this.stream.off('drain', drained); }; const drained = (): void => { done(); resolve(); }; this.stream.once('drain', drained); timer = setTimeout(() => { done(); reject(this.failure('CODEX_STDIN_BACKPRESSURE')); }, this.drainTimeoutMs); }); }
  private failure(code: CodexProtocolFault['code']): CodexProtocolFault { if (!this.failed) { this.failed = true; codexLog('protocol.frame.refused', { safeCode: code }); } return new CodexProtocolFault(code); }
  private refuse(code: CodexProtocolFault['code']): never { throw this.failure(code); }
}
