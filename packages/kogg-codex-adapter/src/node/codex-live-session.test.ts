import assert from 'node:assert/strict'; import { PassThrough } from 'node:stream'; import test from 'node:test';
import { CodexLiveSession, CodexLiveSessionFault, type CodexLiveSessionHost } from './codex-live-session';
import { CodexCredentialFault } from './codex-credential-reservation';
import { CodexProtocolClient } from './codex-protocol-client'; import type { CodexFrameSchema, CodexValidatedFrame } from './codex-protocol-core';

// diagnostic-coverage: codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const schema: CodexFrameSchema = { validate(frame) {
  const keys = Object.keys(frame).sort().join(','); if (keys === 'id,outcome,result' && typeof frame.id === 'number') return { kind: 'response', id: frame.id, outcome: 'result', privateResult: frame.result };
  if (keys === 'lifecycle,method' && typeof frame.method === 'string') return { kind: 'notification', method: frame.method, lifecycle: frame.lifecycle } as CodexValidatedFrame; return undefined;
} };
function fixture(sendTurnStarted = true, privatePrompt: unknown = true, activationFails = false) {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough(); const events: string[] = []; const observations: string[] = []; const faults: string[] = []; let buffer = '';
  stdin.on('data', chunk => { buffer += Buffer.from(chunk).toString('utf8'); while (buffer.includes('\n')) { const end = buffer.indexOf('\n'); const frame = JSON.parse(buffer.slice(0, end)) as { id?: number; method?: string }; buffer = buffer.slice(end + 1); if (frame.id) stdout.write(`${JSON.stringify({ id: frame.id, outcome: 'result', result: { privateId: frame.method } })}\n`); if (frame.method === 'turn/start' && sendTurnStarted) stdout.write(`${JSON.stringify({ method: 'turn/started', lifecycle: 'turn-started' })}\n`); events.push(`request.${frame.method}`); } });
  let streamsClosed = false; const closeStreams = (): void => { if (streamsClosed) return; streamsClosed = true; stdout.end(); stderr.end(); };
  const host: CodexLiveSessionHost = { processId: 'process-1', start: async () => { events.push('host.started'); return { stdin, stdout, stderr }; }, terminateOwnedHost: async () => { events.push('host.terminated'); closeStreams(); }, enumerateResiduals: async () => { events.push('host.enumerated'); return 0; } };
  let contentClosed = 0; const session = new CodexLiveSession({ attemptId: 'attempt-1', operationId: 'operation-1', host, initializeParams: {}, threadParams: { ephemeral: true }, turnParams: { privatePrompt }, activateCredentials: processId => { events.push(`credentials.activated.${processId}`); if (activationFails) throw new CodexCredentialFault('CODEX_CREDENTIAL_LEASE_REFUSED'); }, revokeCredentials: () => { events.push('credentials.revoked'); }, onObservation: (_sequence, observation) => { if (observation.kind === 'notification') observations.push(observation.lifecycle); }, onFault: code => { faults.push(code); }, startTimeoutMs: 20, cleanupTimeoutMs: 20,
    createClient: (stream, onObservation) => new CodexProtocolClient({ attemptId: 'attempt-1', schema, acceptedInboundMethods: new Set(['turn/started', 'turn/completed']), stdin: stream, content: { accept: async () => true, closeInput: () => { contentClosed++; }, drain: async () => true }, authorityDenial: id => ({ id, error: {} }), onObservation }) });
  return { session, stdout, events, observations, faults, contentClosed: () => contentClosed };
}
test('composes verified host stdio through initialize, thread, turn, terminal cleanup, and empty enumeration', async () => {
  const value = fixture(); await value.session.start(); assert.deepEqual(value.observations, ['turn-started']); assert.equal(value.events.indexOf('credentials.activated.process-1') < value.events.indexOf('host.started'), true); value.stdout.write(`${JSON.stringify({ method: 'turn/completed', lifecycle: 'turn-completed' })}\n`); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await value.session.cleanup(), { terminalCode: 'CODEX_OK', residualCount: 0, cleaned: true }); assert.equal(value.events.indexOf('credentials.revoked') < value.events.indexOf('request.shutdown'), true); assert.deepEqual(value.events.slice(-2), ['host.terminated', 'host.enumerated']); assert.equal(value.contentClosed() >= 1, true); assert.deepEqual(value.faults, []);
});
test('cancellation interrupts exactly once before shutdown and preserves cancelled terminal precedence', async () => {
  const value = fixture(); await value.session.start(); assert.deepEqual(await value.session.cancel(), { terminalCode: 'CODEX_CANCELLED', residualCount: 0, cleaned: true }); assert.equal(value.events.filter(event => event === 'request.turn/interrupt').length, 1); assert.equal(value.events.indexOf('request.turn/interrupt') < value.events.indexOf('request.shutdown'), true);
});
test('first-activity timeout interrupts and fully cleans without exposing private turn params', async () => {
  const canary = `codex-live-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try { const value = fixture(false, canary); await assert.rejects(value.session.start(), error => error instanceof CodexLiveSessionFault && error.code === 'CODEX_FIRST_ACTIVITY_TIMEOUT' && error.cleanup.cleaned); assert.equal(value.events.includes('request.turn/interrupt'), true); assert.deepEqual(value.events.slice(-2), ['host.terminated', 'host.enumerated']); assert.equal(logs.join('\n').includes(canary), false); }
  finally { console.error = original; }
});
test('credential activation refusal prevents host spawn and still completes cleanup', async () => {
  const value = fixture(true, true, true); await assert.rejects(value.session.start(), error => error instanceof CodexLiveSessionFault && error.code === 'CODEX_CREDENTIAL_LEASE_REFUSED' && error.cleanup.cleaned); assert.equal(value.events.includes('host.started'), false); assert.equal(value.events.indexOf('credentials.activated.process-1') < value.events.indexOf('credentials.revoked'), true); assert.deepEqual(value.events.slice(-2), ['host.terminated', 'host.enumerated']);
});
