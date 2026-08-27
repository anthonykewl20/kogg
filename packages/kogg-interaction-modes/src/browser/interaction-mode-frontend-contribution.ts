import { Command, CommandContribution, CommandRegistry, MessageService, environment } from '@theia/core';
import { FrontendApplicationContribution, QuickInputService, StatusBar, StatusBarAlignment } from '@theia/core/lib/browser';
import type { QuickPickValue } from '@theia/core/lib/common/quick-pick-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KOGG_TASKS_CHANGED_EVENT } from '@kogg/tasks/lib/browser/tasks-events';
import { KoggTasksService, type KoggTasksService as TasksService, type TaskSummary } from '@kogg/tasks/lib/common/tasks-protocol';
import {
  KoggInteractionModesService, type InteractionModeV1, type KoggInteractionModesService as InteractionModesService,
  type ModeProjectionV1, type ModeTransitionProjectionV1
} from '../common/interaction-modes-protocol';

// diagnostic-coverage: interaction-modes.authority, interaction-modes.transitions, interaction-modes.operations, interaction-modes.restoration, interaction-modes.accessibility, interaction-modes.source-maps
const STATUS_ID = 'kogg.interaction-mode';
const SELECT_MODE: Command = { id: 'kogg.interaction-mode.select', label: 'Kogg: Select Interaction Mode' };
const MODE_LABEL: Readonly<Record<InteractionModeV1, string>> = { plan: 'Plan', build: 'Build', kogg: 'Kogg' };
const MODE_DETAIL: Readonly<Record<InteractionModeV1, string>> = {
  plan: 'Research and approval-ready planning only. Production mutation is refused.',
  build: 'Private worktree implementation and tests. Governed PASS and merge remain unavailable.',
  kogg: 'Complete governed lifecycle with required approvals, evidence, verdict, and controlled merge.'
};
type TransitionProjection = ModeTransitionProjectionV1;

@injectable()
export class InteractionModeFrontendContribution implements FrontendApplicationContribution, CommandContribution {
  private task: TaskSummary | undefined;
  private projection: ModeProjectionV1 | undefined;
  private pending: TransitionProjection | undefined;
  private readonly focusListener = () => void this.refresh();
  private readonly taskListener = () => void this.refresh();
  constructor(
    @inject(StatusBar) private readonly statusBar: StatusBar,
    @inject(QuickInputService) private readonly quickInput: QuickInputService,
    @inject(MessageService) private readonly messages: MessageService,
    @inject(KoggTasksService) private readonly tasks: TasksService,
    @inject(KoggInteractionModesService) private readonly modes: InteractionModesService
  ) {}

  onStart(): void {
    console.info('[kogg:ui:mode-selector] selector.started');
    void this.render('loading'); void this.refresh(); window.addEventListener('focus', this.focusListener);
    window.addEventListener(KOGG_TASKS_CHANGED_EVENT, this.taskListener);
  }
  onStop(): void {
    window.removeEventListener('focus', this.focusListener);
    window.removeEventListener(KOGG_TASKS_CHANGED_EVENT, this.taskListener);
    console.info('[kogg:ui:mode-selector] selector.stopped');
    void this.statusBar.removeElement(STATUS_ID);
  }
  registerCommands(commands: CommandRegistry): void { commands.registerCommand(SELECT_MODE, { execute: () => this.selectMode() }); }

  private async refresh(): Promise<void> {
    try {
      const tasks = (await this.tasks.list()).filter(task => task.lifecycle === 'active');
      this.task = tasks.find(task => task.taskId === this.task?.taskId) ?? tasks[0];
      if (!this.task) { this.projection = undefined; this.pending = undefined; await this.render('no-task'); return; }
      this.projection = await this.modes.get({ requestId: crypto.randomUUID(), taskId: this.task.taskId });
      if (this.projection.state !== 'transition-pending') this.pending = undefined;
      await this.render('ready');
    } catch (error) {
      console.error('[kogg:ui:mode-selector] mode.restore.failed', { errorType: errorName(error) });
      await this.render('unavailable');
    }
  }

  private async render(state: 'loading' | 'ready' | 'no-task' | 'unavailable'): Promise<void> {
    const projection = this.projection; const mode = projection ? MODE_LABEL[projection.selectedMode] : 'Plan';
    const authority = projection ? authorityLabel(projection) : state === 'no-task' ? 'no active task' : state;
    const label = `Mode: ${mode}; authority: ${authority}; stage: ${projection?.activeStage ?? 'unavailable'}`;
    await this.statusBar.setElement(STATUS_ID, {
      text: `$(shield) ${mode} · ${projection?.activeStage ?? authority}`,
      name: 'Kogg interaction mode', alignment: StatusBarAlignment.LEFT, priority: 100,
      command: SELECT_MODE.id, tooltip: `${label}. ${projection ? blockedExplanation(projection) : 'Create an active task to establish task-scoped authority.'}`,
      accessibilityInformation: { label }
    });
  }

  private async selectMode(): Promise<void> {
    await this.refresh();
    if (!this.task || !this.projection) { await this.messages.warn('Create an active governed task before selecting an interaction mode.'); return; }
    if (this.projection.state === 'transition-pending') { await this.handlePending(); return; }
    const choices: Array<QuickPickValue<InteractionModeV1>> = (['plan', 'build', 'kogg'] as const).map(mode => ({
      label: `${mode === this.projection!.selectedMode ? '$(check) ' : ''}${MODE_LABEL[mode]}`,
      description: mode === this.projection!.selectedMode ? 'Current task mode' : transitionDescription(this.projection!.selectedMode, mode),
      detail: MODE_DETAIL[mode], ariaLabel: `${MODE_LABEL[mode]}. ${MODE_DETAIL[mode]}`, value: mode
    }));
    const selected = await this.quickInput.showQuickPick(choices, { placeholder: `Task ${this.task.taskId.slice(0, 8)} — choose an authority-bounded mode` });
    if (!selected || selected.value === this.projection.selectedMode) return;
    const consequence = `${transitionDescription(this.projection.selectedMode, selected.value)} ${MODE_DETAIL[selected.value]}`;
    if (await this.messages.warn(consequence, 'Request switch', 'Cancel') !== 'Request switch') return;
    await this.requestTransition(selected.value);
  }

  private async requestTransition(toMode: InteractionModeV1): Promise<void> {
    const task = this.task!; const projection = this.projection!; const requestId = crypto.randomUUID(); const transitionId = crypto.randomUUID();
    console.info('[kogg:ui:mode-selector] mode.transition-requested', { requestId, taskId: task.taskId, fromMode: projection.selectedMode, toMode });
    try {
      const body = { transitionId, requestId, taskId: task.taskId, expectedSequence: projection.sequence, fromMode: projection.selectedMode, toMode,
        requestedConfigurationDigest: await configurationDigest(toMode) };
      this.pending = environment.electron.is() ? await this.modes.requestDesktopTransition(body) : await mutation('/kogg/modes/transitions/request', body);
      this.projection = this.pending.mode; await this.render('ready');
      console.info('[kogg:ui:mode-selector] mode.transition-approved', { requestId, taskId: task.taskId, fromMode: projection.selectedMode, toMode, safeCode: this.pending.safeCode });
      await this.messages.warn(`Switch requested: ${this.pending.safeCode}. Effective authority is disabled until confirmation and owner qualification complete.`, 'Keep pending', 'Cancel request').then(choice => choice === 'Cancel request' ? this.cancelPending() : undefined);
    } catch (error) {
      console.error('[kogg:ui:mode-selector] mode.transition.refused', { requestId, taskId: task.taskId, fromMode: projection.selectedMode, toMode, safeCode: safeCode(error), errorType: errorName(error) });
      await this.messages.error(`Mode switch refused: ${safeCode(error)}.`); await this.refresh();
    }
  }

  private async handlePending(): Promise<void> {
    if (!this.pending) { await this.messages.warn('A durable mode transition is pending. Reopen the originating browser window or wait for expiry; no authority is active meanwhile.'); return; }
    if (await this.messages.warn(`Switching ${MODE_LABEL[this.pending.fromMode]} → ${MODE_LABEL[this.pending.toMode]}. Effective authority is disabled.`, 'Keep pending', 'Cancel request') === 'Cancel request') await this.cancelPending();
  }

  private async cancelPending(): Promise<void> {
    if (!this.pending) return; const requestId = crypto.randomUUID(); const prior = this.pending;
    try {
      const cancel = { requestId, transitionId: prior.transitionId, taskId: prior.taskId };
      const result = environment.electron.is() ? await this.modes.cancelDesktopTransition(cancel) : await mutation('/kogg/modes/transitions/cancel', cancel);
      this.pending = undefined; this.projection = result.mode; await this.render('ready');
      console.info('[kogg:ui:mode-selector] mode.transition-cancelled', { requestId, taskId: prior.taskId, fromMode: prior.fromMode, toMode: prior.toMode, safeCode: result.safeCode });
    } catch (error) {
      console.error('[kogg:ui:mode-selector] mode.transition.refused', { requestId, taskId: prior.taskId, fromMode: prior.fromMode, toMode: prior.toMode, safeCode: safeCode(error), errorType: errorName(error) });
      await this.messages.error(`Mode transition cancellation failed: ${safeCode(error)}.`);
    }
  }
}

async function mutation(path: string, body: unknown): Promise<TransitionProjection> {
  const csrfResponse = await fetch('/kogg/auth/csrf', { cache: 'no-store', credentials: 'same-origin' });
  if (!csrfResponse.ok) throw new ModeUiError('authentication_required');
  const csrf = await csrfResponse.json() as { csrfToken?: unknown }; if (typeof csrf.csrfToken !== 'string') throw new ModeUiError('mutation_authority_refused');
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-kogg-csrf': csrf.csrfToken }, body: JSON.stringify(body) });
  const value = await response.json() as TransitionProjection | { error?: unknown };
  if (!response.ok) throw new ModeUiError(typeof (value as { error?: unknown }).error === 'string' ? String((value as { error: string }).error) : 'MODE_REGISTRY_UNAVAILABLE');
  return value as TransitionProjection;
}
async function configurationDigest(mode: InteractionModeV1): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ mode, qualification: 'pending', schemaVersion: 1 }));
  const digest = await crypto.subtle.digest('SHA-256', bytes); return `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}
function authorityLabel(projection: ModeProjectionV1): string { return projection.state === 'transition-pending' ? 'disabled during transition' : `${projection.effectiveCapabilities.length} bounded capabilities`; }
function blockedExplanation(projection: ModeProjectionV1): string { if (projection.state === 'transition-pending') return 'All mode operations are refused until transition confirmation, qualification, cleanup, and commit.'; if (projection.selectedMode === 'plan') return 'Plan cannot modify production files; switch to Build or Kogg through explicit confirmation.'; if (projection.selectedMode === 'build') return 'Build cannot claim governed PASS or merge; continue through Kogg verification.'; return 'Kogg remains bounded by approvals, independent checks, evidence, verdict, controlled merge, and cleanup.'; }
function transitionDescription(from: InteractionModeV1, to: InteractionModeV1): string { const order = { plan: 0, build: 1, kogg: 2 }; return order[to] > order[from] ? 'Authority expansion requires explicit confirmation and fresh owner qualification.' : 'Authority reduction requires active-work cancellation and externally proved cleanup.'; }
class ModeUiError extends Error { constructor(readonly code: string) { super(code); this.name = 'ModeUiError'; } }
function safeCode(error: unknown): string { return error instanceof ModeUiError ? error.code : 'MODE_REGISTRY_UNAVAILABLE'; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
