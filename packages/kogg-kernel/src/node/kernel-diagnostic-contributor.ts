import { inject, injectable } from '@theia/core/shared/inversify';
import {
  KernelBridgeToken,
  type KernelBridge,
  type KoggDiagnosticCheck,
  type KoggDiagnosticContributor
} from '@kogg/contracts';

// diagnostic-coverage: kernel.health, kernel.journal

@injectable()
export class KernelDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'kernel';

  constructor(@inject(KernelBridgeToken) private readonly kernel: KernelBridge) {}

  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    const checks: KoggDiagnosticCheck[] = [];
    try {
      const health = await this.kernel.health();
      checks.push({
        id: 'kernel.health',
        status: health.status === 'ready' ? 'pass' : health.status === 'degraded' ? 'warn' : 'fail',
        summary: `Ranex kernel reports ${health.status}.`,
        details: { confinement: health.capabilities.confinement, commandCount: health.capabilities.commands.length }
      });
    } catch (error) {
      console.error('[kogg:kernel:diagnostics] health.failed', { errorType: errorName(error) });
      checks.push({ id: 'kernel.health', status: 'fail', summary: 'Ranex kernel health request failed.', details: { errorType: errorName(error) } });
    }
    try {
      const journal = await this.kernel.verifyJournal();
      checks.push({
        id: 'kernel.journal',
        status: journal.valid ? 'pass' : 'fail',
        summary: journal.valid ? 'Ranex journal verification passed.' : 'Ranex journal verification failed.'
      });
    } catch (error) {
      console.error('[kogg:kernel:diagnostics] journal.failed', { errorType: errorName(error) });
      checks.push({ id: 'kernel.journal', status: 'fail', summary: 'Ranex journal verification could not run.', details: { errorType: errorName(error) } });
    }
    return checks;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
