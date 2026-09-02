import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { injectable } from '@theia/core/shared/inversify';
import { AgentsWidget } from './agents-widget';

// diagnostic-coverage: agents.source-maps
// observability-exempt: Declarative view registration has no fallible operational boundary.

@injectable()
export class AgentsContribution extends AbstractViewContribution<AgentsWidget> {
  constructor() { super({ widgetId: AgentsWidget.ID, widgetName: AgentsWidget.LABEL, defaultWidgetOptions: { area: 'main', rank: 120 }, toggleCommandId: 'kogg.agents.open' }); }
}
