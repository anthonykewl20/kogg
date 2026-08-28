import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexClientFault, CodexProtocolClient } from './codex-protocol-client';
import type { CodexContentRouter, CodexFrameSchema, CodexSafeObservation, CodexValidatedFrame } from './codex-protocol-core';
import { CodexStdioDrainer } from './codex-stdio-drainer';

// diagnostic-coverage: codex.protocol, codex.cleanup, codex.source-maps
class MemoryStdin extends EventEmitter { destroyed = false; writableLength = 0; readonly writes: Buffer[] = []; write(value: Uint8Array): boolean { this.writes.push(Buffer.from(value)); return true; } }
const accepted = new Set(['turn/started', 'item/completed', 'turn/completed', 'item/approval']);
const schema: CodexFrameSchema = { validate(frame) {
  const keys = Object.keys(frame).sort().join(',');
  if (keys === 'id,outcome,result' && typeof frame.id === 'number' && frame.outcome === 'result') return { kind: 'response', id: frame.id, outcome: 'result', privateResult: frame.result };
  if (keys === 'id,outcome' && typeof frame.id === 'number' && frame.outcome === 'error') return { kind: 'response', id: frame.id, outcome: 'error' };
  if (keys === 'lifecycle,method' && typeof frame.method === 'string') return { kind: 'notification', method: frame.method, lifecycle: frame.lifecycle } as CodexValidatedFrame;
  if (keys === 'id,lifecycle,method' && typeof frame.id === 'number' && frame.lifecycle === 'authority-request') return { kind: 'server-request', id: frame.id, method: String(frame.method), lifecycle: 'authority-request' };
  return undefined;
} };
const line = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);
const fault = (code: string) => (error: unknown): boolean => error instanceof CodexClientFault && error.code === code;
function create(content: CodexContentRouter = { accept: async () => true }): { client: CodexProtocolClient; stdin: MemoryStdin; observations: Array<{ sequence: number; observation: CodexSafeObservation }> } {
  const stdin = new MemoryStdin(); const observations: Array<{ sequence: number; observation: CodexSafeObservation }> = [];
  const client = new CodexProtocolClient({ attemptId: 'attempt-1', schema, acceptedInboundMethods: accepted, stdin: stdin as never, content, authorityDenial: id => ({ id, error: { code: -32600, message: 'Denied by Kogg policy' } }), onObservation: (sequence, observation) => observations.push({ sequence, observation }) });
  return { client, stdin, observations };
}

test('correlates private results while exposing only sequenced safe lifecycle observations', async () => {
  const { client, stdin, observations } = create();
  const initialize = client.request('initialize', { clientInfo: { name: 'kogg', version: '1.0.0' }, capabilities: {} }); await client.push(line({ id: 1, outcome: 'result', result: { privatePlatform: 'linux' } })); assert.deepEqual(await initialize, { privatePlatform: 'linux' }); await client.initialized();
  const thread = client.request('thread/start', { ephemeral: true }); await client.push(line({ id: 2, outcome: 'result', result: { thread: { id: 'private-thread' } } })); assert.deepEqual(await thread, { thread: { id: 'private-thread' } });
  const turn = client.request('turn/start', { input: [{ type: 'text', text: 'private-input' }] }); await client.push(line({ id: 3, outcome: 'result', result: { turn: { id: 'private-turn' } } })); await turn;
  await client.push(line({ method: 'turn/started', lifecycle: 'turn-started' })); await client.push(line({ method: 'item/completed', lifecycle: 'activity' })); await client.push(line({ method: 'turn/completed', lifecycle: 'turn-completed' }));
  assert.deepEqual(observations.map(value => [value.sequence, value.observation.kind === 'notification' ? value.observation.lifecycle : value.observation.kind]), [[1, 'response'], [2, 'response'], [3, 'response'], [4, 'turn-started'], [5, 'activity'], [6, 'turn-completed']]);
  assert.equal(JSON.stringify(observations).includes('private'), false); assert.match(Buffer.concat(stdin.writes).toString(), /"method":"initialize"/u);
});

test('denies authority requests exactly once, settles the private correlation, and fails the turn closed', async () => {
  const { client, stdin, observations } = create(); const initialize = client.request('initialize', {}); await client.push(line({ id: 1, outcome: 'result', result: {} })); await initialize; await client.initialized(); const thread = client.request('thread/start', {}); await client.push(line({ id: 2, outcome: 'result', result: {} })); await thread; const turn = client.request('turn/start', {}); await client.push(line({ id: 3, outcome: 'result', result: {} })); await turn; await client.push(line({ method: 'turn/started', lifecycle: 'turn-started' }));
  await assert.rejects(client.push(Buffer.concat([line({ id: 91, method: 'item/approval', lifecycle: 'authority-request' }), line({ method: 'turn/completed', lifecycle: 'turn-completed' })])), fault('CODEX_AUTHORITY_REQUESTED')); assert.deepEqual(client.outstanding(), { client: 0, server: 0 }); assert.equal(client.faulted(), true); assert.equal(observations.some(value => value.observation.kind === 'notification' && value.observation.lifecycle === 'turn-completed'), false);
  const denials = stdin.writes.map(value => value.toString()).filter(value => value.includes('Denied by Kogg policy')); assert.equal(denials.length, 1); assert.match(denials[0]!, /"id":91/u);
});

test('classifies request refusal and rejects every waiter after a protocol fault without logging private data', async () => {
  const refused = create(); const initialize = refused.client.request('initialize', {}); await assert.rejects(refused.client.push(line({ id: 1, outcome: 'error' }))); await assert.rejects(initialize);
  const canary = `codex-client-private-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try { const invalid = create(); const pending = invalid.client.request('initialize', { value: canary }); await assert.rejects(invalid.client.push(line({ unknown: canary }))); await assert.rejects(pending); assert.equal(logs.join('\n').includes(canary), false); }
  finally { console.error = original; }
  const requestError = create(); const first = requestError.client.request('initialize', {}); await requestError.client.push(line({ id: 1, outcome: 'result', result: {} })); await first; await requestError.client.initialized(); const thread = requestError.client.request('thread/start', {}); await requestError.client.push(line({ id: 2, outcome: 'result', result: {} })); await thread; const turn = requestError.client.request('turn/start', {}); await requestError.client.push(line({ id: 3, outcome: 'result', result: {} })); await turn; await requestError.client.push(line({ method: 'turn/started', lifecycle: 'turn-started' })); const interrupt = requestError.client.request('turn/interrupt', {}); await requestError.client.push(line({ id: 4, outcome: 'error' })); await assert.rejects(interrupt, fault('CODEX_PROVIDER_REFUSED'));
  const brokenNotification = create(); const ready = brokenNotification.client.request('initialize', {}); await brokenNotification.client.push(line({ id: 1, outcome: 'result', result: {} })); await ready; brokenNotification.stdin.destroyed = true; await assert.rejects(brokenNotification.client.initialized()); await assert.rejects(brokenNotification.client.request('thread/start', {}));
});

test('closes content input on cleanup or protocol failure and fails a stalled content drain closed', async () => {
  let closed = 0; const cleanup = create({ accept: async () => true, closeInput: () => { closed++; }, drain: async () => true }); cleanup.client.beginCleanup(); assert.equal(closed, 1); await cleanup.client.drainContent(10); assert.equal(closed, 2);
  let faultClosed = 0; const invalid = create({ accept: async () => true, closeInput: () => { faultClosed++; } }); const pending = invalid.client.request('initialize', {}); await assert.rejects(invalid.client.push(line({ invalid: true }))); await assert.rejects(pending); assert.equal(faultClosed, 1);
  const stalled = create({ accept: async () => true, closeInput: () => undefined, drain: async () => false }); await assert.rejects(stalled.client.drainContent(10), fault('CODEX_CONTENT_BACKPRESSURE')); await assert.rejects(stalled.client.request('initialize', {}));
});

test('abandons a timed-out interrupt correlation during cleanup and validates a late reply without reviving it', async () => {
  const { client } = create(); const initialize = client.request('initialize', {}); await client.push(line({ id: 1, outcome: 'result', result: {} })); await initialize; await client.initialized(); const thread = client.request('thread/start', {}); await client.push(line({ id: 2, outcome: 'result', result: {} })); await thread; const turn = client.request('turn/start', {}); await client.push(line({ id: 3, outcome: 'result', result: {} })); await turn; await client.push(line({ method: 'turn/started', lifecycle: 'turn-started' }));
  const interrupt = client.request('turn/interrupt', {}); client.beginCleanup(); await assert.rejects(interrupt, fault('CODEX_CANCELLED')); await client.push(line({ id: 4, outcome: 'result', result: {} })); assert.equal(client.faulted(), false); const shutdown = client.request('shutdown', {}); await client.push(line({ id: 5, outcome: 'result', result: {} })); await shutdown;
});

test('owns split stdout through the protocol client while stderr remains discard-only', async () => {
  const value = create(); const stdout = new PassThrough(); const stderr = new PassThrough(); const faults: string[] = []; const draining = new CodexStdioDrainer(value.client, code => { faults.push(code); }).run(stdout, stderr);
  const initialize = value.client.request('initialize', {}); const response = line({ id: 1, outcome: 'result', result: { privateValue: true } }); stdout.write(response.subarray(0, 4)); stdout.write(response.subarray(4)); assert.deepEqual(await initialize, { privateValue: true });
  stdout.end(); stderr.end('private stderr must be discarded'); assert.deepEqual(await draining, { stderrBytes: 32, faulted: false }); assert.deepEqual(faults, []); assert.equal(JSON.stringify(value.observations).includes('privateValue'), false);
});
