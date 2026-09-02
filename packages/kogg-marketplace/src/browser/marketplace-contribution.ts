import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { KoggMarketplaceWidget } from './marketplace-widget';

// observability-exempt: This class contains declarative view registration only; widget operations are logged by KoggMarketplaceWidget.
// diagnostic-exempt: Declarative view registration has no independent runtime state; marketplace widget and backend checks cover behavior.

@injectable()
export class KoggMarketplaceContribution extends AbstractViewContribution<KoggMarketplaceWidget> {
    constructor() {
        super({
            widgetId: KoggMarketplaceWidget.ID,
            widgetName: KoggMarketplaceWidget.LABEL,
            defaultWidgetOptions: { area: 'main', rank: 450 },
            toggleCommandId: 'kogg.marketplace.open'
        });
    }
}
