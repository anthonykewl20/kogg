import { MessageService } from '@theia/core';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { KoggProjectsService, type KoggProjectsService as ProjectsService } from '@kogg/projects/lib/common/projects-protocol';
import type { ProjectRegistrySnapshot } from '@kogg/contracts';
import { KoggTasksService, type ReviewProjection, type TaskMutationResult, type TaskProjection, type TaskSummary, type MutationPrecondition } from '../common/tasks-protocol';
import { KOGG_TASKS_CHANGED_EVENT } from './tasks-events';

// diagnostic-coverage: tasks.registry, tasks.revisions, tasks.bindings, tasks.approvals

@injectable()
export class TasksWidget extends BaseWidget {
  static readonly ID = 'kogg-tasks';
  static readonly LABEL = 'Kogg Tasks';
  private projects: ProjectRegistrySnapshot = { schemaVersion: 1, revision: 1, projects: [] };
  private tasks: readonly TaskSummary[] = [];
  private selected: TaskProjection | undefined;
  private review: ReviewProjection | undefined;
  private conflictBuffer: string | undefined;
  private readonly sessionId = crypto.randomUUID();
  private status = 'Loading tasks…';
  private busy = false;

  constructor(@inject(KoggTasksService) private readonly service: KoggTasksService,
    @inject(KoggProjectsService) private readonly projectService: ProjectsService,
    @inject(MessageService) private readonly messages: MessageService) { super(); }

  @postConstruct()
  protected init(): void {
    this.id = TasksWidget.ID; this.title.label = TasksWidget.LABEL; this.title.caption = 'Governed task specifications and approvals';
    this.title.closable = true; this.addClass('kogg-tasks-widget'); this.render(); void this.load();
  }

  private async load(taskId?: string): Promise<void> {
    await this.run(async () => {
      this.projects = await this.projectService.snapshot();
      const active = this.projects.projects.find(project => project.id === this.projects.activeProjectId);
      this.tasks = await this.service.list(active?.id);
      const target = taskId ?? this.selected?.taskId ?? this.tasks[0]?.taskId;
      this.selected = target ? await this.service.get(target).catch(() => undefined) : undefined;
      this.review = undefined;
      this.status = active ? (this.tasks.length ? 'Task registry ready.' : 'Create the first governed task.') : 'Open an active Kogg project before creating tasks.';
    }, false);
  }

  private render(): void {
    const active = this.projects.projects.find(project => project.id === this.projects.activeProjectId);
    const repositories = active?.repositories.filter(repository => repository.availability === 'available') ?? [];
    const repositoryOptions = repositories.map(item => '<option value="' + html(item.id) + '">' + html(item.displayName) + '</option>').join('');
    const taskItems = this.tasks.map(task => '<li><button data-task="' + html(task.taskId) + '"' + (this.busy ? ' disabled' : '') + '>Task ' + html(short(task.taskId)) + ' · r' + html(task.taskRevision) + ' · ' + html(task.specificationLifecycle) + (task.approvalLifecycle ? ' · approved' : '') + '</button></li>').join('');
    let output = '<div class="kogg-panel"><header><h2>Kogg Tasks</h2><p>Draft, freeze, review, approve, revoke, and retain exact task specifications.</p></header>';
    output += '<p role="status" aria-live="polite"><strong>Status:</strong> ' + html(this.status) + '</p>';
    if (active) output += '<form data-action="create" class="kogg-form-grid"><label>Repository<select name="repositoryId">' + repositoryOptions + '</select></label>'
      + '<label>Line endings<select name="lineEnding"><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>'
      + '<label>Initial specification<textarea name="content" rows="8" maxlength="1048576" required></textarea></label><button' + (this.busy || !repositories.length ? ' disabled' : '') + '>Create task</button></form>';
    else output += '<p class="kogg-blocked">No active project.</p>';
    output += '<section><h3>Tasks</h3>' + (taskItems ? '<ul>' + taskItems + '</ul>' : '<p>None</p>') + '</section>';
    if (this.selected) output += this.renderTask(this.selected);
    this.node.innerHTML = output + '</div>'; this.bindEvents();
  }

  private renderTask(task: TaskProjection): string {
    const spec = task.currentSpecification; const editable = task.lifecycle === 'active' && spec.lifecycle === 'draft';
    let output = '<section data-task-detail="' + html(task.taskId) + '"><h3>Task ' + html(short(task.taskId)) + '</h3><p>Revision ' + html(task.taskRevision)
      + ' · ' + html(task.lifecycle) + ' · ' + html(spec.lifecycle) + ' · ' + String(spec.byteLength) + ' bytes · ' + html(spec.lineEnding.toUpperCase()) + '</p>';
    output += '<label>Specification<textarea data-specification rows="16"' + (editable && !this.busy ? '' : ' readonly') + '>' + html(this.conflictBuffer ?? spec.content) + '</textarea></label>';
    if (editable) output += '<label>Save line endings<select data-save-eol><option value="lf"' + (spec.lineEnding !== 'crlf' ? ' selected' : '') + '>LF</option><option value="crlf"' + (spec.lineEnding === 'crlf' ? ' selected' : '') + '>CRLF</option></select></label>'
      + '<div class="kogg-package-actions"><button data-save>Save draft</button><button data-freeze>Freeze exact revision</button></div>';
    if (spec.lifecycle === 'frozen' && task.lifecycle === 'active') output += '<div class="kogg-package-actions"><button data-successor>Create successor draft</button>'
      + (task.currentApproval ? '<button data-revoke>Revoke approval ' + html(short(task.currentApproval.approvalId)) + '</button>' : '<button data-review>Review for approval</button>') + '</div>';
    if (this.review?.projection?.taskId === task.taskId) output += '<article class="kogg-review"><h4>Review complete frozen revision</h4><p>Task ' + html(short(task.taskId)) + ', revision ' + html(task.taskRevision)
      + ', ' + String(spec.byteLength) + ' bytes, ' + html(spec.lineEnding.toUpperCase()) + '.</p><pre tabindex="0">' + html(spec.content) + '</pre><button data-approve>Approve this exact revision</button></article>';
    if (task.lifecycle === 'active') output += '<button data-archive>Archive task</button>';
    return output + '</section>';
  }

  private bindEvents(): void {
    this.node.querySelector<HTMLFormElement>('form[data-action="create"]')?.addEventListener('submit', event => {
      event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
      void this.create(String(data.get('repositoryId')), String(data.get('content')), String(data.get('lineEnding')));
    });
    this.node.querySelectorAll<HTMLElement>('[data-task]').forEach(button => button.addEventListener('click', () => void this.load(button.dataset.task)));
    this.node.querySelector<HTMLElement>('[data-save]')?.addEventListener('click', () => void this.save());
    this.node.querySelector<HTMLElement>('[data-freeze]')?.addEventListener('click', () => void this.mutate('Freezing exact revision…', request => this.service.freeze({ ...request, taskId: this.selected!.taskId })));
    this.node.querySelector<HTMLElement>('[data-successor]')?.addEventListener('click', () => void this.mutate('Creating successor draft…', request => this.service.createSuccessorDraft({ ...request, taskId: this.selected!.taskId })));
    this.node.querySelector<HTMLElement>('[data-review]')?.addEventListener('click', () => void this.beginReview());
    this.node.querySelector<HTMLElement>('[data-approve]')?.addEventListener('click', () => void this.approve());
    this.node.querySelector<HTMLElement>('[data-revoke]')?.addEventListener('click', () => void this.mutate('Revoking approval…', request => this.service.revoke({ ...request, taskId: this.selected!.taskId })));
    this.node.querySelector<HTMLElement>('[data-archive]')?.addEventListener('click', () => void this.mutate('Archiving task…', request => this.service.archive({ ...request, taskId: this.selected!.taskId })));
  }

  private async create(repositoryId: string, content: string, lineEnding: string): Promise<void> {
    const active = this.projects.activeProjectId; if (!active) return;
    await this.run(async () => {
      const result = await this.service.create({ requestId: crypto.randomUUID(), projectId: active, repositoryId, content: withEol(content, lineEnding) });
      await this.accept(result, 'Task created.'); if (result.projection) await this.load(result.projection.taskId);
    });
  }
  private async save(): Promise<void> {
    const textarea = this.node.querySelector<HTMLTextAreaElement>('[data-specification]');
    const mode = this.node.querySelector<HTMLSelectElement>('[data-save-eol]')?.value ?? 'lf'; if (!textarea) return;
    this.conflictBuffer = withEol(textarea.value, mode);
    await this.mutate('Saving task draft…', request => this.service.edit({ ...request, taskId: this.selected!.taskId, content: this.conflictBuffer! }));
  }
  private async beginReview(): Promise<void> {
    if (!this.selected) return;
    await this.run(async () => {
      this.status = 'Loading exact frozen revision for review…'; this.render();
      this.review = await this.service.beginApprovalReview({ requestId: crypto.randomUUID(), taskId: this.selected!.taskId, sessionId: this.sessionId });
      if (this.review.kind !== 'completed') throw new UiResult(this.review.code);
      this.selected = this.review.projection; this.status = 'Review the entire frozen revision before approval.';
    });
  }
  private async approve(): Promise<void> {
    if (!this.review?.challenge || !this.selected) return;
    await this.mutate('Approving exact frozen revision…', request => this.service.approve({ ...request, taskId: this.selected!.taskId, sessionId: this.sessionId, challenge: this.review!.challenge! }));
  }
  private expectation(): MutationPrecondition { return { requestId: crypto.randomUUID(), expectedRegistryRevision: this.selected!.registryRevision, expectedTaskRevision: this.selected!.taskRevision }; }
  private async mutate(status: string, action: (request: MutationPrecondition) => Promise<TaskMutationResult>): Promise<void> {
    if (!this.selected) return;
    await this.run(async () => { this.status = status; this.render(); const result = await action(this.expectation()); await this.accept(result, 'Task registry updated.'); if (result.projection) this.selected = result.projection; this.conflictBuffer = undefined; this.review = undefined; this.tasks = await this.service.list(this.projects.activeProjectId); });
  }
  private async accept(result: TaskMutationResult, success: string): Promise<void> { if (result.kind !== 'completed') throw new UiResult(result.code); this.status = success; }
  private async run(action: () => Promise<void>, notify = true): Promise<void> {
    this.busy = true; this.render();
    try { await action(); }
    catch (error) { const code = error instanceof UiResult ? error.code : 'INTERNAL_FAILURE'; console.error('[kogg:tasks:widget] operation.failed', { errorType: error instanceof Error ? error.name : 'UnknownError', safeCode: code }); this.status = textFor(code); if (notify) void this.messages.error(this.status); }
    finally { this.busy = false; this.render(); window.dispatchEvent(new Event(KOGG_TASKS_CHANGED_EVENT)); }
  }
}

class UiResult extends Error { constructor(readonly code: string) { super(code); } }
function short(value: string): string { return value.slice(0, 8); }
function html(value: string): string { return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!); }
function withEol(value: string, mode: string): string { const lf = value.replace(/\r\n|\r/gu, '\n'); return mode === 'crlf' ? lf.replace(/\n/gu, '\r\n') : lf; }
function textFor(code: string): string {
  const messages: Record<string, string> = {
    TASK_ARCHIVED: 'This task is archived.', TASK_NOT_DRAFT: 'Only a draft can be edited or frozen.', SPEC_EMPTY: 'Enter a specification before continuing.',
    SPEC_TOO_LARGE: 'The specification exceeds the one MiB limit.', SPEC_INVALID_UNICODE: 'The specification contains invalid Unicode.',
    BINDING_MISSING: 'The task repository binding is missing.', BINDING_CHANGED: 'The task repository binding changed. Refresh before continuing.',
    PROJECT_UNTRUSTED: 'Open the active trusted project before continuing.', REVIEW_REQUIRED: 'Review the complete frozen revision before approval.',
    REVIEW_EXPIRED: 'The approval review expired. Review again.', REVIEW_SESSION_CHANGED: 'The approval review belongs to another session.',
    APPROVAL_NOT_CURRENT: 'The approval is no longer current.', REGISTRY_REVISION_CONFLICT: 'The task registry changed elsewhere. Your draft remains available.',
    TASK_REVISION_CONFLICT: 'The task changed elsewhere. Copy your draft or reload the current revision.', REQUEST_ID_REUSED: 'The request identity was already used for a different action.',
    INTEGRITY_FAILED: 'Task storage integrity failed. Mutations are blocked.', TRANSACTION_BUSY: 'Task storage is busy. Refresh before deciding whether to retry.'
  };
  return messages[code] ?? 'The governed task operation failed safely.';
}
