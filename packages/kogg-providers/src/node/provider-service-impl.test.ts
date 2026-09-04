import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { AccountLoginManager } from './account-login-manager';
import { KoggProviderServiceImpl } from './provider-service-impl';
import type { ChatStreamEvent, KoggProviderChatClient } from '../common/provider-service';

const operations = {
    startOperation: async () => ({
        id: 'chat-test-operation', cancellable: false, start() {}, active() {}, waiting() {}, activity() {}, refuse() {}, complete() {}, fail() {}, timeout() {}, cancel: async () => undefined,
        cleanup: async () => undefined,
        registerProcess: () => ({ spawning() {}, started() {}, ready() {}, activity() {}, failed() {}, exited() {}, cleanup() {} })
    })
} as unknown as OperationRegistryApi;

class RecordingChatClient implements KoggProviderChatClient {
    readonly events: ChatStreamEvent[] = [];
    onChatEvent(event: ChatStreamEvent): void { this.events.push(event); }
    deltas(): string[] { return this.events.filter(event => event.kind === 'delta').map(event => event.text ?? ''); }
}

function sseResponse(frames: string[], options: { holdOpen?: boolean; signal?: AbortSignal } = {}): Response {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            if (!options.holdOpen) controller.close();
        }
    });
    // Real fetch errors the response body with an AbortError when the request
    // signal fires; mirror that so cancellation paths are exercised end to end.
    options.signal?.addEventListener('abort', () => {
        const abort = new Error('This operation was aborted');
        abort.name = 'AbortError';
        streamController?.error(abort);
    }, { once: true });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface CapturedRequest { readonly url: string; readonly body: Record<string, unknown>; }

function stubFetch(responder: (url: string, body: Record<string, unknown>, signal?: AbortSignal) => Response): { requests: CapturedRequest[]; restore(): void } {
    const requests: CapturedRequest[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        requests.push({ url, body });
        return responder(url, body, init?.signal ?? undefined);
    }) as typeof fetch;
    return { requests, restore: () => { globalThis.fetch = original; } };
}

function serviceWith(chatClient: RecordingChatClient, logins: Partial<AccountLoginManager> = {}): KoggProviderServiceImpl {
    const providers = {
        getProvider: (id: string) => ({ id, name: id, configuration: 'api-key', governedQualification: 'unqualified' }),
        listProviders: async () => [],
        credentialStatus: async () => 'missing' as const
    };
    const credentials = { get: async () => 'test-secret', listMetadata: async () => [] };
    const loginManager = {
        chat: async () => { throw new Error('login chat not expected'); },
        cancelChat: () => false,
        ...logins
    } as unknown as AccountLoginManager;
    const service = new KoggProviderServiceImpl(
        providers as never, credentials as never, operations, loginManager
    );
    service.setChatClient(chatClient);
    return service;
}

test('streams OpenAI-compatible chat completions with conversation history and pushes deltas', { timeout: 10_000 }, async () => {
    const client = new RecordingChatClient();
    const stub = stubFetch(() => sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n'
    ]));
    try {
        const service = serviceWith(client);
        const reply = await service.advisoryChat({
            provider: 'openai', account: 'default', model: 'gpt-x', prompt: 'again',
            history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
            sessionId: 'session-openai'
        });
        assert.equal(reply, 'Hello');
        assert.deepEqual(client.deltas(), ['Hel', 'lo']);
        const done = client.events.find(event => event.kind === 'done');
        assert.equal(done?.text, 'Hello');
        const request = stub.requests[0]!;
        assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
        assert.deepEqual(request.body.messages, [
            { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }
        ]);
        assert.equal(request.body.stream, true);
    } finally {
        stub.restore();
    }
});

test('parses Anthropic stream deltas into pushed events', { timeout: 10_000 }, async () => {
    const client = new RecordingChatClient();
    const stub = stubFetch(() => sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bon"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"jour"}}\n\n',
        'data: {"type":"message_stop"}\n\n'
    ], { holdOpen: true }));
    try {
        const service = serviceWith(client);
        const reply = await service.advisoryChat({ provider: 'anthropic', account: 'default', model: 'claude-x', prompt: 'hi', sessionId: 'session-anthropic' });
        assert.equal(reply, 'Bonjour');
        assert.deepEqual(client.deltas(), ['Bon', 'jour']);
        const request = stub.requests[0]!;
        assert.ok(String(request.url).startsWith('https://api.anthropic.com/v1/messages'));
        assert.equal(request.body.stream, true);
    } finally {
        stub.restore();
    }
});

test('advisory chat for account providers delegates to the login manager with history', { timeout: 10_000 }, async () => {
    const client = new RecordingChatClient();
    const seen: Array<{ model: string; prompt: string; sessionId?: string }> = [];
    const logins = {
        chat: async (_provider: string, model: string, prompt: string, options: { sessionId?: string }) => {
            seen.push({ model, prompt, sessionId: options.sessionId });
            return 'account reply';
        },
        cancelChat: () => false
    };
    const providers = {
        getProvider: () => ({ id: 'codex-plan', name: 'Codex', configuration: 'oauth-account', governedQualification: 'unqualified' })
    };
    const credentials = { get: async () => 'account-token', listMetadata: async () => [] };
    const service = new KoggProviderServiceImpl(providers as never, credentials as never, operations, logins as unknown as AccountLoginManager);
    service.setChatClient(client);
    const reply = await service.advisoryChat({
        provider: 'codex-plan', account: 'default', model: 'gpt-5.6-luna', prompt: 'hello',
        history: [{ role: 'user', content: 'earlier' }], sessionId: 'session-account'
    });
    assert.equal(reply, 'account reply');
    assert.deepEqual(seen, [{ model: 'gpt-5.6-luna', prompt: 'hello', sessionId: 'session-account' }]);
});

test('cancelChat aborts an in-flight provider stream and normalizes the error', { timeout: 10_000 }, async () => {
    const client = new RecordingChatClient();
    const stub = stubFetch((_url, _body, signal) => sseResponse([], { holdOpen: true, signal }));
    try {
        const service = serviceWith(client);
        const pending = service.advisoryChat({ provider: 'openai', account: 'default', model: 'gpt-x', prompt: 'slow', sessionId: 'session-stop' });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(await service.cancelChat('session-stop'));
        await assert.rejects(() => pending, /Generation stopped\./u);
        assert.ok(client.events.some(event => event.kind === 'error' && event.error === 'Generation stopped.'));
    } finally {
        stub.restore();
    }
});

test('falls back to single-shot parsing when a streaming request gets a JSON answer', { timeout: 10_000 }, async () => {
    const client = new RecordingChatClient();
    const stub = stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Plain reply.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
        const service = serviceWith(client);
        const reply = await service.advisoryChat({ provider: 'openai', account: 'default', model: 'gpt-x', prompt: 'hi', sessionId: 'session-json' });
        assert.equal(reply, 'Plain reply.');
        assert.deepEqual(client.deltas(), ['Plain reply.']);
    } finally {
        stub.restore();
    }
});

test('cancelChat reports false for unknown sessions', { timeout: 10_000 }, async () => {
    const client = new RecordingChatClient();
    const service = serviceWith(client);
    assert.equal(await service.cancelChat('no-such-session'), false);
});
