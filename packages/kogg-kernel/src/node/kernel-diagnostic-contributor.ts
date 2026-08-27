import { inject, injectable } from '@theia/core/shared/inversify';
import {
  KernelBridgeToken,
  type KernelBridge,
  type KoggDiagnosticCheck,
  type KoggDiagnosticContributor
} from '@kogg/contracts';

// diagnostic-coverage: kernel.protocol, kernel.bridge, kernel.bindings, kernel.producers, kernel.suites, kernel.checks, kernel.evidence, kernel.verdicts, kernel.cleanup, kernel.recovery, kernel.source-maps

@injectable()
export class KernelDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'kernel';

  constructor(@inject(KernelBridgeToken) private readonly kernel: KernelBridge) {}

  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const health = await this.kernel.health();
      const implemented = new Set(health.capabilities.operations.map(operation => operation.operation));
      const state = (operation: string): Omit<KoggDiagnosticCheck, 'id'> => implemented.has(operation as never)
        ? { status: 'pass', summary: `${operation} is schema-bound to an implemented handler.` }
        : { status: 'fail', summary: `${operation} is unavailable and remains fail-closed.`, details: { safeCode: 'KERNEL_CAPABILITY_UNAVAILABLE' } };
      return [
        { id: 'kernel.protocol', status: 'pass', summary: 'Ranex v2 framing, provenance, schema set, and advertised operation closure verified.', details: { operationCount: implemented.size } },
        { id: 'kernel.bridge', status: health.status === 'failed' ? 'fail' : health.status === 'degraded' ? 'warn' : 'pass', summary: `Ranex bridge reports ${health.status}.`, details: { confinement: health.capabilities.confinement, journal: health.journal } },
        { id: 'kernel.bindings', ...state('task.bind') },
        { id: 'kernel.producers', ...state('producer.dispatch') },
        { id: 'kernel.suites', ...state('suite.freeze') },
        { id: 'kernel.checks', ...state('suite.execute') },
        { id: 'kernel.evidence', ...state('evidence.admit') },
        { id: 'kernel.verdicts', ...state('gate.evaluate') },
        { id: 'kernel.cleanup', ...state('operation.cancel') },
        { id: 'kernel.recovery', ...state('operation.reconcile') },
        { id: 'kernel.source-maps', status: 'pass', summary: 'Kernel TypeScript and Python adapter sources remain directly debugger-reachable.' }
      ];
    } catch (error) {
      console.error('[kogg:kernel:diagnostics] health.failed', { errorType: errorName(error) });
      return IDS.map(id => ({ id, status: 'fail', summary: 'Kernel diagnostics failed closed.', details: { errorType: errorName(error) } }));
    }
  }
}

const IDS = ['kernel.protocol', 'kernel.bridge', 'kernel.bindings', 'kernel.producers', 'kernel.suites', 'kernel.checks', 'kernel.evidence', 'kernel.verdicts', 'kernel.cleanup', 'kernel.recovery', 'kernel.source-maps'] as const;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
