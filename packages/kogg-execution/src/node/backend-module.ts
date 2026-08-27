import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { ExecutionTargetBindingAuthority, KoggExecutionServicePath, type KoggExecutionService } from '../common/execution-protocol';
import { KoggAgentWorkspaceAuthority } from '@kogg/agents/lib/common/agents-protocol';
import { KoggOperationRegistry } from '@kogg/operations/lib/common/operations-protocol';
import { AgentWorkspaceController } from './agent-workspace-controller';
import { ExecutionAllocationRegistry } from './execution-allocation-registry';
import { ExecutionDiagnosticContributor } from './execution-diagnostic-contributor';
import { ExecutionService } from './execution-service';
import { ExecutionTargetRegistry } from './execution-target-registry';
import { ExecutionOperationsOwnerWiring } from './execution-operations-owner-wiring';
import { NativeAllocationController } from './native-allocation-controller';
import { ProductionPrivateGitSeeder } from './production-private-git-seeder';
import { ProductionCandidateLifecycle } from './production-candidate-lifecycle';

// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.git-independence, execution.source-integrity, execution.process-cleanup, execution.capacity, execution.recovery, execution.retention, execution.source-maps
export default new ContainerModule(bind => {
  bind(ExecutionAllocationRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(ExecutionAllocationRegistry);
  bind(ExecutionOperationsOwnerWiring).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(ExecutionOperationsOwnerWiring);
  bind(ExecutionTargetRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(ExecutionTargetRegistry);
  bind(ExecutionTargetBindingAuthority).toService(ExecutionTargetRegistry);
  bind(NativeAllocationController).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(NativeAllocationController);
  bind(ProductionPrivateGitSeeder).toDynamicValue(context => new ProductionPrivateGitSeeder(context.container.get(KoggOperationRegistry))).inSingletonScope();
  bind(ProductionCandidateLifecycle).toSelf().inSingletonScope();
  bind(AgentWorkspaceController).toSelf().inSingletonScope(); bind(KoggAgentWorkspaceAuthority).toService(AgentWorkspaceController);
  bind(ExecutionDiagnosticContributor).toSelf().inSingletonScope(); bind(KoggDiagnosticContribution).toService(ExecutionDiagnosticContributor);
  bind(ExecutionService).toSelf().inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggExecutionService>(
    KoggExecutionServicePath,
    () => context.container.get(ExecutionService)
  )).inSingletonScope();
});
