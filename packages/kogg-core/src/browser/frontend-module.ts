import '../../src/browser/styles/kogg.css';
import { CommandContribution } from '@theia/core';
import { FrontendApplicationContribution, WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import {
  KoggDiagnosticsServicePath,
  KoggDiagnosticsServiceToken,
  type KoggDiagnosticsService
} from '../common/diagnostics-service';
import { KoggFrontendContribution } from './kogg-frontend-contribution';

export default new ContainerModule(bind => {
  bind(KoggDiagnosticsServiceToken).toDynamicValue(context => context.container
    .get(WebSocketConnectionProvider)
    .createProxy<KoggDiagnosticsService>(KoggDiagnosticsServicePath)).inSingletonScope();
  bind(KoggFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(KoggFrontendContribution);
  bind(CommandContribution).toService(KoggFrontendContribution);
});
