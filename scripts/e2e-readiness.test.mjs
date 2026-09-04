import assert from 'node:assert/strict';
import test from 'node:test';
import { discover, platformCapabilities, selectedScenario } from './e2e-readiness.mjs';
const context = { runId: '10000000-0000-4000-8000-000000000001', runtime: 'browser', platform: 'linux' };

test('discovery succeeds early and records only the safe reason and attempt', async () => {
    const logs = []; const waits = []; let clock = 0;
    const result = await discover({ ...context, reason: 'visible-contribution', deadlineMs: 10_000, now: () => clock, wait: async value => { waits.push(value); clock += value; }, logger: line => logs.push(line), probe: async ({ attempt }) => attempt === 3 && 'ready' });
    assert.equal(result, 'ready'); assert.deepEqual(waits, [100, 250]);
    assert.deepEqual(logs.map(line => { const value = JSON.parse(line.slice(line.indexOf('{'))); return { reason: value.reason, attempt: value.attempt }; }), [{ reason: 'visible-contribution', attempt: 1 }, { reason: 'visible-contribution', attempt: 2 }, { reason: 'visible-contribution', attempt: 3 }, { reason: 'visible-contribution', attempt: 3 }]);
});

test('discovery keeps probing until the deadline without leaking probe failures', async () => {
    const logs = []; const waits = []; let clock = 0; let attempts = 0;
    await assert.rejects(discover({ ...context, reason: 'fixture-readiness', deadlineMs: 10_000, now: () => clock, wait: async value => { waits.push(value); clock += value; }, logger: line => logs.push(line), probe: async () => { attempts++; throw new Error('private provider body'); } }), error => error.message === 'E2E_DISCOVERY_TIMEOUT' && error.stack === error.message);
    // The ramp opens the window and the last step repeats to the deadline.
    assert.equal(attempts, waits.length + 1);
    assert.deepEqual(waits.slice(0, 4), [100, 250, 500, 1_000]);
    assert.ok(waits.every(value => value <= 2_000), 'no wait exceeds the ramp ceiling');
    assert.ok(clock >= 10_000, 'the full deadline budget is used');
    assert.equal(logs.join('\n').includes('private provider body'), false);
    assert.match(logs.at(-1), /discovery\.failed.*E2E_APPLICATION_NOT_READY/u);
});

test('discovery and capability decisions reject open inputs', async () => {
    await assert.rejects(discover({ ...context, reason: 'submit', probe: async () => true }), /E2E_DISCOVERY_INVALID/u);
    await assert.rejects(discover({ ...context, reason: 'fixture-readiness', deadlineMs: 0, probe: async () => true }), /E2E_DISCOVERY_INVALID/u);
    assert.throws(() => platformCapabilities('mobile', 'linux'), /E2E_CAPABILITY_INVALID/u);
    assert.deepEqual(platformCapabilities('browser', 'windows').map(value => value.status), ['refusal-required','runtime-delegated']);
    assert.deepEqual(platformCapabilities('electron', 'linux').map(value => value.status), ['pending-qualification','available']);
    assert.equal(selectedScenario('browser', { KOGG_E2E_WORKFLOW_ONLY: '1' }), 'workflow');
    assert.equal(selectedScenario('electron', {}), 'portable-surface');
    assert.throws(() => selectedScenario('mobile', {}), /E2E_SCENARIO_INVALID/u);
});
