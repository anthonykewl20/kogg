import { CommandContribution } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggFrontendContribution } from './kogg-frontend-contribution';

export default new ContainerModule(bind => {
  bind(KoggFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(KoggFrontendContribution);
  bind(CommandContribution).toService(KoggFrontendContribution);
});
