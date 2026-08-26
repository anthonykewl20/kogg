import { WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { WorkflowPrototypeService, WorkflowPrototypeServicePath } from '../common/workflow-prototype-protocol';
import { WorkflowPrototypeContribution } from './workflow-prototype-contribution';
import { WorkflowPrototypeWidget } from './workflow-prototype-widget';

// diagnostic-exempt: Disposable prototype RPC/view wiring.
export default new ContainerModule(bind => {
  bind(WorkflowPrototypeService).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, WorkflowPrototypeServicePath)).inSingletonScope();
  bind(WorkflowPrototypeWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({ id: WorkflowPrototypeWidget.ID, createWidget: () => context.container.get(WorkflowPrototypeWidget) })).inSingletonScope();
  bindViewContribution(bind, WorkflowPrototypeContribution);
});
