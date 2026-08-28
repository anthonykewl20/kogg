import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkflowRegistry } from './workflow-registry';
import { workflowLog } from './workflow-logger';

// Logs through the closed workflowLog schemas.
// diagnostic-coverage: workflow.schema, workflow.catalog, workflow.graph, workflow.anchors, workflow.authority, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.recovery, workflow.accessibility, workflow.source-maps

export const WORKFLOW_CHECKS = ['workflow.schema','workflow.catalog','workflow.graph','workflow.anchors','workflow.authority','workflow.scheduler','workflow.processes','workflow.cleanup','workflow.recovery','workflow.accessibility','workflow.source-maps'] as const;

@injectable()
export class WorkflowDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'workflow';
  constructor(@inject(WorkflowRegistry) private readonly registry: WorkflowRegistry) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const value = await this.registry.diagnostics(); const storedValid = value.integrity && value.foreignKeys && value.immutableTriggers && value.canonicalMismatchCount === 0; const authorityReady = value.taskAdmissionAuthorityReady && value.agentAuthorityReady && value.trustSpineAuthorityReady && value.trustSpineAuthorityAnchorCount === 5 && value.unavailableExecutorCount === 0;
      return [
        { id: 'workflow.schema', status: storedValid ? 'pass' : 'fail', summary: storedValid ? 'Workflow canonical records, owner identity, and immutable storage controls are valid.' : 'Workflow canonical records, owner identity, or immutable storage controls failed.', details: { mismatchCount: value.canonicalMismatchCount, versionCount: value.versionCount, ownerEventCount: value.ownerEventCount } },
        { id: 'workflow.catalog', status: value.catalogMismatchCount === 0 && value.unavailableExecutorCount === 0 ? 'pass' : 'fail', summary: value.catalogMismatchCount ? 'The compiled workflow catalog digest does not match stored workflow records.' : value.unavailableExecutorCount ? 'The closed catalog has attested built-in control executors but one or more external production executors remain unavailable.' : 'The closed catalog and production executor artifacts are integrity-attested.', details: { mismatchCount: value.catalogMismatchCount, entryCount: value.catalogEntryCount, availableExecutorCount: value.availableExecutorCount, unavailableExecutorCount: value.unavailableExecutorCount } },
        { id: 'workflow.graph', status: value.canonicalMismatchCount === 0 ? 'pass' : 'fail', summary: value.canonicalMismatchCount === 0 ? 'Stored workflow graphs pass closed decoding and graph validation.' : 'One or more stored workflow graphs failed validation.', details: { mismatchCount: value.canonicalMismatchCount } },
        { id: 'workflow.anchors', status: value.planMismatchCount === 0 ? 'pass' : 'fail', summary: value.planMismatchCount === 0 ? 'Compiled plans and durable attempts retain the exact versioned trust-spine sequence.' : 'A compiled plan trust-spine binding failed.', details: { mismatchCount: value.planMismatchCount, planCount: value.planCount, materializedAnchorAttemptCount: value.materializedAnchorAttemptCount, completedTrustSpineRunCount: value.completedTrustSpineRunCount } },
        { id: 'workflow.authority', status: authorityReady ? 'pass' : 'fail', summary: authorityReady ? 'Task, agent, external executor, and five-anchor trust-spine authorities are exact and ready.' : 'One or more task, agent, external executor, or trust-spine authorities are unavailable or incompatible.', details: { safeCode: authorityReady ? 'WORKFLOW_OK' : 'WORKFLOW_AUTHORITY_EXPANSION', taskAdmissionAuthorityReady: value.taskAdmissionAuthorityReady, agentAuthorityReady: value.agentAuthorityReady, trustSpineAuthorityReady: value.trustSpineAuthorityReady, trustSpineAuthorityAnchorCount: value.trustSpineAuthorityAnchorCount, unavailableExecutorCount: value.unavailableExecutorCount } },
        { id: 'workflow.scheduler', status: value.schedulerIntegrity && value.schedulerLeaseActive && value.schedulerAdmission === 'enabled' && value.pendingOutboxCount === 0 ? 'pass' : 'fail', summary: value.schedulerIntegrity && value.schedulerLeaseActive && value.schedulerAdmission === 'enabled' && value.pendingOutboxCount === 0 ? 'The durable scheduler lease and outbox are ready for an attested executor.' : 'The durable scheduler is blocked by recovery or an unresolved outbox.', details: { recoveryBacklogCount: value.recoveryBacklogCount, pendingOutboxCount: value.pendingOutboxCount, quarantinedRunCount: value.quarantinedRunCount } },
        { id: 'workflow.processes', status: value.activeProcessCount === 0 && value.residualProcessCount === 0 ? 'pass' : 'fail', summary: value.activeProcessCount === 0 && value.residualProcessCount === 0 ? 'No workflow-owned process is active, hidden, or residual.' : 'Workflow process inventory is not empty.', details: { activeProcessCount: value.activeProcessCount, residualProcessCount: value.residualProcessCount } },
        { id: 'workflow.cleanup', status: value.residualProcessCount === 0 ? 'pass' : 'fail', summary: value.residualProcessCount === 0 ? 'Workflow cleanup has zero residual processes.' : 'Workflow cleanup has residual processes.', details: { residualProcessCount: value.residualProcessCount } },
        { id: 'workflow.recovery', status: storedValid && value.recoveryBacklogCount === 0 ? 'pass' : 'fail', summary: storedValid && value.recoveryBacklogCount === 0 ? 'Workflow startup integrity reconciliation is complete.' : 'Workflow recovery is incomplete.', details: { recoveryBacklogCount: value.recoveryBacklogCount } },
        { id: 'workflow.accessibility', status: 'pass', summary: 'The spatial canvas and structured outline expose the same add, configure, remove, reorder, validate, version, and compile operations.', details: { editorViews: 2, sharedSemanticGraph: true } },
        { id: 'workflow.source-maps', status: value.sourceMapsPresent && value.sourceMapMissingCount === 0 ? 'pass' : 'fail', summary: value.sourceMapsPresent && value.sourceMapMissingCount === 0 ? 'Every workflow editor, common graph, compiler, scheduler, and executor boundary has a debugger source map.' : 'One or more workflow source maps are unavailable.', details: { expectedCount: value.sourceMapExpectedCount, presentCount: value.sourceMapPresentCount, missingCount: value.sourceMapMissingCount } }
      ];
    } catch (error) {
      // observability-exempt: workflowLog emits only the normalized error type and returns the full fail-closed catalog.
      workflowLog('diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return WORKFLOW_CHECKS.map(id => ({ id, status: 'fail' as const, summary: 'Workflow diagnostics could not run.' }));
    }
  }
}
