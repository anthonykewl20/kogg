import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { KoggDiagnosticContribution, KernelBridgeToken } from '@kogg/contracts';
import { KernelBackendContribution } from './kernel-backend-contribution';
import { KernelBridgeImpl } from './kernel-bridge';
import { KernelDiagnosticContributor } from './kernel-diagnostic-contributor';
import { KernelTaskBindingService } from './kernel-task-binding-service';

export default new ContainerModule(bind => {
  bind(KernelBridgeImpl).toSelf().inSingletonScope();
  bind(KernelBridgeToken).toService(KernelBridgeImpl);
  bind(KernelBackendContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(KernelBackendContribution);
  bind(KernelDiagnosticContributor).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(KernelDiagnosticContributor);
  bind(KernelTaskBindingService).toSelf().inSingletonScope();
});
