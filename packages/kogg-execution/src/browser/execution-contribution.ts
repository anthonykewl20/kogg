import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { injectable } from '@theia/core/shared/inversify';
import { ExecutionWidget } from './execution-widget';

// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.source-maps
// observability-exempt: Declarative Theia view registration has no runtime lifecycle or failure boundary of its own.
@injectable()
export class ExecutionContribution extends AbstractViewContribution<ExecutionWidget> {
  constructor() {
    super({ widgetId: ExecutionWidget.ID, widgetName: ExecutionWidget.LABEL, defaultWidgetOptions: { area: 'left', rank: 120 }, toggleCommandId: 'kogg.execution.open' });
  }
}
