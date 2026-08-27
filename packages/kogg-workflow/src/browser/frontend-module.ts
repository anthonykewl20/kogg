import { WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggWorkflowService, KoggWorkflowServicePath } from '../common/workflow-protocol';
import { WorkflowEditorContribution } from './workflow-editor-contribution';
import { WorkflowEditorWidget } from './workflow-editor-widget';

// diagnostic-coverage: workflow.accessibility, workflow.source-maps

export default new ContainerModule(bind => {
  bind(KoggWorkflowService).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, KoggWorkflowServicePath)).inSingletonScope();
  bind(WorkflowEditorWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({ id: WorkflowEditorWidget.ID, createWidget: () => context.container.get(WorkflowEditorWidget) })).inSingletonScope();
  bindViewContribution(bind, WorkflowEditorContribution);
});
