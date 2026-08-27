import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { OperationRegistry } from './operation-registry';
import { OperationsReadModel } from './operations-read-model';

// diagnostic-coverage: operations.owners, operations.projection, operations.processes
// observability-exempt: Wiring delegates publication and ingestion lifecycle to the observable owner and projection implementations.

@injectable()
export class OperationsOwnerWiring implements BackendApplicationContribution {
  constructor(@inject(OperationRegistry) private readonly registry: OperationRegistry,
    @inject(OperationsReadModel) private readonly projection: OperationsReadModel) {}
  onStart(): void { this.projection.registerOwner('operation'); this.registry.setOwnerSink(this.projection); this.registry.publishOwnerEvents(); }
  onStop(): void { this.registry.setOwnerSink(undefined); }
}
