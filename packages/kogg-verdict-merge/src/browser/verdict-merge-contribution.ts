import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { injectable } from '@theia/core/shared/inversify';
import { VerdictMergeWidget } from './verdict-merge-widget';

// observability-exempt: Declarative view registration has no fallible runtime boundary.
// diagnostic-coverage: merge.authorization, merge.source-maps
@injectable()
export class VerdictMergeContribution extends AbstractViewContribution<VerdictMergeWidget> implements FrontendApplicationContribution {
  constructor() { super({ widgetId: VerdictMergeWidget.ID, widgetName: VerdictMergeWidget.LABEL, defaultWidgetOptions: { area: 'left', rank: 115 }, toggleCommandId: 'kogg.verdict-merge.open' }); }
  onStart(): void {}
}
