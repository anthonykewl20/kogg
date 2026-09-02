import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplication } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { KoggProviderWidget } from './provider-widget';

// observability-exempt: This class contains declarative view registration only; provider operations are logged by KoggProviderWidget.
// diagnostic-exempt: Declarative view registration has no independent runtime state; provider widget and backend checks cover behavior.

@injectable()
export class KoggProviderContribution extends AbstractViewContribution<KoggProviderWidget> {
    constructor() {
        super({
            widgetId: KoggProviderWidget.ID,
            widgetName: KoggProviderWidget.LABEL,
            defaultWidgetOptions: { area: 'right', rank: 400 },
            toggleCommandId: 'kogg.ai.open'
        });
    }

    async initializeLayout(_application: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: true });
    }
}
