import { inject, injectable } from '@theia/core/shared/inversify';
import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { ExecutionAllocationRegistry } from './execution-allocation-registry';
import { executionLoggingDiagnostics } from './execution-logger';
import { ExecutionTargetRegistry } from './execution-target-registry';

// Every execution catalog check is returned even when inspection fails; absent production owners fail rather than disappear.
// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.git-independence, execution.source-integrity, execution.process-cleanup, execution.capacity, execution.recovery, execution.retention, execution.source-maps
export const EXECUTION_CHECKS = ['execution.target-qualification', 'execution.worktree-registry', 'execution.git-independence', 'execution.source-integrity', 'execution.process-cleanup', 'execution.capacity', 'execution.recovery', 'execution.retention', 'execution.source-maps'] as const;
@injectable()
export class ExecutionDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'execution';
  constructor(@inject(ExecutionTargetRegistry) private readonly targets: ExecutionTargetRegistry,
    @inject(ExecutionAllocationRegistry) private readonly allocations: ExecutionAllocationRegistry,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const target = this.targets.projection(); const allocation = this.allocations.diagnostics(); const operation = this.operations.diagnostics(); const logging = executionLoggingDiagnostics();
      const registryHealthy = allocation.integrity && allocation.foreignKeys && allocation.permissions
        && allocation.quarantinedCount === 0 && allocation.recoveryRequiredCount === 0 && allocation.cleanupFailureCount === 0
        && allocation.loggingViolationCount === 0 && logging.violationCount === 0;
      return [
        { id: 'execution.target-qualification', ...result(target.qualified, target.qualified ? 'The exact writable-agent Linux target is currently qualified.' : `Execution target refused with ${target.safeCode}.`) },
        { id: 'execution.worktree-registry', ...result(registryHealthy, registryHealthy ? 'The durable private allocation registry is consistent.' : 'The durable private allocation registry requires recovery.') },
        { id: 'execution.git-independence', ...result(allocation.unverifiedCount === 0, 'No allocation is awaiting Git independence proof.') },
        { id: 'execution.source-integrity', ...result(allocation.unverifiedCount === 0 && allocation.pendingImportIntentCount === 0, 'No source-integrity verification or candidate import is pending.') },
        { id: 'execution.process-cleanup', ...result(operation.residualCount === 0 && operation.cleanupFailureCount === 0 && allocation.pendingCleanupIntentCount === 0, 'No execution process residual or physical cleanup intent is pending.') },
        { id: 'execution.capacity', ...result(allocation.admission === 'enabled' && allocation.reservationCount < 64, 'Execution reservation capacity is available.') },
        { id: 'execution.recovery', ...result(allocation.admission === 'enabled' && operation.recoveryComplete && operation.admission === 'enabled', 'Execution startup recovery is complete.') },
        { id: 'execution.retention', ...result(allocation.retentionViolationCount === 0, 'Every candidate cleanup transition agrees with its durable retention fact.') },
        { id: 'execution.source-maps', ...result(target.sourceMapsPresent, target.sourceMapsPresent ? 'Execution backend source maps are present.' : 'Execution backend source maps are missing.') }
      ];
    } catch (error) { console.error('[kogg:execution:target] diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); return EXECUTION_CHECKS.map(id => check(id, false, 'Execution diagnostics could not run.')); }
  }
}
function check(id: typeof EXECUTION_CHECKS[number], passed: boolean, summary: string): KoggDiagnosticCheck { return { id, ...result(passed, summary) }; }
function result(passed: boolean, summary: string): Pick<KoggDiagnosticCheck, 'status' | 'summary'> { return { status: passed ? 'pass' : 'fail', summary }; }
