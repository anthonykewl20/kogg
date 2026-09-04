import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import {
    CredentialStoreToken, ProviderRegistryToken,
    type CredentialStore, type ProviderRegistry
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { runOperation } from '@kogg/operations/lib/node/run-operation';
import { AccountLoginManager } from './account-login-manager';
import { consumeSseStream } from './sse';
import type {
    AccountLoginState, AdvisoryChatRequest, ChatStreamEvent,
    KoggProviderChatClient, KoggProviderService
} from '../common/provider-service';

// diagnostic-coverage: providers.registry, providers.credentials, operations.registry, operations.cleanup

interface ActiveApiChat {
    readonly abort: AbortController;
}

const CHAT_STOPPED = 'Generation stopped.';

@injectable()
export class KoggProviderServiceImpl implements KoggProviderService {
    private chatClient: KoggProviderChatClient | undefined;
    private readonly apiChats = new Map<string, ActiveApiChat>();

    constructor(
        @inject(ProviderRegistryToken) private readonly providers: ProviderRegistry,
        @inject(CredentialStoreToken) private readonly credentials: CredentialStore,
        @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
        @inject(AccountLoginManager) private readonly logins: AccountLoginManager
    ) {}

    // Invoked by the JSON-RPC connection handler with the frontend's chat
    // client proxy, mirroring the operations registry wiring.
    setChatClient(client?: KoggProviderChatClient): void { this.chatClient = client; }

    listProviders() { return this.connection(() => Promise.resolve(this.providers.listProviders())); }
    listCredentialMetadata() { return this.connection(() => this.credentials.listMetadata()); }
    configureCredential(provider: string, account: string, secret: string) { return this.connection(() => this.credentials.set(provider, account, secret)); }
    deleteCredential(provider: string, account: string) { return this.connection(() => this.credentials.delete(provider, account)); }
    credentialStatus(provider: string, account: string) { return this.connection(() => this.providers.credentialStatus(provider, account)); }
    importAccountCredential(provider: string, account: string) {
        return this.connection(() => this.providers.importAccountCredential(provider, account));
    }
    startAccountLogin(provider: string, account: string): Promise<AccountLoginState> { return this.logins.start(provider, account); }
    accountLoginState(provider: string): Promise<AccountLoginState> { return Promise.resolve(this.logins.state(provider)); }
    submitAccountLoginCode(provider: string, code: string): Promise<AccountLoginState> { return Promise.resolve(this.logins.submitCode(provider, code)); }
    cancelAccountLogin(provider: string): Promise<AccountLoginState> { return this.logins.cancel(provider); }
    discoverModels(provider: string, account: string, endpoint?: string) { return this.connection(() => this.providers.discoverModels(provider, account, endpoint)); }
    testConnection(provider: string, account: string, endpoint?: string) {
        // A reachable service returning a negative connection result (including
        // a missing credential) is a completed diagnostic, not an operational
        // failure. Preserve the actionable provider detail for the UI.
        return runOperation(this.operations, 'provider-connection', () => this.providers.testConnection(provider, account, endpoint));
    }

    cancelChat(sessionId: string): Promise<boolean> {
        if (this.logins.cancelChat(sessionId)) return Promise.resolve(true);
        const chat = this.apiChats.get(sessionId);
        if (!chat) return Promise.resolve(false);
        this.apiChats.delete(sessionId);
        chat.abort.abort();
        console.info('[kogg:providers:service] advisory-chat.cancelled', {});
        return Promise.resolve(true);
    }

    async advisoryChat(request: AdvisoryChatRequest): Promise<string> {
        return runOperation(this.operations, 'provider-session', async activity => {
            const sessionId = request.sessionId ?? randomUUID();
            console.info('[kogg:providers:service] advisory-chat.requested', { providerId: request.provider, historyTurns: request.history?.length ?? 0 });
            const descriptor = this.providers.getProvider(request.provider);
            if (!descriptor) throw new Error(`Unknown Kogg provider ${request.provider}`);
            const secret = descriptor.configuration === 'local' ? undefined : await this.credentials.get(request.provider, request.account);
            if (descriptor.configuration !== 'local' && !secret) throw new Error('Configure this provider credential before starting advisory chat.');
            const emit = (text: string): void => { if (text) this.push({ sessionId, kind: 'delta', text }); };
            const finish = (text: string): void => { this.push({ sessionId, kind: 'done', text }); };
            try {
                let result: string;
                if (descriptor.configuration === 'oauth-account') {
                    result = await this.logins.chat(request.provider, request.model, request.prompt, {
                        history: request.history,
                        sessionId,
                        onDelta: emit
                    });
                } else {
                    const chat: ActiveApiChat = { abort: new AbortController() };
                    this.apiChats.set(sessionId, chat);
                    try {
                        result = await this.apiChat(request, secret, chat, emit, () => activity());
                    } finally {
                        this.apiChats.delete(sessionId);
                    }
                }
                console.info('[kogg:providers:service] advisory-chat.completed', { providerId: request.provider, streamedCharacters: result.length });
                finish(result);
                return result;
            } catch (error) {
                // A user stop or an aborted request normalizes to the same
                // safe message so the UI can render one deterministic state.
                const stopped = error instanceof Error && (error.message === CHAT_STOPPED || error.name === 'AbortError');
                this.push({ sessionId, kind: 'error', error: stopped ? CHAT_STOPPED : 'The advisory chat request failed.' });
                throw stopped ? new Error(CHAT_STOPPED) : error;
            }
        });
    }

    private push(event: ChatStreamEvent): void {
        try { this.chatClient?.onChatEvent(event); } catch { /* observability-exempt: a dropped stream push must not fail the chat; the request promise is the authoritative terminal signal. */ }
    }

    private async apiChat(
        request: AdvisoryChatRequest,
        secret: string | undefined,
        chat: ActiveApiChat,
        emit: (text: string) => void,
        activity: () => void
    ): Promise<string> {
        const provider = request.provider;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (secret) headers.authorization = `Bearer ${secret}`;
        let target = chatEndpoint(provider, request.endpoint, request.model);
        let body: unknown;
        let terminal = false;
        let parse: (data: string) => string | undefined;
        const history = request.history ?? [];
        if (provider === 'anthropic') {
            delete headers.authorization;
            headers['x-api-key'] = secret!;
            headers['anthropic-version'] = '2023-06-01';
            body = { model: request.model, max_tokens: 2048, stream: true, messages: [...history, { role: 'user', content: request.prompt }] };
            parse = data => {
                const event = JSON.parse(data) as { type?: string; delta?: { text?: unknown } };
                if (event.type === 'message_stop') terminal = true;
                return event.type === 'content_block_delta' && typeof event.delta?.text === 'string' ? event.delta.text : undefined;
            };
        } else if (provider === 'google') {
            delete headers.authorization;
            headers['x-goog-api-key'] = secret!;
            target = target.replace(':generateContent', ':streamGenerateContent?alt=sse');
            body = { contents: [...history.map(turn => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] })), { role: 'user', parts: [{ text: request.prompt }] }] };
            parse = data => {
                const event = JSON.parse(data) as { candidates?: Array<{ finishReason?: unknown; content?: { parts?: Array<{ text?: unknown }> } }> };
                const candidate = event.candidates?.[0];
                if (candidate?.finishReason) terminal = true;
                const text = candidate?.content?.parts?.map(part => typeof part.text === 'string' ? part.text : '').join('') ?? '';
                return text || undefined;
            };
        } else if (provider === 'huggingface') {
            body = { inputs: request.prompt, parameters: { max_new_tokens: 1024, return_full_text: false } };
            const response = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body), signal: chat.abort.signal });
            activity();
            if (!response.ok) throw new Error(`Kogg advisory chat failed with HTTP ${response.status}`);
            const text = extractText(await response.json());
            emit(text);
            return text;
        } else {
            // OpenAI-compatible chat completions: openai, ollama, llamafile,
            // copilot, and any custom endpoint speaking the same protocol.
            body = { model: request.model, stream: true, messages: [...history, { role: 'user', content: request.prompt }] };
            parse = data => {
                if (data === '[DONE]') { terminal = true; return undefined; }
                const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
                const text = event.choices?.[0]?.delta?.content;
                return typeof text === 'string' && text ? text : undefined;
            };
        }
        const response = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body), signal: chat.abort.signal });
        activity();
        if (!response.ok) throw new Error(`Kogg advisory chat failed with HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.body || !contentType.includes('text/event-stream')) {
            // The endpoint ignored the stream flag (or sent no body): the
            // current response already carries the complete answer.
            if (!response.body) {
                const plain = await fetch(target, { method: 'POST', headers, body: JSON.stringify({ ...body as Record<string, unknown>, stream: false }), signal: chat.abort.signal });
                activity();
                if (!plain.ok) throw new Error(`Kogg advisory chat failed with HTTP ${plain.status}`);
                const text = extractText(await plain.json());
                emit(text);
                return text;
            }
            const text = extractText(await response.json());
            emit(text);
            return text;
        }
        let collected = '';
        await consumeSseStream(response.body, {
            idleTimeoutMs: 60_000,
            totalTimeoutMs: 180_000,
            onEvent: data => {
                const text = safeParse(data, parse);
                if (text) { collected += text; emit(text); }
                return terminal ? 'stop' : undefined;
            }
        });
        activity();
        if (!collected.trim()) throw new Error('Provider response contained no advisory text.');
        return collected.trim();
    }

    private connection<T>(work: () => Promise<T>): Promise<T> {
        return runOperation(this.operations, 'provider-connection', work);
    }
}

function safeParse(data: string, parse: (data: string) => string | undefined): string | undefined {
    try { return parse(data); } catch { return undefined; /* observability-exempt: malformed stream frames carry no text and are skipped; the no-text terminal refusal is observable. */ }
}

function chatEndpoint(provider: string, configured: string | undefined, model: string): string {
    if (provider === 'google') {
        const base = configured ?? 'https://generativelanguage.googleapis.com/v1beta/models';
        const key = new URL(base).search;
        return `${base.replace(/\/models(?:\?.*)?$/u, '')}/models/${encodeURIComponent(model)}:generateContent${key}`;
    }
    const defaults: Record<string, string> = {
        openai: 'https://api.openai.com/v1/chat/completions', anthropic: 'https://api.anthropic.com/v1/messages',
        ollama: 'http://127.0.0.1:11434/api/chat', copilot: 'https://api.githubcopilot.com/chat/completions',
        huggingface: `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`,
        llamafile: 'http://127.0.0.1:8080/v1/chat/completions'
    };
    if (!configured) return defaults[provider] ?? (() => { throw new Error(`No chat endpoint for ${provider}`); })();
    return configured
        .replace(/\/models\/?$/u, '/chat/completions')
        .replace(/\/api\/tags\/?$/u, '/api/chat');
}

function extractText(payload: unknown): string {
    const value = payload as Record<string, any>;
    const text = value?.choices?.[0]?.message?.content
        ?? value?.message?.content
        ?? value?.content?.[0]?.text
        ?? value?.candidates?.[0]?.content?.parts?.[0]?.text
        ?? value?.generated_text
        ?? (Array.isArray(value) ? value[0]?.generated_text : undefined);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Provider response contained no advisory text.');
    return text.trim();
}
