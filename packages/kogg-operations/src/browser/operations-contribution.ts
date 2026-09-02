import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandRegistry, type Command } from '@theia/core';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { injectable } from '@theia/core/shared/inversify';
import { OperationsWidget } from './operations-widget';

// diagnostic-coverage: operations.processes, operations.admission
// observability-exempt: This declarative view contribution performs no fallible operational work.

@injectable()
export class OperationsContribution extends AbstractViewContribution<OperationsWidget> implements FrontendApplicationContribution {
  static readonly SHOW: Command = { id: 'kogg.operations.show', label: 'Kogg: Show Operations' };
  constructor() {
    super({ widgetId: OperationsWidget.ID, widgetName: OperationsWidget.LABEL, defaultWidgetOptions: { area: 'main', rank: 110 }, toggleCommandId: 'kogg.operations.open' });
  }
  onStart(): void {}
  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(OperationsContribution.SHOW, { execute: () => this.openView({ activate: true }) });
  }
}
