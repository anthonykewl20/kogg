import { inject, injectable } from '@theia/core/shared/inversify';
import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { OperationRegistry } from './operation-registry';
import { OperationsReadModel } from './operations-read-model';

// diagnostic-coverage: operations.registry, operations.recovery, operations.processes, operations.cleanup, operations.admission

@injectable()
export class OperationDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'operations';
  constructor(@inject(OperationRegistry) private readonly registry: OperationRegistry,
    @inject(OperationsReadModel) private readonly projection: OperationsReadModel) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const result = this.registry.diagnostics();
      const projection = this.projection.diagnostics(); const processFailed = Boolean(result.stalledCount || result.residualCount || projection.processAbnormalCount);
      return [
        { id: 'operations.registry', status: result.integrity && result.foreignKeys && result.permissions ? 'pass' : 'fail', summary: result.integrity && result.foreignKeys && result.permissions ? 'Operation registry integrity, foreign keys, and permissions are valid.' : 'Operation registry integrity, foreign keys, or permissions failed.' },
        { id: 'operations.recovery', status: result.recoveryComplete ? 'pass' : 'fail', summary: result.recoveryComplete ? 'Startup operation recovery is complete.' : 'Startup operation recovery is incomplete.' },
        { id: 'operations.processes', status: processFailed ? 'fail' : 'pass', summary: processFailed ? 'An authoritative or projected abnormal Kogg process requires attention.' : 'Authoritative and projected process inventories contain no abnormal process.', details: { activeCount: result.activeCount, stalledCount: result.stalledCount, residualCount: result.residualCount, projectedAbnormalCount: projection.processAbnormalCount } },
        { id: 'operations.cleanup', status: result.cleanupFailureCount ? 'fail' : 'pass', summary: result.cleanupFailureCount ? 'One or more operations lack proved cleanup.' : 'Operation cleanup records are complete.', details: { cleanupFailureCount: result.cleanupFailureCount } },
        { id: 'operations.admission', status: result.admission === 'enabled' ? 'pass' : 'fail', summary: result.admission === 'enabled' ? 'Operation admission is enabled.' : 'Operation admission is blocked by recovery or cleanup state.' }
      ];
    } catch (error) {
      console.error('[kogg:operations:diagnostics] diagnose.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return ['registry', 'recovery', 'processes', 'cleanup', 'admission'].map(id => ({ id: `operations.${id}`, status: 'fail' as const, summary: 'Operation diagnostics could not run.' }));
    }
  }
}
