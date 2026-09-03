import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { inject, injectable } from 'inversify';
import { CredentialStoreToken, type CredentialStore, type ModelDescriptor, type ProviderDescriptor, type ProviderRegistry } from '@kogg/contracts';

// diagnostic-coverage: providers.registry, providers.credentials

const PROVIDERS: readonly ProviderDescriptor[] = [
    provider('openai', 'OpenAI / OpenAI-compatible', 'api-key', false),
    provider('anthropic', 'Anthropic', 'api-key', false),
    provider('google', 'Google', 'api-key', false),
    provider('ollama', 'Ollama', 'local', true),
    provider('copilot', 'GitHub Copilot', 'oauth', false),
    provider('huggingface', 'Hugging Face', 'api-key', false),
    provider('llamafile', 'LlamaFile', 'local', true),
    provider('codex-plan', 'OpenAI Codex (ChatGPT plan)', 'oauth-account', false),
    provider('claude-max', 'Anthropic Claude (Max plan)', 'oauth-account', false)
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
        if (descriptor.configuration === 'oauth-account') return discoverAccountModels(providerId);
        const secret = descriptor.configuration === 'local' ? undefined : await this.credentials.get(providerId, account);
        if (descriptor.configuration !== 'local' && !secret) throw new Error(`Credential for ${providerId}/${account} is not configured`);
        const headers = providerHeaders(providerId, secret);
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
        if (descriptor.configuration === 'oauth-account') return testAccountConnection(providerId, parseAccountSecret(secret));
        const target = endpoint ?? defaultEndpoint(providerId);
        try {
            const headers = providerHeaders(providerId, secret);
            const response = await fetch(target, { headers, signal: AbortSignal.timeout(10_000) });
            return { ok: response.ok, detail: response.ok ? 'Connection succeeded' : `Provider returned HTTP ${response.status}` };
        } catch (error) {
            console.warn('[kogg:providers:registry] connection-test.failed', {
                providerId,
                errorType: error instanceof Error ? error.name : 'UnknownError'
            });
            return { ok: false, detail: error instanceof Error ? error.message : 'Connection failed' };
        }
    }

    async importAccountCredential(providerId: string, account: string): Promise<void> {
        const descriptor = this.requireProvider(providerId);
        if (descriptor.configuration !== 'oauth-account') throw new Error(`Provider ${providerId} does not use signed-in account import`);
        const credential = readAccountCredential(providerId);
        await this.credentials.set(providerId, account, JSON.stringify(credential));
        console.info('[kogg:providers:registry] account.import.completed', { providerId, account });
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

function providerHeaders(providerId: string, secret?: string): Record<string, string> {
    if (!secret) return {};
    if (providerId === 'anthropic') {
        return { 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
    }
    if (providerId === 'google') return { 'x-goog-api-key': secret };
    return { authorization: `Bearer ${secret}` };
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

interface AccountCredential { readonly accessToken: string; readonly accountId?: string }

function parseAccountSecret(secret: string | undefined): AccountCredential | undefined {
    if (!secret) return undefined;
    try {
        const value = JSON.parse(secret) as Record<string, unknown>;
        const accessToken = typeof value.accessToken === 'string' ? value.accessToken : '';
        if (accessToken) return { accessToken, accountId: typeof value.accountId === 'string' ? value.accountId : undefined };
    } catch { /* observability-exempt: legacy raw-token secrets fall through to the bearer path without content disclosure. */ }
    return { accessToken: secret };
}

function readAccountCredential(providerId: string): AccountCredential {
    if (providerId === 'codex-plan') {
        const file = process.env.KOGG_CODEX_AUTH_FILE ?? path.join(homedir(), '.codex', 'auth.json');
        if (!existsSync(file)) throw new Error('No Codex CLI sign-in found. Install the Codex CLI and run "codex login" first.');
        try {
            const tokens = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown } };
            const accessToken = typeof tokens.tokens?.access_token === 'string' ? tokens.tokens.access_token : '';
            const accountId = typeof tokens.tokens?.account_id === 'string' ? tokens.tokens.account_id : undefined;
            if (!accessToken) throw new Error('empty');
            return { accessToken, accountId };
        } catch {
            throw new Error('The Codex CLI sign-in could not be read. Run "codex login" again.');
        }
    }
    if (providerId === 'claude-max') {
        const command = process.env.KOGG_CLAUDE_CREDENTIALS_COMMAND?.split(' ') ?? ['security', 'find-generic-password', '-w', '-s', 'Claude Code-credentials'];
        const result = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8', timeout: 5_000 });
        if (result.status !== 0 || !result.stdout.trim()) throw new Error('No Claude Code sign-in found. Run "claude" and sign in with your Max account first.');
        try {
            const oauth = JSON.parse(result.stdout) as { claudeAiOauth?: { accessToken?: unknown } };
            const accessToken = typeof oauth.claudeAiOauth?.accessToken === 'string' ? oauth.claudeAiOauth.accessToken : '';
            if (!accessToken) throw new Error('empty');
            return { accessToken };
        } catch {
            throw new Error('The Claude Code sign-in could not be read. Run "claude /login" again.');
        }
    }
    throw new Error(`Unknown account provider ${providerId}`);
}

const ACCOUNT_MODEL_CATALOG: Readonly<Record<string, readonly string[]>> = {
    'codex-plan': ['gpt-5.6-sol'],
    'claude-max': ['claude-sonnet-4-5', 'claude-opus-4-3', 'claude-haiku-4-5']
};

async function discoverAccountModels(providerId: string): Promise<readonly ModelDescriptor[]> {
    if (providerId === 'claude-max') {
        try {
            const response = await fetch('https://api.anthropic.com/v1/models', {
                headers: { authorization: `Bearer ${accountBearer(providerId)}`, 'anthropic-beta': 'oauth-2025-04-20' },
                signal: AbortSignal.timeout(10_000)
            });
            if (response.ok) {
                const payload = await response.json() as { data?: Array<{ id?: unknown }> };
                const models = (payload.data ?? []).flatMap(item => typeof item?.id === 'string' ? [{ id: item.id, name: item.id, provider: providerId }] : []);
                if (models.length) return models;
            }
        } catch { /* observability-exempt: discovery falls back to the closed static catalog; the safe model list carries no provider content. */ }
    }
    return (ACCOUNT_MODEL_CATALOG[providerId] ?? []).map(id => ({ id, name: id, provider: providerId }));
}

function accountBearer(providerId: string): string {
    // Re-read the live CLI store for short-lived account tokens; failures surface as auth errors upstream.
    return readAccountCredential(providerId).accessToken;
}

async function testAccountConnection(providerId: string, credential: AccountCredential | undefined): Promise<{ ok: boolean; detail: string }> {
    if (!credential) return { ok: false, detail: 'Credential is not configured' };
    try {
        if (providerId === 'codex-plan') {
            if (!credential.accountId) return { ok: false, detail: 'Import the signed-in Codex account again (account id missing)' };
            const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
                headers: { authorization: `Bearer ${credential.accessToken}`, 'chatgpt-account-id': credential.accountId }
            });
            // 405 means the endpoint exists and authentication passed; it rejects GET by design.
            if (response.status === 405 || response.ok) return { ok: true, detail: 'Connected to the ChatGPT plan account' };
            if (response.status === 403 || response.status === 404) return { ok: false, detail: 'OpenAI is currently refusing requests from this network (edge block or plan limit). Wait a few minutes and test again; a VPN may be required for chatgpt.com on this network.' };
            return { ok: false, detail: `ChatGPT plan returned HTTP ${response.status}.` };
        }
        if (providerId === 'claude-max') {
            const response = await fetch('https://api.anthropic.com/v1/models', {
                headers: { authorization: `Bearer ${credential.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }
            });
            if (response.ok) return { ok: true, detail: 'Connected to the Claude Max account' };
            return { ok: false, detail: `Anthropic returned HTTP ${response.status}. Click Sign in again to reconnect.` };
        }
        return { ok: false, detail: `Unknown account provider ${providerId}` };
    } catch (error) {
        console.warn('[kogg:providers:registry] account-test.failed', { providerId, errorType: error instanceof Error ? error.name : 'UnknownError' });
        return { ok: false, detail: 'Connection failed' };
    }
}
