import { inject, injectable } from '@theia/core/shared/inversify';
import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { ExecutionTargetRegistry } from './execution-target-registry';

// Every execution catalog check is returned even when inspection fails; absent production owners fail rather than disappear.
// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.git-independence, execution.source-integrity, execution.process-cleanup, execution.capacity, execution.recovery, execution.source-maps
export const EXECUTION_CHECKS = ['execution.target-qualification', 'execution.worktree-registry', 'execution.git-independence', 'execution.source-integrity', 'execution.process-cleanup', 'execution.capacity', 'execution.recovery', 'execution.source-maps'] as const;
@injectable()
export class ExecutionDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'execution';
  constructor(@inject(ExecutionTargetRegistry) private readonly targets: ExecutionTargetRegistry) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const value = this.targets.projection();
      return [
        { id: 'execution.target-qualification', ...result(value.qualified, value.qualified ? 'The exact writable-agent Linux target is currently qualified.' : `Execution target refused with ${value.safeCode}.`) },
        { id: 'execution.worktree-registry', ...result(value.activeAllocationCount === 0, 'No private execution allocations are active.') },
        { id: 'execution.git-independence', ...result(value.activeAllocationCount === 0, 'No allocation is awaiting Git independence proof.') },
        { id: 'execution.source-integrity', ...result(value.activeAllocationCount === 0, 'No source-integrity verification is pending.') },
        { id: 'execution.process-cleanup', ...result(value.residualProcessCount === 0, 'No execution process residual is recorded.') },
        { id: 'execution.capacity', ...result(value.activeAllocationCount === 0, 'Execution capacity has no active reservation.') },
        { id: 'execution.recovery', ...result(value.recoveryComplete && value.residualProcessCount === 0, 'Execution startup recovery is complete.') },
        { id: 'execution.source-maps', ...result(value.sourceMapsPresent, value.sourceMapsPresent ? 'Execution backend source maps are present.' : 'Execution backend source maps are missing.') }
      ];
    } catch (error) { console.error('[kogg:execution:target] diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); return EXECUTION_CHECKS.map(id => check(id, false, 'Execution diagnostics could not run.')); }
  }
}
function check(id: typeof EXECUTION_CHECKS[number], passed: boolean, summary: string): KoggDiagnosticCheck { return { id, ...result(passed, summary) }; }
function result(passed: boolean, summary: string): Pick<KoggDiagnosticCheck, 'status' | 'summary'> { return { status: passed ? 'pass' : 'fail', summary }; }
