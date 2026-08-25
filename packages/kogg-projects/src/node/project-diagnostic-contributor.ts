import { inject, injectable } from '@theia/core/shared/inversify';
import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { ProjectRegistry } from './project-registry';

// diagnostic-coverage: projects.registry, projects.repositories, projects.restoration, projects.processes

@injectable()
export class ProjectDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'projects';

  constructor(@inject(ProjectRegistry) private readonly registry: ProjectRegistry) {}

  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const result = this.registry.diagnostics();
      return [
        {
          id: 'projects.registry', status: result.integrity && result.foreignKeys ? 'pass' : 'fail',
          summary: result.integrity && result.foreignKeys ? 'Project registry integrity and foreign keys are valid.' : 'Project registry integrity or foreign keys failed.'
        },
        {
          id: 'projects.repositories', status: result.unavailableCount ? 'warn' : 'pass',
          summary: result.unavailableCount ? 'One or more registered repositories require attention.' : 'Registered repositories are available.',
          details: { repositoryCount: result.repositoryCount, unavailableCount: result.unavailableCount }
        },
        {
          id: 'projects.restoration', status: result.activeConsistent && result.pendingConsistent ? 'pass' : 'fail',
          summary: result.activeConsistent && result.pendingConsistent ? 'Project restoration state is internally consistent.' : 'Project restoration state is inconsistent.'
        },
        {
          id: 'projects.processes', status: result.activeProcesses ? 'fail' : 'pass',
          summary: result.activeProcesses ? 'A Kogg repository probe is still active.' : 'No residual Kogg repository probe exists.',
          details: { activeProcessCount: result.activeProcesses }
        }
      ];
    } catch (error) {
      console.error('[kogg:projects:diagnostics] diagnose.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return [
        { id: 'projects.registry', status: 'fail', summary: 'Project registry diagnostics could not run.' },
        { id: 'projects.repositories', status: 'fail', summary: 'Repository diagnostics could not run.' },
        { id: 'projects.restoration', status: 'fail', summary: 'Project restoration diagnostics could not run.' },
        { id: 'projects.processes', status: 'fail', summary: 'Project process diagnostics could not run.' }
      ];
    }
  }
}
