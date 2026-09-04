import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CredentialStore } from '@kogg/contracts';
import type { OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { KoggProviderRegistry } from './provider-registry';
import { KoggProviderServiceImpl } from './provider-service-impl';

const credentials: CredentialStore = {
    set: async () => undefined,
    get: async () => 'google-test-secret',
    delete: async () => true,
    listMetadata: async () => []
};
const operations = {
    startOperation: async () => ({
        id: 'provider-test-operation', cancellable: false, start() {}, active() {}, waiting() {}, activity() {}, refuse() {},
        complete() {}, fail() {}, timeout() {}, cancel: async () => undefined, cleanup: async () => undefined,
        registerProcess() { throw new Error('No process is expected in this provider test'); }
    })
} as unknown as OperationRegistryApi;

test('uses the Google API-key header for discovery and advisory chat without exposing it as a bearer token', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ init: RequestInit; url: string }> = [];
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        requests.push({ init: init ?? {}, url });
        return requests.length === 1
            ? new Response(JSON.stringify({ models: [{ name: 'gemini-test' }] }), { status: 200 })
            : new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    const encoder = new TextEncoder();
                    const frame = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
                    controller.enqueue(frame({ candidates: [{ content: { parts: [{ text: 'advisory ' }] } }] }));
                    controller.enqueue(frame({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'reply' }] } }] }));
                    controller.close();
                }
            }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    try {
        const registry = new KoggProviderRegistry(credentials);
        assert.deepEqual(await registry.discoverModels('google', 'default', 'https://google.invalid/models'), [
            { id: 'gemini-test', name: 'gemini-test', provider: 'google' }
        ]);
        const service = new KoggProviderServiceImpl(registry, credentials, operations, { state: () => ({ status: 'idle', needsCode: false }), chat: async () => 'plan reply' } as never);
        assert.equal(await service.advisoryChat({
            provider: 'google', account: 'default', endpoint: 'https://google.invalid/models',
            model: 'gemini-test', prompt: 'test prompt'
        }), 'advisory reply');

        for (const request of requests) {
            const headers = new Headers(request.init.headers);
            assert.equal(headers.get('x-goog-api-key'), 'google-test-secret');
            assert.equal(headers.has('authorization'), false);
        }
        assert.match(requests[1]!.url, /:streamGenerateContent\?alt=sse/u);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('returns an actionable negative connection result without misclassifying it as an operation failure', async () => {
    const events: string[] = [];
    const missingCredentials: CredentialStore = {
        set: async () => undefined, get: async () => undefined, delete: async () => false, listMetadata: async () => []
    };
    const observedOperations = {
        startOperation: async () => ({
            id: 'negative-provider-test', cancellable: false, start() { events.push('start'); }, active() { events.push('active'); },
            waiting() {}, activity() {}, refuse() {}, complete() { events.push('complete'); }, fail() { events.push('fail'); },
            timeout() {}, cancel: async () => undefined, cleanup: async () => { events.push('cleanup'); },
            registerProcess() { throw new Error('No process is expected in this provider test'); }
        })
    } as unknown as OperationRegistryApi;
    const service = new KoggProviderServiceImpl(new KoggProviderRegistry(missingCredentials), missingCredentials, observedOperations, { state: () => ({ status: 'idle', needsCode: false }), chat: async () => 'plan reply' } as never);

    assert.deepEqual(await service.testConnection('openai', 'default'), { ok: false, detail: 'Credential is not configured' });
    assert.equal(events.includes('complete'), true);
    assert.equal(events.includes('fail'), false);
});

test('imports the signed-in Codex plan account and chats through the streaming responses API', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-codex-import-'));
    const authFile = path.join(directory, 'auth.json');
    await writeFile(authFile, JSON.stringify({ tokens: { access_token: 'codex-access-token', account_id: 'acct-1' } }));
    const previous = process.env.KOGG_CODEX_AUTH_FILE;
    process.env.KOGG_CODEX_AUTH_FILE = authFile;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url?: string | URL; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
        requests.push({ url: input instanceof Request ? input.url : String(input), init });
        const url = String(input);
        if (url.includes('/backend-api/codex/models')) return new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra' }] }), { status: 200 });
        if (url.includes('/backend-api/codex/responses')) return new Response('', { status: 405 });
        throw new Error(`Unexpected fetch ${url}`);
    };
    try {
        const store = new Map<string, string>();
        const storeCredentials: CredentialStore = {
            set: async (provider, account, secret) => { store.set(`${provider}/${account}`, secret); },
            get: async (provider, account) => store.get(`${provider}/${account}`),
            delete: async () => true,
            listMetadata: async () => []
        };
        const registry = new KoggProviderRegistry(storeCredentials);
        await registry.importAccountCredential('codex-plan', 'default');
        assert.equal(await registry.credentialStatus('codex-plan', 'default'), 'configured');
        const connection = await registry.testConnection('codex-plan', 'default');
        assert.deepEqual(connection, { ok: true, detail: 'Connected to the ChatGPT plan account' });
        const models = await registry.discoverModels('codex-plan', 'default');
        assert.deepEqual(models, [{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'codex-plan' }]);
        const service = new KoggProviderServiceImpl(registry, storeCredentials, operations, { state: () => ({ status: 'idle', needsCode: false }), chat: async () => 'plan reply' } as never);
        assert.equal(await service.advisoryChat({ provider: 'codex-plan', account: 'default', model: 'gpt-5.6-sol', prompt: 'ping' }), 'plan reply');
        assert.equal(store.get('codex-plan/default'), JSON.stringify({ accessToken: 'codex-access-token', accountId: 'acct-1' }));
    } finally {
        globalThis.fetch = originalFetch;
        if (previous === undefined) delete process.env.KOGG_CODEX_AUTH_FILE; else process.env.KOGG_CODEX_AUTH_FILE = previous;
        await rm(directory, { recursive: true, force: true });
    }
});

test('refuses account imports when the CLI sign-in is absent and never stores partial credentials', async () => {
    const previous = process.env.KOGG_CODEX_AUTH_FILE;
    const previousClaude = process.env.KOGG_CLAUDE_CREDENTIALS_COMMAND;
    process.env.KOGG_CODEX_AUTH_FILE = path.join(os.tmpdir(), 'kogg-missing-auth.json');
    process.env.KOGG_CLAUDE_CREDENTIALS_COMMAND = path.join(os.tmpdir(), 'kogg-missing-security');
    const storeCredentials: CredentialStore = { set: async () => undefined, get: async () => undefined, delete: async () => true, listMetadata: async () => [] };
    try {
        const registry = new KoggProviderRegistry(storeCredentials);
        await assert.rejects(() => registry.importAccountCredential('codex-plan', 'default'), /codex login/);
        await assert.rejects(() => registry.importAccountCredential('claude-max', 'default'), /claude/i);
        await assert.rejects(() => registry.importAccountCredential('openai', 'default'), /signed-in account import/);
    } finally {
        if (previous === undefined) delete process.env.KOGG_CODEX_AUTH_FILE; else process.env.KOGG_CODEX_AUTH_FILE = previous;
        if (previousClaude === undefined) delete process.env.KOGG_CLAUDE_CREDENTIALS_COMMAND; else process.env.KOGG_CLAUDE_CREDENTIALS_COMMAND = previousClaude;
    }
});
