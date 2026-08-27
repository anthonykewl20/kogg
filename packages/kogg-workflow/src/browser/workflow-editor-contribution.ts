import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { injectable } from '@theia/core/shared/inversify';
import { WorkflowEditorWidget } from './workflow-editor-widget';

// diagnostic-coverage: workflow.accessibility
// observability-exempt: Declarative view registration has no operational lifecycle; the widget and registry own observable actions.

@injectable()
export class WorkflowEditorContribution extends AbstractViewContribution<WorkflowEditorWidget> {
  constructor() { super({ widgetId: WorkflowEditorWidget.ID, widgetName: WorkflowEditorWidget.LABEL, defaultWidgetOptions: { area: 'main', rank: 240 }, toggleCommandId: 'kogg.workflow.open' }); }
}
