import { KoggOperationsOwnerSink, type OperationsOwnerSink } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { MergeAuthorizationRegistry } from './merge-authorization-registry';

// diagnostic-coverage: operations.owners, operations.projection, merge.authorization, merge.atomicity, merge.recovery
// observability-exempt: Wiring delegates publication and ingestion lifecycle to the observable merge owner and Operations projection.
@injectable()
export class MergeOperationsOwnerWiring implements BackendApplicationContribution {
  constructor(@inject(MergeAuthorizationRegistry) private readonly registry: MergeAuthorizationRegistry,
    @inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink) {}
  onStart(): void { this.sink.registerOwner('merge'); this.registry.setOwnerSink(this.sink); }
  onStop(): void { this.registry.setOwnerSink(undefined); }
}
