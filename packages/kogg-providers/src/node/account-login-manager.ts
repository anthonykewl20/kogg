import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
