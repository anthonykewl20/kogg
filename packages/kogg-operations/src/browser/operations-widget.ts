import { CommandService, MessageService } from '@theia/core';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { KoggOperationsClientToken, KoggOperationsService, type OperationsSnapshot } from '../common/operations-protocol';
import { OperationsClient } from './operations-client';

// diagnostic-coverage: operations.processes, operations.cleanup, operations.admission

@injectable()
export class OperationsWidget extends BaseWidget {
  static readonly ID = 'kogg-operations';
  static readonly LABEL = 'Kogg Operations';
  private snapshotValue: OperationsSnapshot = { schemaVersion: 1, revision: 1, admission: 'recovering', active: [], recent: [] };
  private cancellingOperation: string | undefined;
  constructor(
    @inject(KoggOperationsService) private readonly service: KoggOperationsService,
    @inject(KoggOperationsClientToken) client: OperationsClient,
    @inject(MessageService) private readonly messages: MessageService,
    @inject(CommandService) private readonly commands: CommandService
  ) { super(); client.listen(snapshot => this.applySnapshot(snapshot)); }
  @postConstruct() protected init(): void {
    this.id = OperationsWidget.ID; this.title.label = OperationsWidget.LABEL;
    this.title.caption = 'Kogg operation lifecycle and process cleanup'; this.title.closable = true;
    this.addClass('kogg-operations-widget'); this.render(); void this.refresh();
  }
  applySnapshot(snapshot: OperationsSnapshot): void { this.snapshotValue = snapshot; this.render(); }
  private async refresh(): Promise<void> {
    // Prototype #65 branch-only debugger marker; this change is never merged.
    debugger;
    try { this.snapshotValue = await this.service.snapshot(); }
    catch (error) { console.error('[kogg:operations:widget] snapshot.failed', { errorType: errorName(error) }); void this.messages.error('Kogg operations could not be loaded.'); }
    finally { this.render(); }
  }
  private render(): void {
    const item = (operation: OperationsSnapshot['active'][number], active: boolean): string => {
      const correlations = Object.entries(operation.correlations).map(([key, value]) => `${key}: ${value}`).join(' · ');
      const warning = operation.blocksAdmission || operation.state === 'stalled' || operation.cleanup === 'failed';
      return `<article data-operation-row="${operation.id}" class="${warning ? 'kogg-operation-warning' : ''}">
      <div><strong>${escapeHtml(operation.kind)}</strong><p>${escapeHtml(operation.state)} · ${escapeHtml(operation.id.slice(0, 8))} · ${operation.processCount} process${operation.processCount === 1 ? '' : 'es'} · ${operation.activityCount} activities</p>${correlations ? `<p>${escapeHtml(correlations)}</p>` : ''}${operation.safeCode ? `<p>${escapeHtml(operation.safeCode)}</p>` : ''}</div>
      ${active && operation.canCancel ? `<button data-cancel="${operation.id}" ${this.cancellingOperation ? 'disabled' : ''}>${this.cancellingOperation === operation.id ? 'Cancelling…' : 'Cancel'}</button>` : ''}</article>`;
    };
    const needsDiagnostics = this.snapshotValue.admission !== 'enabled' || [...this.snapshotValue.active, ...this.snapshotValue.recent].some(operation => operation.blocksAdmission || operation.state === 'stalled' || operation.cleanup === 'failed');
    this.node.innerHTML = `<div class="kogg-panel"><header><h2>Kogg Operations</h2><p>Safe lifecycle, recovery, and cleanup status for Kogg-owned work.</p></header>
      <p role="status"><strong>Admission:</strong> ${escapeHtml(this.snapshotValue.admission)}</p>
      <button data-refresh ${this.cancellingOperation ? 'disabled' : ''}>Refresh</button>${needsDiagnostics ? '<button data-diagnostics>Run Diagnostics</button>' : ''}
      <section><h3>Active</h3><div class="kogg-package-list">${this.snapshotValue.active.length ? this.snapshotValue.active.map(operation => item(operation, true)).join('') : '<p>No active operations.</p>'}</div></section>
      <section><h3>Recent</h3><div class="kogg-package-list">${this.snapshotValue.recent.length ? this.snapshotValue.recent.map(operation => item(operation, false)).join('') : '<p>No recent operations.</p>'}</div></section></div>`;
    this.node.querySelector<HTMLElement>('[data-refresh]')?.addEventListener('click', () => void this.refresh());
    this.node.querySelector<HTMLElement>('[data-diagnostics]')?.addEventListener('click', () => void this.commands.executeCommand('kogg.diagnostics.run'));
    this.node.querySelectorAll<HTMLElement>('[data-cancel]').forEach(button => button.addEventListener('click', () => void this.cancel(button.dataset.cancel!)));
  }
  private async cancel(operationId: string): Promise<void> {
    const choice = await this.messages.warn('Cancel this Kogg operation and clean up its owned resources?', 'Cancel operation', 'Keep running');
    if (choice !== 'Cancel operation') return;
    this.cancellingOperation = operationId; this.render();
    try { this.snapshotValue = await this.service.cancel({ requestId: crypto.randomUUID(), operationId }); }
    catch (error) { console.error('[kogg:operations:widget] operation.cancel.failed', { operationId, errorType: errorName(error) }); void this.messages.error('The operation could not be cancelled.'); }
    finally { this.cancellingOperation = undefined; this.render(); }
  }
}
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!); }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
