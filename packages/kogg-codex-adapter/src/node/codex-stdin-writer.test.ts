import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CodexProtocolFault } from './codex-protocol-core';
import { CodexStdinWriter } from './codex-stdin-writer';

// diagnostic-coverage: codex.protocol, codex.cleanup, codex.source-maps
class FakeWritable extends EventEmitter { destroyed = false; writableLength = 0; readonly writes: Buffer[] = []; constructor(private readonly accept = true) { super(); } write(value: Uint8Array): boolean { this.writes.push(Buffer.from(value)); return this.accept; } }
const code = (expected: CodexProtocolFault['code']) => (error: unknown): boolean => error instanceof CodexProtocolFault && error.code === expected;

test('serializes exact newline frames in call order without retaining payloads', async () => { const stream = new FakeWritable(); const writer = new CodexStdinWriter(stream as never); await Promise.all([writer.send({ id: 1, method: 'initialize' }), writer.send({ method: 'initialized' })]); assert.equal(Buffer.concat(stream.writes).toString(), '{"id":1,"method":"initialize"}\n{"method":"initialized"}\n'); });

test('fails oversized, cyclic, destroyed, and stalled writes with closed codes and no payload log echo', async () => {
  const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); }; const canary = `stdin-private-${Date.now()}`;
  try {
    const oversized = new CodexStdinWriter(new FakeWritable() as never); await assert.rejects(oversized.send({ value: canary.repeat(300_000) }), code('CODEX_STDIN_BACKPRESSURE'));
    const cyclic: Record<string, unknown> = { value: canary }; cyclic.self = cyclic; await assert.rejects(new CodexStdinWriter(new FakeWritable() as never).send(cyclic), code('CODEX_PROTOCOL_VIOLATION'));
    const destroyed = new FakeWritable(); destroyed.destroyed = true; await assert.rejects(new CodexStdinWriter(destroyed as never).send({ value: canary }), code('CODEX_STDIN_BACKPRESSURE'));
    const stalled = new FakeWritable(false); await assert.rejects(new CodexStdinWriter(stalled as never, 20).send({ value: canary }), code('CODEX_STDIN_BACKPRESSURE'));
    assert.equal(logs.join('\n').includes(canary), false);
  } finally { console.error = original; }
});
