import { KoggOperationsOwnerSink, type OperationsOwnerSink } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkflowRegistry } from './workflow-registry';

// diagnostic-coverage: operations.owners, operations.projection, workflow.scheduler, workflow.recovery
// observability-exempt: Wiring delegates publication and ingestion lifecycle to the observable owner and projection implementations.
@injectable()
export class WorkflowOperationsOwnerWiring implements BackendApplicationContribution {
  constructor(@inject(WorkflowRegistry) private readonly registry: WorkflowRegistry,
    @inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink) {}
  onStart(): void { this.sink.registerOwner('workflow'); this.registry.setOwnerSink(this.sink); }
  onStop(): void { this.registry.setOwnerSink(undefined); }
}
