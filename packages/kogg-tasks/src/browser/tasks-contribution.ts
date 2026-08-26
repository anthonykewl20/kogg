import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { injectable } from '@theia/core/shared/inversify';
import { TasksWidget } from './tasks-widget';

// diagnostic-coverage: tasks.registry
// observability-exempt: This declarative view contribution performs no fallible operational work; task mutations are logged by the widget and backend registry.

@injectable()
export class TasksContribution extends AbstractViewContribution<TasksWidget> {
  constructor() { super({ widgetId: TasksWidget.ID, widgetName: TasksWidget.LABEL, defaultWidgetOptions: { area: 'left', rank: 110 }, toggleCommandId: 'kogg.tasks.open' }); }
}
