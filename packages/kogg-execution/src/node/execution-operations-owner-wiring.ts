import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggOperationsOwnerSink, type OperationsOwnerSink } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { ExecutionAllocationRegistry } from './execution-allocation-registry';

// diagnostic-coverage: operations.owners, operations.projection, execution.worktree-registry, execution.recovery
// observability-exempt: Wiring delegates publication and ingestion lifecycle to the observable owner and projection implementations.
@injectable()
export class ExecutionOperationsOwnerWiring implements BackendApplicationContribution {
  constructor(@inject(ExecutionAllocationRegistry) private readonly registry: ExecutionAllocationRegistry,
    @inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink) {}
  onStart(): void { this.sink.registerOwner('execution'); this.registry.setOwnerSink(this.sink); }
  onStop(): void { this.registry.setOwnerSink(undefined); }
}
