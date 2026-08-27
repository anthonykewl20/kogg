import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggOperationsOwnerSink, type OperationsOwnerSink } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { ProjectRegistry } from './project-registry';

// diagnostic-coverage: operations.owners, operations.projection, projects.registry, projects.restoration
// observability-exempt: Wiring delegates owner publication and projection ingestion to their observable implementations.

@injectable()
export class ProjectOperationsOwnerWiring implements BackendApplicationContribution {
  constructor(@inject(ProjectRegistry) private readonly registry: ProjectRegistry,
    @inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink) {}
  onStart(): void { this.sink.registerOwner('project'); this.registry.setOwnerSink(this.sink); }
  onStop(): void { this.registry.setOwnerSink(undefined); }
}
