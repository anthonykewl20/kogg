import { CommandService, MessageService } from '@theia/core';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { KoggOperationsClientToken, KoggOperationsService, type OperationsSnapshot } from '../common/operations-protocol';
import { OperationsClient } from './operations-client';
import { KoggOperationsReadModelService, type KoggOperationsReadModelService as OperationsReadModelService, type OperationsProjectionSnapshotV1, type OperationsTimelineEntryV1 } from '../common/operations-read-model-protocol';
import { entriesForRunDetail, RUN_DETAIL_TABS, runOutcomeSummary, type RunDetailTab } from '../common/operations-presentation';

// diagnostic-coverage: operations.projection, operations.owners, operations.timeline, operations.processes, operations.cleanup, operations.admission, operations.stream, operations.support, operations.actions

@injectable()
export class OperationsWidget extends BaseWidget {
  static readonly ID = 'kogg-operations';
  static readonly LABEL = 'Kogg Operations';
  private snapshotValue: OperationsSnapshot = { schemaVersion: 1, revision: 1, admission: 'recovering', active: [], recent: [] };
  private projection: OperationsProjectionSnapshotV1 | undefined;
  private timeline: readonly OperationsTimelineEntryV1[] = [];
  private selectedRunId: string | undefined;
  private selectedDetail: RunDetailTab = 'timeline';
  private cancellingOperation: string | undefined;
  private diagnosingRun = false;
  private streamCursor = restoreStreamCursor();
  private streamState: 'connecting' | 'current' | 'resync-required' = 'connecting';
  private streamSync: Promise<void> = Promise.resolve();
  constructor(
    @inject(KoggOperationsService) private readonly service: KoggOperationsService,
    @inject(KoggOperationsReadModelService) private readonly readModel: OperationsReadModelService,
    @inject(KoggOperationsClientToken) client: OperationsClient,
    @inject(MessageService) private readonly messages: MessageService,
    @inject(CommandService) private readonly commands: CommandService
  ) { super(); client.listen(snapshot => this.applySnapshot(snapshot)); client.listenProjection(() => void this.scheduleProjectionSync()); }
  @postConstruct() protected init(): void {
    this.id = OperationsWidget.ID; this.title.label = OperationsWidget.LABEL;
    this.title.caption = 'Kogg operation lifecycle and process cleanup'; this.title.closable = true;
    this.addClass('kogg-operations-widget'); this.render(); void this.refresh();
  }
  applySnapshot(snapshot: OperationsSnapshot): void { this.snapshotValue = snapshot; this.render(); }
  private async refresh(): Promise<void> {
    try { [this.snapshotValue] = await Promise.all([this.service.snapshot(), this.scheduleProjectionSync()]); }
    catch (error) { console.error('[kogg:operations:widget] snapshot.failed', { errorType: errorName(error) }); void this.messages.error('Kogg operations could not be loaded.'); }
    finally { this.render(); }
  }
  private scheduleProjectionSync(): Promise<void> {
    const scheduled = this.streamSync.then(() => this.synchronizeProjection());
    this.streamSync = scheduled.catch(() => undefined);
    return scheduled;
  }
  private async synchronizeProjection(): Promise<void> {
    try {
      const subscription = await this.readModel.subscribe(this.streamCursor);
      this.streamState = subscription.state;
      if (subscription.state === 'resync-required') console.warn('[kogg:operations:stream] resync-required', { safeCode: 'STREAM_CURSOR_REJECTED' });
      this.projection = await this.readModel.projectionSnapshot();
      if (this.selectedRunId) this.timeline = (await this.readModel.timelinePage(this.selectedRunId, undefined, 200)).items;
      this.streamCursor = subscription.cursor; persistStreamCursor(subscription.cursor);
      this.streamState = 'current';
    }
    catch (error) { console.error('[kogg:operations:widget] projection.refresh.failed', { errorType: errorName(error) }); }
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
    const projectedRuns = this.projection?.runs ?? [];
    const projectionRows = projectedRuns.map(run => `<tr data-projected-run="${escapeHtml(run.runId)}"><td><button data-select-run="${escapeHtml(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</button></td><td>${escapeHtml(run.lifecycle)}</td><td>${run.attemptCount}</td><td>${run.retryCount}</td><td>${run.liveProcessCount}</td><td>${run.abnormalProcessCount}</td><td>${escapeHtml(runOutcomeSummary(run))}</td></tr>`).join('');
    const detailEntries = entriesForRunDetail(this.timeline, this.selectedDetail);
    const timelineRows = detailEntries.map(entry => `<tr><td>${escapeHtml(entry.displayTime)}</td><td>${escapeHtml(entry.ownerKind)}</td><td>${escapeHtml(entry.eventKind)}</td><td>${escapeHtml(entry.safeCode ?? 'none')}</td></tr>`).join('');
    const detailTabs = RUN_DETAIL_TABS.map(tab => `<button role="tab" aria-selected="${tab === this.selectedDetail}" data-detail-tab="${tab}">${escapeHtml(detailLabel(tab))}</button>`).join('');
    this.node.innerHTML = `<div class="kogg-panel"><header><h2>Kogg Operations</h2><p>Safe lifecycle, recovery, and cleanup status for Kogg-owned work.</p></header>
      <p role="status"><strong>Admission:</strong> ${escapeHtml(this.snapshotValue.admission)}</p>
      <p role="status"><strong>Projection:</strong> ${escapeHtml(this.projection?.lifecycle ?? 'loading')} · ${this.projection?.faultCount ?? 0} faults</p>
      <p role="status"><strong>Stream:</strong> ${escapeHtml(this.streamState)} · sequence ${escapeHtml(this.projection?.changeSequence ?? 'loading')}</p>
      <button data-refresh ${this.cancellingOperation ? 'disabled' : ''}>Refresh</button><button data-support>Export safe support bundle</button>${needsDiagnostics ? '<button data-diagnostics>Run Diagnostics</button>' : ''}
      <section><h3>Governed runs</h3>${projectedRuns.length ? `<div tabindex="0" role="region" aria-label="Governed run projection"><table><thead><tr><th>Run</th><th>Lifecycle</th><th>Attempts</th><th>Retries</th><th>Live</th><th>Abnormal</th><th>Checks / evidence / verdict / merge</th></tr></thead><tbody>${projectionRows}</tbody></table></div>` : `<p>${this.projection?.lifecycle === 'degraded' ? 'Run projection is degraded.' : 'No governed runs match the current projection.'}</p>`}</section>
      ${this.selectedRunId ? `<section><h3>Details for run ${escapeHtml(this.selectedRunId.slice(0, 8))}</h3><button data-diagnose-run ${this.diagnosingRun || this.projection?.lifecycle !== 'current' ? 'disabled' : ''}>${this.diagnosingRun ? 'Diagnosing…' : 'Diagnose selected run'}</button><div role="tablist" aria-label="Governed run details">${detailTabs}</div><div tabindex="0" role="tabpanel" aria-label="${escapeHtml(detailLabel(this.selectedDetail))} details"><table><thead><tr><th>Observed</th><th>Owner</th><th>Event</th><th>Safe code</th></tr></thead><tbody>${timelineRows || '<tr><td colspan="4">No matching safe timeline entries.</td></tr>'}</tbody></table></div></section>` : ''}
      <section><h3>Active</h3><div class="kogg-package-list">${this.snapshotValue.active.length ? this.snapshotValue.active.map(operation => item(operation, true)).join('') : '<p>No active operations.</p>'}</div></section>
      <section><h3>Recent</h3><div class="kogg-package-list">${this.snapshotValue.recent.length ? this.snapshotValue.recent.map(operation => item(operation, false)).join('') : '<p>No recent operations.</p>'}</div></section></div>`;
    this.node.querySelector<HTMLElement>('[data-refresh]')?.addEventListener('click', () => void this.refresh());
    this.node.querySelector<HTMLElement>('[data-diagnostics]')?.addEventListener('click', () => void this.commands.executeCommand('kogg.diagnostics.run'));
    this.node.querySelector<HTMLElement>('[data-support]')?.addEventListener('click', () => void this.exportSupport());
    this.node.querySelectorAll<HTMLElement>('[data-select-run]').forEach(button => button.addEventListener('click', () => void this.selectRun(button.dataset.selectRun!)));
    this.node.querySelector<HTMLElement>('[data-diagnose-run]')?.addEventListener('click', () => void this.diagnoseSelectedRun());
    this.node.querySelectorAll<HTMLElement>('[data-detail-tab]').forEach(button => button.addEventListener('click', () => { this.selectedDetail = button.dataset.detailTab as RunDetailTab; this.render(); }));
    this.node.querySelectorAll<HTMLElement>('[data-cancel]').forEach(button => button.addEventListener('click', () => void this.cancel(button.dataset.cancel!)));
  }
  private async selectRun(runId: string): Promise<void> {
    this.selectedRunId = runId; this.selectedDetail = 'timeline'; this.timeline = []; this.render();
    try { this.timeline = (await this.readModel.timelinePage(runId, undefined, 200)).items; }
    catch (error) { console.error('[kogg:operations:widget] timeline.failed', { runId, errorType: errorName(error) }); void this.messages.error('The safe operations timeline could not be loaded.'); }
    finally { this.render(); }
  }
  private async diagnoseSelectedRun(): Promise<void> {
    const runId = this.selectedRunId; const expectedProjectionSequence = this.projection?.changeSequence;
    if (!runId || !expectedProjectionSequence || this.projection?.lifecycle !== 'current') return;
    this.diagnosingRun = true; this.render();
    try {
      const receipt = await this.readModel.requestAction({ requestId: crypto.randomUUID(), action: 'diagnose', runId, expectedProjectionSequence });
      if (receipt.status === 'forwarded') void this.messages.info('Diagnostics completed for the selected run.');
      else void this.messages.warn(`Diagnostics were not started (${receipt.safeCode}).`);
    } catch (error) { console.error('[kogg:operations:widget] run.diagnose.failed', { runId, errorType: errorName(error) }); void this.messages.error('Diagnostics could not be completed for the selected run.'); }
    finally { this.diagnosingRun = false; await this.scheduleProjectionSync(); this.render(); }
  }
  private async exportSupport(): Promise<void> {
    const choice = await this.messages.warn(`Export a private, redacted support bundle${this.selectedRunId ? ' for the selected run' : ''}? It expires after 24 hours.`, 'Export bundle', 'Cancel');
    if (choice !== 'Export bundle') return;
    try {
      const receipt = await this.readModel.exportSupport({ requestId: crypto.randomUUID(), ...(this.selectedRunId ? { runId: this.selectedRunId } : {}) });
      const exported = await this.readModel.readSupportExport(receipt.exportId); const blob = new Blob([exported.content], { type: 'application/json' }); const url = URL.createObjectURL(blob);
      try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = `kogg-operations-support-${receipt.exportId}.json`; anchor.click(); }
      finally { URL.revokeObjectURL(url); }
      void this.messages.info(`Private support bundle exported (${receipt.byteLength} bytes).`);
    } catch (error) { console.error('[kogg:operations:widget] support.export.failed', { errorType: errorName(error) }); void this.messages.error('The private support bundle could not be exported.'); }
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
function detailLabel(tab: RunDetailTab): string { return ({ timeline: 'Timeline', files: 'Files / execution', checks: 'Checks', 'evidence-verdict': 'Evidence / verdict', merge: 'Merge', usage: 'Usage', processes: 'Processes' })[tab]; }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!); }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
const STREAM_CURSOR_KEY = 'kogg.operations.stream.cursor.v1';
function restoreStreamCursor(): string | undefined {
  try { return sessionStorage.getItem(STREAM_CURSOR_KEY) ?? undefined; }
  catch (error) { console.warn('[kogg:operations:stream] cursor.restore.failed', { safeCode: 'STREAM_CURSOR_STORAGE_UNAVAILABLE', errorType: errorName(error) }); return undefined; }
}
function persistStreamCursor(cursor: string): void {
  try { sessionStorage.setItem(STREAM_CURSOR_KEY, cursor); }
  catch (error) { console.warn('[kogg:operations:stream] cursor.persist.failed', { safeCode: 'STREAM_CURSOR_STORAGE_UNAVAILABLE', errorType: errorName(error) }); }
}
