import { inject, injectable } from 'inversify';
import { CredentialStoreToken, type CredentialStore, type ModelDescriptor, type ProviderDescriptor, type ProviderRegistry } from '@kogg/contracts';

const PROVIDERS: readonly ProviderDescriptor[] = [
    provider('openai', 'OpenAI / OpenAI-compatible', 'api-key', false),
    provider('anthropic', 'Anthropic', 'api-key', false),
    provider('google', 'Google', 'api-key', false),
    provider('ollama', 'Ollama', 'local', true),
    provider('copilot', 'GitHub Copilot', 'oauth', false),
    provider('huggingface', 'Hugging Face', 'api-key', false),
    provider('llamafile', 'LlamaFile', 'local', true)
];

function provider(id: string, name: string, configuration: ProviderDescriptor['configuration'], local: boolean): ProviderDescriptor {
    return { id, name, configuration, capabilities: { streaming: true, toolCalls: true, structuredOutput: true, local }, governedQualification: 'blocked' };
}

@injectable()
export class KoggProviderRegistry implements ProviderRegistry {
    constructor(@inject(CredentialStoreToken) private readonly credentials: CredentialStore) {}

    listProviders(): readonly ProviderDescriptor[] { return PROVIDERS; }
    getProvider(id: string): ProviderDescriptor | undefined { return PROVIDERS.find(item => item.id === id); }

    async discoverModels(providerId: string, account: string, endpoint?: string): Promise<readonly ModelDescriptor[]> {
        const descriptor = this.requireProvider(providerId);
        const secret = descriptor.configuration === 'local' ? undefined : await this.credentials.get(providerId, account);
        if (descriptor.configuration !== 'local' && !secret) throw new Error(`Credential for ${providerId}/${account} is not configured`);
        const headers: Record<string, string> = secret ? { authorization: `Bearer ${secret}` } : {};
        if (providerId === 'anthropic' && secret) {
            delete headers.authorization;
            headers['x-api-key'] = secret;
            headers['anthropic-version'] = '2023-06-01';
        }
        const response = await fetch(endpoint ?? defaultEndpoint(providerId), { headers, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}`);
        const payload = await response.json() as Record<string, unknown>;
        const candidates = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
        return candidates.flatMap(item => {
            if (typeof item === 'string') return [{ id: item, name: item, provider: providerId }];
            if (!item || typeof item !== 'object') return [];
            const record = item as Record<string, unknown>;
            const id = String(record.id ?? record.name ?? record.model ?? '');
            return id ? [{ id, name: String(record.display_name ?? record.displayName ?? record.name ?? id), provider: providerId }] : [];
        });
    }

    async credentialStatus(providerId: string, account: string): Promise<'configured' | 'missing'> {
        const descriptor = this.requireProvider(providerId);
        if (descriptor.configuration === 'local') return 'configured';
        return (await this.credentials.get(providerId, account)) ? 'configured' : 'missing';
    }

    async testConnection(providerId: string, account: string, endpoint?: string): Promise<{ ok: boolean; detail: string }> {
        const descriptor = this.requireProvider(providerId);
        const secret = descriptor.configuration === 'local' ? undefined : await this.credentials.get(providerId, account);
        if (descriptor.configuration !== 'local' && !secret) return { ok: false, detail: 'Credential is not configured' };
        const target = endpoint ?? defaultEndpoint(providerId);
        try {
            const headers: Record<string, string> = {};
            if (secret) headers.authorization = `Bearer ${secret}`;
            if (providerId === 'anthropic' && secret) {
                delete headers.authorization;
                headers['x-api-key'] = secret;
                headers['anthropic-version'] = '2023-06-01';
            }
            const response = await fetch(target, { headers, signal: AbortSignal.timeout(10_000) });
            return { ok: response.ok, detail: response.ok ? 'Connection succeeded' : `Provider returned HTTP ${response.status}` };
        } catch (error) {
            return { ok: false, detail: error instanceof Error ? error.message : 'Connection failed' };
        }
    }

    assertGoverned(providerId: string): void {
        const descriptor = this.requireProvider(providerId);
        if (descriptor.governedQualification !== 'qualified') {
            throw new Error(`Provider ${providerId} is advisory-only until Ranex reports it as qualified`);
        }
    }

    private requireProvider(id: string): ProviderDescriptor {
        const descriptor = this.getProvider(id);
        if (!descriptor) throw new Error(`Unknown Kogg provider ${id}`);
        return descriptor;
    }
}

function defaultEndpoint(id: string): string {
    const endpoints: Record<string, string> = {
        openai: 'https://api.openai.com/v1/models', anthropic: 'https://api.anthropic.com/v1/models',
        google: 'https://generativelanguage.googleapis.com/v1beta/models', ollama: 'http://127.0.0.1:11434/api/tags',
        copilot: 'https://api.githubcopilot.com/models', huggingface: 'https://huggingface.co/api/whoami-v2',
        llamafile: 'http://127.0.0.1:8080/v1/models'
    };
    const endpoint = endpoints[id];
    if (!endpoint) throw new Error(`No connection-test endpoint for ${id}`);
    return endpoint;
}
