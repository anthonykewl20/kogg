import { inject, injectable } from 'inversify';
import {
    CredentialStoreToken, ProviderRegistryToken,
    type CredentialStore, type ProviderRegistry
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { runOperation } from '@kogg/operations/lib/node/run-operation';
import { AccountLoginManager } from './account-login-manager';
import type { AccountLoginState, AdvisoryChatRequest, KoggProviderService } from '../common/provider-service';

// diagnostic-coverage: providers.registry, providers.credentials, operations.registry, operations.cleanup

@injectable()
export class KoggProviderServiceImpl implements KoggProviderService {
    constructor(
        @inject(ProviderRegistryToken) private readonly providers: ProviderRegistry,
        @inject(CredentialStoreToken) private readonly credentials: CredentialStore,
        @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
        @inject(AccountLoginManager) private readonly logins: AccountLoginManager
    ) {}

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

    async advisoryChat(request: AdvisoryChatRequest): Promise<string> {
        return runOperation(this.operations, 'provider-session', async activity => {
            console.info('[kogg:providers:service] advisory-chat.requested', { providerId: request.provider });
            const descriptor = this.providers.getProvider(request.provider);
            if (!descriptor) throw new Error(`Unknown Kogg provider ${request.provider}`);
            const secret = descriptor.configuration === 'local' ? undefined : await this.credentials.get(request.provider, request.account);
            if (descriptor.configuration !== 'local' && !secret) throw new Error('Configure this provider credential before starting advisory chat.');
            if (descriptor.configuration === 'oauth-account') return await accountChat(request, secret!);
            const target = chatEndpoint(request.provider, request.endpoint, request.model);
            const headers: Record<string, string> = { 'content-type': 'application/json' };
            if (secret) headers.authorization = `Bearer ${secret}`;
            let body: unknown = { model: request.model, messages: [{ role: 'user', content: request.prompt }], stream: false };
            if (request.provider === 'anthropic') {
                delete headers.authorization;
                headers['x-api-key'] = secret!;
                headers['anthropic-version'] = '2023-06-01';
                body = { model: request.model, max_tokens: 2048, messages: [{ role: 'user', content: request.prompt }] };
            } else if (request.provider === 'google') {
                delete headers.authorization;
                headers['x-goog-api-key'] = secret!;
                body = { contents: [{ role: 'user', parts: [{ text: request.prompt }] }] };
            } else if (request.provider === 'huggingface') {
                body = { inputs: request.prompt, parameters: { max_new_tokens: 1024, return_full_text: false } };
            }
            const response = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
            activity();
            if (!response.ok) throw new Error(`Kogg advisory chat failed with HTTP ${response.status}`);
            const result = extractText(await response.json());
            console.info('[kogg:providers:service] advisory-chat.completed', { providerId: request.provider });
            return result;
        });
    }

    private connection<T>(work: () => Promise<T>): Promise<T> {
        return runOperation(this.operations, 'provider-connection', work);
    }
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

async function accountChat(request: AdvisoryChatRequest, secret: string): Promise<string> {
    let credential: { accessToken: string; accountId?: string };
    try {
        const parsed = JSON.parse(secret) as { accessToken?: unknown; accountId?: unknown };
        if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) throw new Error('invalid');
        credential = { accessToken: parsed.accessToken, accountId: typeof parsed.accountId === 'string' ? parsed.accountId : undefined };
    } catch { throw new Error('The saved account credential is invalid. Import the signed-in account again.'); }
    if (request.provider === 'codex-plan') {
        if (!credential.accountId) throw new Error('The saved Codex account is missing its account id. Import the signed-in account again.');
        const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${credential.accessToken}`,
                'chatgpt-account-id': credential.accountId,
                accept: 'text/event-stream'
            },
            body: JSON.stringify({
                model: request.model,
                instructions: 'You are the Kogg advisory assistant. Answer concisely.',
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.prompt }] }],
                store: false,
                stream: true
            }),
            signal: AbortSignal.timeout(120_000)
        });
        if (!response.ok || !response.body) throw new Error(`Codex plan chat failed with HTTP ${response.status}. Run "codex login" and import the account again.`);
        const text = await response.text();
        for (const line of text.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
                const event = JSON.parse(line.slice(6)) as { type?: string; response?: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }> } };
                if (event.type !== 'response.completed') continue;
                const message = (event.response?.output ?? []).find(item => item.type === 'message');
                const output = (message?.content ?? []).find(item => item.type === 'output_text');
                if (typeof output?.text === 'string' && output.text.trim()) return output.text.trim();
            } catch { /* observability-exempt: malformed stream events are skipped; the terminal no-text refusal is the observable outcome. */ }
        }
        throw new Error('Codex plan returned no advisory text.');
    }
    if (request.provider === 'claude-max') {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${credential.accessToken}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({ model: request.model, max_tokens: 2048, messages: [{ role: 'user', content: request.prompt }] }),
            signal: AbortSignal.timeout(120_000)
        });
        if (!response.ok) throw new Error(`Claude Max chat failed with HTTP ${response.status}. Use Sign in again to reconnect.`);
        const result = await response.json() as { content?: Array<{ type?: string; text?: unknown }> };
        const text = (result.content ?? []).find(item => item.type === 'text')?.text;
        if (typeof text !== 'string' || !text.trim()) throw new Error('Claude Max returned no advisory text.');
        return text.trim();
    }
    throw new Error(`No account chat for ${request.provider}`);
}
