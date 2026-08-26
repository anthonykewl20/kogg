import { WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggTasksService, KoggTasksServicePath } from '../common/tasks-protocol';
import { TasksContribution } from './tasks-contribution';
import { TasksWidget } from './tasks-widget';
import { InteractionModesService, InteractionModesServicePath } from '../common/interaction-modes-protocol';

export default new ContainerModule(bind => {
  bind(KoggTasksService).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, KoggTasksServicePath)).inSingletonScope();
  bind(InteractionModesService).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, InteractionModesServicePath)).inSingletonScope();
  bind(TasksWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({ id: TasksWidget.ID, createWidget: () => context.container.get(TasksWidget) })).inSingletonScope();
  bindViewContribution(bind, TasksContribution);
});
