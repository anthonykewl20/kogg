import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { TaskRegistry } from './task-registry';

// diagnostic-coverage: tasks.registry, tasks.revisions, tasks.bindings, tasks.approvals

@injectable()
export class TaskDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'tasks';
  constructor(@inject(TaskRegistry) private readonly registry: TaskRegistry) {}

  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const result = await this.registry.diagnostics();
      return [
        { id: 'tasks.registry', status: result.integrity && result.foreignKeys && result.immutableTriggers && result.openTransactionCount === 0 ? 'pass' : 'fail',
          summary: result.integrity && result.foreignKeys && result.immutableTriggers ? 'Task registry integrity and immutable storage controls are valid.' : 'Task registry integrity or immutable storage controls failed.',
          details: { taskCount: result.taskCount, openTransactionCount: result.openTransactionCount } },
        { id: 'tasks.revisions', status: result.revisionMismatchCount ? 'fail' : 'pass',
          summary: result.revisionMismatchCount ? 'One or more task revisions failed canonical verification.' : 'Task revision chains and canonical digests are valid.',
          details: { mismatchCount: result.revisionMismatchCount } },
        { id: 'tasks.bindings', status: result.bindingMismatchCount ? 'fail' : 'pass',
          summary: result.bindingMismatchCount ? 'One or more task repository bindings are no longer current.' : 'Task repository bindings are current.',
          details: { mismatchCount: result.bindingMismatchCount } },
        { id: 'tasks.approvals', status: result.approvalMismatchCount ? 'fail' : 'pass',
          summary: result.approvalMismatchCount ? 'One or more current approvals do not match the frozen revision.' : 'Current approvals match immutable frozen revisions.',
          details: { mismatchCount: result.approvalMismatchCount } }
      ];
    } catch (error) {
      console.error('[kogg:tasks:diagnostics] diagnose.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return [
        { id: 'tasks.registry', status: 'fail', summary: 'Task registry diagnostics could not run.' },
        { id: 'tasks.revisions', status: 'fail', summary: 'Task revision diagnostics could not run.' },
        { id: 'tasks.bindings', status: 'fail', summary: 'Task binding diagnostics could not run.' },
        { id: 'tasks.approvals', status: 'fail', summary: 'Task approval diagnostics could not run.' }
      ];
    }
  }
}
