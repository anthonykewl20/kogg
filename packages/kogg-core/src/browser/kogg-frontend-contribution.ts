import {
  Command,
  CommandContribution,
  CommandRegistry,
  environment,
  MessageService
} from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import { FrontendApplication, FrontendApplicationContribution, OpenerService, open } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  KoggDiagnosticsServiceToken,
  type KoggDiagnosticReport,
  type KoggDiagnosticsService
} from '../common/diagnostics-service';

// diagnostic-coverage: core.runtime, core.browser-auth

export const KoggCommands = {
  about: { id: 'kogg.about', label: 'Kogg: About' } satisfies Command,
  marketplace: { id: 'kogg.marketplace', label: 'Kogg: Open Marketplace' } satisfies Command,
  signOut: { id: 'kogg.auth.signOut', label: 'Kogg: Sign Out' } satisfies Command,
  runDiagnostics: { id: 'kogg.diagnostics.run', label: 'Kogg: Run Diagnostics' } satisfies Command,
  exportSupportBundle: { id: 'kogg.diagnostics.export', label: 'Kogg: Export Diagnostic Support Bundle' } satisfies Command
};

@injectable()
export class KoggFrontendContribution implements FrontendApplicationContribution, CommandContribution {
  constructor(
    @inject(MessageService) private readonly messages: MessageService,
    @inject(CommandRegistry) private readonly commands: CommandRegistry,
    @inject(OpenerService) private readonly openerService: OpenerService,
    @inject(KoggDiagnosticsServiceToken) private readonly diagnostics: KoggDiagnosticsService
  ) {}

  onStart(_application: FrontendApplication): void {
    document.title = 'Kogg';
    document.documentElement.dataset.kogg = 'true';
    document.body.classList.add('kogg-application');
    console.info('[kogg:ui:shell] theme.applied', { themeVersion: 2 });
    this.installBrowserAuthenticationGuard();
    this.removeStockAgentCommands();
  }

  private removeStockAgentCommands(): void {
    for (const command of this.commands.getAllCommands()) {
      if (command.id.startsWith('aiConfiguration.') || /custom[- ]agent/iu.test(`${command.id} ${command.label ?? ''}`)) {
        this.commands.unregisterCommand(command.id);
      }
    }
  }

  private installBrowserAuthenticationGuard(): void {
    if (environment.electron.is()) return;
    const check = async () => {
      try {
        const response = await fetch('/kogg/auth/status', { cache: 'no-store', credentials: 'same-origin' });
        if (response.status === 401) window.location.replace('/kogg/auth/login');
      } catch (error) {
        console.warn('[kogg:core:frontend] auth-status.unavailable', {
          errorType: error instanceof Error ? error.name : 'UnknownError'
        });
        // A temporary network outage is handled by Theia's reconnect UI.
      }
    };
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    window.setInterval(check, 10_000);
  }

  registerCommands(commands: CommandRegistry): void {
    // The bundled VS Code Git extension calls this internal VS Code command
    // after a commit even when no chat edit session exists. Kogg intentionally
    // ships without VS Code's stock chat agents, so the compatible behavior is
    // a no-op rather than an unhandled plugin-host rejection.
    commands.registerCommand({ id: '_chat.editSessions.accept' }, { execute: () => undefined });
    commands.registerCommand(KoggCommands.about, {
      execute: () => this.messages.info('Kogg — engineering control plane powered by the embedded Ranex kernel.')
    });
    commands.registerCommand(KoggCommands.marketplace, {
      execute: async () => {
        const toggle = 'kogg.marketplace.open';
        if (commands.getCommand(toggle)) await commands.executeCommand(toggle);
        else await this.messages.warn('Kogg Marketplace is unavailable in this application composition.');
      }
    });
    commands.registerCommand(KoggCommands.signOut, {
      isVisible: () => !environment.electron.is(),
      execute: async () => {
        await fetch('/kogg/auth/logout', { method: 'POST', credentials: 'same-origin' });
        window.location.replace('/kogg/auth/login');
      }
    });
    commands.registerCommand(KoggCommands.runDiagnostics, {
      execute: async () => this.runDiagnostics()
    });
    commands.registerCommand(KoggCommands.exportSupportBundle, {
      execute: async () => {
        try {
          const bundle = await this.diagnostics.createSupportBundle();
          console.info('[kogg:core:frontend] support-bundle.created', { overall: bundle.report.overall });
          await open(this.openerService, new URI(bundle.uri));
          await this.messages.info(`Kogg diagnostic bundle created: ${summary(bundle.report)}`);
        } catch (error) {
          console.error('[kogg:core:frontend] support-bundle.failed', {
            errorType: error instanceof Error ? error.name : 'UnknownError'
          });
          await this.messages.error('Kogg could not create the diagnostic support bundle. See logs for details.');
        }
      }
    });
  }

  private async runDiagnostics(): Promise<void> {
    try {
      const report = await this.diagnostics.run();
      console.info('[kogg:core:frontend] diagnostics.completed', {
        overall: report.overall,
        checkCount: report.checks.length
      });
      const failures = report.checks.filter(check => check.status === 'fail');
      const detail = failures.length ? ` Failed: ${failures.map(check => check.id).join(', ')}.` : '';
      const text = `${summary(report)}${detail}`;
      if (report.overall === 'fail') await this.messages.error(text);
      else if (report.overall === 'warn') await this.messages.warn(text);
      else await this.messages.info(text);
    } catch (error) {
      console.error('[kogg:core:frontend] diagnostics.failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
      await this.messages.error('Kogg diagnostics could not run. See logs for details.');
    }
  }
}

function summary(report: KoggDiagnosticReport): string {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of report.checks) counts[check.status] += 1;
  return `Diagnostics: ${report.overall.toUpperCase()} — ${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed.`;
}
