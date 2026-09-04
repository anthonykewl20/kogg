import { injectable } from '@theia/core/shared/inversify';
import type { ChatStreamEvent, KoggProviderChatClient } from '../common/provider-service';

// diagnostic-coverage: providers.registry
// observability-exempt: Local callback fan-out for chat stream deltas; the
// backend request promise remains the authoritative terminal signal.

@injectable()
export class ProviderChatClient implements KoggProviderChatClient {
    private readonly listeners = new Set<(event: ChatStreamEvent) => void>();

    onChatEvent(event: ChatStreamEvent): void { for (const listener of [...this.listeners]) listener(event); }

    listen(listener: (event: ChatStreamEvent) => void): void {
        this.listeners.add(listener);
    }

    unlisten(listener: (event: ChatStreamEvent) => void): void {
        this.listeners.delete(listener);
    }
}
