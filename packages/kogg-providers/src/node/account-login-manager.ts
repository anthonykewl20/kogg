import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inject, injectable } from 'inversify';
import { ProviderRegistryToken, type ProviderRegistry } from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { consumeSseStream, CodexStreamRejection, codexStreamText, handleCodexStreamEvent, type CodexStreamState } from './sse';
import type { ChatTurn } from '../common/provider-service';

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

interface ActiveLoginLease {
    activity(): void; exited(exitClass: 'zero' | 'nonzero' | 'signal'): void; failed(code: string, errorType: string): void; cleanup(): void;
}

interface ActiveLogin {
    child: ChildProcessWithoutNullStreams | undefined;
    lease: ActiveLoginLease | undefined;
    state: AccountLoginState;
}

export interface ChatCallOptions {
    readonly history?: readonly ChatTurn[];
    readonly sessionId?: string;
    onDelta?: (text: string) => void;
}

interface ActiveChat {
    readonly abort: AbortController;
    child?: ChildProcess;
}

const URL_PATTERN = /https:\/\/[^\s"']+/u;

@injectable()
export class AccountLoginManager {
    private readonly logins = new Map<string, ActiveLogin>();
    private readonly lastStates = new Map<string, AccountLoginState>();
    private readonly chats = new Map<string, ActiveChat>();
    private readonly starting = new Set<string>();

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
        if (this.starting.has(providerId)) {
            // A concurrent caller waits for the pending start to register its
            // login instead of observing a stale idle state.
            for (let attempt = 0; attempt < 40 && !this.logins.has(providerId); attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return this.state(providerId);
        }
        if (providerId !== 'codex-plan' && providerId !== 'claude-max') throw new Error(`Provider ${providerId} does not support in-app sign-in`);
        this.starting.add(providerId);
        try {
            const command = loginCommand(providerId);
            console.info('[kogg:providers:login] login.started', { providerId });
            const operation = await this.operations.startOperation({ kind: 'provider-session', cancellable: true, absoluteTimeoutMs: 10 * 60_000 });
            const login: ActiveLogin = {
                child: undefined,
                lease: undefined,
                state: { status: 'running', needsCode: providerId === 'claude-max' }
            };
            // Register synchronously so concurrent start() calls observe the
            // pending login instead of spawning a duplicate CLI.
            this.logins.set(providerId, login);
            const lease = operation.registerProcess({
                kind: 'provider-cli', owner: 'kogg-supervisor',
                cancel: async () => { loginCancel(providerId, this.logins); }
            });
            login.lease = lease;
            operation.start(); lease.spawning();
            const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
            login.child = child;
            lease.started(child.pid ?? -1);
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
                const cancelled = login.state.status === 'cancelled';
                if (cancelled) {
                    // cancel() already closed the lease and recorded the
                    // terminal state; only the registry operation remains.
                    try { await operation.cleanup(); } catch { /* observability-exempt: cleanup of an already-cancelled login operation cannot change the user-visible outcome. */ }
                    return;
                }
                const exitClass = exitCode === 0 ? 'zero' : exitCode === null ? 'signal' : 'nonzero';
                try { lease.exited(exitClass); } catch { /* observability-exempt: the lease may already be terminal after a timeout; the registry state remains authoritative. */ }
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
                    try { operation.fail('OWNER_UNAVAILABLE', error instanceof Error ? error.name : 'UnknownError'); } catch { /* observability-exempt: the operation already reached a terminal state (timeout); its recorded outcome stays authoritative. */ }
                    console.warn('[kogg:providers:login] login.import.failed', { providerId, errorType: error instanceof Error ? error.name : 'UnknownError' });
                }
            });
            child.once('error', error => {
                this.recordTerminal(providerId, { status: 'failed', needsCode: false, error: `The sign-in tool could not start: ${error.message}` });
                try { lease.failed('PROCESS_SPAWN_FAILED', error.name); lease.cleanup(); } catch { /* observability-exempt: the lease may already be terminal after a timeout. */ }
                void operation.cleanup().catch(() => undefined);
                try { operation.fail('PROCESS_SPAWN_FAILED', error.name); } catch { /* observability-exempt: the operation already reached a terminal state (timeout). */ }
                console.warn('[kogg:providers:login] login.spawn.failed', { providerId, errorType: error.name });
            });
            return login.state;
        } finally {
            this.starting.delete(providerId);
        }
    }

    submitCode(providerId: string, code: string): AccountLoginState {
        const login = this.logins.get(providerId);
        if (!login || login.state.status !== 'awaiting-code') return this.state(providerId);
        try {
            if (login.child?.stdin.destroyed) throw new Error('stdin closed');
            login.child?.stdin.write(`${code.trim()}\n`);
            if (!login.child) throw new Error('child missing');
        } catch {
            this.recordTerminal(providerId, { status: 'failed', needsCode: false, error: 'The sign-in tool is no longer running. Start the sign-in again.' });
            console.warn('[kogg:providers:login] login.code.write-failed', { providerId });
            return this.state(providerId);
        }
        login.state = { ...login.state, status: 'running' };
        console.info('[kogg:providers:login] login.code.submitted', { providerId });
        return login.state;
    }

    async chat(providerId: string, model: string, prompt: string, options: ChatCallOptions = {}): Promise<string> {
        const sessionId = options.sessionId ?? randomUUID();
        const session: ActiveChat = { abort: new AbortController() };
        this.chats.set(sessionId, session);
        try {
            // Evidence from this deployment: chatgpt.com/backend-api is reachable
            // while api.openai.com (the CLI's transport) can be blocked on the same
            // network. Direct streaming is therefore primary for Codex, with the
            // CLI as fallback.
            if (providerId === 'codex-plan') {
                try {
                    return await this.directCodexChat(model, prompt, options, session);
                } catch (error) {
                    if (isAbort(error)) throw new Error(CHAT_STOPPED_MESSAGE);
                    console.warn('[kogg:providers:login] direct-chat.failed', { providerId, errorType: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message.slice(0, 200) : 'UnknownError' });
                }
            }
            return await this.cliChat(providerId, model, prompt, options, session);
        } finally {
            this.chats.delete(sessionId);
        }
    }

    cancelChat(sessionId: string): boolean {
        const session = this.chats.get(sessionId);
        if (!session) return false;
        this.chats.delete(sessionId);
        session.abort.abort();
        session.child?.kill('SIGTERM');
        console.info('[kogg:providers:login] chat.cancelled', {});
        return true;
    }

    private async directCodexChat(model: string, prompt: string, options: ChatCallOptions, session: ActiveChat): Promise<string> {
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
                input: codexInput(prompt, options.history),
                store: false,
                stream: true
            }),
            signal: session.abort.signal
        });
        if (response.status === 400 || response.status === 403 || response.status === 404) {
            // observability-exempt: a malformed rejection body falls back to the generic HTTP-status refusal, which is the observable outcome.
            const detail = await response.json().catch(() => undefined) as { detail?: unknown } | undefined;
            const reason = typeof detail?.detail === 'string' && detail.detail ? `: ${detail.detail}` : '';
            throw new Error(`Codex plan rejected the request with HTTP ${response.status}${reason}`);
        }
        if (!response.ok || !response.body) throw new Error(`Codex plan chat failed with HTTP ${response.status}.`);
        // The stream frequently stays open after the reply text arrives, so
        // read incrementally: deltas stream to the caller and the read stops
        // as soon as the output is complete.
        const state: CodexStreamState = { parts: [], sawDelta: false };
        try {
            await consumeSseStream(response.body, {
                idleTimeoutMs: 90_000,
                totalTimeoutMs: 180_000,
                onEvent: data => {
                    const outcome = handleCodexStreamEvent(data, state);
                    if (state.parts.length && options.onDelta) options.onDelta(codexStreamText(state));
                    return outcome === 'stop' ? 'stop' : undefined;
                }
            });
        } catch (error) {
            if (error instanceof CodexStreamRejection) throw new Error(`Codex plan stream failed: ${error.message}`);
            throw error;
        }
        const text = codexStreamText(state);
        if (!text) throw new Error('Codex plan returned no advisory text.');
        return text;
    }

    private async cliChat(providerId: string, model: string, prompt: string, options: ChatCallOptions, session: ActiveChat): Promise<string> {
        const command = chatCommand(providerId, model, flattenHistory(prompt, options.history));
        console.info('[kogg:providers:login] cli-chat.started', { providerId, model });
        const operation = await this.operations.startOperation({ kind: 'provider-session', cancellable: true, absoluteTimeoutMs: 300_000 });
        const lease = operation.registerProcess({
            kind: 'provider-cli', owner: 'kogg-supervisor',
            cancel: async () => { session.child?.kill('SIGTERM'); }
        });
        operation.start(); lease.spawning();
        const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        session.child = child;
        lease.started(child.pid ?? -1);
        // Registry timeouts (or a lease cancel) must settle the RPC promise;
        // otherwise the widget stays busy forever waiting on a dead child.
        const abortPromise = new Promise<never>((_, reject) => {
            session.abort.signal.addEventListener('abort', () => {
                try { child.kill('SIGTERM'); } catch { /* observability-exempt: the CLI already exited; the rejection below is the observable stop outcome. */ }
                reject(new Error(CHAT_STOPPED_MESSAGE));
            }, { once: true });
        });
        return await Promise.race([new Promise<string>((resolve, reject) => {
            const stdout: string[] = [];
            const stderr: string[] = [];
            child.stdout!.on('data', (chunk: Buffer) => { lease.activity(); operation.active(); stdout.push(chunk.toString('utf8')); });
            child.stderr!.on('data', (chunk: Buffer) => { lease.activity(); stderr.push(chunk.toString('utf8')); });
            child.once('error', error => {
                try { lease.failed('PROCESS_SPAWN_FAILED', error.name); lease.cleanup(); void operation.cleanup(); } catch { /* observability-exempt: the lease or operation may already be terminal after a timeout. */ }
                try { operation.fail('PROCESS_SPAWN_FAILED', error.name); } catch { /* observability-exempt: the operation already reached a terminal state (timeout). */ }
                reject(new Error(`The ${providerId === 'claude-max' ? 'claude' : 'codex'} CLI could not start: ${error.message}`));
            });
            child.once('exit', code => {
                try { lease.exited(code === 0 ? 'zero' : code === null ? 'signal' : 'nonzero'); lease.cleanup(); void operation.cleanup(); } catch { /* observability-exempt: the lease may already be terminal after a timeout; the abort race settles the RPC. */ }
                if (code !== 0 && session.abort.signal.aborted) { reject(new Error(CHAT_STOPPED_MESSAGE)); return; }
                const text = extractReply(stdout.join(''), providerId);
                if (code === 0 && text) { try { operation.complete(); } catch { /* observability-exempt: the operation already reached a terminal state (timeout). */ } resolve(text); return; }
                try { operation.fail('PROCESS_EXIT_NONZERO', 'NonZeroExit'); } catch { /* observability-exempt: the operation already reached a terminal state (timeout). */ }
                const reason = lastMeaningfulLine(stderr.join('')) ?? (text ? undefined : 'The CLI produced no reply.');
                reject(new Error(providerId === 'claude-max'
                    ? `Claude CLI did not complete${reason ? `: ${reason}` : '.'}`
                    : `Codex CLI did not complete${reason ? `: ${reason}` : '.'}`));
            });
        }), abortPromise]);
    }

    async cancel(providerId: string): Promise<AccountLoginState> {
        const login = this.logins.get(providerId);
        if (!login) return { status: 'idle', needsCode: false };
        login.child?.kill('SIGTERM');
        login.state = { status: 'cancelled', needsCode: false };
        this.recordTerminal(providerId, login.state);
        // The child's exit handler skips terminal transitions once the state is
        // cancelled, so only the lease lifecycle is closed here; the exit event
        // completes the registry operation cleanup.
        try { login.lease?.exited('signal'); login.lease?.cleanup(); } catch { /* observability-exempt: the lease may already be terminal after a timeout; the registry state stays authoritative. */ }
        console.info('[kogg:providers:login] login.cancelled', { providerId });
        return login.state;
    }
}

function loginCancel(providerId: string, logins: Map<string, ActiveLogin>): void {
    const login = logins.get(providerId);
    if (login?.child) login.child.kill('SIGTERM');
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

export const CHAT_STOPPED_MESSAGE = 'Generation stopped.';

function isAbort(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'UserAbortError');
}

// Shapes the Responses API `input` array, replaying prior turns so follow-up
// questions carry the conversation. Assistant turns use output_text content
// parts, as the Responses API requires.
function codexInput(prompt: string, history?: readonly ChatTurn[]): Array<{ type: 'message'; role: 'user' | 'assistant'; content: Array<{ type: 'input_text' | 'output_text'; text: string }> }> {
    const turns = (history ?? []).map(turn => ({
        type: 'message' as const,
        role: turn.role,
        content: [{ type: turn.role === 'assistant' ? 'output_text' as const : 'input_text' as const, text: turn.content }]
    }));
    return [...turns, { type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text: prompt }] }];
}

// CLI chat has no native multi-turn flag, so prior turns are folded into the
// prompt with explicit speaker labels. The direct streaming path is primary;
// this only keeps the fallback conversationally coherent.
function flattenHistory(prompt: string, history?: readonly ChatTurn[]): string {
    if (!history?.length) return prompt;
    const transcript = history.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n\n');
    return `${transcript}\n\nUser: ${prompt}`;
}
