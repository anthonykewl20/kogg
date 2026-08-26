import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WorkflowPrototypeService, type PrototypeSnapshot, type WorkflowPrototypeService as Service } from '../common/workflow-prototype-protocol';

// diagnostic-exempt: Disposable visible issue #100 prototype; production widget belongs to #101.
@injectable()
export class WorkflowPrototypeWidget extends BaseWidget {
  static readonly ID = 'kogg-workflow-prototype'; static readonly LABEL = 'Kogg Workflow Probe';
  private snapshot: PrototypeSnapshot | undefined; private status = 'Loading workflow probe…'; private busy = false;
  constructor(@inject(WorkflowPrototypeService) private readonly service: Service) { super(); }
  @postConstruct() protected init(): void { this.id = WorkflowPrototypeWidget.ID; this.title.label = WorkflowPrototypeWidget.LABEL; this.title.closable = true; this.addClass('kogg-workflow-prototype-widget'); this.render(); void this.load(); }
  private async load(): Promise<void> { this.snapshot = await this.service.snapshot(); this.status = 'Immutable workflow prototype ready.'; this.render(); }
  private render(): void {
    const snapshot = this.snapshot;
    const nodes = snapshot?.nodes.map(node => `<li data-node="${html(node.id)}"><strong>${html(node.kind)}</strong> · ${html(node.state)} · attempt ${node.attempt}</li>`).join('') ?? '';
    this.node.innerHTML = `<div class="kogg-panel"><header><h2>Kogg Workflow Probe</h2><p>Experimental real Theia/backend/process boundary for issue #100.</p></header><p role="status" aria-live="polite"><strong>Status:</strong> ${html(this.status)}</p>`
      + (snapshot ? `<p data-run-state>Run ${html(snapshot.state)} · ${html(snapshot.safeCode)} · template ${html(snapshot.templateVersion)} · digest ${html(snapshot.templateDigest)} · immutable ${String(snapshot.immutable)} · events ${snapshot.eventCount} · processes ${snapshot.processCount}</p><ol>${nodes}</ol>` : '')
      + `<div class="kogg-package-actions"><button data-success${this.busy ? ' disabled' : ''}>Run serial + parallel + condition</button><button data-retry${this.busy ? ' disabled' : ''}>Run bounded retry</button><button data-cancel${this.busy ? ' disabled' : ''}>Run cancellation</button><button data-recover${this.busy ? ' disabled' : ''}>Recover</button></div>`
      + `<div class="kogg-package-actions"><button data-cycle${this.busy ? ' disabled' : ''}>Refuse cycle</button><button data-bypass${this.busy ? ' disabled' : ''}>Refuse anchor bypass</button><button data-authority${this.busy ? ' disabled' : ''}>Refuse authority expansion</button></div></div>`;
    this.bindEvents();
  }
  private bindEvents(): void {
    this.node.querySelector<HTMLElement>('[data-success]')?.addEventListener('click', () => void this.run('Running serial/parallel workflow…', () => this.service.runScenario({ requestId: crypto.randomUUID(), scenario: 'success' })));
    this.node.querySelector<HTMLElement>('[data-retry]')?.addEventListener('click', () => void this.run('Running bounded retry…', () => this.service.runScenario({ requestId: crypto.randomUUID(), scenario: 'retry' })));
    this.node.querySelector<HTMLElement>('[data-cancel]')?.addEventListener('click', () => void this.run('Cancelling registered child…', () => this.service.runScenario({ requestId: crypto.randomUUID(), scenario: 'cancel' })));
    this.node.querySelector<HTMLElement>('[data-recover]')?.addEventListener('click', () => void this.run('Reconciling durable run…', () => this.service.recover({ requestId: crypto.randomUUID() })));
    this.node.querySelector<HTMLElement>('[data-cycle]')?.addEventListener('click', () => void this.run('Validating cyclic graph…', () => this.service.refuseGraph({ requestId: crypto.randomUUID(), mutation: 'cycle' })));
    this.node.querySelector<HTMLElement>('[data-bypass]')?.addEventListener('click', () => void this.run('Validating trust anchors…', () => this.service.refuseGraph({ requestId: crypto.randomUUID(), mutation: 'anchor-bypass' })));
    this.node.querySelector<HTMLElement>('[data-authority]')?.addEventListener('click', () => void this.run('Validating authority ceiling…', () => this.service.refuseGraph({ requestId: crypto.randomUUID(), mutation: 'authority-expansion' })));
  }
  private async run(status: string, action: () => Promise<PrototypeSnapshot>): Promise<void> { this.busy = true; this.status = status; this.render(); try { this.snapshot = await action(); this.status = `Workflow probe: ${this.snapshot.safeCode}.`; } catch { this.status = 'Workflow probe failed safely.'; console.error('[kogg:workflow:prototype-widget] operation.failed', { errorType: 'Error', safeCode: 'WORKFLOW_INTERNAL' }); } finally { this.busy = false; this.render(); } }
}
function html(value: string): string { return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!); }
