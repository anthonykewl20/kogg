import { KoggOperationsOwnerSink, type OperationsOwnerSink } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AgentRegistry } from './agent-registry';

// diagnostic-coverage: operations.owners, operations.projection, agents.attempts, agents.recovery
// observability-exempt: Wiring delegates publication and ingestion to observable owners.
@injectable()
export class AgentOperationsOwnerWiring implements BackendApplicationContribution {
  constructor(
    @inject(AgentRegistry) private readonly registry: AgentRegistry,
    @inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink
  ) {}

  onStart(): void {
    this.sink.registerOwner('adapter');
    this.registry.setOwnerSink(this.sink);
  }

  onStop(): void {
    this.registry.setOwnerSink(undefined);
  }
}
