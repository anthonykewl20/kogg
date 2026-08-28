import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HarnessRunManifest } from './e2e-run-manifest.mjs';
import { platformCapabilities } from './e2e-readiness.mjs';

const runId = '10000000-0000-4000-8000-000000000001'; const cleaned = [{ id: 'fixture-1', kind: 'signed-registry', state: 'cleaned', forced: false, exitClass: 'signal' }];
const verified = { oracle: 'pass', sourceMap: 'pass', mappedCount: 11 };
test('atomically records the complete successful run lifecycle and closed checks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-run-manifest-')); const logs = [];
    try { const run = await HarnessRunManifest.create({ root, runtime: 'browser', platform: 'linux', capabilities: platformCapabilities('browser', 'linux'), runId, logger: line => logs.push(line) }); await run.starting(); await run.active('portable-surface'); await run.scenarioCompleted(); await run.cleaning([{ ...cleaned[0], state: 'ready', exitClass: 'unknown' }]); await run.completed({ fixtures: cleaned, residualCount: 0, verification: verified }); const value = await run.read(); assert.equal(value.state, 'completed'); assert.equal(value.scenarioState, 'completed'); assert.deepEqual(value.steps, [{ id: 'visible-journey', state: 'passed' }]); assert.deepEqual(value.capabilities.map(capability => capability.status), ['pending-qualification','available']); assert.deepEqual(value.harnessChecks.map(check => check.status), ['pass','pass','pass','pass','pass']); assert.equal(value.harnessChecks.at(-1).mappedCount, 11); assert.deepEqual(logs.map(line => line.match(/(?:run|scenario|step|residual-check)\.[a-z.]+/u)?.[0]).filter(Boolean), ['run.requested','run.started','scenario.started','step.started','step.completed','scenario.completed','residual-check.started','residual-check.completed','run.completed']); }
    finally { await rm(root, { recursive: true, force: true }); }
});
test('cleanup failure overrides success and terminal states cannot be rewritten', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-run-manifest-'));
    try { const run = await HarnessRunManifest.create({ root, runtime: 'electron', platform: 'macos', capabilities: platformCapabilities('electron', 'macos'), runId }); await run.starting(); await run.active('portable-surface'); await run.scenarioFailed(); await run.cleaning(cleaned); const residual = [{ ...cleaned[0], state: 'residual', exitClass: 'unknown' }]; await assert.rejects(run.completed({ fixtures: residual, residualCount: 1, verification: verified }), /E2E_MANIFEST_SUCCESS_REFUSED/u); assert.equal((await run.read()).state, 'cleaning'); await run.failed({ fixtures: residual, residualCount: 1, safeCode: 'E2E_PROCESS_RESIDUAL' }); const failed = await run.read(); assert.equal(failed.state, 'failed'); assert.equal(failed.scenarioState, 'failed'); assert.deepEqual(failed.steps, [{ id: 'visible-journey', state: 'failed', safeCode: 'E2E_STEP_FAILED' }]); assert.equal(failed.harnessChecks.find(check => check.id === 'e2e.processes').status, 'fail'); assert.deepEqual(failed.harnessChecks.slice(-2).map(check => check.status), ['fail','fail']); await assert.rejects(run.failed({ fixtures: residual, residualCount: 1 }), /E2E_MANIFEST_TRANSITION_INVALID/u); }
    finally { await rm(root, { recursive: true, force: true }); }
});
test('manifest refuses cleanup before a visible scenario reaches a terminal state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-run-manifest-'));
    try { const run = await HarnessRunManifest.create({ root, runtime: 'browser', platform: 'linux', capabilities: platformCapabilities('browser', 'linux'), runId }); await run.starting(); await run.active('portable-surface'); await assert.rejects(run.cleaning(cleaned), /E2E_MANIFEST_SCENARIO_INCOMPLETE/u); await run.scenarioFailed(); await assert.rejects(run.scenarioCompleted(), /E2E_MANIFEST_SCENARIO_INVALID/u); }
    finally { await rm(root, { recursive: true, force: true }); }
});
test('manifest refuses missing or duplicate capability decisions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-run-manifest-'));
    try { await assert.rejects(HarnessRunManifest.create({ root, runtime: 'browser', platform: 'linux', runId }), /E2E_MANIFEST_INVALID/u); const duplicate = [platformCapabilities('browser', 'linux')[0], platformCapabilities('browser', 'linux')[0]]; await assert.rejects(HarnessRunManifest.create({ root, runtime: 'browser', platform: 'linux', capabilities: duplicate, runId }), /E2E_MANIFEST_INVALID/u); await assert.rejects(HarnessRunManifest.create({ root, runtime: 'browser', platform: 'linux', capabilities: platformCapabilities('browser', 'windows'), runId }), /E2E_MANIFEST_INVALID/u); }
    finally { await rm(root, { recursive: true, force: true }); }
});
