import assert from 'node:assert/strict';
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
    const requests: RequestInit[] = [];
    globalThis.fetch = async (_input, init) => {
        requests.push(init ?? {});
        return requests.length === 1
            ? new Response(JSON.stringify({ models: [{ name: 'gemini-test' }] }), { status: 200 })
            : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'advisory reply' }] } }] }), { status: 200 });
    };
    try {
        const registry = new KoggProviderRegistry(credentials);
        assert.deepEqual(await registry.discoverModels('google', 'default', 'https://google.invalid/models'), [
            { id: 'gemini-test', name: 'gemini-test', provider: 'google' }
        ]);
        const service = new KoggProviderServiceImpl(registry, credentials, operations);
        assert.equal(await service.advisoryChat({
            provider: 'google', account: 'default', endpoint: 'https://google.invalid/models',
            model: 'gemini-test', prompt: 'test prompt'
        }), 'advisory reply');

        for (const request of requests) {
            const headers = new Headers(request.headers);
            assert.equal(headers.get('x-goog-api-key'), 'google-test-secret');
            assert.equal(headers.has('authorization'), false);
        }
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
    const service = new KoggProviderServiceImpl(new KoggProviderRegistry(missingCredentials), missingCredentials, observedOperations);

    assert.deepEqual(await service.testConnection('openai', 'default'), { ok: false, detail: 'Credential is not configured' });
    assert.equal(events.includes('complete'), true);
    assert.equal(events.includes('fail'), false);
});
