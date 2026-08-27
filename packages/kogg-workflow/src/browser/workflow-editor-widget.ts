import { MessageService } from '@theia/core';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { KoggProjectsService, type KoggProjectsService as ProjectsService } from '@kogg/projects/lib/common/projects-protocol';
import { EDITABLE_NODE_KINDS, KoggWorkflowService, type EditableNodeKind, type EditableWorkflowGraphV1, type EditableWorkflowNodeV1, type KoggWorkflowService as WorkflowService, type WorkflowAuthorityEffect, type WorkflowTemplateVersionProjection } from '../common/workflow-protocol';
import { buildLinearGraph, moveOutlineNode } from '../common/workflow-outline';

// diagnostic-coverage: workflow.schema, workflow.graph, workflow.authority, workflow.accessibility, workflow.source-maps

const EMPTY_CONFIGURATION_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const GRANTS: Readonly<Record<EditableNodeKind, readonly WorkflowAuthorityEffect[]>> = {
  'research.agent': ['read-repository','invoke-provider'], 'pseudocode.agent': ['read-repository','mutate-private-repository','invoke-provider'],
  'probe.agent': ['read-repository','mutate-private-repository','invoke-provider','run-tool'], 'implementation.agent': ['read-repository','mutate-private-repository','invoke-provider','run-tool'],
  'tool.git': ['read-repository','mutate-private-repository','run-tool'], 'tool.build': ['read-repository','run-tool'],
  'check.deterministic': ['read-repository','run-tool','record-check'], 'approval.specification': ['record-approval'], 'approval.continue': ['record-approval'],
  'control.condition': [], 'control.parallel': [], 'control.join': [], 'control.group': [], 'control.finally': []
};

@injectable()
export class WorkflowEditorWidget extends BaseWidget {
  static readonly ID = 'kogg-workflow-editor'; static readonly LABEL = 'Kogg Workflow Editor';
  private projectId: string | undefined; private templateId: string = crypto.randomUUID();
  private nodes: EditableWorkflowNodeV1[] = [node('research.agent'), node('implementation.agent')]; private edgeIds = [crypto.randomUUID()];
  private versions: readonly WorkflowTemplateVersionProjection[] = []; private status = 'Loading workflow editor…'; private busy = false;

  constructor(@inject(KoggWorkflowService) private readonly service: WorkflowService,
    @inject(KoggProjectsService) private readonly projects: ProjectsService,
    @inject(MessageService) private readonly messages: MessageService) { super(); }

  @postConstruct() protected init(): void {
    this.id = WorkflowEditorWidget.ID; this.title.label = WorkflowEditorWidget.LABEL; this.title.caption = 'Accessible governed workflow outline';
    this.title.closable = true; this.addClass('kogg-workflow-editor-widget'); this.render(); void this.load();
  }

  private async load(): Promise<void> {
    await this.run('editor.load', async () => {
      const projects = await this.projects.snapshot(); this.projectId = projects.activeProjectId;
      if (!this.projectId) { this.status = 'Open an active Kogg project before editing a workflow.'; return; }
      const projectVersions = await this.service.listProjectVersions(this.projectId); this.templateId = projectVersions.at(-1)?.templateId ?? crypto.randomUUID();
      this.versions = projectVersions.filter(version => version.templateId === this.templateId);
      this.status = this.versions.length ? `Workflow version ${this.versions.at(-1)!.versionNumber} is current.` : 'Structured workflow outline ready.';
    }, false);
  }

  private render(): void {
    const options = EDITABLE_NODE_KINDS.map(kind => `<option value="${kind}">${kind}</option>`).join('');
    const rows = this.nodes.map((item, index) => `<li data-workflow-node="${html(item.nodeId)}"><strong>${index + 1}. ${html(item.kind)}</strong><span> · ${item.requestedEffects.length} bounded effects · retry ${item.retry.maxAttempts}</span><div class="kogg-package-actions"><button data-up="${index}" ${this.busy || index === 0 ? 'disabled' : ''} aria-label="Move ${html(item.kind)} up">Up</button><button data-down="${index}" ${this.busy || index === this.nodes.length - 1 ? 'disabled' : ''} aria-label="Move ${html(item.kind)} down">Down</button><button data-remove="${index}" ${this.busy || this.nodes.length === 1 ? 'disabled' : ''} aria-label="Remove ${html(item.kind)}">Remove</button></div></li>`).join('');
    const versions = this.versions.map(version => `<li data-workflow-version="${version.versionNumber}">Version ${version.versionNumber} · ${html(version.versionId.slice(0, 8))} · immutable</li>`).join('');
    this.node.innerHTML = `<div class="kogg-panel"><header><h2>Kogg Workflow Editor</h2><p>Structured outline equivalent for keyboard and assistive technology. Execution remains unavailable until every selected production executor and authority grant is attested.</p></header><p role="status" aria-live="polite"><strong>Status:</strong> ${html(this.status)}</p>${this.projectId ? `<section><h3>Editable node order</h3><ol aria-label="Workflow node outline">${rows}</ol><form data-add class="kogg-form-grid"><label>Node kind<select name="kind">${options}</select></label><button ${this.busy ? 'disabled' : ''}>Add node</button></form><div class="kogg-package-actions"><button data-validate ${this.busy ? 'disabled' : ''}>Validate workflow</button><button data-save ${this.busy ? 'disabled' : ''}>Save immutable version</button><button data-compile ${this.busy || !this.versions.length ? 'disabled' : ''}>Compile current version</button></div><section><h3>Saved versions</h3><ol aria-label="Immutable workflow versions">${versions || '<li>None</li>'}</ol></section></section>` : '<p class="kogg-blocked">No active project.</p>'}</div>`;
    this.bindEvents();
  }

  private bindEvents(): void {
    this.node.querySelector<HTMLFormElement>('[data-add]')?.addEventListener('submit', event => { event.preventDefault(); const kind = new FormData(event.currentTarget as HTMLFormElement).get('kind') as EditableNodeKind; this.nodes.push(node(kind)); this.resetEdges(); this.status = `${kind} added.`; this.render(); });
    this.node.querySelectorAll<HTMLElement>('[data-up]').forEach(button => button.addEventListener('click', () => this.move(Number(button.dataset.up), -1)));
    this.node.querySelectorAll<HTMLElement>('[data-down]').forEach(button => button.addEventListener('click', () => this.move(Number(button.dataset.down), 1)));
    this.node.querySelectorAll<HTMLElement>('[data-remove]').forEach(button => button.addEventListener('click', () => { this.nodes.splice(Number(button.dataset.remove), 1); this.resetEdges(); this.status = 'Node removed.'; this.render(); }));
    this.node.querySelector<HTMLElement>('[data-validate]')?.addEventListener('click', () => void this.validate());
    this.node.querySelector<HTMLElement>('[data-save]')?.addEventListener('click', () => void this.save());
    this.node.querySelector<HTMLElement>('[data-compile]')?.addEventListener('click', () => void this.compile());
  }

  private move(index: number, offset: -1 | 1): void { this.nodes = [...moveOutlineNode(this.nodes, index, offset)]; this.resetEdges(); this.status = 'Node order changed.'; this.render(); }
  private resetEdges(): void { this.edgeIds = this.nodes.slice(1).map(() => crypto.randomUUID()); }
  private graph(): EditableWorkflowGraphV1 { return buildLinearGraph(this.projectId!, this.nodes, this.edgeIds); }
  private async validate(): Promise<void> { await this.run('draft.validate', async () => { const result = await this.service.validate(this.graph()); this.status = result.valid ? `Workflow valid: ${result.nodeCount} nodes and ${result.edgeCount} edges.` : `Workflow refused: ${result.code}.`; if (!result.valid) throw new UiResult(result.code); }); }
  private async save(): Promise<void> { await this.run('version.save', async () => { const result = await this.service.saveVersion({ requestId: crypto.randomUUID(), templateId: this.templateId, expectedVersionNumber: this.versions.at(-1)?.versionNumber ?? 0, graph: this.graph() }); if (result.kind !== 'completed') throw new UiResult(result.code); this.versions = (await this.service.listProjectVersions(this.projectId!)).filter(version => version.templateId === this.templateId); this.status = `Workflow version ${result.version!.versionNumber} saved immutably.`; }); }
  private async compile(): Promise<void> { const current = this.versions.at(-1); if (!current) return; await this.run('compile', async () => { const result = await this.service.compile({ requestId: crypto.randomUUID(), versionId: current.versionId }); if (result.kind !== 'completed') throw new UiResult(result.code); this.status = `Compiled plan ${result.plan!.planId.slice(0, 8)} with ${result.plan!.injectedAnchorCount} mandatory anchors.`; }); }
  private async run(operation: string, action: () => Promise<void>, notify = true): Promise<void> { this.busy = true; this.render(); console.info('[kogg:workflow:editor] ui.operation.started', { operation, templateId: this.templateId, projectId: this.projectId ?? 'unavailable' }); try { await action(); console.info('[kogg:workflow:editor] ui.operation.completed', { operation, templateId: this.templateId, projectId: this.projectId ?? 'unavailable' }); } catch (error) { const safeCode = error instanceof UiResult ? error.code : 'WORKFLOW_INTERNAL'; console.error('[kogg:workflow:editor] ui.operation.failed', { operation, templateId: this.templateId, projectId: this.projectId ?? 'unavailable', safeCode, errorType: error instanceof Error ? error.name : 'UnknownError' }); this.status = `Workflow operation failed safely: ${safeCode}.`; if (notify) void this.messages.error(this.status); } finally { this.busy = false; this.render(); } }
}

class UiResult extends Error { constructor(readonly code: string) { super(code); } }
function node(kind: EditableNodeKind): EditableWorkflowNodeV1 { return { nodeId: crypto.randomUUID(), kind, kindVersion: '1', configurationDigest: EMPTY_CONFIGURATION_DIGEST, requestedEffects: GRANTS[kind], retry: { maxAttempts: 1, backoffMs: 0, sideEffectPolicy: 'none' } }; }
function html(value: string): string { return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!); }
