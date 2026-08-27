import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  ExecutionQualificationProjection, ExecutionRunListV1, ExecutionRunProjectionV1, GetExecutionQualificationV1,
  GetExecutionRunV1, KoggExecutionService, ListExecutionRunsV1
} from '../common/execution-protocol';
import { ExecutionAllocationRegistry } from './execution-allocation-registry';
import { executionLog } from './execution-logger';
import { ExecutionTargetRegistry } from './execution-target-registry';

// The public execution boundary exposes only closed qualification and path-free run projections; mutation inputs remain backend-owned.
// executionLog routes every service lifecycle event through [kogg:execution:service].
// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.source-maps
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

@injectable()
export class ExecutionService implements KoggExecutionService {
  constructor(@inject(ExecutionAllocationRegistry) private readonly allocations: Pick<ExecutionAllocationRegistry, 'getRun' | 'listRuns'>,
    @inject(ExecutionTargetRegistry) private readonly targets: Pick<ExecutionTargetRegistry, 'projection'>) {}

  async qualification(request: GetExecutionQualificationV1): Promise<ExecutionQualificationProjection> {
    if (!request || Object.keys(request).join(',') !== 'requestId' || !UUID.test(request.requestId)) {
      executionLog('service.qualification.refused', { eventVersion: 1, safeCode: 'QUALIFICATION_PROTOCOL_INVALID' });
      throw new ExecutionServiceError('QUALIFICATION_PROTOCOL_INVALID');
    }
    executionLog('service.qualification.requested', { eventVersion: 1, requestId: request.requestId });
    const projection = this.targets.projection();
    executionLog('service.qualification.completed', { eventVersion: 1, requestId: request.requestId, targetId: projection.targetId, safeCode: projection.safeCode });
    return projection;
  }

  getRun(request: GetExecutionRunV1): Promise<ExecutionRunProjectionV1 | undefined> { return this.allocations.getRun(request); }
  listRuns(request: ListExecutionRunsV1): Promise<ExecutionRunListV1> { return this.allocations.listRuns(request); }
}

export class ExecutionServiceError extends Error {
  constructor(readonly code: 'QUALIFICATION_PROTOCOL_INVALID') { super(code); this.name = 'ExecutionServiceError'; }
}
