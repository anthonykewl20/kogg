import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexProtocolCore, type CodexFrameSchema } from './codex-protocol-core';
import { CodexStdioDrainer } from './codex-stdio-drainer';

// diagnostic-coverage: codex.protocol, codex.processes, codex.cleanup, codex.source-maps
const schema: CodexFrameSchema = { validate(frame) { return Object.keys(frame).sort().join(',') === 'lifecycle,method' && frame.method === 'turn/started' && frame.lifecycle === 'turn-started' ? { kind: 'notification', method: 'turn/started', lifecycle: 'turn-started' } : undefined; } };

test('serially drains split stdout frames and discards stderr after safe byte counting', async () => {
  const core = new CodexProtocolCore({ validate(frame, expected) { if (expected === 'initialize' && frame.id === 1 && frame.outcome === 'result') return { kind: 'response', id: 1, outcome: 'result' }; if (frame.method === 'turn/started') return { kind: 'notification', method: 'turn/started', lifecycle: 'turn-started' }; return undefined; } }, new Set(['turn/started']), { accept: async () => true }); core.request(1, 'initialize');
  const stdout = new PassThrough(); const stderr = new PassThrough(); const faults: string[] = []; const running = new CodexStdioDrainer(core, code => { faults.push(code); }).run(stdout, stderr);
  stdout.write('{"id":1,"out'); stdout.write('come":"result"}\n'); stderr.write('private-stderr'); stdout.end(); stderr.end(); const result = await running;
  assert.equal(result.stderrBytes, 14); assert.equal(result.faulted, false); assert.deepEqual(faults, []); assert.deepEqual(core.drain(), [{ kind: 'response', requestMethod: 'initialize', outcome: 'result' }]);
});

test('reports one closed stderr/protocol fault, keeps draining, and never logs later private bytes', async () => {
  const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); }; const canary = `stdio-private-${Date.now()}`;
  try {
    const core = new CodexProtocolCore(schema, new Set(['turn/started']), { accept: async () => true }); const stdout = new PassThrough(); const stderr = new PassThrough(); const faults: string[] = []; const running = new CodexStdioDrainer(core, code => { faults.push(code); }, 8).run(stdout, stderr);
    stderr.write('123456789'); await new Promise(resolve => setImmediate(resolve)); stdout.write(`${canary}\n`); stderr.write(canary); stdout.end(); stderr.end(); const result = await running;
    assert.deepEqual(faults, ['CODEX_STDERR_LIMIT']); assert.equal(result.faulted, true); assert.equal(result.stderrBytes, 9); assert.equal(logs.join('\n').includes(canary), false);
  } finally { console.error = original; }
});

test('preserves incomplete stdout EOF as a protocol violation while completing both drains', async () => { const core = new CodexProtocolCore(schema, new Set(['turn/started']), { accept: async () => true }); const stdout = new PassThrough(); const stderr = new PassThrough(); const faults: string[] = []; const running = new CodexStdioDrainer(core, code => { faults.push(code); }).run(stdout, stderr); stdout.end('{"method":'); stderr.end(); const result = await running; assert.equal(result.faulted, true); assert.deepEqual(faults, ['CODEX_PROTOCOL_VIOLATION']); });
