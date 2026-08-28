import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserCredentialStore, electronCredentialService } from './credential-store';

test('browser credentials are encrypted at rest and expose metadata only', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kogg-credentials-'));
    const priorState = process.env.KOGG_STATE_DIR;
    const priorKey = process.env.KOGG_MASTER_KEY;
    process.env.KOGG_STATE_DIR = root;
    process.env.KOGG_MASTER_KEY = 'test-only-master-key';
    try {
        const store = new BrowserCredentialStore();
        await store.set('openai', 'default', 'sk-not-written-in-plaintext');
        assert.equal(await store.get('openai', 'default'), 'sk-not-written-in-plaintext');
        const onDisk = await fs.readFile(path.join(root, 'credentials', 'browser.enc.json'), 'utf8');
        assert.equal(onDisk.includes('sk-not-written-in-plaintext'), false);
        assert.deepEqual((await store.listMetadata()).map(({ provider, account }) => ({ provider, account })), [{ provider: 'openai', account: 'default' }]);
    } finally {
        if (priorState === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = priorState;
        if (priorKey === undefined) delete process.env.KOGG_MASTER_KEY; else process.env.KOGG_MASTER_KEY = priorKey;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('accepts only a cryptographically unique E2E Keychain service override', () => {
    const prior = process.env.KOGG_E2E_CREDENTIAL_SERVICE;
    try {
        delete process.env.KOGG_E2E_CREDENTIAL_SERVICE;
        assert.equal(electronCredentialService(), 'Kogg AI Providers');
        process.env.KOGG_E2E_CREDENTIAL_SERVICE = 'user-controlled-service';
        assert.equal(electronCredentialService(), 'Kogg AI Providers');
        process.env.KOGG_E2E_CREDENTIAL_SERVICE = `Kogg AI Providers E2E ${'a'.repeat(32)}`;
        assert.equal(electronCredentialService(), `Kogg AI Providers E2E ${'a'.repeat(32)}`);
    } finally {
        if (prior === undefined) delete process.env.KOGG_E2E_CREDENTIAL_SERVICE; else process.env.KOGG_E2E_CREDENTIAL_SERVICE = prior;
    }
});
