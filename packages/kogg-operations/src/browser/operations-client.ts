import { injectable } from '@theia/core/shared/inversify';
import type { KoggOperationsClient, OperationsSnapshot } from '../common/operations-protocol';
import type { KoggOperationsReadModelClient, OperationsProjectionChangeV1 } from '../common/operations-read-model-protocol';

// diagnostic-coverage: operations.processes, operations.admission
// observability-exempt: This callback fan-out contains no operational boundary or fallible state change.

@injectable()
export class OperationsClient implements KoggOperationsClient, KoggOperationsReadModelClient {
  private readonly listeners = new Set<(snapshot: OperationsSnapshot) => void>();
  private readonly projectionListeners = new Set<(change: OperationsProjectionChangeV1) => void>();
  changed(snapshot: OperationsSnapshot): void { for (const listener of this.listeners) listener(snapshot); }
  listen(listener: (snapshot: OperationsSnapshot) => void): void { this.listeners.add(listener); }
  projectionChanged(change: OperationsProjectionChangeV1): void { for (const listener of this.projectionListeners) listener(change); }
  listenProjection(listener: (change: OperationsProjectionChangeV1) => void): void { this.projectionListeners.add(listener); }
}
