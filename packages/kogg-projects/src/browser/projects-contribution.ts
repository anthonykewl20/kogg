import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { KoggProjectsService } from '../common/projects-protocol';
import { ProjectsWidget } from './projects-widget';

// diagnostic-coverage: projects.restoration

@injectable()
export class ProjectsContribution extends AbstractViewContribution<ProjectsWidget> implements FrontendApplicationContribution {
  constructor(
    @inject(KoggProjectsService) private readonly service: KoggProjectsService,
    @inject(WorkspaceService) private readonly workspace: WorkspaceService
  ) {
    super({
      widgetId: ProjectsWidget.ID,
      widgetName: ProjectsWidget.LABEL,
      defaultWidgetOptions: { area: 'left', rank: 100 },
      toggleCommandId: 'kogg.projects.open'
    });
  }

  async onDidInitializeLayout(_application: FrontendApplication): Promise<void> {
    const requestId = crypto.randomUUID();
    try {
      // Reconciliation needs the actual restored workspace URI. Running after
      // layout initialization avoids blocking WorkspaceService's own startup
      // while still fencing preserve-window project-switch reconciliation.
      await this.workspace.ready;
      const reconciliation = await this.service.reconcileWorkspace({ requestId, currentWorkspaceUri: this.workspace.workspace?.resource.toString() });
      if (reconciliation.action === 'open' && reconciliation.workspaceUri) {
        const recoveryKey = `kogg-project-recovery:${reconciliation.workspaceUri}`;
        if (sessionStorage.getItem(recoveryKey)) {
          console.error('[kogg:projects:switch] project.restore.failed', { operationId: requestId, safeCode: 'PROJECT_RESTORE_LOOP' });
          return;
        }
        sessionStorage.setItem(recoveryKey, '1');
        await this.workspace.openWorkspace(new URI(reconciliation.workspaceUri), { preserveWindow: true });
      }
    } catch (error) {
      console.error('[kogg:projects:switch] project.restore.failed', { operationId: requestId, errorType: error instanceof Error ? error.name : 'UnknownError' });
    }
  }
}
