import assert from 'node:assert/strict'; import { PassThrough } from 'node:stream'; import test from 'node:test';
import type { OperationLease, ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import { CodexProcessHost, CodexProcessHostFault, type CodexOwnedHost, type QualifiedCodexExecutionOwner } from './codex-process-host';

// diagnostic-coverage: codex.confinement, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
function harness(options: { registrationFails?: boolean; host?: Partial<CodexOwnedHost>; residuals?: number; spawnFails?: boolean; spawnStalls?: boolean } = {}) {
  const events: string[] = []; let close!: (value: { exitClass: 'zero' | 'nonzero' | 'signal' }) => void; const closed = new Promise<{ exitClass: 'zero' | 'nonzero' | 'signal' }>(resolve => { close = resolve; });
  const process: ProcessLease = { id: 'process-1', spawning: () => events.push('process.spawning'), started: () => events.push('process.started'), ready: () => events.push('process.ready'), activity: () => undefined, failed: () => events.push('process.failed'), exited: value => events.push(`process.exited.${value}`), cleanup: () => events.push('process.cleaned') };
  const operation = { id: 'operation-1', registerProcess: () => { events.push('process.registered'); if (options.registrationFails) throw new Error('private registry failure'); return process; } } as unknown as OperationLease;
  const base: CodexOwnedHost = { pid: 42, identityVerified: true, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), closed };
  const owner: QualifiedCodexExecutionOwner = { spawn: async input => { events.push(`owner.spawn.${input.processRegistrationId}`); if (options.spawnFails) throw new Error('private spawn failure'); if (options.spawnStalls) return new Promise<CodexOwnedHost>(() => undefined); return { ...base, ...options.host }; }, terminate: async id => { events.push(`owner.terminate.${id}`); }, enumerateResiduals: async id => { events.push(`owner.enumerate.${id}`); return options.residuals ?? 0; } };
  const faults: string[] = []; return { events, close, faults, register: () => CodexProcessHost.register({ attemptId: 'attempt-1', operation, owner, onFault: code => { faults.push(code); }, spawnTimeoutMs: 20, cleanupTimeoutMs: 20 }) };
}
test('registers before requesting spawn and exposes only verified owned stdio', async () => {
  const value = harness(); const host = value.register(); const stdio = await host.start(); assert.ok(stdio.stdin); assert.deepEqual(value.events.slice(0, 5), ['process.registered', 'process.spawning', 'owner.spawn.process-1', 'process.started', 'process.ready']);
  const terminate = host.terminateOwnedHost(); value.close({ exitClass: 'signal' }); await terminate; assert.equal(await host.enumerateResiduals(), 0); assert.deepEqual(value.faults, []); assert.deepEqual(value.events.slice(-4), ['owner.terminate.process-1', 'process.exited.signal', 'owner.enumerate.process-1', 'process.cleaned']);
});
test('refuses registration before spawn and cleans a failed or unverified start', async () => {
  const registration = harness({ registrationFails: true }); assert.throws(() => registration.register(), error => error instanceof CodexProcessHostFault && error.code === 'CODEX_PROCESS_REGISTRATION_FAILED'); assert.equal(registration.events.includes('owner.spawn.process-1'), false);
  const failed = harness({ spawnFails: true }); await assert.rejects(failed.register().start(), error => error instanceof CodexProcessHostFault && error.code === 'CODEX_PROCESS_START_FAILED'); assert.deepEqual(failed.events.slice(-4), ['process.failed', 'owner.terminate.process-1', 'owner.enumerate.process-1', 'process.cleaned']);
  const identity = harness({ host: { identityVerified: false } }); await assert.rejects(identity.register().start(), error => error instanceof CodexProcessHostFault && error.code === 'CODEX_CONFINEMENT_UNVERIFIED'); assert.equal(identity.events.includes('process.cleaned'), true);
  const timeout = harness({ spawnStalls: true }); await assert.rejects(timeout.register().start(), error => error instanceof CodexProcessHostFault && error.code === 'CODEX_PROCESS_START_FAILED'); assert.equal(timeout.events.includes('process.cleaned'), true);
});
test('classifies unexpected host close and leaves residual cleanup externally provable', async () => {
  const value = harness({ residuals: 2 }); const host = value.register(); await host.start(); value.close({ exitClass: 'zero' }); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(value.faults, ['CODEX_HOST_EXITED']); assert.equal(await host.enumerateResiduals(), 2); assert.equal(value.events.includes('process.cleaned'), false);
});
test('does not expose private owner failures in supervision logs', async () => {
  const canary = `codex-host-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try { const value = harness(); const host = value.register(); await assert.rejects(CodexProcessHost.register({ attemptId: 'attempt-2', operation: { id: 'operation-2', registerProcess: () => ({ id: 'process-2', spawning: () => undefined, started: () => undefined, ready: () => undefined, activity: () => undefined, failed: () => undefined, exited: () => undefined, cleanup: () => undefined }) } as unknown as OperationLease, owner: { spawn: async () => { throw new Error(canary); }, terminate: async () => undefined, enumerateResiduals: async () => 0 }, onFault: () => undefined, spawnTimeoutMs: 20, cleanupTimeoutMs: 20 }).start()); assert.equal(logs.join('\n').includes(canary), false); assert.equal(host.processId, 'process-1'); }
  finally { console.error = original; }
});
