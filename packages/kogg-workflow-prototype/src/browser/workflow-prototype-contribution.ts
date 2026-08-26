import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { injectable } from '@theia/core/shared/inversify';
import { WorkflowPrototypeWidget } from './workflow-prototype-widget';

// diagnostic-exempt: Disposable prototype view declaration.
// observability-exempt: Pure Theia view-registration glue; the widget owns interactive lifecycle logging.
@injectable()
export class WorkflowPrototypeContribution extends AbstractViewContribution<WorkflowPrototypeWidget> {
  constructor() { super({ widgetId: WorkflowPrototypeWidget.ID, widgetName: WorkflowPrototypeWidget.LABEL, defaultWidgetOptions: { area: 'left', rank: 115 }, toggleCommandId: 'kogg.workflow-prototype.open' }); }
}
