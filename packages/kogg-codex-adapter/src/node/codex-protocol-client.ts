import type { Writable } from 'node:stream';
import type { CodexSafeCode } from '../common/codex-protocol';
import { codexLog } from './codex-logger';
import { CodexProtocolCore, CodexProtocolFault, type CodexContentRouter, type CodexFrameSchema, type CodexPrivateFrameConsumer, type CodexSafeObservation, type CodexValidatedFrame } from './codex-protocol-core';
import { CodexStdinWriter } from './codex-stdin-writer';

// Logs use [kogg:agents:codex-protocol]; private results and correlations remain attempt-local and never enter safe observations.
// diagnostic-coverage: codex.protocol, codex.cleanup, codex.source-maps
export type CodexRequestClass = 'initialize' | 'thread/start' | 'turn/start' | 'turn/interrupt' | 'shutdown';
export interface CodexProtocolClientInput {
  readonly attemptId: string;
  readonly schema: CodexFrameSchema;
  readonly acceptedInboundMethods: Pick<ReadonlySet<string>, 'has'>;
  readonly stdin: Writable;
  readonly content: CodexContentRouter;
  readonly authorityDenial: (requestId: number) => Readonly<Record<string, unknown>>;
  readonly onObservation: (sequence: number, observation: CodexSafeObservation) => void;
  readonly stdinDrainTimeoutMs?: number;
}

type Pending = { readonly requestClass: CodexRequestClass; readonly resolve: (result: unknown) => void; readonly reject: (error: CodexClientFault) => void };

export class CodexClientFault extends Error { constructor(readonly code: CodexSafeCode) { super(code); } }

export class CodexProtocolClient implements CodexPrivateFrameConsumer {
  private readonly core: CodexProtocolCore; private readonly writer: CodexStdinWriter;
  private readonly pending = new Map<number, Pending>(); private readonly authorityRequests: number[] = [];
  private requestId = 0; private sequence = 0; private failed = false;
  constructor(private readonly input: CodexProtocolClientInput) {
    if (!input.attemptId || input.attemptId.length > 128) throw new Error('Invalid attempt id');
    this.core = new CodexProtocolCore(input.schema, input.acceptedInboundMethods, input.content, this);
    this.writer = new CodexStdinWriter(input.stdin, input.stdinDrainTimeoutMs);
  }

  phase(): ReturnType<CodexProtocolCore['phase']> { return this.core.phase(); }
  outstanding(): { readonly client: number; readonly server: number } { return this.core.outstanding(); }

  async request(requestClass: CodexRequestClass, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.guard(); const id = ++this.requestId; this.core.request(id, requestClass);
    codexLog('protocol.request.started', { attemptId: this.input.attemptId, requestClass });
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { requestClass, resolve, reject }));
    try { await this.writer.send({ id, method: requestClass, params }); }
    catch (error) { this.pending.delete(id); const code = codeOf(error); codexLog('protocol.request.failed', { attemptId: this.input.attemptId, requestClass, safeCode: code }); this.fail(code); throw error; }
    return response;
  }

  async initialized(params: Readonly<Record<string, unknown>> = {}): Promise<void> {
    this.guard(); this.core.notification('initialized'); try { await this.writer.send({ method: 'initialized', params }); }
    catch (error) { this.fail(codeOf(error)); throw error; }
  }

  async push(chunk: Uint8Array): Promise<void> {
    this.guard();
    try {
      await this.core.push(chunk);
      for (const observation of this.core.drain()) this.input.onObservation(++this.sequence, observation);
      while (this.authorityRequests.length) {
        const requestId = this.authorityRequests.shift()!; await this.writer.send(this.input.authorityDenial(requestId)); this.core.resolveServerRequest(requestId);
        codexLog('protocol.authority.denied', { attemptId: this.input.attemptId, pendingCount: this.authorityRequests.length });
      }
    } catch (error) { this.fail(codeOf(error)); throw error; }
  }

  end(): void {
    try { this.core.end(); if (this.pending.size || this.authorityRequests.length) throw new CodexClientFault('CODEX_TRANSPORT_LOST'); }
    catch (error) { this.fail(codeOf(error)); throw error; }
  }
  beginCleanup(): void { this.guard(); this.core.beginCleanup(); }

  accept(frame: CodexValidatedFrame): void {
    if (frame.kind === 'server-request') { this.authorityRequests.push(frame.id); return; }
    if (frame.kind !== 'response') return; const pending = this.pending.get(frame.id); if (!pending) throw new CodexClientFault('CODEX_PROTOCOL_VIOLATION'); this.pending.delete(frame.id);
    if (frame.outcome === 'result') { codexLog('protocol.request.completed', { attemptId: this.input.attemptId, requestClass: pending.requestClass }); pending.resolve(frame.privateResult); }
    else { const error = new CodexClientFault('CODEX_PROVIDER_REFUSED'); codexLog('protocol.request.failed', { attemptId: this.input.attemptId, requestClass: pending.requestClass, safeCode: error.code }); pending.reject(error); }
  }

  private guard(): void { if (this.failed) throw new CodexClientFault('CODEX_PROTOCOL_VIOLATION'); }
  private fail(code: CodexSafeCode): void {
    if (this.failed) return; this.failed = true;
    for (const pending of this.pending.values()) { codexLog('protocol.request.failed', { attemptId: this.input.attemptId, requestClass: pending.requestClass, safeCode: code }); pending.reject(new CodexClientFault(code)); }
    this.pending.clear(); this.authorityRequests.length = 0;
  }
}

function codeOf(error: unknown): CodexSafeCode { return error instanceof CodexProtocolFault || error instanceof CodexClientFault ? error.code : 'CODEX_INTERNAL_FAILURE'; }
