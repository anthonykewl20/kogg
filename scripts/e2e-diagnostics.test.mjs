import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyProductDiagnostics } from './e2e-diagnostics.mjs';

const context = { runId: '10000000-0000-4000-8000-000000000001', runtime: 'browser', platform: 'linux' };
test('requires exact catalog coverage and records only aggregate diagnostic outcomes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-e2e-diagnostics-')); const logs = [];
    try {
        await mkdir(path.join(root, 'diagnostics')); await writeFile(path.join(root, 'diagnostics/catalog.json'), JSON.stringify({ schemaVersion: 1, checks: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] }));
        const value = await verifyProductDiagnostics({ root, ...context, logger: line => logs.push(line), report: { schemaVersion: 1, overall: 'fail', checks: [{ id: 'three', status: 'fail', summary: 'private' }, { id: 'one', status: 'pass' }, { id: 'two', status: 'warn' }] } });
        assert.deepEqual(value, { coverage: 'complete', checkCount: 3, passCount: 1, warnCount: 1, failCount: 1 }); assert.equal(logs.join('\n').includes('private'), false); assert.match(logs.at(-1), /diagnostics\.completed/u);
        await assert.rejects(verifyProductDiagnostics({ root, ...context, logger: line => logs.push(line), report: { schemaVersion: 1, overall: 'pass', checks: [{ id: 'one', status: 'pass', details: 'private-canary' }] } }), error => error.message === 'E2E_DIAGNOSTICS_INCOMPLETE' && error.stack === error.message);
        assert.equal(logs.join('\n').includes('private-canary'), false); assert.match(logs.at(-1), /diagnostics\.failed.*E2E_DIAGNOSTICS_INCOMPLETE/u);
    } finally { await rm(root, { recursive: true, force: true }); }
});
