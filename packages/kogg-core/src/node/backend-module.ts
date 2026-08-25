import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ContainerModule } from '@theia/core/shared/inversify';
import { BrowserAuthContribution } from './browser-auth-contribution';

export default new ContainerModule(bind => {
  bind(BrowserAuthContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(BrowserAuthContribution);
});
