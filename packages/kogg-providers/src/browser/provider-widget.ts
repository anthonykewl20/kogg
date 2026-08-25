import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { MessageService } from '@theia/core';
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
    private busy = false;

    constructor(
        @inject(KoggProviderService) private readonly service: KoggProviderService,
        @inject(MessageService) private readonly messages: MessageService
    ) { super(); }

    @postConstruct()
    protected init(): void {
        this.id = KoggProviderWidget.ID;
        this.title.label = KoggProviderWidget.LABEL;
        this.title.caption = 'Kogg provider configuration and advisory chat';
        this.title.closable = true;
        this.addClass('kogg-provider-widget');
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
        this.node.innerHTML = `<div class="kogg-panel">
          <header><h2>Kogg AI</h2><p>Configure an advisory provider. Governed mutation remains blocked until Ranex qualifies the selected path.</p></header>
          <div class="kogg-form-grid">
            <label>Provider<select data-field="provider">${this.providers.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === this.provider ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
            <label>Account<input data-field="account" value="${escapeHtml(this.account)}"></label>
            <label>Endpoint (optional)<input data-field="endpoint" value="${escapeHtml(this.endpoint)}" placeholder="Use provider default"></label>
            ${descriptor?.configuration === 'local' ? '' : '<label>Credential<input data-field="secret" type="password" autocomplete="new-password" placeholder="Stored securely; never read back"></label>'}
          </div>
          <div class="kogg-actions">
            ${descriptor?.configuration === 'local' ? '' : `<button data-action="save" ${this.busy ? 'disabled' : ''}>Save credential</button>`}
            <button data-action="test" ${this.busy ? 'disabled' : ''}>Test connection</button>
            <button data-action="models" ${this.busy ? 'disabled' : ''}>Discover models</button>
          </div>
          <p role="status"><strong>Status:</strong> ${escapeHtml(this.status)}</p>
          <section><h3>Stored credentials</h3>${this.credentials.length ? `<ul>${this.credentials.map(item => `<li>${escapeHtml(item.provider)} / ${escapeHtml(item.account)} <span>updated ${escapeHtml(item.updatedAt)}</span> <button data-delete-provider="${escapeHtml(item.provider)}" data-delete-account="${escapeHtml(item.account)}" ${this.busy ? 'disabled' : ''}>Delete</button></li>`).join('')}</ul>` : '<p>None. Secret values are never displayed.</p>'}</section>
          <p><strong>Ranex qualification:</strong> <span class="kogg-blocked">${descriptor?.governedQualification === 'qualified' ? 'Qualified' : 'Advisory only — governed mutation blocked'}</span></p>
          <label>Model<select data-field="model"><option value="">Select a discovered model</option>${this.models.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === this.selectedModel ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
          <label>Advisory prompt<textarea data-field="prompt" rows="6" placeholder="Ask Kogg for analysis or guidance"></textarea></label>
          <button data-action="chat" ${this.busy || !this.selectedModel ? 'disabled' : ''}>Send advisory request</button>
          ${this.reply ? `<section class="kogg-advisory-reply"><h3>Advisory response</h3><pre>${escapeHtml(this.reply)}</pre></section>` : ''}
        </div>`;
        this.node.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach(field => field.addEventListener('change', () => this.capture()));
        this.node.querySelector<HTMLElement>('[data-action="save"]')?.addEventListener('click', () => void this.saveCredential());
        this.node.querySelector<HTMLElement>('[data-action="test"]')?.addEventListener('click', () => void this.testConnection());
        this.node.querySelector<HTMLElement>('[data-action="models"]')?.addEventListener('click', () => void this.discoverModels());
        this.node.querySelector<HTMLElement>('[data-action="chat"]')?.addEventListener('click', () => void this.chat());
        this.node.querySelectorAll<HTMLElement>('[data-delete-provider]').forEach(button => button.addEventListener('click', () => {
            void this.deleteCredential(button.dataset.deleteProvider!, button.dataset.deleteAccount!);
        }));
    }

    private capture(): void {
        const read = (name: string) => (this.node.querySelector(`[data-field="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
        const changedProvider = read('provider') !== this.provider;
        this.provider = read('provider'); this.account = read('account'); this.endpoint = read('endpoint'); this.selectedModel = read('model');
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
        const prompt = (this.node.querySelector('[data-field="prompt"]') as HTMLTextAreaElement | null)?.value.trim() ?? '';
        if (!prompt || !this.selectedModel) { await this.messages.warn('Select a model and enter an advisory prompt.'); return; }
        await this.run(async () => {
            this.reply = await this.service.advisoryChat({ provider: this.provider, account: this.account, endpoint: this.endpoint || undefined, model: this.selectedModel, prompt });
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
