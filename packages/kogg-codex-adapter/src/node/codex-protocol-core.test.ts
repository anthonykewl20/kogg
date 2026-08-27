import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_PROTOCOL_LIMITS, CodexProtocolCore, CodexProtocolFault, type CodexFrameSchema, type CodexValidatedFrame } from './codex-protocol-core';

// diagnostic-coverage: codex.protocol, codex.cleanup, codex.source-maps
const ACCEPTED = new Set(['turn/started', 'item/completed', 'turn/completed', 'item/approval']);
const schema: CodexFrameSchema = { validate(frame) {
  const keys = Object.keys(frame).sort().join(',');
  if (keys === 'id,outcome' && typeof frame.id === 'number' && (frame.outcome === 'result' || frame.outcome === 'error')) return { kind: 'response', id: frame.id, outcome: frame.outcome };
  if (keys === 'lifecycle,method' && typeof frame.method === 'string' && ['turn-started', 'activity', 'turn-completed'].includes(String(frame.lifecycle))) return { kind: 'notification', method: frame.method, lifecycle: frame.lifecycle } as CodexValidatedFrame;
  if (keys === 'content,contentBytes,lifecycle,method' && typeof frame.method === 'string' && frame.lifecycle === 'activity' && typeof frame.contentBytes === 'number') return { kind: 'notification', method: frame.method, lifecycle: 'activity', content: frame.content, contentBytes: frame.contentBytes };
  if (keys === 'id,lifecycle,method' && typeof frame.id === 'number' && typeof frame.method === 'string' && frame.lifecycle === 'authority-request') return { kind: 'server-request', id: frame.id, method: frame.method, lifecycle: 'authority-request' };
  return undefined;
} };
const line = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);
const expectCode = (code: CodexProtocolFault['code']) => (error: unknown): boolean => error instanceof CodexProtocolFault && error.code === code;
function core(accept: (content: unknown, byteCount: number) => Promise<boolean> = async () => true): CodexProtocolCore { return new CodexProtocolCore(schema, ACCEPTED, { accept }); }
async function readyTurn(peer: CodexProtocolCore): Promise<void> {
  peer.request(1, 'initialize'); await peer.push(line({ id: 1, outcome: 'result' })); peer.notification('initialized');
  peer.request(2, 'thread/start'); await peer.push(line({ id: 2, outcome: 'result' })); peer.request(3, 'turn/start'); await peer.push(line({ id: 3, outcome: 'result' })); await peer.push(line({ method: 'turn/started', lifecycle: 'turn-started' }));
}

test('reduces one exact thread and turn while routing split UTF-8 content outside safe observations', async () => {
  const routed: unknown[] = []; const peer = core(async content => { routed.push(content); return true; }); await readyTurn(peer);
  const frame = line({ method: 'item/completed', lifecycle: 'activity', content: 'private-🙂', contentBytes: 12 }); const split = frame.indexOf(Buffer.from('🙂')) + 2;
  await peer.push(frame.subarray(0, split)); await peer.push(frame.subarray(split)); await peer.push(line({ method: 'turn/completed', lifecycle: 'turn-completed' }));
  const observations = peer.drain(); assert.equal(peer.phase(), 'turn-terminal-observed'); assert.deepEqual(routed, ['private-🙂']); assert.deepEqual(observations.at(-2), { kind: 'notification', lifecycle: 'activity' }); assert.equal(JSON.stringify(observations).includes('private'), false);
});

test('fails closed on unknown methods, schema fields, order, correlations, duplicate terminals, and trailing EOF bytes', async () => {
  const unknown = core(); await assert.rejects(unknown.push(line({ method: 'unknown/event', lifecycle: 'activity' })), expectCode('CODEX_PROTOCOL_UNSUPPORTED'));
  const shape = core(); await assert.rejects(shape.push(line({ method: 'turn/started', lifecycle: 'turn-started', extra: true })), expectCode('CODEX_PROTOCOL_VIOLATION'));
  const order = core(); await assert.rejects(order.push(line({ method: 'turn/started', lifecycle: 'turn-started' })), expectCode('CODEX_PROTOCOL_VIOLATION'));
  const correlation = core(); correlation.request(1, 'initialize'); await assert.rejects(correlation.push(line({ id: 2, outcome: 'result' })), expectCode('CODEX_PROTOCOL_VIOLATION'));
  const duplicate = core(); await readyTurn(duplicate); await duplicate.push(line({ method: 'turn/completed', lifecycle: 'turn-completed' })); await assert.rejects(duplicate.push(line({ method: 'turn/completed', lifecycle: 'turn-completed' })), expectCode('CODEX_PROTOCOL_VIOLATION'));
  const eof = core(); await eof.push(Buffer.from('{"id":1')); assert.throws(() => eof.end(), expectCode('CODEX_PROTOCOL_VIOLATION'));
});

test('rejects out-of-order content before routing and never echoes its value in protocol logs', async () => {
  const canary = `codex-private-content-${Date.now()}`; let routed = false; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  try { const peer = core(async () => { routed = true; return true; }); await assert.rejects(peer.push(line({ method: 'item/completed', lifecycle: 'activity', content: canary, contentBytes: canary.length })), expectCode('CODEX_PROTOCOL_VIOLATION')); assert.equal(routed, false); assert.equal(logs.join('\n').includes(canary), false); }
  finally { console.error = original; }
});

test('enforces fatal UTF-8, frame, decoded queue, request, server-request, and content bounds', async () => {
  const utf8 = core(); await assert.rejects(utf8.push(Buffer.from([0xff, 0x0a])), expectCode('CODEX_PROTOCOL_VIOLATION'));
  const frame = core(); await assert.rejects(frame.push(Buffer.alloc(CODEX_PROTOCOL_LIMITS.incompleteBytes + 1, 0x61)), expectCode('CODEX_FRAME_TOO_LARGE'));
  const queue = core(); queue.request(1, 'initialize'); await queue.push(line({ id: 1, outcome: 'result' })); queue.notification('initialized'); queue.request(2, 'thread/start'); await queue.push(line({ id: 2, outcome: 'result' })); queue.request(3, 'turn/start'); await queue.push(line({ id: 3, outcome: 'result' })); await queue.push(line({ method: 'turn/started', lifecycle: 'turn-started' }));
  queue.drain(); for (let count = 0; count < CODEX_PROTOCOL_LIMITS.queuedCount; count++) await queue.push(line({ method: 'item/completed', lifecycle: 'activity' }));
  await assert.rejects(queue.push(line({ method: 'item/completed', lifecycle: 'activity' })), expectCode('CODEX_QUEUE_OVERFLOW'));
  const server = core(); await readyTurn(server); server.drain(); for (let id = 1; id <= CODEX_PROTOCOL_LIMITS.outstandingRequests; id++) await server.push(line({ id: id + 100, method: 'item/approval', lifecycle: 'authority-request' }));
  await assert.rejects(server.push(line({ id: 165, method: 'item/approval', lifecycle: 'authority-request' })), expectCode('CODEX_PROTOCOL_VIOLATION'));
  const backpressure = core(async () => false); await readyTurn(backpressure); await assert.rejects(backpressure.push(line({ method: 'item/completed', lifecycle: 'activity', content: 'private', contentBytes: 7 })), expectCode('CODEX_CONTENT_BACKPRESSURE'));
});
