import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { AccountLoginManager } from './account-login-manager';

const operations = {
    startOperation: async () => ({
        id: 'login-test-operation', cancellable: true, start() {}, active() {}, waiting() {}, activity() {}, refuse() {}, complete() {}, fail() {}, timeout() {}, cancel: async () => undefined,
        cleanup: async () => undefined,
        registerProcess: () => { const calls: string[] = []; return { spawning: () => calls.push('spawning'), started: () => calls.push('started'), ready: () => calls.push('ready'), activity: () => calls.push('activity'), failed: () => calls.push('failed'), exited: () => calls.push('exited'), cleanup: () => calls.push('cleanup') }; }
    })
} as unknown as OperationRegistryApi;

test('drives a provider CLI login from URL capture through import', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-login-'));
    const stub = path.join(directory, 'login-stub.sh');
    await writeFile(stub, '#!/bin/sh\necho "If your browser did not open, navigate to this URL to authenticate:"\necho "https://provider.invalid/oauth/authorize?state=abc"\nsleep 0.2\nexit 0\n');
    await writeFile(path.join(directory, 'auth.json'), JSON.stringify({ tokens: { access_token: 'stub-access', account_id: 'stub-account' } }));
    const previousCommand = process.env.KOGG_CODEX_LOGIN_COMMAND;
    const previousAuth = process.env.KOGG_CODEX_AUTH_FILE;
    process.env.KOGG_CODEX_LOGIN_COMMAND = `/bin/sh ${stub}`;
    process.env.KOGG_CODEX_AUTH_FILE = path.join(directory, 'auth.json');
    const imported: string[] = [];
    const providers = { importAccountCredential: async (provider: string) => { imported.push(provider); } };
    const manager = new AccountLoginManager(operations, providers as never);
    try {
        await manager.start('codex-plan', 'default');
        for (let attempt = 0; attempt < 20 && !manager.state('codex-plan').url; attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
        assert.match(manager.state('codex-plan').url ?? '', /provider\.invalid/u);
        await new Promise(resolve => setTimeout(resolve, 700));
        const done = manager.state('codex-plan');
        assert.equal(done.status, 'succeeded');
        assert.deepEqual(imported, ['codex-plan']);
        await assert.rejects(() => manager.start('openai', 'default'), /in-app sign-in/u);
    } finally {
        if (previousCommand === undefined) delete process.env.KOGG_CODEX_LOGIN_COMMAND; else process.env.KOGG_CODEX_LOGIN_COMMAND = previousCommand;
        if (previousAuth === undefined) delete process.env.KOGG_CODEX_AUTH_FILE; else process.env.KOGG_CODEX_AUTH_FILE = previousAuth;
        await rm(directory, { recursive: true, force: true });
    }
});

test('forwards pasted codes to the provider CLI stdin', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-login-code-'));
    const stub = path.join(directory, 'code-stub.sh');
    await writeFile(stub, '#!/bin/sh\necho "Opening browser to sign in…"\necho "Paste code here if prompted > "\nread -r code\necho "code:$code" > "' + directory + '/code-captured.txt"\nexit 0\n');
    await writeFile(path.join(directory, 'auth.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stub-claude' } }));
    const previousCommand = process.env.KOGG_CLAUDE_LOGIN_COMMAND;
    const previousAuth = process.env.KOGG_CLAUDE_CREDENTIALS_COMMAND;
    process.env.KOGG_CLAUDE_LOGIN_COMMAND = `/bin/sh ${stub}`;
    process.env.KOGG_CLAUDE_CREDENTIALS_COMMAND = `/bin/cat ${directory}/auth.json`;
    const providers = { importAccountCredential: async () => undefined };
    const manager = new AccountLoginManager(operations, providers as never);
    try {
        await manager.start('claude-max', 'default');
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(manager.state('claude-max').status, 'awaiting-code');
        manager.submitCode('claude-max', '  123-456  ');
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(manager.state('claude-max').status, 'succeeded');
        const captured = await readFile(path.join(directory, 'code-captured.txt'), 'utf8');
        assert.equal(captured.trim(), 'code:123-456');
    } finally {
        if (previousCommand === undefined) delete process.env.KOGG_CLAUDE_LOGIN_COMMAND; else process.env.KOGG_CLAUDE_LOGIN_COMMAND = previousCommand;
        if (previousAuth === undefined) delete process.env.KOGG_CLAUDE_CREDENTIALS_COMMAND; else process.env.KOGG_CLAUDE_CREDENTIALS_COMMAND = previousAuth;
        await rm(directory, { recursive: true, force: true });
    }
});

import { readFile } from 'node:fs/promises';

test('chat drives the codex CLI and extracts the agent message from JSONL', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-cli-chat-'));
    const stub = path.join(directory, 'codex-chat.sh');
    const NL = String.fromCharCode(10);
    await writeFile(stub, '#!/bin/sh' + NL + 'echo \'{"type":"thread.started"}\'' + NL + 'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"cli reply"}}\'' + NL + 'exit 0' + NL);
    const previous = process.env.KOGG_CODEX_CHAT_COMMAND;
    process.env.KOGG_CODEX_CHAT_COMMAND = `/bin/sh ${stub}`;
    const providers = { importAccountCredential: async () => undefined };
    const manager = new AccountLoginManager(operations, providers as never);
    try {
        assert.equal(await manager.chat('codex-plan', 'gpt-5.6-sol', 'ping'), 'cli reply');
    } finally {
        if (previous === undefined) delete process.env.KOGG_CODEX_CHAT_COMMAND; else process.env.KOGG_CODEX_CHAT_COMMAND = previous;
        await rm(directory, { recursive: true, force: true });
    }
});

test('chat drives the claude CLI and extracts the JSON result', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-claude-chat-'));
    const stub = path.join(directory, 'claude-chat.sh');
    const NL = String.fromCharCode(10);
    await writeFile(stub, '#!/bin/sh' + NL + 'echo \'{"result":"claude reply","is_error":false}\'' + NL + 'exit 0' + NL);
    const previous = process.env.KOGG_CLAUDE_CHAT_COMMAND;
    process.env.KOGG_CLAUDE_CHAT_COMMAND = `/bin/sh ${stub}`;
    const providers = { importAccountCredential: async () => undefined };
    const manager = new AccountLoginManager(operations, providers as never);
    try {
        assert.equal(await manager.chat('claude-max', 'claude-sonnet-4-5', 'ping'), 'claude reply');
    } finally {
        if (previous === undefined) delete process.env.KOGG_CLAUDE_CHAT_COMMAND; else process.env.KOGG_CLAUDE_CHAT_COMMAND = previous;
        await rm(directory, { recursive: true, force: true });
    }
});

test('chat failures surface the CLI exit and a meaningful stderr line', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-cli-fail-'));
    const stub = path.join(directory, 'fail.sh');
    const NL = String.fromCharCode(10);
    await writeFile(stub, '#!/bin/sh' + NL + 'echo "ERROR: model not supported" >&2' + NL + 'exit 1' + NL);
    const previous = process.env.KOGG_CODEX_CHAT_COMMAND;
    process.env.KOGG_CODEX_CHAT_COMMAND = `/bin/sh ${stub}`;
    const providers = { importAccountCredential: async () => undefined };
    const manager = new AccountLoginManager(operations, providers as never);
    try {
        await assert.rejects(() => manager.chat('codex-plan', 'gpt-5.6-sol', 'ping'), /model not supported/);
    } finally {
        if (previous === undefined) delete process.env.KOGG_CODEX_CHAT_COMMAND; else process.env.KOGG_CODEX_CHAT_COMMAND = previous;
        await rm(directory, { recursive: true, force: true });
    }
});

async function writeCodexAuthFile(directory: string): Promise<string> {
    const authFile = path.join(directory, 'auth.json');
    await writeFile(authFile, JSON.stringify({ tokens: { access_token: 'stub-access', account_id: 'stub-account' } }));
    process.env.KOGG_CODEX_AUTH_FILE = authFile;
    return authFile;
}

test('direct codex chat streams deltas and replays conversation history', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-codex-stream-'));
    await writeCodexAuthFile(directory);
    const deltas: string[] = [];
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"Hel"}\n\n'));
                controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"lo"}\n\n'));
                controller.enqueue(encoder.encode('data: {"type":"response.output_text.done","text":"Hello"}\n\n'));
                controller.close();
            }
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const providers = { importAccountCredential: async () => undefined };
    const manager = new AccountLoginManager(operations, providers as never);
    try {
        const reply = await manager.chat('codex-plan', 'gpt-5.6-luna', 'again', {
            sessionId: 'session-stream',
            history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
            onDelta: text => deltas.push(text)
        });
        assert.equal(reply, 'Hello');
        // Each frame reports the accumulated text: two deltas grow it, and the
        // terminal done event must not append a duplicate copy.
        assert.deepEqual(deltas, ['Hel', 'Hello', 'Hello']);
        assert.ok(requests[0]!.url.includes('chatgpt.com/backend-api/codex/responses'));
        const input = requests[0]!.body.input as Array<{ role: string; content: Array<{ type: string }> }>;
        assert.deepEqual(input.map(turn => ({ role: turn.role, type: turn.content[0]!.type })), [
            { role: 'user', type: 'input_text' }, { role: 'assistant', type: 'output_text' }, { role: 'user', type: 'input_text' }
        ]);
    } finally {
        globalThis.fetch = originalFetch;
        const authFile = path.join(directory, 'auth.json');
        if (process.env.KOGG_CODEX_AUTH_FILE === authFile) delete process.env.KOGG_CODEX_AUTH_FILE;
        await rm(directory, { recursive: true, force: true });
    }
});

test('cancelChat aborts the in-flight direct codex stream with a stop message', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-codex-stop-'));
    await writeCodexAuthFile(directory);
    const originalFetch = globalThis.fetch;
    // Mirror real fetch: the returned promise rejects with an AbortError as
    // soon as the request signal fires.
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
            const abort = new Error('This operation was aborted');
            abort.name = 'AbortError';
            reject(abort);
        }, { once: true });
    })) as typeof fetch;
    const providers = { importAccountCredential: async () => undefined };
    const manager = new AccountLoginManager(operations, providers as never);
    try {
        const pending = manager.chat('codex-plan', 'gpt-5.6-luna', 'slow', { sessionId: 'session-stop' });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(await manager.cancelChat('session-stop'), true);
        await assert.rejects(() => pending, /Generation stopped\./u);
        assert.equal(await manager.cancelChat('session-stop'), false);
    } finally {
        globalThis.fetch = originalFetch;
        const authFile = path.join(directory, 'auth.json');
        if (process.env.KOGG_CODEX_AUTH_FILE === authFile) delete process.env.KOGG_CODEX_AUTH_FILE;
        await rm(directory, { recursive: true, force: true });
    }
});

test('a concurrent duplicate login start does not spawn a second CLI', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kogg-login-race-'));
    const stub = path.join(directory, 'slow-stub.sh');
    await writeFile(stub, '#!/bin/sh\nsleep 5\nexit 0\n');
    const previousCommand = process.env.KOGG_CODEX_LOGIN_COMMAND;
    process.env.KOGG_CODEX_LOGIN_COMMAND = `/bin/sh ${stub}`;
    const providers = { importAccountCredential: async () => undefined };
    const manager = new AccountLoginManager(operations, providers as never);
    try {
        const [first, second] = await Promise.all([manager.start('codex-plan', 'default'), manager.start('codex-plan', 'default')]);
        assert.equal(first.status, 'running');
        assert.equal(second.status, 'running');
        await manager.cancel('codex-plan');
        assert.equal(manager.state('codex-plan').status, 'cancelled');
        // The cancelled state must survive the child exit event.
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(manager.state('codex-plan').status, 'cancelled');
    } finally {
        if (previousCommand === undefined) delete process.env.KOGG_CODEX_LOGIN_COMMAND; else process.env.KOGG_CODEX_LOGIN_COMMAND = previousCommand;
        await rm(directory, { recursive: true, force: true });
    }
});
