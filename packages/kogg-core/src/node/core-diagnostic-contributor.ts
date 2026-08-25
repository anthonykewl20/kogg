import os from 'node:os';
import { injectable } from '@theia/core/shared/inversify';
import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';

// diagnostic-coverage: core.runtime, core.browser-auth

@injectable()
export class CoreDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'core';

  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    console.debug('[kogg:core:diagnostics] core-checks.started');
    const runtime = process.env.KOGG_RUNTIME ?? 'unknown';
    const authConfigured = runtime !== 'browser' || Boolean(process.env.KOGG_AUTH_TOKEN);
    return [
      {
        id: 'core.runtime',
        status: runtime === 'browser' || runtime === 'electron' ? 'pass' : 'warn',
        summary: runtime === 'browser' || runtime === 'electron' ? `Kogg ${runtime} runtime is active.` : 'Kogg runtime mode is not declared.',
        details: { runtime, platform: process.platform, architecture: process.arch, node: process.version, cpuCount: os.cpus().length }
      },
      {
        id: 'core.browser-auth',
        status: authConfigured ? 'pass' : 'fail',
        summary: authConfigured ? 'Browser authentication configuration is present.' : 'Browser mode requires its access key.'
      }
    ];
  }
}
