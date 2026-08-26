import { injectable } from '@theia/core/shared/inversify';
import type { KoggOperationsClient, OperationsSnapshot } from '../common/operations-protocol';

// diagnostic-coverage: operations.processes, operations.admission
// observability-exempt: This callback fan-out contains no operational boundary or fallible state change.

@injectable()
export class OperationsClient implements KoggOperationsClient {
  private readonly listeners = new Set<(snapshot: OperationsSnapshot) => void>();
  changed(snapshot: OperationsSnapshot): void { for (const listener of this.listeners) listener(snapshot); }
  listen(listener: (snapshot: OperationsSnapshot) => void): void { this.listeners.add(listener); }
}
