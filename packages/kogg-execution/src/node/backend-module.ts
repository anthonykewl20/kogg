import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggExecutionServicePath, type KoggExecutionService } from '../common/execution-protocol';
import { ExecutionAllocationRegistry } from './execution-allocation-registry';
import { ExecutionDiagnosticContributor } from './execution-diagnostic-contributor';
import { ExecutionService } from './execution-service';
import { ExecutionTargetRegistry } from './execution-target-registry';

// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.git-independence, execution.source-integrity, execution.process-cleanup, execution.capacity, execution.recovery, execution.source-maps
export default new ContainerModule(bind => {
  bind(ExecutionAllocationRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(ExecutionAllocationRegistry);
  bind(ExecutionTargetRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(ExecutionTargetRegistry);
  bind(ExecutionDiagnosticContributor).toSelf().inSingletonScope(); bind(KoggDiagnosticContribution).toService(ExecutionDiagnosticContributor);
  bind(ExecutionService).toSelf().inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggExecutionService>(
    KoggExecutionServicePath,
    () => context.container.get(ExecutionService)
  )).inSingletonScope();
});
