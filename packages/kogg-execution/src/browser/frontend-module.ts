import { WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggExecutionService, KoggExecutionServicePath } from '../common/execution-protocol';
import { ExecutionContribution } from './execution-contribution';
import { ExecutionWidget } from './execution-widget';

// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.source-maps
export default new ContainerModule(bind => {
  bind(KoggExecutionService).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, KoggExecutionServicePath)).inSingletonScope();
  bind(ExecutionWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({ id: ExecutionWidget.ID, createWidget: () => context.container.get(ExecutionWidget) })).inSingletonScope();
  bindViewContribution(bind, ExecutionContribution);
});
