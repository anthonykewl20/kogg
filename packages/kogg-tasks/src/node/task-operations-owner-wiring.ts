import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggOperationsOwnerSink, type OperationsOwnerSink } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { TaskRegistry } from './task-registry';

// diagnostic-coverage: operations.owners, operations.projection, tasks.registry, tasks.revisions
// observability-exempt: Wiring delegates owner publication and projection ingestion to their observable implementations.

@injectable()
export class TaskOperationsOwnerWiring implements BackendApplicationContribution {
  constructor(@inject(TaskRegistry) private readonly registry: TaskRegistry,
    @inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink) {}
  onStart(): void { this.sink.registerOwner('task'); this.registry.setOwnerSink(this.sink); }
  onStop(): void { this.registry.setOwnerSink(undefined); }
}
