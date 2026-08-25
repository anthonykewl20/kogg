import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { KernelBridgeToken } from '@kogg/contracts';
import { KernelBackendContribution } from './kernel-backend-contribution';
import { KernelBridgeImpl } from './kernel-bridge';

export default new ContainerModule(bind => {
  bind(KernelBridgeImpl).toSelf().inSingletonScope();
  bind(KernelBridgeToken).toService(KernelBridgeImpl);
  bind(KernelBackendContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(KernelBackendContribution);
});
