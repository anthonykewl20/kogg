import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyRepository, verifySourceMapText } from './e2e-verifier.mjs';

test('independent Git/filesystem oracle accepts only a clean tracked fixture', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-e2e-oracle-'));
    try {
        await writeFile(path.join(root, 'README.md'), '# fixture\n');
        for (const args of [['init'],['config','user.name','Kogg E2E'],['config','user.email','kogg@example.invalid'],['add','README.md'],['commit','-m','fixture']]) assert.equal(spawnSync('git', ['-C', root, ...args], { stdio: 'ignore' }).status, 0);
        assert.equal(await verifyRepository(root), true); await writeFile(path.join(root, 'README.md'), '# Kogg E2E\nHuman workflow change.\n'); assert.equal(await verifyRepository(root, 'browser-baseline'), true); await assert.rejects(verifyRepository(root, 'clean'), /E2E_ORACLE_MISMATCH/u);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('source-map verifier requires a real generated-to-TypeScript statement mapping', () => {
    assert.equal(verifySourceMapText(JSON.stringify({ version: 3, file: 'output.js', sources: ['source.ts'], names: [], mappings: 'AAAA' })), 1);
    assert.throws(() => verifySourceMapText(JSON.stringify({ version: 3, file: 'output.js', sources: ['output.js'], names: [], mappings: 'AAAA' })), /E2E_SOURCE_MAP_MISSING/u);
    assert.throws(() => verifySourceMapText('{private-invalid-map'), error => error.message === 'E2E_SOURCE_MAP_MISSING' && error.stack === error.message);
});
