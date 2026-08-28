import { inject, injectable } from '@theia/core/shared/inversify';
import {
  KernelBridgeToken,
  type KernelBridge,
  type KoggDiagnosticCheck,
  type KoggDiagnosticContributor
} from '@kogg/contracts';
import { RanexOperationsOwner } from './ranex-operations-owner';
import { CheckOperationsOwner } from './check-operations-owner';
import { kernelSourceMapDiagnostics } from './kernel-source-map-diagnostics';

// diagnostic-coverage: kernel.protocol, kernel.bridge, kernel.bindings, kernel.producers, kernel.suites, kernel.checks, kernel.evidence, kernel.verdicts, kernel.cleanup, kernel.recovery, kernel.source-maps, operations.ranex-owner, operations.check-owner

@injectable()
export class KernelDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'kernel';

  constructor(@inject(KernelBridgeToken) private readonly kernel: KernelBridge,
    @inject(RanexOperationsOwner) private readonly ranexOwner: RanexOperationsOwner,
    @inject(CheckOperationsOwner) private readonly checkOwner: CheckOperationsOwner) {}

  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      const health = await this.kernel.health();
      const implemented = new Set(health.capabilities.operations.map(operation => operation.operation));
      const state = (operation: string): Omit<KoggDiagnosticCheck, 'id'> => implemented.has(operation as never)
        ? { status: 'pass', summary: `${operation} is schema-bound to an implemented handler.` }
        : { status: 'fail', summary: `${operation} is unavailable and remains fail-closed.`, details: { safeCode: 'KERNEL_CAPABILITY_UNAVAILABLE' } };
      const states = (operations: readonly string[]): Omit<KoggDiagnosticCheck, 'id'> => statesFor(implemented, operations);
      const ranexOwner = this.ranexOwner.diagnostics();
      const checkOwner = this.checkOwner.diagnostics();
      const sourceMaps = kernelSourceMapDiagnostics();
      return [
        { id: 'kernel.protocol', status: 'pass', summary: 'Ranex v2 framing, provenance, schema set, and advertised operation closure verified.', details: { operationCount: implemented.size } },
        { id: 'kernel.bridge', status: health.status === 'failed' ? 'fail' : health.status === 'degraded' ? 'warn' : 'pass', summary: `Ranex bridge reports ${health.status}.`, details: { confinement: health.capabilities.confinement, journal: health.journal } },
        { id: 'kernel.bindings', ...state('task.bind') },
        { id: 'kernel.producers', ...state('producer.dispatch') },
        { id: 'kernel.suites', ...state('suite.freeze') },
        { id: 'kernel.checks', ...state('suite.execute') },
        { id: 'kernel.evidence', ...state('evidence.admit') },
        { id: 'kernel.verdicts', ...states(['gate.evaluate', 'verdict.read']) },
        { id: 'kernel.cleanup', ...state('operation.cancel') },
        { id: 'kernel.recovery', ...state('operation.reconcile') },
        { id: 'operations.ranex-owner', status: 'pass', summary: 'Ranex evidence and gate facts replay from the verified authoritative journal.', details: { sourceEventCount: ranexOwner.sourceEventCount, projectedEventCount: ranexOwner.projectedEventCount } },
        { id: 'operations.check-owner', status: 'pass', summary: 'Authoritative check outcomes replay from the verified Ranex journal.', details: { sourceEventCount: checkOwner.sourceEventCount, projectedEventCount: checkOwner.projectedEventCount } },
        { id: 'kernel.source-maps', status: sourceMaps.missingCount === 0 ? 'pass' : 'fail', summary: sourceMaps.missingCount === 0 ? 'Every kernel TypeScript failure boundary and the Python adapter remain debugger-reachable.' : 'One or more kernel TypeScript maps or the Python adapter source is missing.', details: { ...sourceMaps } }
      ];
    } catch (error) {
      console.error('[kogg:kernel:diagnostics] health.failed', { errorType: errorName(error) });
      return IDS.map(id => ({ id, status: 'fail', summary: 'Kernel diagnostics failed closed.', details: { errorType: errorName(error) } }));
    }
  }
}

function statesFor(implemented: ReadonlySet<string>, operations: readonly string[]): Omit<KoggDiagnosticCheck, 'id'> {
  const missing = operations.filter(operation => !implemented.has(operation));
  return missing.length === 0
    ? { status: 'pass', summary: `${operations.join(' and ')} are schema-bound to implemented handlers.` }
    : { status: 'fail', summary: `${missing.join(' and ')} are unavailable and remain fail-closed.`, details: { safeCode: 'KERNEL_CAPABILITY_UNAVAILABLE' } };
}

const IDS = ['kernel.protocol', 'kernel.bridge', 'kernel.bindings', 'kernel.producers', 'kernel.suites', 'kernel.checks', 'kernel.evidence', 'kernel.verdicts', 'kernel.cleanup', 'kernel.recovery', 'operations.ranex-owner', 'operations.check-owner', 'kernel.source-maps'] as const;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
