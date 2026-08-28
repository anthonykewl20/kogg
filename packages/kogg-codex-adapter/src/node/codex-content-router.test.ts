import assert from 'node:assert/strict'; import test from 'node:test'; import { CodexAttemptContentRouter } from './codex-content-router';
// diagnostic-coverage: codex.protocol, codex.cleanup, codex.source-maps
test('serializes authorized volatile content and proves a closed queue drained', async () => {
  let release!: () => void; const first = new Promise<void>(resolve => { release = resolve; }); const seen: Array<[number, unknown]> = [];
  const router = new CodexAttemptContentRouter('attempt-1', async delivery => { if (delivery.sequence === 1) await first; seen.push([delivery.sequence, delivery.content]); }, 8);
  const one = router.accept({ value: 'one' }, 4); const two = router.accept({ value: 'two' }, 4); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(router.diagnostics(), { closed: false, failed: false, pendingCount: 2, pendingBytes: 8, deliveredCount: 0 }); release(); assert.equal(await one, true); assert.equal(await two, true); assert.deepEqual(seen.map(value => value[0]), [1, 2]); router.closeInput(); assert.equal(await router.drain(100), true); assert.deepEqual(router.diagnostics(), { closed: true, failed: false, pendingCount: 0, pendingBytes: 0, deliveredCount: 2 }); assert.equal(await router.accept({ value: 'late' }, 1), false);
});
test('refuses byte overflow without dropping the accepted delivery or exposing its content', async () => {
  const canary = `codex-content-${Date.now()}`; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const logs: string[] = []; const original = { info: console.info, error: console.error }; console.info = (...values: unknown[]) => logs.push(JSON.stringify(values)); console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try { const router = new CodexAttemptContentRouter('attempt-2', async () => held, 4); const accepted = router.accept({ canary }, 4); await new Promise(resolve => setImmediate(resolve)); assert.equal(await router.accept({ canary }, 1), false); assert.equal(JSON.stringify(router.diagnostics()).includes(canary), false); release(); assert.equal(await accepted, true); assert.equal(logs.join('\n').includes(canary), false); }
  finally { console.info = original.info; console.error = original.error; }
});
test('fails queued deliveries after an authorized consumer failure and reports drain timeout', async () => {
  const failed = new CodexAttemptContentRouter('attempt-3', async () => { throw new Error('private consumer failure'); }, 8); assert.equal(await failed.accept({ private: true }, 1), false); assert.equal(await failed.accept({ private: true }, 1), false); assert.deepEqual(failed.diagnostics(), { closed: false, failed: true, pendingCount: 0, pendingBytes: 0, deliveredCount: 0 });
  const stalled = new CodexAttemptContentRouter('attempt-4', async () => new Promise<void>(() => undefined), 8); void stalled.accept({ private: true }, 1); await new Promise(resolve => setImmediate(resolve)); assert.equal(await stalled.drain(10), false); assert.deepEqual(stalled.diagnostics(), { closed: true, failed: true, pendingCount: 1, pendingBytes: 1, deliveredCount: 0 });
});
