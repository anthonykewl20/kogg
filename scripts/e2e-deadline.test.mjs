import assert from 'node:assert/strict';
import test from 'node:test';
import { ABSOLUTE_DEADLINES_MS, HarnessAbsoluteDeadline } from './e2e-deadline.mjs';

const context = { runId: '10000000-0000-4000-8000-000000000001', runtime: 'browser', platform: 'linux' };

test('fires the one qualified absolute deadline with a closed safe error', async () => {
    const logs = []; let callback; let delay; let timeoutError; let invocations = 0;
    const deadline = new HarnessAbsoluteDeadline({ ...context, qualified: true, logger: line => logs.push(line), schedule: (next, milliseconds) => { callback = next; delay = milliseconds; return 1; }, cancel: () => assert.fail('expired timer must not be cancelled'), onTimeout: error => { invocations++; timeoutError = error; } });
    deadline.start(); assert.equal(delay, ABSOLUTE_DEADLINES_MS.qualified); callback(); callback(); await Promise.resolve();
    assert.equal(invocations, 1); assert.equal(timeoutError.message, 'E2E_ABSOLUTE_TIMEOUT'); assert.equal(timeoutError.stack, timeoutError.message);
    assert.deepEqual(logs.map(line => line.match(/deadline\.[a-z-]+/u)?.[0]), ['deadline.started','deadline.timed-out']);
    assert.doesNotMatch(logs.join('\n'), /prompt|path|body/iu);
});

test('cancels the portable deadline exactly once when settlement starts', () => {
    const logs = []; const cancelled = []; let callback;
    const deadline = new HarnessAbsoluteDeadline({ ...context, qualified: false, logger: line => logs.push(line), schedule: (next, milliseconds) => { callback = next; assert.equal(milliseconds, ABSOLUTE_DEADLINES_MS.portable); return 7; }, cancel: value => cancelled.push(value), onTimeout: () => assert.fail('completed deadline must not fire') });
    deadline.start(); deadline.complete(); deadline.complete(); callback();
    assert.deepEqual(cancelled, [7]); assert.deepEqual(logs.map(line => line.match(/deadline\.[a-z-]+/u)?.[0]), ['deadline.started','deadline.completed']);
    assert.throws(() => deadline.start(), /E2E_DEADLINE_TRANSITION_INVALID/u);
});
