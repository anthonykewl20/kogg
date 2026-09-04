import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { CommandService, MessageService } from '@theia/core';
import type { CredentialMetadata, ModelDescriptor, ProviderDescriptor } from '@kogg/contracts';
import { KoggProviderService, type AccountLoginState, type ChatStreamEvent, type ChatTurn } from '../common/provider-service';
import { ProviderChatClient } from './chat-client';
import { renderMarkdown, type RenderedCodeBlock } from './markdown';

// diagnostic-coverage: providers.registry, providers.credentials

interface ThreadMessage extends ChatTurn {
    readonly failed?: boolean;
}

const HISTORY_TURN_LIMIT = 20;

@injectable()
export class KoggProviderWidget extends BaseWidget {
    static readonly ID = 'kogg-provider-setup';
    static readonly LABEL = 'Kogg AI';
    private providers: readonly ProviderDescriptor[] = [];
    private models: readonly ModelDescriptor[] = [];
    private credentials: readonly CredentialMetadata[] = [];
    private provider = 'ollama';
    private account = 'default';
    private endpoint = '';
    private selectedModel = '';
    private status = 'Select a provider and test the connection.';
    private loginState: AccountLoginState | undefined;
    private loginPoll: number | undefined;
    private loginPollBusy = false;
    private thread: ThreadMessage[] = [];
    private promptDraft = '';
    private chatError = '';
    private chatMode: 'plan' | 'build' | 'kogg' = 'plan';
    private chatModeState = 'loading';
    private chatModeStage = '';
    private chatModeProbe: number | undefined;
    private settingsOpen = false;
    private busy = false;
    private streaming = false;
    private streamSession = '';
    private streamingText = '';
    private streamStartedAt = 0;
    private streamTimer: number | undefined;
    private streamTextEl: HTMLElement | undefined;
    private streamElapsedEl: HTMLElement | undefined;
    private codeBlocks: readonly RenderedCodeBlock[] = [];

    constructor(
        @inject(KoggProviderService) private readonly service: KoggProviderService,
        @inject(MessageService) private readonly messages: MessageService,
        @inject(CommandService) private readonly commands: CommandService,
        @inject(ProviderChatClient) private readonly chatClient: ProviderChatClient
    ) { super(); }

    @postConstruct()
    protected init(): void {
        this.id = KoggProviderWidget.ID;
        this.title.label = KoggProviderWidget.LABEL;
        this.title.caption = 'Kogg provider configuration and advisory chat';
        this.title.closable = true;
        this.addClass('kogg-provider-widget');
        const modeListener = (event: Event) => {
            const detail = (event as CustomEvent<{ state?: unknown; selectedMode?: unknown; activeStage?: unknown }>).detail;
            if (!detail || !isChatMode(detail.selectedMode)) return;
            if (this.chatModeProbe !== undefined) { window.clearInterval(this.chatModeProbe); this.chatModeProbe = undefined; }
            this.chatMode = detail.selectedMode;
            this.chatModeState = typeof detail.state === 'string' ? detail.state : 'unavailable';
            this.chatModeStage = typeof detail.activeStage === 'string' ? detail.activeStage : '';
            this.render();
        };
        window.addEventListener('kogg:interaction-mode-ui', modeListener);
        this.toDispose.push({ dispose: () => window.removeEventListener('kogg:interaction-mode-ui', modeListener) });
        this.toDispose.push({ dispose: () => { if (this.chatModeProbe !== undefined) window.clearInterval(this.chatModeProbe); } });
        window.dispatchEvent(new Event('kogg:interaction-mode-ui-request'));
        // If no interaction-mode extension answers, stop advertising "loading".
        this.chatModeProbe = window.setTimeout(() => {
            if (this.chatModeState === 'loading') { this.chatModeState = 'unavailable'; this.render(); }
        }, 4_000);
        this.chatClient.listen(event => this.onChatEvent(event));
        this.toDispose.push({ dispose: () => this.stopStreamTimer() });
        this.toDispose.push({ dispose: () => this.stopLoginPoll() });
        void this.load();
        this.render();
    }

    private async load(): Promise<void> {
        try {
            [this.providers, this.credentials] = await Promise.all([
                this.service.listProviders(),
                this.service.listCredentialMetadata()
            ]);
        }
        catch (error) {
            console.error('[kogg:providers:widget] providers-load.failed', { errorType: errorName(error) });
            this.status = message(error);
        }
        this.maybeAutoDiscover();
        this.render();
    }

    private onChatEvent(event: ChatStreamEvent): void {
        if (event.sessionId !== this.streamSession || !this.streaming) return;
        if (event.kind === 'delta' && event.text) {
            this.streamingText += event.text;
            if (this.streamTextEl) {
                this.streamTextEl.textContent = this.streamingText;
                this.scrollThreadToBottom();
            }
        } else if (event.kind === 'error' && event.error) {
            this.streamTextEl?.classList.add('stalled');
            if (this.streamElapsedEl) this.streamElapsedEl.textContent = event.error === 'Generation stopped.' ? 'stopped' : 'error';
        }
    }

    private scrollThreadToBottom(): void {
        const view = this.node.querySelector<HTMLElement>('.kogg-chat-thread');
        if (view) view.scrollTop = view.scrollHeight;
    }

    private render(): void {
        // Preserve the live details state: re-renders replace the DOM, and a
        // missed toggle event would otherwise collapse an open settings panel.
        const liveSettings = this.node.querySelector<HTMLDetailsElement>('.kogg-ai-settings');
        if (liveSettings) this.settingsOpen = liveSettings.open;
        const liveModel = this.node.querySelector<HTMLSelectElement>('select[data-field="model"]')?.value ?? '';
        if (!this.selectedModel && liveModel) this.selectedModel = liveModel;
        // Preserve focus and caret across the re-render (e.g. the login poll
        // must not interrupt typing the confirmation code).
        const active = this.node.ownerDocument.activeElement as HTMLElement | null;
        const activeField = active?.closest?.('[data-field]')?.getAttribute('data-field');
        const activeSelectionStart = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
        const descriptor = this.providers.find(item => item.id === this.provider);
        const chatReady = !!this.selectedModel;
        const credentialConfigured = descriptor?.configuration === 'local'
            || this.credentials.some(item => item.provider === this.provider && item.account === this.account);
        const connectionState = chatReady ? 'Ready' : credentialConfigured ? 'Connected' : 'Not connected';
        this.codeBlocks = [];
        this.node.innerHTML = `<div class="kogg-panel kogg-ai-panel">
          <header><h2>Kogg AI</h2><p>Your engineering copilot, grounded in the active workspace.</p></header>
          <details class="kogg-ai-settings" ${this.settingsOpen ? 'open' : ''}>
            <summary><span>Model connection</span><strong class="${chatReady ? 'ready' : ''}">${escapeHtml(this.selectedModel || connectionState)}</strong></summary>
            <div class="kogg-provider-step"><span>1</span><div><strong>Choose a provider</strong><p>Cloud APIs and local runtimes are supported.</p></div></div>
            <div class="kogg-provider-cards" role="radiogroup" aria-label="AI provider">
              ${this.providers.map(item => {
                const connected = item.configuration === 'local' || this.credentials.some(value => value.provider === item.id);
                return `<button type="button" role="radio" aria-checked="${item.id === this.provider}" data-provider-option="${escapeHtml(item.id)}" class="${item.id === this.provider ? 'selected' : ''}"><span class="kogg-provider-monogram">${escapeHtml(item.name.slice(0, 1))}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(providerDescription(item))}</small></span><i class="${connected ? 'connected' : ''}" title="${connected ? 'Credential or local runtime available' : 'Not connected'}"></i></button>`;
              }).join('')}
            </div>
            <div class="kogg-provider-step"><span>2</span><div><strong>Connect securely</strong><p>${descriptor?.configuration === 'local' ? 'Kogg connects directly to the runtime on this machine.' : descriptor?.configuration === 'oauth-account' ? 'Kogg imports the signed-in account from the matching CLI on this machine. The token is encrypted at rest and never displayed.' : descriptor?.configuration === 'oauth' ? 'Enter an access token. Browser authorization is not enabled yet.' : 'Credentials are encrypted at rest and never displayed again.'}</p></div></div>
            <div class="kogg-form-grid">
            <label>Provider<select data-field="provider">${this.providers.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === this.provider ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
            <label>Account<input data-field="account" value="${escapeHtml(this.account)}"></label>
            <label>Endpoint (optional)<input data-field="endpoint" value="${escapeHtml(this.endpoint)}" placeholder="Use provider default"></label>
            ${descriptor?.configuration === 'local' || descriptor?.configuration === 'oauth-account' ? '' : `<label>${descriptor?.configuration === 'oauth' ? 'Access token' : 'API key'}<input data-field="secret" type="password" autocomplete="new-password" placeholder="Paste once; never shown again"></label>`}
            </div>
            ${descriptor?.configuration === 'oauth-account' ? this.renderAccountLogin() : `<div class="kogg-actions">
            ${descriptor?.configuration === 'local' ? '' : `<button data-action="save" ${this.busy ? 'disabled' : ''}>Save credential</button>`}
            <button data-action="test" ${this.busy ? 'disabled' : ''}>Test connection</button>
            <button data-action="models" ${this.busy ? 'disabled' : ''}>Discover models</button>
            </div>`}
            <p role="status" class="kogg-connection-status"><i class="${credentialConfigured ? 'connected' : ''}"></i><strong>${escapeHtml(connectionState)}:</strong> ${escapeHtml(this.status)}</p>
            <section><h3>Stored credentials</h3>${this.credentials.length ? `<ul>${this.credentials.map(item => `<li>${escapeHtml(item.provider)} / ${escapeHtml(item.account)} <span>updated ${escapeHtml(item.updatedAt)}</span> <button data-delete-provider="${escapeHtml(item.provider)}" data-delete-account="${escapeHtml(item.account)}" ${this.busy ? 'disabled' : ''}>Delete</button></li>`).join('')}</ul>` : '<p>None. Secret values are never displayed.</p>'}</section>
            <p><strong>Ranex qualification:</strong> <span class="kogg-blocked">${descriptor?.governedQualification === 'qualified' ? 'Qualified' : 'Advisory only — governed mutation blocked'}</span></p>
            <div class="kogg-provider-step"><span>3</span><div><strong>Select a model</strong><p>Discover models after the connection succeeds.</p></div></div>
            <label>Model<select data-field="model"><option value="">Select a discovered model</option>${this.models.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === this.selectedModel ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
          </details>
          <div class="kogg-chat-thread" role="log" aria-live="polite" aria-busy="${this.streaming}">
            ${this.renderThread()}
          </div>
          <div class="kogg-chat-modes" role="group" aria-label="Chat mode">
            <span>Mode</span>
            ${(['plan', 'build', 'kogg'] as const).map(mode => `<button type="button" data-chat-mode="${mode}" aria-pressed="${this.chatMode === mode}" class="${this.chatMode === mode ? 'selected' : ''}" title="${escapeHtml(chatModeDescription(mode))}">${escapeHtml(mode[0]!.toUpperCase() + mode.slice(1))}</button>`).join('')}
            <small>${escapeHtml(this.chatModeState === 'ready' ? this.chatModeStage || 'ready' : this.chatModeState === 'no-task' ? 'No active task' : this.chatModeState)}</small>
          </div>
          <div class="kogg-chat-composer">
            <label><span class="theia-sr-only">Message Kogg</span><textarea data-field="prompt" rows="3" placeholder="${chatReady ? 'Ask Kogg about your code… Enter to send, Shift+Enter for a new line.' : 'Connect a model to start chatting'}">${escapeHtml(this.promptDraft)}</textarea></label>
            <div><span>${chatReady ? `${escapeHtml(this.selectedModel)} · ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}↵ also sends` : 'No model selected'}</span>${this.streaming
                ? `<button data-action="stop" class="kogg-chat-stop" aria-label="Stop generating">Stop</button>`
                : `<button data-action="chat" aria-label="Send message" ${!chatReady ? 'disabled' : ''}>Send</button>`}</div>
          </div>
        </div>`;
        this.bindDom();
        this.restoreFocus(activeField, activeSelectionStart);
        if (this.streaming) {
            this.streamTextEl = this.node.querySelector<HTMLElement>('[data-stream-target]') ?? undefined;
            this.streamElapsedEl = this.node.querySelector<HTMLElement>('.kogg-chat-elapsed') ?? undefined;
            if (this.streamTextEl) this.streamTextEl.textContent = this.streamingText;
            this.scrollThreadToBottom();
        } else {
            this.streamTextEl = undefined;
            this.streamElapsedEl = undefined;
        }
    }

    private renderThread(): string {
        const blocks: RenderedCodeBlock[] = [];
        const bubbles = this.thread.map(turn => {
            if (turn.role === 'user') return `<div class="kogg-chat-message user"><span>You</span><p>${escapeHtml(turn.content)}</p></div>`;
            const rendered = renderMarkdown(turn.content);
            for (const block of rendered.codeBlocks) blocks.push(block);
            return `<div class="kogg-chat-message assistant${turn.failed ? ' failed' : ''}"><span>Kogg</span>${turn.content ? rendered.html : `<div class="kogg-chat-pending"><i class="kogg-chat-spinner" aria-hidden="true"></i><small>Thinking… <span class="kogg-chat-elapsed">0s</span></small></div>`}</div>`;
        });
        if (this.streaming) {
            const pendingIndex = this.thread.length - 1;
            if (pendingIndex >= 0 && this.thread[pendingIndex]?.role === 'assistant' && !this.thread[pendingIndex]!.content) {
                // The placeholder for the in-flight turn already rendered; swap
                // its pending area for the live streaming target.
                bubbles[pendingIndex] = `<div class="kogg-chat-message assistant"><span>Kogg</span><pre class="kogg-chat-stream" data-stream-target></pre><small class="kogg-chat-stream-meta"><i class="kogg-chat-spinner" aria-hidden="true"></i><span class="kogg-chat-elapsed">0s</span></small></div>`;
            }
        }
        this.codeBlocks = blocks;
        if (!this.thread.length) {
            const chatReady = !!this.selectedModel;
            return `<div class="kogg-chat-empty"><div class="kogg-chat-mark">K</div><h3>What are we building?</h3><p>${chatReady ? 'Ask about the workspace, plan a change, or investigate a problem.' : 'Connect a provider, verify it, and choose a model to begin.'}</p>${chatReady ? '' : '<button data-open-settings>Connect a provider</button>'}</div>`;
        }
        const newChat = this.thread.length && !this.streaming ? '<button type="button" class="kogg-chat-new" data-action="new-chat">New chat</button>' : '';
        const error = this.chatError ? `<div class="kogg-chat-error" role="alert"><strong>The request failed.</strong> <span>${escapeHtml(this.chatError)}</span> <button type="button" data-action="retry">Retry</button></div>` : '';
        return `${bubbles.join('')}${error}${newChat}`;
    }

    private bindDom(): void {
        this.node.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach(field => field.addEventListener('change', () => this.capture()));
        this.node.querySelector<HTMLDetailsElement>('.kogg-ai-settings')?.addEventListener('toggle', event => {
            this.settingsOpen = (event.currentTarget as HTMLDetailsElement).open;
        });
        this.node.querySelectorAll<HTMLElement>('[data-provider-option]').forEach(button => button.addEventListener('click', () => {
            this.capture();
            this.provider = button.dataset.providerOption!;
            this.models = [];
            this.selectedModel = '';
            this.status = 'Provider selected. Add its connection details, then test the connection.';
            this.render();
            this.maybeAutoDiscover();
        }));
        this.node.querySelector<HTMLElement>('[data-open-settings]')?.addEventListener('click', () => {
            this.settingsOpen = true;
            this.render();
            this.node.querySelector('.kogg-ai-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        const prompt = this.node.querySelector<HTMLTextAreaElement>('[data-field="prompt"]');
        prompt?.addEventListener('input', () => { this.promptDraft = prompt.value; });
        prompt?.addEventListener('keydown', event => {
            // Plain Enter sends; Shift+Enter inserts a newline. Guards keep an
            // in-flight IME composition (keyCode 229) from sending early.
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void this.chat(); }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void this.chat(); }
        });
        this.node.querySelector<HTMLElement>('[data-action="save"]')?.addEventListener('click', () => void this.saveCredential());
        this.node.querySelector<HTMLElement>('[data-action="import"]')?.addEventListener('click', () => void this.importAccount());
        this.node.querySelector<HTMLElement>('[data-action="login"]')?.addEventListener('click', () => void this.startLogin());
        this.node.querySelector<HTMLElement>('[data-action="open-login"]')?.addEventListener('click', () => { if (this.loginState?.url) window.open(this.loginState.url, '_blank', 'noopener'); });
        this.node.querySelector<HTMLElement>('[data-action="submit-login-code"]')?.addEventListener('click', () => void this.submitLoginCode());
        this.node.querySelector<HTMLElement>('[data-action="cancel-login"]')?.addEventListener('click', () => void this.cancelLogin());
        this.node.querySelector<HTMLElement>('[data-action="test"]')?.addEventListener('click', () => void this.testConnection());
        this.node.querySelector<HTMLElement>('[data-action="models"]')?.addEventListener('click', () => void this.discoverModels());
        this.node.querySelector<HTMLElement>('[data-action="chat"]')?.addEventListener('click', () => void this.chat());
        this.node.querySelector<HTMLElement>('[data-action="stop"]')?.addEventListener('click', () => void this.stopStreaming());
        this.node.querySelector<HTMLElement>('[data-action="new-chat"]')?.addEventListener('click', () => {
            this.thread = [];
            this.chatError = '';
            this.render();
        });
        this.node.querySelector<HTMLElement>('[data-action="retry"]')?.addEventListener('click', () => {
            const lastUser = [...this.thread].reverse().find(turn => turn.role === 'user');
            this.chatError = '';
            if (lastUser) { this.promptDraft = lastUser.content; this.thread = this.thread.slice(0, this.thread.lastIndexOf(lastUser)); }
            this.render();
            this.node.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')?.focus();
        });
        this.node.querySelectorAll<HTMLElement>('[data-chat-mode]').forEach(button => button.addEventListener('click', () => {
            const mode = button.dataset.chatMode;
            if (!isChatMode(mode)) return;
            console.info('[kogg:providers:widget] chat-mode.requested', { selectedMode: mode, currentMode: this.chatMode });
            void this.commands.executeCommand('kogg.interaction-mode.select', mode);
        }));
        this.node.querySelectorAll<HTMLElement>('[data-delete-provider]').forEach(button => button.addEventListener('click', () => {
            void this.deleteCredential(button.dataset.deleteProvider!, button.dataset.deleteAccount!);
        }));
        this.node.querySelectorAll<HTMLElement>('[data-copy-code]').forEach(button => button.addEventListener('click', () => {
            const block = this.codeBlocks[Number(button.dataset.copyCode)];
            if (!block) return;
            void navigator.clipboard.writeText(block.code).then(() => {
                button.textContent = 'Copied';
                window.setTimeout(() => { button.textContent = 'Copy'; }, 1_500);
            });
        }));
    }

    private restoreFocus(field: string | null | undefined, selectionStart: number | null): void {
        if (!field) return;
        const target = this.node.querySelector<HTMLElement>(`[data-field="${field}"]`);
        if (!target) return;
        target.focus();
        if (selectionStart !== null && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
            try { target.setSelectionRange(selectionStart, selectionStart); } catch { /* observability-exempt: inputs without selection APIs simply keep focus; no operational state changes. */ }
        }
    }

    private capture(): void {
        const read = (name: string) => (this.node.querySelector(`[data-field="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
        const changedProvider = read('provider') !== this.provider;
        this.provider = read('provider'); this.account = read('account'); this.endpoint = read('endpoint'); this.selectedModel = read('model'); this.promptDraft = read('prompt');
        if (changedProvider) { this.models = []; this.selectedModel = ''; this.status = 'Provider changed. Test the connection.'; this.render(); this.maybeAutoDiscover(); }
    }

    private readonly autoDiscovered = new Set<string>();

    private async reloadCredentials(): Promise<void> {
        this.credentials = await this.service.listCredentialMetadata();
    }

    private isAccountConnected(): boolean {
        const descriptor = this.providers.find(item => item.id === this.provider);
        return descriptor?.configuration === 'oauth-account'
            && this.credentials.some(item => item.provider === this.provider && item.account === (this.account || 'default'));
    }

    private maybeAutoDiscover(): void {
        if (this.autoDiscovered.has(this.provider) || !this.isAccountConnected() || this.models.length > 0) return;
        this.autoDiscovered.add(this.provider);
        void this.discoverModels();
    }

    private renderAccountLogin(): string {
        const brand = this.provider === 'claude-max' ? 'Anthropic' : 'OpenAI';
        const login = this.loginState;
        if (login && (login.status === 'running' || login.status === 'awaiting-code')) {
            return `<div class="kogg-login-flow">
                <p class="kogg-login-heading">${login.status === 'awaiting-code' ? 'Paste the confirmation code from your browser' : `Waiting for you to finish signing in with ${brand}`}</p>
                ${login.url ? `<div class="kogg-login-url"><code>${escapeHtml(login.url)}</code><button type="button" data-action="open-login">Open browser</button></div>` : '<p class="kogg-login-hint">The sign-in page is opening…</p>'}
                ${login.status === 'awaiting-code' ? `<div class="kogg-login-code"><input data-field="login-code" placeholder="Confirmation code" autocomplete="one-time-code"><button type="button" data-action="submit-login-code">Submit code</button></div>` : ''}
                <button type="button" class="kogg-login-cancel" data-action="cancel-login">Cancel sign-in</button>
            </div>`;
        }
        if (this.isAccountConnected()) {
            return `<div class="kogg-actions">
                <button data-action="test" ${this.busy ? 'disabled' : ''}>Test connection</button>
                <button data-action="models" ${this.busy ? 'disabled' : ''}>Discover models</button>
                <button type="button" class="kogg-login-secondary" data-action="login" ${this.busy ? 'disabled' : ''}>Sign in again</button>
            </div>`;
        }
        return `<div class="kogg-login-entry">
            <button type="button" class="kogg-login-primary" data-action="login" ${this.busy ? 'disabled' : ''}>Sign in with ${brand}</button>
            <button type="button" class="kogg-login-secondary" data-action="import" ${this.busy ? 'disabled' : ''}>Use an existing CLI sign-in</button>
            ${login?.status === 'failed' && login.error ? `<p class="kogg-login-error">${escapeHtml(login.error)}</p>` : ''}
        </div>`;
    }

    private async submitLoginCode(): Promise<void> {
        const input = this.node.querySelector<HTMLInputElement>('[data-field="login-code"]');
        const code = input?.value.trim() ?? '';
        if (!code) { await this.messages.warn('Paste the confirmation code from the browser first.'); return; }
        try {
            this.loginState = await this.service.submitAccountLoginCode(this.provider, code);
        } catch (error) {
            console.warn('[kogg:providers:widget] login.code-submit.failed', { providerId: this.provider, errorType: errorName(error) });
            await this.messages.error(message(error));
            return;
        }
        this.render();
        this.scheduleLoginPoll();
    }

    private async cancelLogin(): Promise<void> {
        this.stopLoginPoll();
        try {
            this.loginState = await this.service.cancelAccountLogin(this.provider);
        } catch (error) {
            console.warn('[kogg:providers:widget] login.cancel.failed', { providerId: this.provider, errorType: errorName(error) });
            await this.messages.error(message(error));
            return;
        }
        this.render();
    }

    private async startLogin(): Promise<void> {
        console.info('[kogg:providers:widget] login.requested', { providerId: this.provider });
        try {
            this.loginState = await this.service.startAccountLogin(this.provider, this.account || 'default');
        } catch (error) {
            console.warn('[kogg:providers:widget] login.start.failed', { providerId: this.provider, errorType: errorName(error) });
            await this.messages.error(message(error));
            return;
        }
        this.render();
        this.scheduleLoginPoll();
    }

    private scheduleLoginPoll(): void {
        if (this.loginPoll !== undefined || !this.loginState || (this.loginState.status !== 'running' && this.loginState.status !== 'awaiting-code')) return;
        let lastSnapshot = '';
        this.loginPoll = window.setInterval(async () => {
            if (this.loginPollBusy) return;
            this.loginPollBusy = true;
            try {
                this.loginState = await this.service.accountLoginState(this.provider);
                const login = this.loginState;
                if (!login) return;
                const snapshot = JSON.stringify([login.status, login.url ?? '', login.needsCode]);
                if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; this.render(); }
                if (login.status === 'succeeded') {
                    this.stopLoginPoll();
                    await this.reloadCredentials();
                    this.render();
                    await this.messages.info(`${this.provider === 'claude-max' ? 'Anthropic' : 'OpenAI'} account connected.`);
                    await this.testConnection();
                    await this.discoverModels();
                } else if (login.status === 'failed' || login.status === 'cancelled') {
                    this.stopLoginPoll();
                    if (login.status === 'failed') await this.messages.error(login.error ?? 'Sign-in did not complete.');
                    this.render();
                }
            } catch (error) {
                console.warn('[kogg:providers:widget] login.poll.failed', { providerId: this.provider, errorType: errorName(error) });
            } finally {
                this.loginPollBusy = false;
            }
        }, 1_200);
    }

    private stopLoginPoll(): void {
        if (this.loginPoll !== undefined) { window.clearInterval(this.loginPoll); this.loginPoll = undefined; }
    }

    private async importAccount(): Promise<void> {
        console.info('[kogg:providers:widget] account.import.requested', { providerId: this.provider });
        await this.run(async () => {
            await this.service.importAccountCredential(this.provider, this.account || 'default');
            await this.reloadCredentials();
            this.status = 'Signed-in account imported.';
        });
        this.render();
        await this.testConnection();
        await this.discoverModels();
    }

    private async saveCredential(): Promise<void> {
        this.capture();
        const secret = (this.node.querySelector('[data-field="secret"]') as HTMLInputElement | null)?.value ?? '';
        if (!secret) { await this.messages.warn('Enter a credential to store.'); return; }
        await this.run(async () => {
            await this.service.configureCredential(this.provider, this.account, secret);
            this.credentials = await this.service.listCredentialMetadata();
            this.status = 'Credential securely stored.';
        });
    }

    private async deleteCredential(provider: string, account: string): Promise<void> {
        await this.run(async () => {
            await this.service.deleteCredential(provider, account);
            this.credentials = await this.service.listCredentialMetadata();
            this.status = `Credential metadata for ${provider}/${account} was deleted.`;
        });
    }

    private async testConnection(): Promise<void> {
        this.capture();
        await this.run(async () => { const result = await this.service.testConnection(this.provider, this.account, this.endpoint || undefined); this.status = result.detail; });
    }

    private async discoverModels(): Promise<void> {
        this.capture();
        await this.run(async () => {
            this.models = await this.service.discoverModels(this.provider, this.account, this.endpoint || undefined);
            this.selectedModel = this.models[0]?.id ?? '';
            this.status = this.models.length ? `Discovered ${this.models.length} model(s).` : 'Connection succeeded, but no models were returned.';
        });
    }

    private async chat(): Promise<void> {
        if (this.streaming) return;
        this.capture();
        const prompt = this.promptDraft.trim();
        if (!prompt || !this.selectedModel) { await this.messages.warn('Select a model and enter an advisory prompt.'); return; }
        const history = this.thread.slice(-HISTORY_TURN_LIMIT);
        this.thread = [...this.thread, { role: 'user', content: prompt }, { role: 'assistant', content: '' }];
        this.promptDraft = '';
        this.chatError = '';
        this.streaming = true;
        this.streamingText = '';
        this.streamSession = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        this.streamStartedAt = Date.now();
        this.render();
        this.startStreamTimer();
        this.node.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')?.focus();
        try {
            const reply = await this.service.advisoryChat({
                provider: this.provider, account: this.account, endpoint: this.endpoint || undefined,
                model: this.selectedModel, prompt, history, sessionId: this.streamSession
            });
            this.thread = [...this.thread.slice(0, -1), { role: 'assistant', content: reply || this.streamingText }];
            this.status = 'Advisory response received. Governed mutation remains subject to Ranex qualification.';
        } catch (error) {
            console.error('[kogg:providers:widget] chat.failed', { providerId: this.provider, errorType: errorName(error) });
            const text = message(error);
            const stopped = text.includes('stopped');
            this.thread = [...this.thread.slice(0, -1), { role: 'assistant', content: stopped ? 'Generation stopped.' : '', failed: !stopped }];
            this.chatError = stopped ? '' : text;
            if (!stopped) await this.messages.error(text);
        } finally {
            this.streaming = false;
            this.stopStreamTimer();
            this.streamSession = '';
            this.render();
            this.node.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')?.focus();
        }
    }

    private async stopStreaming(): Promise<void> {
        if (!this.streamSession) return;
        try { await this.service.cancelChat(this.streamSession); }
        catch (error) { console.warn('[kogg:providers:widget] chat.cancel.failed', { errorType: errorName(error) }); }
    }

    private startStreamTimer(): void {
        this.stopStreamTimer();
        this.streamTimer = window.setInterval(() => {
            const seconds = Math.round((Date.now() - this.streamStartedAt) / 1_000);
            if (this.streamElapsedEl) this.streamElapsedEl.textContent = `${seconds}s`;
        }, 1_000);
    }

    private stopStreamTimer(): void {
        if (this.streamTimer !== undefined) { window.clearInterval(this.streamTimer); this.streamTimer = undefined; }
    }

    private async run(operation: () => Promise<void>): Promise<void> {
        this.busy = true; this.render();
        try { await operation(); }
        catch (error) {
            console.error('[kogg:providers:widget] operation.failed', {
                providerId: this.provider,
                errorType: errorName(error)
            });
            this.status = message(error);
            await this.messages.error(this.status);
        }
        finally { this.busy = false; this.render(); }
    }
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'Kogg provider operation failed'; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function providerDescription(provider: ProviderDescriptor): string {
    if (provider.configuration === 'local') return 'Runs on this device';
    if (provider.configuration === 'oauth-account') return 'Signed-in plan account';
    if (provider.configuration === 'oauth') return 'Access token';
    return 'API key';
}
function isChatMode(value: unknown): value is 'plan' | 'build' | 'kogg' { return value === 'plan' || value === 'build' || value === 'kogg'; }
function chatModeDescription(mode: 'plan' | 'build' | 'kogg'): string {
    if (mode === 'plan') return 'Research and approval-ready planning; production mutation is refused.';
    if (mode === 'build') return 'Private implementation and tests; governed PASS and merge remain unavailable.';
    return 'Governed verification, evidence, verdict, and controlled completion.';
}
