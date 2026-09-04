import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inject, injectable } from 'inversify';
import { ProviderRegistryToken, type ProviderRegistry } from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';

// diagnostic-coverage: providers.credentials, providers.registry, operations.processes, operations.cleanup

// Login orchestration drives the provider's own CLI flow: Kogg never handles
// authorization screens, client secrets, or grant parameters — only the safe
// status surface below.

export type AccountLoginStatus = 'idle' | 'running' | 'awaiting-code' | 'succeeded' | 'failed' | 'cancelled';

export interface AccountLoginState {
    readonly status: AccountLoginStatus;
    readonly url?: string;
    readonly needsCode: boolean;
    readonly error?: string;
}

interface ActiveLogin {
    readonly child: ChildProcessWithoutNullStreams;
    readonly lease: { activity(): void; exited(exitClass: 'zero' | 'nonzero' | 'signal'): void; failed(code: string, errorType: string): void; cleanup(): void };
    state: AccountLoginState;
}

const URL_PATTERN = /https:\/\/[^\s"']+/u;

@injectable()
export class AccountLoginManager {
    private readonly logins = new Map<string, ActiveLogin>();
    private readonly lastStates = new Map<string, AccountLoginState>();

    constructor(
        @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
        @inject(ProviderRegistryToken) private readonly providers: ProviderRegistry
    ) {}

    state(providerId: string): AccountLoginState {
        return this.logins.get(providerId)?.state ?? this.lastStates.get(providerId) ?? { status: 'idle', needsCode: false };
    }

    private recordTerminal(providerId: string, state: AccountLoginState): void {
        this.logins.delete(providerId);
        this.lastStates.set(providerId, state);
    }

    async start(providerId: string, account: string): Promise<AccountLoginState> {
        if (this.logins.has(providerId)) return this.state(providerId);
        if (providerId !== 'codex-plan' && providerId !== 'claude-max') throw new Error(`Provider ${providerId} does not support in-app sign-in`);
        const command = loginCommand(providerId);
        console.info('[kogg:providers:login] login.started', { providerId });
        const operation = await this.operations.startOperation({ kind: 'provider-session', cancellable: true, absoluteTimeoutMs: 10 * 60_000 });
        const lease = operation.registerProcess({
            kind: 'provider-cli', owner: 'kogg-supervisor',
            cancel: async () => { loginCancel(providerId, this.logins); }
        });
        operation.start(); lease.spawning();
        const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
        lease.started(child.pid ?? -1);
        const login: ActiveLogin = { child, lease, state: { status: 'running', needsCode: providerId === 'claude-max' } };
        this.logins.set(providerId, login);
        const collect = (chunk: Buffer): void => {
            lease.activity(); operation.active();
            const text = chunk.toString('utf8');
            const url = URL_PATTERN.exec(text)?.[0];
            if (url && login.state.status === 'running') {
                login.state = { ...login.state, url };
                console.info('[kogg:providers:login] login.url.captured', { providerId });
            }
            if (/paste (the )?code|code here/iu.test(text)) {
                login.state = { ...login.state, status: 'awaiting-code' };
                console.info('[kogg:providers:login] login.code.requested', { providerId });
            }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('exit', async exitCode => {
            const exitClass = exitCode === 0 ? 'zero' : exitCode === null ? 'signal' : 'nonzero';
            lease.exited(exitClass);
            try {
                lease.cleanup(); await operation.cleanup();
                if (exitClass === 'zero') {
                    await this.providers.importAccountCredential(providerId, account);
                    this.recordTerminal(providerId, { status: 'succeeded', needsCode: false });
                    console.info('[kogg:providers:login] login.completed', { providerId });
                    operation.complete();
                } else {
                    this.recordTerminal(providerId, { status: 'failed', needsCode: false, error: `Sign-in did not complete (${exitClass} exit).` });
                    console.warn('[kogg:providers:login] login.failed', { providerId, exitClass });
                    operation.fail('PROCESS_EXIT_NONZERO', exitClass === 'signal' ? 'Signalled' : 'NonZeroExit');
                }
            } catch (error) {
                this.recordTerminal(providerId, { status: 'failed', needsCode: false, error: 'The signed-in credential could not be imported.' });
                operation.fail('OWNER_UNAVAILABLE', error instanceof Error ? error.name : 'UnknownError');
                console.warn('[kogg:providers:login] login.import.failed', { providerId, errorType: error instanceof Error ? error.name : 'UnknownError' });
            }
        });
        child.once('error', error => {
            this.recordTerminal(providerId, { status: 'failed', needsCode: false, error: `The sign-in tool could not start: ${error.message}` });
            lease.failed('PROCESS_SPAWN_FAILED', error.name); lease.cleanup(); void operation.cleanup();
            operation.fail('PROCESS_SPAWN_FAILED', error.name);
            console.warn('[kogg:providers:login] login.spawn.failed', { providerId, errorType: error.name });
        });
        return login.state;
    }

    submitCode(providerId: string, code: string): AccountLoginState {
        const login = this.logins.get(providerId);
        if (!login || login.state.status !== 'awaiting-code') return this.state(providerId);
        login.child.stdin.write(`${code.trim()}\n`);
        login.state = { ...login.state, status: 'running' };
        console.info('[kogg:providers:login] login.code.submitted', { providerId });
        return login.state;
    }

    async chat(providerId: string, model: string, prompt: string): Promise<string> {
        // Evidence from this deployment: chatgpt.com/backend-api is reachable
        // while api.openai.com (the CLI's transport) can be blocked on the same
        // network. Direct streaming is therefore primary for Codex, with the
        // CLI as fallback.
        if (providerId === 'codex-plan') {
            try {
                return await this.directCodexChat(model, prompt);
            } catch (error) {
                console.warn('[kogg:providers:login] direct-chat.failed', { providerId, errorType: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message.slice(0, 200) : 'UnknownError' });
            }
        }
        return this.cliChat(providerId, model, prompt);
    }

    private async directCodexChat(model: string, prompt: string): Promise<string> {
        const credential = readAccountCredentialFile('codex-plan');
        if (!credential.accountId) throw new Error('The saved Codex account is missing its account id. Sign in again.');
        const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${credential.accessToken}`,
                'chatgpt-account-id': credential.accountId,
                accept: 'text/event-stream'
            },
            body: JSON.stringify({
                model,
                instructions: 'You are the Kogg advisory assistant. Answer concisely.',
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
                store: false,
                stream: true
            }),
            signal: AbortSignal.timeout(180_000)
        });
        if (response.status === 400 || response.status === 403 || response.status === 404) {
            const detail = await response.json().catch(() => undefined) as { detail?: unknown } | undefined;
            const reason = typeof detail?.detail === 'string' && detail.detail ? `: ${detail.detail}` : '';
            throw new Error(`Codex plan rejected the request with HTTP ${response.status}${reason}`);
        }
        if (!response.ok || !response.body) throw new Error(`Codex plan chat failed with HTTP ${response.status}.`);
        // The stream frequently stays open after the reply text arrives, so
        // read incrementally and resolve as soon as the output is complete
        // instead of waiting for the server to close.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parts: string[] = [];
        let streamError = '';
        let buffer = '';
        const handleEvent = (raw: string): void => {
            if (!raw.startsWith('data: ')) return;
            try {
                const event = JSON.parse(raw.slice(6)) as {
                    type?: string; text?: unknown; response?: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }> };
                    item?: { type?: string; message?: unknown };
                };
                if (event.type === 'response.failed' || event.item?.type === 'error') {
                    streamError = typeof event.item?.message === 'string' ? event.item.message.slice(0, 200) : 'the model stream failed';
                    return;
                }
                if (event.type === 'response.output_text.done' && typeof event.text === 'string' && event.text.trim()) parts.push(event.text.trim());
                if (event.type === 'response.completed') {
                    const message = (event.response?.output ?? []).find(item => item.type === 'message');
                    const output = (message?.content ?? []).find(item => item.type === 'output_text');
                    if (typeof output?.text === 'string' && output.text.trim()) parts.push(output.text.trim());
                }
            } catch { /* observability-exempt: malformed SSE events are skipped; the terminal no-text refusal is the observable outcome. */ }
        };
        const result = await new Promise<string>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Codex plan chat timed out after 180 seconds.')), 180_000);
            let idleTimer: NodeJS.Timeout | undefined;
            const resetIdle = (): void => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => { reader.cancel().catch(() => undefined); reject(new Error('Codex plan stream stalled (no data for 90 seconds).')); }, 90_000);
                idleTimer.unref();
            };
            resetIdle();
            const pump = async (): Promise<void> => {
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        resetIdle();
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split(LINE);
                        buffer = lines.pop() ?? '';
                        for (const line of lines) {
                            handleEvent(line);
                            if (parts.length) { clearTimeout(deadline); resolve(parts.join('').trim()); return; }
                            if (streamError) { clearTimeout(deadline); reject(new Error(`Codex plan stream failed: ${streamError}`)); return; }
                        }
                    }
                    clearTimeout(deadline);
                    if (parts.length) resolve(parts.join('').trim());
                    else reject(new Error(streamError ? `Codex plan stream failed: ${streamError}` : 'Codex plan returned no advisory text.'));
                } catch (error) { clearTimeout(deadline); console.warn('[kogg:providers:login] stream.read.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); reject(error instanceof Error ? error : new Error('stream read failed')); }
            };
            void pump().finally(() => { if (idleTimer) clearTimeout(idleTimer); });
        });
        return result;
    }

    private async cliChat(providerId: string, model: string, prompt: string): Promise<string> {
        const command = chatCommand(providerId, model, prompt);
        console.info('[kogg:providers:login] cli-chat.started', { providerId, model });
        const operation = await this.operations.startOperation({ kind: 'provider-session', cancellable: false, absoluteTimeoutMs: 300_000 });
        const lease = operation.registerProcess({ kind: 'provider-cli', owner: 'kogg-supervisor' });
        operation.start(); lease.spawning();
        const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        lease.started(child.pid ?? -1);
        return await new Promise<string>((resolve, reject) => {
            const stdout: string[] = [];
            const stderr: string[] = [];
            child.stdout!.on('data', (chunk: Buffer) => { lease.activity(); operation.active(); stdout.push(chunk.toString('utf8')); });
            child.stderr!.on('data', (chunk: Buffer) => { lease.activity(); stderr.push(chunk.toString('utf8')); });
            child.once('error', error => {
                lease.failed('PROCESS_SPAWN_FAILED', error.name); lease.cleanup(); void operation.cleanup();
                operation.fail('PROCESS_SPAWN_FAILED', error.name);
                reject(new Error(`The ${providerId === 'claude-max' ? 'claude' : 'codex'} CLI could not start: ${error.message}`));
            });
            child.once('exit', code => {
                lease.exited(code === 0 ? 'zero' : code === null ? 'signal' : 'nonzero');
                lease.cleanup(); void operation.cleanup();
                const text = extractReply(stdout.join(''), providerId);
                if (code === 0 && text) { operation.complete(); resolve(text); return; }
                operation.fail('PROCESS_EXIT_NONZERO', 'NonZeroExit');
                const reason = lastMeaningfulLine(stderr.join('')) ?? (text ? undefined : 'The CLI produced no reply.');
                reject(new Error(providerId === 'claude-max'
                    ? `Claude CLI did not complete${reason ? `: ${reason}` : '.'}`
                    : `Codex CLI did not complete${reason ? `: ${reason}` : '.'}`));
            });
        });
    }

    async cancel(providerId: string): Promise<AccountLoginState> {
        const login = this.logins.get(providerId);
        if (!login) return { status: 'idle', needsCode: false };
        login.child.kill('SIGTERM');
        this.recordTerminal(providerId, { status: 'cancelled', needsCode: false });
        login.lease.exited('signal'); login.lease.cleanup();
        console.info('[kogg:providers:login] login.cancelled', { providerId });
        return login.state;
    }
}

function loginCancel(providerId: string, logins: Map<string, ActiveLogin>): void {
    const login = logins.get(providerId);
    if (login) login.child.kill('SIGTERM');
}

function loginCommand(providerId: string): readonly string[] {
    if (providerId === 'codex-plan') return process.env.KOGG_CODEX_LOGIN_COMMAND?.split(' ') ?? ['codex', 'login'];
    return process.env.KOGG_CLAUDE_LOGIN_COMMAND?.split(' ') ?? ['claude', 'auth', 'login', '--claudeai'];
}

const LINE = String.fromCharCode(10);

function readAccountCredentialFile(providerId: string): { accessToken: string; accountId?: string } {
    const registry = process.env.KOGG_PROVIDERS_REGISTRY_MODULE;
    void registry;
    // Reuse the registry's reader through a narrow re-implementation to avoid a circular import.
    if (providerId === 'codex-plan') {
        const file = process.env.KOGG_CODEX_AUTH_FILE ?? path.join(os.homedir(), '.codex', 'auth.json');
        try {
            const tokens = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown } };
            const accessToken = typeof tokens.tokens?.access_token === 'string' ? tokens.tokens.access_token : '';
            if (!accessToken) throw new Error('empty');
            return { accessToken, accountId: typeof tokens.tokens?.account_id === 'string' ? tokens.tokens.account_id : undefined };
        } catch {
            throw new Error('The Codex CLI sign-in could not be read. Run "codex login" again.');
        }
    }
    throw new Error(`Unknown account provider ${providerId}`);
}

function chatCommand(providerId: string, model: string, prompt: string): readonly string[] {
    if (providerId === 'codex-plan') {
        const override = process.env.KOGG_CODEX_CHAT_COMMAND?.split(' ');
        return override ?? ['codex', 'exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-m', model, prompt];
    }
    if (providerId === 'claude-max') {
        const override = process.env.KOGG_CLAUDE_CHAT_COMMAND?.split(' ');
        return override ?? ['claude', '-p', prompt, '--output-format', 'json', '--model', model];
    }
    throw new Error(`No CLI chat for ${providerId}`);
}

function extractReply(stdout: string, providerId: string): string | undefined {
    if (providerId === 'claude-max') {
        try {
            const value = JSON.parse(stdout.trim().split(LINE).filter(Boolean).pop() ?? '') as { result?: unknown };
            if (typeof value.result === 'string' && value.result.trim()) return value.result.trim();
        } catch { /* observability-exempt: non-JSON CLI output falls through to JSONL extraction without content disclosure. */ }
    }
    let agentMessage: string | undefined;
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            const event = JSON.parse(trimmed) as { type?: string; message?: unknown; item?: { type?: string; text?: unknown }; result?: unknown };
            if (typeof event.result === 'string' && event.result.trim()) agentMessage = event.result.trim();
            if (typeof event.message === 'string' && event.type === 'agent_message' && event.message.trim()) agentMessage = event.message.trim();
            if (event.item?.type === 'agent_message' && typeof event.item.text === 'string' && event.item.text.trim()) agentMessage = event.item.text.trim();
        } catch { /* observability-exempt: non-JSON JSONL lines are skipped; the extracted reply or terminal no-reply refusal is observable. */ }
    }
    return agentMessage;
}

function lastMeaningfulLine(text: string): string | undefined {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('Reading additional'));
    const last = lines[lines.length - 1];
    return last ? last.slice(0, 200) : undefined;
}
