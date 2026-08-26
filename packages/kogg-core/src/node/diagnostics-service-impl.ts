import { promises as fs } from 'node:fs';
import path from 'node:path';
import URI from '@theia/core/lib/common/uri';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import {
  KoggDiagnosticContribution,
  type DiagnosticStatus,
  type KoggDiagnosticCheck,
  type KoggDiagnosticContributor,
  type KoggDiagnosticReport,
  type KoggDiagnosticsService,
  type KoggSupportBundle
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { runOperation } from '@kogg/operations/lib/node/run-operation';

// diagnostic-coverage: core.runtime, operations.registry, operations.cleanup

@injectable()
export class KoggDiagnosticsServiceImpl implements KoggDiagnosticsService {
  constructor(
    @inject(ContributionProvider) @named(KoggDiagnosticContribution)
    private readonly contributors: ContributionProvider<KoggDiagnosticContributor>,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi
  ) {}

  async run(): Promise<KoggDiagnosticReport> {
    return runOperation(this.operations, 'diagnostics', () => this.runChecks());
  }

  private async runChecks(): Promise<KoggDiagnosticReport> {
    console.info('[kogg:core:diagnostics] run.started');
    const checks: KoggDiagnosticCheck[] = [];
    for (const contributor of this.contributors.getContributions()) {
      try {
        checks.push(...await contributor.diagnose());
      } catch (error) {
        console.error('[kogg:core:diagnostics] contributor.failed', {
          contributorId: contributor.id,
          errorType: error instanceof Error ? error.name : 'UnknownError'
        });
        checks.push({
          id: `${contributor.id}.contributor`,
          status: 'fail',
          summary: `${contributor.id} diagnostics could not run.`,
          details: { errorType: error instanceof Error ? error.name : 'UnknownError' }
        });
      }
    }
    const report: KoggDiagnosticReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      overall: overall(checks),
      checks: checks.sort((left, right) => left.id.localeCompare(right.id))
    };
    console.info('[kogg:core:diagnostics] run.completed', { overall: report.overall, checkCount: report.checks.length });
    return report;
  }

  async createSupportBundle(): Promise<KoggSupportBundle> {
    return runOperation(this.operations, 'support-export', async activity => {
      const report = redact(await this.run()) as unknown as KoggDiagnosticReport; activity();
      const directory = path.join(stateRoot(), 'support');
      const stamp = report.generatedAt.replace(/[:.]/gu, '-');
      const destination = path.join(directory, `kogg-diagnostics-${stamp}.json`);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      console.info('[kogg:core:diagnostics] support-bundle.created', { checkCount: report.checks.length });
      return { uri: new URI(destination).withScheme('file').toString(), report };
    });
  }
}

function overall(checks: readonly KoggDiagnosticCheck[]): DiagnosticStatus {
  if (checks.some(check => check.status === 'fail')) return 'fail';
  if (checks.some(check => check.status === 'warn')) return 'warn';
  return 'pass';
}

function stateRoot(): string {
  const root = process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd();
  return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(root, '.kogg', 'state'));
}

function redact(value: unknown, key = ''): unknown {
  if (/authorization|cookie|credential|password|prompt|secret|token/iu.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
      .replace(/\b(?:sk|api|pat|ghp)-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  return value;
}
