import type { CodexContentRouter } from './codex-protocol-core';
import { codexLog } from './codex-logger';

// Content is intentionally attempt-local and volatile. Logs use [kogg:agents:codex-content] and diagnostics contain counts only.
// diagnostic-coverage: codex.protocol, codex.cleanup, codex.source-maps
export const CODEX_CONTENT_PENDING_BYTES = 16 * 1024 * 1024;
export interface CodexContentDelivery { readonly sequence: number; readonly content: unknown; readonly byteCount: number; }
export interface CodexContentDiagnostics { readonly closed: boolean; readonly failed: boolean; readonly pendingCount: number; readonly pendingBytes: number; readonly deliveredCount: number; }
export type CodexAuthorizedContentConsumer = (delivery: CodexContentDelivery) => Promise<void>;

export class CodexAttemptContentRouter implements CodexContentRouter {
  private tail: Promise<void> = Promise.resolve(); private closed = false; private failed = false;
  private pendingCount = 0; private pendingBytes = 0; private deliveredCount = 0; private sequence = 0;
  constructor(private readonly attemptId: string, private readonly consumer: CodexAuthorizedContentConsumer, private readonly maximumPendingBytes = CODEX_CONTENT_PENDING_BYTES) {
    if (!attemptId || attemptId.length > 128 || !Number.isSafeInteger(maximumPendingBytes) || maximumPendingBytes < 1 || maximumPendingBytes > CODEX_CONTENT_PENDING_BYTES) throw new Error('Invalid content router configuration');
  }
  async accept(content: unknown, byteCount: number): Promise<boolean> {
    if (content === undefined || !Number.isSafeInteger(byteCount) || byteCount < 1 || byteCount > this.maximumPendingBytes || this.closed || this.failed || this.pendingBytes + byteCount > this.maximumPendingBytes) { codexLog('content.delivery.failed', { attemptId: this.attemptId, pendingCount: this.pendingCount, safeCode: 'CODEX_CONTENT_BACKPRESSURE' }); return false; }
    const sequence = ++this.sequence; this.pendingCount++; this.pendingBytes += byteCount; codexLog('content.delivery.started', { attemptId: this.attemptId, pendingCount: this.pendingCount });
    const delivery = this.tail.then(async () => { if (this.failed) throw new Error('content router failed'); await this.consumer({ sequence, content, byteCount }); if (this.failed) throw new Error('content router failed'); this.deliveredCount++; return true; })
      .catch(() => { this.failed = true; return false; })
      .then(accepted => { if (accepted) codexLog('content.delivery.completed', { attemptId: this.attemptId, pendingCount: this.pendingCount - 1, deliveredCount: this.deliveredCount }); else codexLog('content.delivery.failed', { attemptId: this.attemptId, pendingCount: this.pendingCount - 1, safeCode: 'CODEX_CONTENT_BACKPRESSURE' }); return accepted; })
      .finally(() => { this.pendingCount--; this.pendingBytes -= byteCount; });
    this.tail = delivery.then(() => undefined); return delivery;
  }
  closeInput(): void { if (this.closed) return; this.closed = true; codexLog('content.closed', { attemptId: this.attemptId, pendingCount: this.pendingCount }); }
  async drain(timeoutMs = 10_000): Promise<boolean> {
    this.closeInput(); if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid content drain timeout');
    let timer: NodeJS.Timeout | undefined; const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try { const drained = await Promise.race([this.tail.then(() => !this.failed && this.pendingCount === 0), timeout]); if (!drained) { this.failed = true; codexLog('content.delivery.failed', { attemptId: this.attemptId, pendingCount: this.pendingCount, safeCode: 'CODEX_CONTENT_BACKPRESSURE' }); } return drained; } finally { if (timer) clearTimeout(timer); }
  }
  diagnostics(): CodexContentDiagnostics { return { closed: this.closed, failed: this.failed, pendingCount: this.pendingCount, pendingBytes: this.pendingBytes, deliveredCount: this.deliveredCount }; }
}
