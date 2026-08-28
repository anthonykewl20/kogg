import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HarnessRunManifest } from './e2e-run-manifest.mjs';

const runId = '10000000-0000-4000-8000-000000000001'; const cleaned = [{ id: 'fixture-1', kind: 'signed-registry', state: 'cleaned', forced: false, exitClass: 'signal' }];
test('atomically records the complete successful run lifecycle and closed checks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-run-manifest-')); const logs = [];
    try { const run = await HarnessRunManifest.create({ root, runtime: 'browser', platform: 'linux', runId, logger: line => logs.push(line) }); await run.starting(); await run.active(); await run.cleaning([{ ...cleaned[0], state: 'ready', exitClass: 'unknown' }]); await run.completed({ fixtures: cleaned, residualCount: 0 }); const value = await run.read(); assert.equal(value.state, 'completed'); assert.deepEqual(value.harnessChecks.map(check => check.status), ['pass','pass','pass']); assert.deepEqual(logs.map(line => line.match(/(?:run|residual-check)\.[a-z.]+/u)?.[0]).filter(Boolean), ['run.requested','run.started','residual-check.started','residual-check.completed','run.completed']); }
    finally { await rm(root, { recursive: true, force: true }); }
});
test('cleanup failure overrides success and terminal states cannot be rewritten', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-run-manifest-'));
    try { const run = await HarnessRunManifest.create({ root, runtime: 'electron', platform: 'macos', runId }); await run.starting(); await run.active(); await run.cleaning(cleaned); const residual = [{ ...cleaned[0], state: 'residual', exitClass: 'unknown' }]; await assert.rejects(run.completed({ fixtures: residual, residualCount: 1 }), /E2E_MANIFEST_SUCCESS_REFUSED/u); assert.equal((await run.read()).state, 'cleaning'); await run.failed({ fixtures: residual, residualCount: 1, safeCode: 'E2E_PROCESS_RESIDUAL' }); const failed = await run.read(); assert.equal(failed.state, 'failed'); assert.equal(failed.harnessChecks.find(check => check.id === 'e2e.processes').status, 'fail'); await assert.rejects(run.failed({ fixtures: residual, residualCount: 1 }), /E2E_MANIFEST_TRANSITION_INVALID/u); }
    finally { await rm(root, { recursive: true, force: true }); }
});
