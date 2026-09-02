import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { CommandService, MessageService } from '@theia/core';
import type { CredentialMetadata, ModelDescriptor, ProviderDescriptor } from '@kogg/contracts';
import { KoggProviderService } from '../common/provider-service';

// diagnostic-coverage: providers.registry, providers.credentials

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
    private reply = '';
    private lastPrompt = '';
    private promptDraft = '';
    private chatMode: 'plan' | 'build' | 'kogg' = 'plan';
    private chatModeState = 'loading';
    private chatModeStage = '';
    private settingsOpen = false;
    private busy = false;

    constructor(
        @inject(KoggProviderService) private readonly service: KoggProviderService,
        @inject(MessageService) private readonly messages: MessageService,
        @inject(CommandService) private readonly commands: CommandService
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
            this.chatMode = detail.selectedMode;
            this.chatModeState = typeof detail.state === 'string' ? detail.state : 'unavailable';
            this.chatModeStage = typeof detail.activeStage === 'string' ? detail.activeStage : '';
            this.render();
        };
        window.addEventListener('kogg:interaction-mode-ui', modeListener);
        this.toDispose.push({ dispose: () => window.removeEventListener('kogg:interaction-mode-ui', modeListener) });
        window.dispatchEvent(new Event('kogg:interaction-mode-ui-request'));
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
        this.render();
    }

    private render(): void {
        const descriptor = this.providers.find(item => item.id === this.provider);
        const chatReady = !!this.selectedModel;
        const credentialConfigured = descriptor?.configuration === 'local'
            || this.credentials.some(item => item.provider === this.provider && item.account === this.account);
        const connectionState = chatReady ? 'Ready' : credentialConfigured ? 'Connected' : 'Not connected';
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
            <div class="kogg-provider-step"><span>2</span><div><strong>Connect securely</strong><p>${descriptor?.configuration === 'local' ? 'Kogg connects directly to the runtime on this machine.' : descriptor?.configuration === 'oauth' ? 'Enter an access token. Browser authorization is not enabled yet.' : 'Credentials are encrypted at rest and never displayed again.'}</p></div></div>
            <div class="kogg-form-grid">
            <label>Provider<select data-field="provider">${this.providers.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === this.provider ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
            <label>Account<input data-field="account" value="${escapeHtml(this.account)}"></label>
            <label>Endpoint (optional)<input data-field="endpoint" value="${escapeHtml(this.endpoint)}" placeholder="Use provider default"></label>
            ${descriptor?.configuration === 'local' ? '' : `<label>${descriptor?.configuration === 'oauth' ? 'Access token' : 'API key'}<input data-field="secret" type="password" autocomplete="new-password" placeholder="Paste once; never shown again"></label>`}
            </div>
            <div class="kogg-actions">
            ${descriptor?.configuration === 'local' ? '' : `<button data-action="save" ${this.busy ? 'disabled' : ''}>Save credential</button>`}
            <button data-action="test" ${this.busy ? 'disabled' : ''}>Test connection</button>
            <button data-action="models" ${this.busy ? 'disabled' : ''}>Discover models</button>
            </div>
            <p role="status" class="kogg-connection-status"><i class="${credentialConfigured ? 'connected' : ''}"></i><strong>${escapeHtml(connectionState)}:</strong> ${escapeHtml(this.status)}</p>
            <section><h3>Stored credentials</h3>${this.credentials.length ? `<ul>${this.credentials.map(item => `<li>${escapeHtml(item.provider)} / ${escapeHtml(item.account)} <span>updated ${escapeHtml(item.updatedAt)}</span> <button data-delete-provider="${escapeHtml(item.provider)}" data-delete-account="${escapeHtml(item.account)}" ${this.busy ? 'disabled' : ''}>Delete</button></li>`).join('')}</ul>` : '<p>None. Secret values are never displayed.</p>'}</section>
            <p><strong>Ranex qualification:</strong> <span class="kogg-blocked">${descriptor?.governedQualification === 'qualified' ? 'Qualified' : 'Advisory only — governed mutation blocked'}</span></p>
            <div class="kogg-provider-step"><span>3</span><div><strong>Select a model</strong><p>Discover models after the connection succeeds.</p></div></div>
            <label>Model<select data-field="model"><option value="">Select a discovered model</option>${this.models.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === this.selectedModel ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
          </details>
          <div class="kogg-chat-thread" aria-live="polite">
            ${this.reply
                ? `<div class="kogg-chat-message user"><span>You</span><p>${escapeHtml(this.lastPrompt)}</p></div><div class="kogg-chat-message assistant"><span>Kogg</span><pre>${escapeHtml(this.reply)}</pre></div>`
                : `<div class="kogg-chat-empty"><div class="kogg-chat-mark">K</div><h3>What are we building?</h3><p>${chatReady ? 'Ask about the workspace, plan a change, or investigate a problem.' : 'Connect a provider, verify it, and choose a model to begin.'}</p>${chatReady ? '' : '<button data-open-settings>Connect a provider</button>'}</div>`}
          </div>
          <div class="kogg-chat-modes" role="group" aria-label="Chat mode">
            <span>Mode</span>
            ${(['plan', 'build', 'kogg'] as const).map(mode => `<button type="button" data-chat-mode="${mode}" aria-pressed="${this.chatMode === mode}" class="${this.chatMode === mode ? 'selected' : ''}" title="${escapeHtml(chatModeDescription(mode))}">${escapeHtml(mode[0]!.toUpperCase() + mode.slice(1))}</button>`).join('')}
            <small>${escapeHtml(this.chatModeState === 'ready' ? this.chatModeStage || 'ready' : this.chatModeState === 'no-task' ? 'No active task' : this.chatModeState)}</small>
          </div>
          <div class="kogg-chat-composer">
            <label><span class="theia-sr-only">Message Kogg</span><textarea data-field="prompt" rows="3" placeholder="${chatReady ? 'Ask Kogg about your code…' : 'Connect a model to start chatting'}" ${chatReady ? '' : 'disabled'}>${escapeHtml(this.promptDraft)}</textarea></label>
            <div><span>${chatReady ? `${escapeHtml(this.selectedModel)} · ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}↵ to send` : 'No model selected'}</span><button data-action="chat" aria-label="Send message" ${this.busy || !chatReady ? 'disabled' : ''}>Send</button></div>
          </div>
        </div>`;
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
        }));
        this.node.querySelector<HTMLElement>('[data-open-settings]')?.addEventListener('click', () => {
            this.settingsOpen = true;
            this.render();
            this.node.querySelector('.kogg-ai-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        const prompt = this.node.querySelector<HTMLTextAreaElement>('[data-field="prompt"]');
        prompt?.addEventListener('input', () => { this.promptDraft = prompt.value; });
        prompt?.addEventListener('keydown', event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void this.chat(); }
        });
        this.node.querySelector<HTMLElement>('[data-action="save"]')?.addEventListener('click', () => void this.saveCredential());
        this.node.querySelector<HTMLElement>('[data-action="test"]')?.addEventListener('click', () => void this.testConnection());
        this.node.querySelector<HTMLElement>('[data-action="models"]')?.addEventListener('click', () => void this.discoverModels());
        this.node.querySelector<HTMLElement>('[data-action="chat"]')?.addEventListener('click', () => void this.chat());
        this.node.querySelectorAll<HTMLElement>('[data-chat-mode]').forEach(button => button.addEventListener('click', () => {
            const mode = button.dataset.chatMode;
            if (!isChatMode(mode)) return;
            console.info('[kogg:providers:widget] chat-mode.requested', { selectedMode: mode, currentMode: this.chatMode });
            void this.commands.executeCommand('kogg.interaction-mode.select', mode);
        }));
        this.node.querySelectorAll<HTMLElement>('[data-delete-provider]').forEach(button => button.addEventListener('click', () => {
            void this.deleteCredential(button.dataset.deleteProvider!, button.dataset.deleteAccount!);
        }));
    }

    private capture(): void {
        const read = (name: string) => (this.node.querySelector(`[data-field="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
        const changedProvider = read('provider') !== this.provider;
        this.provider = read('provider'); this.account = read('account'); this.endpoint = read('endpoint'); this.selectedModel = read('model'); this.promptDraft = read('prompt');
        if (changedProvider) { this.models = []; this.selectedModel = ''; this.status = 'Provider changed. Test the connection.'; this.render(); }
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
        this.capture();
        const prompt = this.promptDraft.trim();
        if (!prompt || !this.selectedModel) { await this.messages.warn('Select a model and enter an advisory prompt.'); return; }
        await this.run(async () => {
            this.reply = await this.service.advisoryChat({ provider: this.provider, account: this.account, endpoint: this.endpoint || undefined, model: this.selectedModel, prompt });
            this.lastPrompt = prompt;
            this.promptDraft = '';
            this.status = 'Advisory response received. Governed mutation remains subject to Ranex qualification.';
        });
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
    if (provider.configuration === 'oauth') return 'Access token';
    return 'API key';
}
function isChatMode(value: unknown): value is 'plan' | 'build' | 'kogg' { return value === 'plan' || value === 'build' || value === 'kogg'; }
function chatModeDescription(mode: 'plan' | 'build' | 'kogg'): string {
    if (mode === 'plan') return 'Research and approval-ready planning; production mutation is refused.';
    if (mode === 'build') return 'Private implementation and tests; governed PASS and merge remain unavailable.';
    return 'Governed verification, evidence, verdict, and controlled completion.';
}
