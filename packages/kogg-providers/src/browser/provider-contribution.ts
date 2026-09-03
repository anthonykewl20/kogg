import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, StatusBar, StatusBarAlignment } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { KoggProviderWidget } from './provider-widget';

const CHAT_STATUS_ID = 'kogg.ai.chat-toggle';

// observability-exempt: Status-bar registration and startup reveal are declarative workbench wiring; provider operations are logged by KoggProviderWidget.
// diagnostic-exempt: Declarative view registration has no independent runtime state; provider widget and backend checks cover behavior.

@injectable()
export class KoggProviderContribution extends AbstractViewContribution<KoggProviderWidget> implements FrontendApplicationContribution {
    constructor(
        @inject(StatusBar) private readonly statusBar: StatusBar
    ) {
        super({
            widgetId: KoggProviderWidget.ID,
            widgetName: KoggProviderWidget.LABEL,
            defaultWidgetOptions: { area: 'right', rank: 400 },
            toggleCommandId: 'kogg.ai.open'
        });
    }

    // onStart runs before the shell layout initializes; StatusBar.setElement
    // internally waits for 'initialized_layout', so every await here must be
    // fire-and-forget or startup deadlocks.
    onStart(): void {
        void this.initializeChatEntryPoints();
    }

    private async initializeChatEntryPoints(): Promise<void> {
        try {
            await this.statusBar.setElement(CHAT_STATUS_ID, {
                text: '$(comment-discussion) Kogg AI',
                name: 'Kogg AI chat',
                alignment: StatusBarAlignment.RIGHT,
                priority: 600,
                command: 'kogg.ai.open',
                tooltip: 'Toggle the Kogg AI chat panel',
                accessibilityInformation: { label: 'Toggle Kogg AI chat panel' }
            });
            // The chat entry point must survive restored layouts: initializeLayout
            // only runs when no layout is stored, so reopen the panel once the
            // workbench is ready on every start. A user who closed the panel in a
            // previous session gets it back; closing it mid-session is respected.
            const widget = this.tryGetWidget();
            if (!widget || !widget.isVisible) await this.openView({ activate: false, reveal: true });
            console.debug('[kogg:providers:contribution] chat-entry.ready');
        } catch (error) {
            console.error('[kogg:providers:contribution] chat-entry.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
        }
    }

    onStop(): void {
        void this.statusBar.removeElement(CHAT_STATUS_ID);
    }
}
