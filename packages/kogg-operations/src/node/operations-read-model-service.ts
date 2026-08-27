import { inject, injectable } from '@theia/core/shared/inversify';
import type { KoggOperationsReadModelClient, KoggOperationsReadModelService, OperationsRunQueryV1 } from '../common/operations-read-model-protocol';
import { OperationsReadModel } from './operations-read-model';
import { OperationsSupportExporter } from './operations-support-export';
import { OperationsActionRouter } from './operations-action-router';

// diagnostic-coverage: operations.projection, operations.timeline, operations.stream, operations.metrics, operations.support
// observability-exempt: This typed RPC facade delegates every operational boundary to its observable owning service.

@injectable()
export class OperationsReadModelService implements KoggOperationsReadModelService {
  constructor(@inject(OperationsReadModel) private readonly projection: OperationsReadModel,
    @inject(OperationsSupportExporter) private readonly support: OperationsSupportExporter,
    @inject(OperationsActionRouter) private readonly actions: OperationsActionRouter) {}
  connect(client: KoggOperationsReadModelClient): KoggOperationsReadModelService {
    const dispose = this.projection.addClient(client);
    const connected = client as KoggOperationsReadModelClient & { onDidCloseConnection?: (listener: () => void) => { dispose(): void } };
    connected.onDidCloseConnection?.(dispose);
    return this;
  }
  projectionSnapshot() { return this.projection.snapshot(); }
  listRuns(query: OperationsRunQueryV1) { return this.projection.listRuns(query); }
  timelinePage(runId: string, cursor?: string, limit?: number) { return this.projection.timelinePage(runId, cursor, limit); }
  metricsSnapshot() { return this.projection.metrics(); }
  subscribe(cursor?: string) { return this.projection.subscribe(cursor); }
  exportSupport(request: Parameters<OperationsSupportExporter['export']>[0]) { return this.support.export(request); }
  readSupportExport(exportId: string) { return this.support.read(exportId); }
  requestAction(request: Parameters<OperationsActionRouter['request']>[0]) { return this.actions.request(request); }
}
