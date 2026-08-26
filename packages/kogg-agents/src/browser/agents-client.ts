import { injectable } from '@theia/core/shared/inversify';
import type { AgentRegistrySnapshot, KoggAgentsClient } from '../common/agents-protocol';

// diagnostic-coverage: agents.attempts, agents.source-maps
// observability-exempt: This callback fan-out performs no operational mutation or fallible external call.

@injectable()
export class AgentsClient implements KoggAgentsClient {
  private readonly listeners = new Set<(snapshot: AgentRegistrySnapshot) => void>();
  changed(snapshot: AgentRegistrySnapshot): void { for (const listener of this.listeners) listener(snapshot); }
  listen(listener: (snapshot: AgentRegistrySnapshot) => void): void { this.listeners.add(listener); }
}
