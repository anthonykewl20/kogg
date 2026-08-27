import { KoggOperationsOwnerSink, type OperationsOwnerSink } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { VerdictMergeService } from './verdict-merge-service';

// diagnostic-coverage: operations.owners, operations.projection, verdict.provenance, verdict.currentness
// observability-exempt: Wiring delegates publication and ingestion lifecycle to the observable verdict owner and Operations projection.
@injectable()
export class VerdictOperationsOwnerWiring implements BackendApplicationContribution {
  constructor(@inject(VerdictMergeService) private readonly service: VerdictMergeService,
    @inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink) {}
  onStart(): void { this.sink.registerOwner('verdict'); this.service.setOwnerSink(this.sink); }
  onStop(): void { this.service.setOwnerSink(undefined); }
}
