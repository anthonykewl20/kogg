import { postConstruct, inject, injectable } from '@theia/core/shared/inversify';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { MessageService } from '@theia/core';
import { KoggMarketplaceService, type InstalledKoggPackage } from '../common/marketplace-service';
import type { KoggPackageManifest } from '@kogg/contracts';

// diagnostic-coverage: marketplace.registry, marketplace.installed

@injectable()
export class KoggMarketplaceWidget extends BaseWidget {
    static readonly ID = 'kogg-marketplace';
    static readonly LABEL = 'Kogg Marketplace';
    private results: readonly KoggPackageManifest[] = [];
    private installed: readonly InstalledKoggPackage[] = [];
    private query = '';
    private busy = false;

    constructor(
        @inject(KoggMarketplaceService) private readonly marketplace: KoggMarketplaceService,
        @inject(MessageService) private readonly messages: MessageService
    ) { super(); }

    @postConstruct()
    protected init(): void {
        this.id = KoggMarketplaceWidget.ID;
        this.title.label = KoggMarketplaceWidget.LABEL;
        this.title.caption = 'Signed extensions from the Kogg Marketplace';
        this.title.closable = true;
        this.addClass('kogg-marketplace-widget');
        void this.refreshInstalled();
        this.render();
    }

    private render(): void {
        const installed = new Map(this.installed.map(item => [item.id, item.version]));
        this.node.innerHTML = `<div class="kogg-panel">
          <header><h2>Kogg Marketplace</h2><p>Only verified packages signed by Kogg can be installed.</p></header>
          <form data-action="search"><input aria-label="Search Kogg Marketplace" name="query" value="${escapeHtml(this.query)}" placeholder="Search Kogg Marketplace"><button ${this.busy ? 'disabled' : ''}>Search</button></form>
          <button data-action="revocations" ${this.busy ? 'disabled' : ''}>Refresh revocations</button>
          <div class="kogg-package-list">${this.results.length ? this.results.map(item => `<article data-package="${escapeHtml(item.id)}">
            <div><strong>${escapeHtml(item.id)}</strong> <span>${escapeHtml(item.version)}</span><p>${escapeHtml(item.publisher)} · ${escapeHtml(item.license)} · ${item.revoked ? 'Revoked' : 'Signature verified'}</p></div>
            <div class="kogg-package-actions">
              <button data-install="${escapeHtml(item.id)}" data-version="${escapeHtml(item.version)}" ${this.busy || item.revoked ? 'disabled' : ''}>${installed.has(item.id) ? 'Reinstall' : 'Install'}</button>
              ${installed.has(item.id) ? `<button data-update="${escapeHtml(item.id)}" ${this.busy ? 'disabled' : ''}>Update</button><button data-rollback="${escapeHtml(item.id)}" ${this.busy ? 'disabled' : ''}>Rollback</button><button data-remove="${escapeHtml(item.id)}" ${this.busy ? 'disabled' : ''}>Remove</button>` : ''}
            </div>
          </article>`).join('') : '<p class="kogg-empty">Search the signed Kogg catalog to find approved packages.</p>'}</div>
          <section><h3>Installed</h3>${this.installed.length ? `<ul>${this.installed.map(item => `<li>${escapeHtml(item.id)} <span>${escapeHtml(item.version)}</span></li>`).join('')}</ul>` : '<p>None</p>'}</section>
        </div>`;
        this.node.querySelector('form')?.addEventListener('submit', event => {
            event.preventDefault();
            const data = new FormData(event.currentTarget as HTMLFormElement);
            void this.search(String(data.get('query') ?? ''));
        });
        this.node.querySelectorAll<HTMLElement>('[data-install]').forEach(button => button.addEventListener('click', () => void this.install(button.dataset.install!, button.dataset.version)));
        this.node.querySelectorAll<HTMLElement>('[data-update]').forEach(button => button.addEventListener('click', () => void this.updatePackage(button.dataset.update!)));
        this.node.querySelectorAll<HTMLElement>('[data-rollback]').forEach(button => button.addEventListener('click', () => void this.rollback(button.dataset.rollback!)));
        this.node.querySelectorAll<HTMLElement>('[data-remove]').forEach(button => button.addEventListener('click', () => void this.remove(button.dataset.remove!)));
        this.node.querySelector<HTMLElement>('[data-action="revocations"]')?.addEventListener('click', () => void this.refreshRevocations());
    }

    private async search(query: string): Promise<void> {
        this.query = query; this.busy = true; this.render();
        try { this.results = await this.marketplace.search(query); }
        catch (error) {
            console.error('[kogg:marketplace:widget] search.failed', { errorType: errorName(error) });
            void this.messages.error(message(error));
        }
        finally { this.busy = false; this.render(); }
    }

    private async install(id: string, version?: string): Promise<void> {
        this.busy = true; this.render();
        try {
            await this.marketplace.install(id, version);
            await this.refreshInstalled();
            void this.messages.info(`${id} was verified and installed from the Kogg Marketplace.`);
        } catch (error) {
            console.error('[kogg:marketplace:widget] install.failed', { packageId: id, errorType: errorName(error) });
            void this.messages.error(message(error));
        }
        finally { this.busy = false; this.render(); }
    }

    private async updatePackage(id: string): Promise<void> {
        await this.mutate(id, 'updated', () => this.marketplace.update(id));
    }

    private async rollback(id: string): Promise<void> {
        await this.mutate(id, 'rolled back', () => this.marketplace.rollback(id));
    }

    private async remove(id: string): Promise<void> {
        this.busy = true; this.render();
        try { await this.marketplace.remove(id); await this.refreshInstalled(); void this.messages.info(`${id} was removed.`); }
        catch (error) {
            console.error('[kogg:marketplace:widget] remove.failed', { packageId: id, errorType: errorName(error) });
            void this.messages.error(message(error));
        }
        finally { this.busy = false; this.render(); }
    }


    private async mutate(id: string, action: string, operation: () => Promise<void>): Promise<void> {
        this.busy = true; this.render();
        try { await operation(); await this.refreshInstalled(); void this.messages.info(`${id} was ${action}.`); }
        catch (error) {
            console.error('[kogg:marketplace:widget] lifecycle.failed', { packageId: id, action, errorType: errorName(error) });
            void this.messages.error(message(error));
        }
        finally { this.busy = false; this.render(); }
    }

    private async refreshRevocations(): Promise<void> {
        this.busy = true; this.render();
        try { await this.marketplace.refreshRevocations(); void this.messages.info('Kogg Marketplace revocations refreshed.'); }
        catch (error) {
            console.error('[kogg:marketplace:widget] revocations-refresh.failed', { errorType: errorName(error) });
            void this.messages.error(message(error));
        }
        finally { this.busy = false; this.render(); }
    }

    private async refreshInstalled(): Promise<void> { this.installed = await this.marketplace.listInstalled(); this.render(); }
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'Kogg Marketplace operation failed'; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
