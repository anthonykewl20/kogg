import type { KoggProjectRole, KoggProjectSummary, ProjectRegistrySnapshot } from '@kogg/contracts';
import { MessageService } from '@theia/core';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog/file-dialog-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { KoggProjectsService } from '../common/projects-protocol';

// diagnostic-coverage: projects.repositories, projects.restoration

const ROLES: readonly KoggProjectRole[] = [
  'orchestrator', 'architect', 'planner', 'worker', 'researcher', 'test-writer',
  'test-executor', 'reviewer', 'security-reviewer', 'performance-reviewer',
  'documentation-agent', 'migration-agent', 'release-agent', 'integrator', 'verification-agent'
];

@injectable()
export class ProjectsWidget extends BaseWidget {
  static readonly ID = 'kogg-projects';
  static readonly LABEL = 'Kogg Projects';
  private snapshot: ProjectRegistrySnapshot = { schemaVersion: 1, revision: 1, projects: [] };
  private selectedProjectId: string | undefined;
  private busy = false;
  private status = 'Loading projects…';

  constructor(
    @inject(KoggProjectsService) private readonly service: KoggProjectsService,
    @inject(FileDialogService) private readonly dialogs: FileDialogService,
    @inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @inject(MessageService) private readonly messages: MessageService
  ) { super(); }

  @postConstruct()
  protected init(): void {
    this.id = ProjectsWidget.ID;
    this.title.label = ProjectsWidget.LABEL;
    this.title.caption = 'Durable Kogg projects and repositories';
    this.title.closable = true;
    this.addClass('kogg-projects-widget');
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    await this.run(async () => {
      this.snapshot = await this.service.snapshot();
      this.selectedProjectId = this.selectedProjectId && this.snapshot.projects.some(project => project.id === this.selectedProjectId)
        ? this.selectedProjectId
        : this.snapshot.activeProjectId ?? this.snapshot.projects[0]?.id;
      this.status = this.snapshot.projects.length ? 'Project registry ready.' : 'Add a Git repository to create your first project.';
    }, false);
  }

  private render(): void {
    const selected = this.snapshot.projects.find(project => project.id === this.selectedProjectId);
    this.node.innerHTML = `<div class="kogg-panel">
      <header><h2>Kogg Projects</h2><p>Projects isolate repositories, execution settings, and agent role assignments.</p></header>
      <form data-action="create" class="kogg-form-grid">
        <label>New project name<input name="displayName" maxlength="80" required placeholder="Project name"></label>
        <button ${this.busy ? 'disabled' : ''}>Choose repository and add project</button>
      </form>
      <p role="status"><strong>Status:</strong> ${escapeHtml(this.status)}</p>
      ${this.snapshot.pendingSwitch ? `<p class="kogg-blocked">Project switch pending for ${escapeHtml(projectName(this.snapshot, this.snapshot.pendingSwitch.toProjectId))}.</p>` : ''}
      <section><h3>Projects</h3>${this.snapshot.projects.length ? `<div class="kogg-package-list">${this.snapshot.projects.map(project => this.renderProject(project)).join('')}</div>` : '<p>None</p>'}</section>
      ${selected ? this.renderSelected(selected) : ''}
    </div>`;
    this.bindEvents();
  }

  private renderProject(project: KoggProjectSummary): string {
    const active = project.id === this.snapshot.activeProjectId;
    const selected = project.id === this.selectedProjectId;
    return `<article data-project-row="${escapeHtml(project.id)}">
      <div><strong>${escapeHtml(project.displayName)}</strong> ${active ? '<span>Active</span>' : ''}
      <p>${project.repositories.length} repositor${project.repositories.length === 1 ? 'y' : 'ies'} · ${escapeHtml(project.lifecycle)}</p></div>
      <div class="kogg-package-actions">
        <button data-select="${escapeHtml(project.id)}" ${this.busy || selected ? 'disabled' : ''}>Manage</button>
        <button data-switch="${escapeHtml(project.id)}" ${this.busy || active || project.lifecycle !== 'available' ? 'disabled' : ''}>Switch</button>
        <button data-remove-project="${escapeHtml(project.id)}" ${this.busy || active ? 'disabled' : ''}>Remove</button>
      </div></article>`;
  }

  private renderSelected(project: KoggProjectSummary): string {
    return `<section data-selected-project="${escapeHtml(project.id)}">
      <h3>Manage ${escapeHtml(project.displayName)}</h3>
      <form data-action="rename" class="kogg-form-grid"><label>Project name<input name="displayName" maxlength="80" value="${escapeHtml(project.displayName)}" required></label><button ${this.busy ? 'disabled' : ''}>Rename</button></form>
      <label>Execution profile<select data-action="profile" ${this.busy ? 'disabled' : ''}>
        ${['default', 'restricted', 'trusted-local'].map(profile => `<option value="${profile}" ${project.executionProfileId === profile ? 'selected' : ''}>${profile}</option>`).join('')}
      </select></label>
      <h4>Repositories</h4><div class="kogg-package-list">${project.repositories.map(repository => `<article>
        <div><strong>${escapeHtml(repository.displayName)}</strong><p>${escapeHtml(repositoryRootLabel(repository.rootUri))} · ${escapeHtml(repository.availability)}</p></div>
        <div class="kogg-package-actions"><button data-relocate="${escapeHtml(repository.id)}" ${this.busy ? 'disabled' : ''}>Relocate</button><button data-remove-repository="${escapeHtml(repository.id)}" ${this.busy || project.repositories.length === 1 ? 'disabled' : ''}>Remove</button></div>
      </article>`).join('')}</div>
      <form data-action="add-repository" class="kogg-form-grid"><label>Repository name<input name="displayName" maxlength="80" required placeholder="Repository name"></label><button ${this.busy ? 'disabled' : ''}>Choose and add repository</button></form>
      <h4>Role assignment</h4><form data-action="role" class="kogg-form-grid">
        <label>Role<select name="role">${ROLES.map(role => `<option value="${role}">${role}</option>`).join('')}</select></label>
        <label>Provider configuration<input name="providerConfigurationId" placeholder="ollama:default" required></label>
        <label>Model<input name="modelId" placeholder="model-id" required></label>
        <button ${this.busy ? 'disabled' : ''}>Assign role</button>
      </form>
      ${Object.keys(project.roleAssignments).length ? `<ul>${Object.entries(project.roleAssignments).map(([role, assignment]) => `<li>${escapeHtml(role)} → ${escapeHtml(assignment!.providerConfigurationId)} / ${escapeHtml(assignment!.modelId)} <button data-clear-role="${escapeHtml(role)}" ${this.busy ? 'disabled' : ''}>Clear</button></li>`).join('')}</ul>` : '<p>No role assignments.</p>'}
      <h4>Task repository bindings</h4><form data-action="task-binding" class="kogg-form-grid">
        <label>Task ID<input name="taskId" maxlength="128" pattern="[a-z0-9][a-z0-9._:-]{0,127}" required placeholder="task-id"></label>
        <label>Task repository<select name="repositoryId">${project.repositories.map(repository => `<option value="${escapeHtml(repository.id)}">${escapeHtml(repository.displayName)}</option>`).join('')}</select></label>
        <button ${this.busy ? 'disabled' : ''}>Bind task</button>
      </form>
      ${project.taskBindings.length ? `<ul>${project.taskBindings.map(binding => `<li>${escapeHtml(binding.taskId)} → ${escapeHtml(project.repositories.find(repository => repository.id === binding.repositoryId)?.displayName ?? 'unknown repository')} <button data-clear-task="${escapeHtml(binding.taskId)}" ${this.busy ? 'disabled' : ''}>Clear</button></li>`).join('')}</ul>` : '<p>No task repository bindings.</p>'}
    </section>`;
  }

  private bindEvents(): void {
    this.node.querySelector<HTMLFormElement>('form[data-action="create"]')?.addEventListener('submit', event => {
      event.preventDefault(); void this.createProject(new FormData(event.currentTarget as HTMLFormElement).get('displayName'));
    });
    this.node.querySelectorAll<HTMLElement>('[data-select]').forEach(button => button.addEventListener('click', () => {
      this.selectedProjectId = button.dataset.select; this.render();
    }));
    this.node.querySelectorAll<HTMLElement>('[data-switch]').forEach(button => button.addEventListener('click', () => void this.switchProject(button.dataset.switch!)));
    this.node.querySelectorAll<HTMLElement>('[data-remove-project]').forEach(button => button.addEventListener('click', () => void this.removeProject(button.dataset.removeProject!)));
    this.node.querySelector<HTMLFormElement>('form[data-action="rename"]')?.addEventListener('submit', event => {
      event.preventDefault(); void this.renameProject(new FormData(event.currentTarget as HTMLFormElement).get('displayName'));
    });
    this.node.querySelector<HTMLSelectElement>('select[data-action="profile"]')?.addEventListener('change', event => void this.setProfile((event.currentTarget as HTMLSelectElement).value));
    this.node.querySelector<HTMLFormElement>('form[data-action="add-repository"]')?.addEventListener('submit', event => {
      event.preventDefault(); void this.addRepository(new FormData(event.currentTarget as HTMLFormElement).get('displayName'));
    });
    this.node.querySelectorAll<HTMLElement>('[data-relocate]').forEach(button => button.addEventListener('click', () => void this.relocateRepository(button.dataset.relocate!)));
    this.node.querySelectorAll<HTMLElement>('[data-remove-repository]').forEach(button => button.addEventListener('click', () => void this.removeRepository(button.dataset.removeRepository!)));
    this.node.querySelector<HTMLFormElement>('form[data-action="role"]')?.addEventListener('submit', event => {
      event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); void this.setRole(String(data.get('role')), String(data.get('providerConfigurationId')), String(data.get('modelId')));
    });
    this.node.querySelectorAll<HTMLElement>('[data-clear-role]').forEach(button => button.addEventListener('click', () => void this.clearRole(button.dataset.clearRole!)));
    this.node.querySelector<HTMLFormElement>('form[data-action="task-binding"]')?.addEventListener('submit', event => {
      event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
      void this.bindTask(String(data.get('taskId')), String(data.get('repositoryId')));
    });
    this.node.querySelectorAll<HTMLElement>('[data-clear-task]').forEach(button => button.addEventListener('click', () => void this.clearTask(button.dataset.clearTask!)));
  }

  private async createProject(value: FormDataEntryValue | null): Promise<void> {
    const repositoryPath = await this.chooseRepository('Choose the first project repository'); if (!repositoryPath) return;
    await this.mutate('Creating project…', request => this.service.createProject({ ...request, displayName: String(value ?? ''), repositoryPath }));
  }
  private async renameProject(value: FormDataEntryValue | null): Promise<void> {
    const project = this.selected(); if (!project) return;
    await this.mutate('Renaming project…', request => this.service.renameProject({ ...request, projectId: project.id, displayName: String(value ?? '') }));
  }
  private async removeProject(projectId: string): Promise<void> {
    const project = this.snapshot.projects.find(item => item.id === projectId); if (!project) return;
    if (!await new ConfirmDialog({ title: 'Remove project from Kogg?', msg: `${project.displayName} will be removed from the registry. Source files will not be deleted.` }).open()) return;
    await this.mutate('Removing project registry entry…', request => this.service.removeProject({ ...request, projectId }));
  }
  private async addRepository(value: FormDataEntryValue | null): Promise<void> {
    const project = this.selected(); if (!project) return;
    const repositoryPath = await this.chooseRepository('Choose a Git repository'); if (!repositoryPath) return;
    await this.mutate('Adding repository…', request => this.service.addRepository({ ...request, projectId: project.id, displayName: String(value ?? ''), repositoryPath }));
  }
  private async relocateRepository(repositoryId: string): Promise<void> {
    const project = this.selected(); if (!project) return;
    const repositoryPath = await this.chooseRepository('Relocate the same Git repository'); if (!repositoryPath) return;
    await this.mutate('Relocating repository…', request => this.service.relocateRepository({ ...request, projectId: project.id, repositoryId, repositoryPath }));
  }
  private async removeRepository(repositoryId: string): Promise<void> {
    const project = this.selected(); if (!project) return;
    if (!await new ConfirmDialog({ title: 'Remove repository from project?', msg: 'Only the registry entry is removed. Source files are not deleted.' }).open()) return;
    await this.mutate('Removing repository registry entry…', request => this.service.removeRepository({ ...request, projectId: project.id, repositoryId }));
  }
  private async setProfile(executionProfileId: string): Promise<void> {
    const project = this.selected(); if (!project) return;
    await this.mutate('Updating execution profile…', request => this.service.setExecutionProfile({ ...request, projectId: project.id, executionProfileId }));
  }
  private async setRole(role: string, providerConfigurationId: string, modelId: string): Promise<void> {
    const project = this.selected(); if (!project) return;
    await this.mutate('Assigning role…', request => this.service.setRoleAssignment({
      ...request, projectId: project.id, role: role as KoggProjectRole, assignment: { providerConfigurationId, modelId }
    }));
  }
  private async clearRole(role: string): Promise<void> {
    const project = this.selected(); if (!project) return;
    await this.mutate('Clearing role assignment…', request => this.service.setRoleAssignment({ ...request, projectId: project.id, role: role as KoggProjectRole }));
  }
  private async bindTask(taskId: string, repositoryId: string): Promise<void> {
    const project = this.selected(); if (!project) return;
    await this.mutate('Binding task repository…', request => this.service.bindTaskRepository({ ...request, projectId: project.id, taskId, repositoryId }));
  }
  private async clearTask(taskId: string): Promise<void> {
    const project = this.selected(); if (!project) return;
    await this.mutate('Clearing task repository binding…', request => this.service.clearTaskRepository({ ...request, projectId: project.id, taskId }));
  }

  private async switchProject(projectId: string): Promise<void> {
    this.busy = true; this.status = 'Preparing project switch…'; this.render();
    const requestId = crypto.randomUUID();
    try {
      const ticket = await this.service.requestSwitch({ requestId, expectedRegistryRevision: this.snapshot.revision, projectId });
      this.status = 'Opening project workspace…'; this.render();
      await this.workspace.openWorkspace(new URI(ticket.workspaceUri), { preserveWindow: true });
    } catch (error) {
      await this.service.cancelSwitch({ requestId: crypto.randomUUID(), operationId: requestId }).catch(() => undefined);
      console.error('[kogg:projects:widget] project-switch.failed', { operationId: requestId, projectId, errorType: errorName(error) });
      this.status = message(error); void this.messages.error(this.status);
      this.busy = false; await this.load();
    }
  }

  private async chooseRepository(title: string): Promise<string | undefined> {
    const uri = await this.dialogs.showOpenDialog({ title, canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
    return uri?.toString();
  }

  private selected(): KoggProjectSummary | undefined { return this.snapshot.projects.find(project => project.id === this.selectedProjectId); }
  private expectation(): { requestId: string; expectedRegistryRevision: number } { return { requestId: crypto.randomUUID(), expectedRegistryRevision: this.snapshot.revision }; }
  private async mutate(status: string, operation: (request: { requestId: string; expectedRegistryRevision: number }) => Promise<ProjectRegistrySnapshot>): Promise<void> {
    await this.run(async () => { this.status = status; this.render(); this.snapshot = await operation(this.expectation()); this.status = 'Project registry updated.'; });
  }
  private async run(operation: () => Promise<void>, notify = true): Promise<void> {
    this.busy = true; this.render();
    try { await operation(); }
    catch (error) {
      console.error('[kogg:projects:widget] operation.failed', { errorType: errorName(error) });
      this.status = message(error); if (notify) void this.messages.error(this.status);
    } finally { this.busy = false; this.render(); }
  }
}

function projectName(snapshot: ProjectRegistrySnapshot, projectId: string): string { return snapshot.projects.find(project => project.id === projectId)?.displayName ?? 'unknown project'; }
function repositoryRootLabel(uri: string): string {
  try { return decodeURIComponent(uri.replace(/\/$/u, '').split('/').pop() ?? 'repository'); }
  catch {
    // observability-exempt: Malformed display encoding falls back to a non-content label and is not an operational failure.
    return 'repository';
  }
}
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!); }
function message(error: unknown): string { return error instanceof Error ? error.message : 'Kogg project operation failed'; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
