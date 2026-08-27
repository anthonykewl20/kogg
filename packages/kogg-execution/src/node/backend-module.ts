import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ContainerModule } from '@theia/core/shared/inversify';
import { ExecutionDiagnosticContributor } from './execution-diagnostic-contributor';
import { ExecutionTargetRegistry } from './execution-target-registry';

// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.git-independence, execution.source-integrity, execution.process-cleanup, execution.capacity, execution.recovery, execution.source-maps
export default new ContainerModule(bind => {
  bind(ExecutionTargetRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(ExecutionTargetRegistry);
  bind(ExecutionDiagnosticContributor).toSelf().inSingletonScope(); bind(KoggDiagnosticContribution).toService(ExecutionDiagnosticContributor);
});
