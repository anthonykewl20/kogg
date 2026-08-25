import assert from 'node:assert/strict';
import test from 'node:test';
import type { CredentialStore } from '@kogg/contracts';
import { KoggProviderRegistry } from './provider-registry';
import { KoggProviderServiceImpl } from './provider-service-impl';

const credentials: CredentialStore = {
    set: async () => undefined,
    get: async () => 'google-test-secret',
    delete: async () => true,
    listMetadata: async () => []
};

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
        const service = new KoggProviderServiceImpl(registry, credentials);
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
