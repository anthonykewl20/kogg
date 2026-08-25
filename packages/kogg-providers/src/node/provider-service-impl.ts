import { inject, injectable } from 'inversify';
import {
    CredentialStoreToken, ProviderRegistryToken,
    type CredentialStore, type ProviderRegistry
} from '@kogg/contracts';
import type { AdvisoryChatRequest, KoggProviderService } from '../common/provider-service';

// diagnostic-coverage: providers.registry, providers.credentials

@injectable()
export class KoggProviderServiceImpl implements KoggProviderService {
    constructor(
        @inject(ProviderRegistryToken) private readonly providers: ProviderRegistry,
        @inject(CredentialStoreToken) private readonly credentials: CredentialStore
    ) {}

    async listProviders() { return this.providers.listProviders(); }
    listCredentialMetadata() { return this.credentials.listMetadata(); }
    configureCredential(provider: string, account: string, secret: string) { return this.credentials.set(provider, account, secret); }
    deleteCredential(provider: string, account: string) { return this.credentials.delete(provider, account); }
    credentialStatus(provider: string, account: string) { return this.providers.credentialStatus(provider, account); }
    discoverModels(provider: string, account: string, endpoint?: string) { return this.providers.discoverModels(provider, account, endpoint); }
    testConnection(provider: string, account: string, endpoint?: string) { return this.providers.testConnection(provider, account, endpoint); }

    async advisoryChat(request: AdvisoryChatRequest): Promise<string> {
        console.info('[kogg:providers:service] advisory-chat.requested', { providerId: request.provider });
        const descriptor = this.providers.getProvider(request.provider);
        if (!descriptor) throw new Error(`Unknown Kogg provider ${request.provider}`);
        const secret = descriptor.configuration === 'local' ? undefined : await this.credentials.get(request.provider, request.account);
        if (descriptor.configuration !== 'local' && !secret) throw new Error('Configure this provider credential before starting advisory chat.');
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
        if (!response.ok) throw new Error(`Kogg advisory chat failed with HTTP ${response.status}`);
        const result = extractText(await response.json());
        console.info('[kogg:providers:service] advisory-chat.completed', { providerId: request.provider });
        return result;
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
