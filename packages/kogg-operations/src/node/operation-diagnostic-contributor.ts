import { inject, injectable } from '@theia/core/shared/inversify';
import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { OperationRegistry } from './operation-registry';

// diagnostic-coverage: operations.registry, operations.recovery, operations.processes, operations.cleanup, operations.admission

@injectable()
export class OperationDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'operations';
  constructor(@inject(OperationRegistry) private readonly registry: OperationRegistry) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const result = this.registry.diagnostics();
      return [
        { id: 'operations.registry', status: result.integrity && result.foreignKeys && result.permissions ? 'pass' : 'fail', summary: result.integrity && result.foreignKeys && result.permissions ? 'Operation registry integrity, foreign keys, and permissions are valid.' : 'Operation registry integrity, foreign keys, or permissions failed.' },
        { id: 'operations.recovery', status: result.recoveryComplete ? 'pass' : 'fail', summary: result.recoveryComplete ? 'Startup operation recovery is complete.' : 'Startup operation recovery is incomplete.' },
        { id: 'operations.processes', status: result.stalledCount || result.residualCount ? 'fail' : 'pass', summary: result.stalledCount || result.residualCount ? 'A stalled or possible-residual Kogg process requires attention.' : 'No stalled or possible-residual Kogg process exists.', details: { activeCount: result.activeCount, stalledCount: result.stalledCount, residualCount: result.residualCount } },
        { id: 'operations.cleanup', status: result.cleanupFailureCount ? 'fail' : 'pass', summary: result.cleanupFailureCount ? 'One or more operations lack proved cleanup.' : 'Operation cleanup records are complete.', details: { cleanupFailureCount: result.cleanupFailureCount } },
        { id: 'operations.admission', status: result.admission === 'enabled' ? 'pass' : 'fail', summary: result.admission === 'enabled' ? 'Operation admission is enabled.' : 'Operation admission is blocked by recovery or cleanup state.' }
      ];
    } catch (error) {
      console.error('[kogg:operations:diagnostics] diagnose.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return ['registry', 'recovery', 'processes', 'cleanup', 'admission'].map(id => ({ id: `operations.${id}`, status: 'fail' as const, summary: 'Operation diagnostics could not run.' }));
    }
  }
}
