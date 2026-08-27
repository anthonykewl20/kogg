import type { KoggProjectSummary, ProjectRegistrySnapshot } from '@kogg/contracts';
import { KoggProjectsService, type KoggProjectsService as ProjectsService } from '@kogg/projects/lib/common/projects-protocol';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { KoggExecutionService, type ExecutionQualificationProjection, type ExecutionRunProjectionV1, type KoggExecutionService as ExecutionService } from '../common/execution-protocol';
import { executionAuthorityNotice, executionStartGate, executionStateLabel } from '../common/execution-view-model';

// Read-only execution UI renders safe projections only; paths, Git controls, bindings, prompts, and provider bodies never enter this boundary.
// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.source-maps
@injectable()
export class ExecutionWidget extends BaseWidget {
  static readonly ID = 'kogg-execution'; static readonly LABEL = 'Kogg Execution';
  private projects: ProjectRegistrySnapshot = { schemaVersion: 1, revision: 1, projects: [] };
  private qualification: ExecutionQualificationProjection = { qualified: false, targetId: 'local-qualified-linux', profileId: 'kogg-writable-agent-v1', safeCode: 'QUALIFICATION_PROFILE_UNAVAILABLE', sourceMapsPresent: true };
  private runs: readonly ExecutionRunProjectionV1[] = []; private selectedProjectId: string | undefined; private busy = false; private status = 'Loading execution state…';

  constructor(@inject(KoggExecutionService) private readonly execution: ExecutionService,
    @inject(KoggProjectsService) private readonly projectService: ProjectsService) { super(); }

  @postConstruct()
  protected init(): void {
    this.id = ExecutionWidget.ID; this.title.label = ExecutionWidget.LABEL; this.title.caption = 'Qualified private execution runs'; this.title.closable = true;
    this.addClass('kogg-execution-widget'); this.render(); void this.load();
  }

  private async load(projectId = this.selectedProjectId): Promise<void> {
    const requestId = crypto.randomUUID(); this.busy = true; this.status = 'Loading execution state…'; this.render();
    console.info('[kogg:execution:widget] runs.load.requested', { requestId });
    try {
      const [projects, qualification] = await Promise.all([this.projectService.snapshot(), this.execution.qualification({ requestId })]);
      this.projects = projects; this.qualification = qualification;
      this.selectedProjectId = projectId && projects.projects.some(project => project.id === projectId) ? projectId : projects.activeProjectId ?? projects.projects[0]?.id;
      this.runs = this.selectedProjectId ? (await this.execution.listRuns({ requestId: crypto.randomUUID(), projectId: this.selectedProjectId })).runs : [];
      this.status = this.runs.length ? `${this.runs.length} execution run${this.runs.length === 1 ? '' : 's'}.` : 'No execution runs for this project.';
      console.info('[kogg:execution:widget] runs.load.completed', { requestId, projectId: this.selectedProjectId, resultCount: this.runs.length, safeCode: qualification.safeCode });
    } catch (error) {
      this.runs = []; this.status = 'Execution state could not be loaded.';
      console.error('[kogg:execution:widget] runs.load.failed', { requestId, projectId: this.selectedProjectId, errorType: error instanceof Error ? error.name : 'UnknownError' });
    } finally { this.busy = false; this.render(); }
  }

  private render(): void {
    const gate = executionStartGate(this.qualification); const selected = this.projects.projects.find(project => project.id === this.selectedProjectId);
    this.node.innerHTML = `<div class="kogg-panel"><header><h2>Kogg Execution</h2><p>Qualified private runs and closed lifecycle status.</p></header>
      <label>Project<select data-project ${this.busy || !this.projects.projects.length ? 'disabled' : ''}>${this.projects.projects.map(project => `<option value="${escapeHtml(project.id)}" ${project.id === this.selectedProjectId ? 'selected' : ''}>${escapeHtml(project.displayName)}</option>`).join('')}</select></label>
      <div class="kogg-package-actions"><button data-refresh ${this.busy ? 'disabled' : ''}>Refresh</button><button disabled title="${escapeHtml(gate.summary)}">Start run</button></div>
      <p role="status"><strong>Qualification:</strong> ${escapeHtml(this.qualification.safeCode)} · <strong>Status:</strong> ${escapeHtml(this.status)}</p>
      <p class="kogg-blocked">${escapeHtml(gate.summary)}</p>
      <section><h3>${selected ? escapeHtml(selected.displayName) : 'Runs'}</h3>${this.runs.length ? `<div class="kogg-package-list">${this.runs.map(run => renderRun(run, selected)).join('')}</div>` : '<p>None</p>'}</section></div>`;
    this.node.querySelector<HTMLButtonElement>('[data-refresh]')?.addEventListener('click', () => void this.load());
    this.node.querySelector<HTMLSelectElement>('[data-project]')?.addEventListener('change', event => void this.load((event.currentTarget as HTMLSelectElement).value));
  }
}

function renderRun(run: ExecutionRunProjectionV1, project: KoggProjectSummary | undefined): string {
  const repository = project?.repositories.find(item => item.id === run.repositoryId)?.displayName ?? 'Registered repository';
  return `<article><div><strong>${escapeHtml(executionStateLabel(run.state))}</strong><p>${escapeHtml(repository)} · run ${escapeHtml(shortId(run.runId))} · attempt ${escapeHtml(shortId(run.attemptId))}</p><p class="kogg-blocked">${escapeHtml(executionAuthorityNotice(run))}</p></div><div><span>${escapeHtml(run.authorityMode)} authority · sequence ${escapeHtml(run.authoritySequence)}</span><p>${escapeHtml(run.safeCode)} · revision ${escapeHtml(run.revision)} · cleanup ${escapeHtml(run.cleanupState)}</p></div></article>`;
}
function shortId(value: string): string { return value.slice(0, 8); }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!); }
