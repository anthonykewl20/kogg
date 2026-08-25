import {
  Command,
  CommandContribution,
  CommandRegistry,
  MessageService
} from '@theia/core';
import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';

export const KoggCommands = {
  about: { id: 'kogg.about', label: 'Kogg: About' } satisfies Command,
  marketplace: { id: 'kogg.marketplace', label: 'Kogg: Open Marketplace' } satisfies Command
};

@injectable()
export class KoggFrontendContribution implements FrontendApplicationContribution, CommandContribution {
  constructor(@inject(MessageService) private readonly messages: MessageService) {}

  onStart(_application: FrontendApplication): void {
    document.title = 'Kogg';
    document.documentElement.dataset.kogg = 'true';
    document.body.classList.add('kogg-application');
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(KoggCommands.about, {
      execute: () => this.messages.info('Kogg — engineering control plane powered by the embedded Ranex kernel.')
    });
    commands.registerCommand(KoggCommands.marketplace, {
      execute: async () => {
        const toggle = 'vsxExtensions.toggle';
        if (commands.getCommand(toggle)) await commands.executeCommand(toggle);
        else await this.messages.warn('Kogg Marketplace is unavailable in this application composition.');
      }
    });
  }
}
