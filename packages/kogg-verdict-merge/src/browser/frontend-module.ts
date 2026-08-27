import { FrontendApplicationContribution, WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggVerdictMergeServicePath, KoggVerdictMergeServiceToken } from '../common/verdict-merge-protocol';
import { VerdictMergeContribution } from './verdict-merge-contribution';
import { VerdictMergeWidget } from './verdict-merge-widget';

export default new ContainerModule(bind => {
  bind(KoggVerdictMergeServiceToken).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, KoggVerdictMergeServicePath)).inSingletonScope();
  bind(VerdictMergeWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({ id: VerdictMergeWidget.ID, createWidget: () => context.container.get(VerdictMergeWidget) })).inSingletonScope();
  bindViewContribution(bind, VerdictMergeContribution); bind(FrontendApplicationContribution).toService(VerdictMergeContribution);
});
