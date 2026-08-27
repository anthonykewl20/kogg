import type { Readable } from 'node:stream';
import type { CodexSafeCode } from '../common/codex-protocol';
import { CodexProtocolCore, CodexProtocolFault } from './codex-protocol-core';
import { codexLog } from './codex-logger';

// Stdout is schema-owned protocol input; stderr is byte-counted and discarded. Neither stream content enters logs or errors.
// diagnostic-coverage: codex.protocol, codex.processes, codex.cleanup, codex.source-maps
const MAX_STDERR_BYTES = 64 * 1024 * 1024;
type StdioFault = Extract<CodexSafeCode, 'CODEX_PROTOCOL_VIOLATION' | 'CODEX_PROTOCOL_UNSUPPORTED' | 'CODEX_FRAME_TOO_LARGE' | 'CODEX_QUEUE_OVERFLOW' | 'CODEX_CONTENT_BACKPRESSURE' | 'CODEX_STDERR_LIMIT' | 'CODEX_TRANSPORT_LOST'>;
export class CodexStdioDrainer {
  private failed = false; private stderrBytes = 0;
  constructor(private readonly protocol: CodexProtocolCore, private readonly onFault: (code: StdioFault) => void | Promise<void>, private readonly stderrLimit = MAX_STDERR_BYTES) { if (!Number.isSafeInteger(stderrLimit) || stderrLimit < 1 || stderrLimit > MAX_STDERR_BYTES) throw new Error('Invalid stderr limit'); }
  async run(stdout: Readable, stderr: Readable): Promise<{ readonly stderrBytes: number; readonly faulted: boolean }> { await Promise.all([this.stdout(stdout), this.stderr(stderr)]); return { stderrBytes: this.stderrBytes, faulted: this.failed }; }
  private async stdout(stream: Readable): Promise<void> { try { for await (const chunk of stream) if (!this.failed) try { await this.protocol.push(Buffer.from(chunk as Uint8Array)); } catch (error) { await this.fail(error instanceof CodexProtocolFault ? error.code as StdioFault : 'CODEX_TRANSPORT_LOST', error instanceof CodexProtocolFault); } if (!this.failed) this.protocol.end(); } catch (error) { // observability-exempt: fail emits a closed code while raw stream errors and protocol bytes are discarded.
      await this.fail(error instanceof CodexProtocolFault ? error.code as StdioFault : 'CODEX_TRANSPORT_LOST', error instanceof CodexProtocolFault); } }
  private async stderr(stream: Readable): Promise<void> { try { for await (const chunk of stream) { const size = Buffer.byteLength(chunk as Uint8Array); this.stderrBytes = Math.min(this.stderrLimit + 1, this.stderrBytes + size); if (this.stderrBytes > this.stderrLimit) await this.fail('CODEX_STDERR_LIMIT', false); } } catch { // observability-exempt: fail emits a closed transport code while raw stderr errors and bytes are discarded.
      await this.fail('CODEX_TRANSPORT_LOST', false); } }
  private async fail(code: StdioFault, alreadyLogged: boolean): Promise<void> { if (this.failed) return; this.failed = true; if (!alreadyLogged) codexLog('protocol.frame.refused', { safeCode: code }); try { await this.onFault(code); } catch { // observability-exempt: The attempt owner already received the closed fault; callback details are intentionally discarded while stdio continues draining.
      return; } }
}
