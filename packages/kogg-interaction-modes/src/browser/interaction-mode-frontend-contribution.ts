import { Command, CommandContribution, CommandRegistry, MessageService, environment } from '@theia/core';
import { FrontendApplicationContribution, QuickInputService, StatusBar, StatusBarAlignment } from '@theia/core/lib/browser';
import type { QuickPickValue } from '@theia/core/lib/common/quick-pick-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KOGG_TASKS_CHANGED_EVENT } from '@kogg/tasks/lib/browser/tasks-events';
import { KoggTasksService, type KoggTasksService as TasksService, type TaskSummary } from '@kogg/tasks/lib/common/tasks-protocol';
import {
  KoggInteractionModesService, type InteractionModeV1, type KoggInteractionModesService as InteractionModesService,
  type ModeProjectionV1, type ModeTransitionConfigurationV1, type ModeTransitionProjectionV1
} from '../common/interaction-modes-protocol';
import { modeAuthorityLabel, modeBlockedExplanation, modeSelectionAllowed } from '../common/interaction-mode-view-model';

// diagnostic-coverage: interaction-modes.authority, interaction-modes.transitions, interaction-modes.operations, interaction-modes.restoration, interaction-modes.accessibility, interaction-modes.source-maps
const STATUS_ID = 'kogg.interaction-mode';
const BROADCAST_NAME = 'kogg:interaction-modes:v1';
export const KOGG_INTERACTION_MODE_UI_EVENT = 'kogg:interaction-mode-ui';
export const KOGG_INTERACTION_MODE_UI_REQUEST_EVENT = 'kogg:interaction-mode-ui-request';
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
  private readonly broadcast = new BroadcastChannel(BROADCAST_NAME);
  private readonly focusListener = () => void this.refresh();
  private readonly taskListener = () => void this.refresh();
  private readonly broadcastListener = () => void this.refresh();
  private readonly uiRequestListener = () => void this.render(this.projection ? 'ready' : this.task ? 'loading' : 'no-task');
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
    window.addEventListener(KOGG_INTERACTION_MODE_UI_REQUEST_EVENT, this.uiRequestListener);
    this.broadcast.addEventListener('message', this.broadcastListener);
  }
  onStop(): void {
    window.removeEventListener('focus', this.focusListener);
    window.removeEventListener(KOGG_TASKS_CHANGED_EVENT, this.taskListener);
    window.removeEventListener(KOGG_INTERACTION_MODE_UI_REQUEST_EVENT, this.uiRequestListener);
    this.broadcast.removeEventListener('message', this.broadcastListener); this.broadcast.close();
    console.info('[kogg:ui:mode-selector] selector.stopped');
    void this.statusBar.removeElement(STATUS_ID);
  }
  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(SELECT_MODE, { execute: (requested?: unknown) => this.selectMode(isInteractionMode(requested) ? requested : undefined) });
  }

  private async refresh(): Promise<void> {
    try {
      const tasks = (await this.tasks.list()).filter(task => task.lifecycle === 'active');
      this.task = tasks.find(task => task.taskId === this.task?.taskId) ?? tasks[0];
      if (!this.task) { this.projection = undefined; this.pending = undefined; await this.render('no-task'); return; }
      this.projection = await this.modes.get({ requestId: crypto.randomUUID(), taskId: this.task.taskId });
      this.pending = this.projection.state === 'transition-pending'
        ? await this.modes.getPendingTransition({ requestId: crypto.randomUUID(), taskId: this.task.taskId }) : undefined;
      await this.render('ready');
    } catch (error) {
      console.error('[kogg:ui:mode-selector] mode.restore.failed', { errorType: errorName(error) });
      await this.render('unavailable');
    }
  }

  private async render(state: 'loading' | 'ready' | 'no-task' | 'unavailable'): Promise<void> {
    const projection = this.projection; const mode = projection ? MODE_LABEL[projection.selectedMode] : 'Plan';
    const authority = projection ? modeAuthorityLabel(projection) : state === 'no-task' ? 'no active task' : state;
    const label = `Mode: ${mode}; authority: ${authority}; stage: ${projection?.activeStage ?? 'unavailable'}`;
    await this.statusBar.setElement(STATUS_ID, {
      text: `$(shield) ${mode} · ${projection?.activeStage ?? authority}`,
      name: 'Kogg interaction mode', alignment: StatusBarAlignment.LEFT, priority: 100,
      command: SELECT_MODE.id, tooltip: `${label}. ${projection ? modeBlockedExplanation(projection) : 'Create an active task to establish task-scoped authority.'}`,
      accessibilityInformation: { label }
    });
    window.dispatchEvent(new CustomEvent(KOGG_INTERACTION_MODE_UI_EVENT, { detail: {
      state, selectedMode: projection?.selectedMode ?? 'plan', activeStage: projection?.activeStage,
      authority, taskId: this.task?.taskId
    } }));
  }

  private async selectMode(requested?: InteractionModeV1): Promise<void> {
    await this.refresh();
    if (!this.task || !this.projection) { await this.messages.warn('Create an active governed task before selecting an interaction mode.'); return; }
    if (this.projection.state === 'transition-pending') { await this.handlePending(); return; }
    if (!modeSelectionAllowed(this.projection)) {
      await this.messages.warn(`Mode switch unavailable: ${this.projection.safeCode}. Restore the exact current task binding first.`); return;
    }
    const choices: Array<QuickPickValue<InteractionModeV1>> = (['plan', 'build', 'kogg'] as const).map(mode => ({
      label: `${mode === this.projection!.selectedMode ? '$(check) ' : ''}${MODE_LABEL[mode]}`,
      description: mode === this.projection!.selectedMode ? 'Current task mode' : transitionDescription(this.projection!.selectedMode, mode),
      detail: MODE_DETAIL[mode], ariaLabel: `${MODE_LABEL[mode]}. ${MODE_DETAIL[mode]}`, value: mode
    }));
    const selected = requested
      ? choices.find(choice => choice.value === requested)
      : await this.quickInput.showQuickPick(choices, { placeholder: `Task ${this.task.taskId.slice(0, 8)} — choose an authority-bounded mode` });
    if (!selected || selected.value === this.projection.selectedMode) return;
    const consequence = `${transitionDescription(this.projection.selectedMode, selected.value)} ${MODE_DETAIL[selected.value]}`;
    if (await this.messages.warn(consequence, 'Request switch', 'Cancel') !== 'Request switch') return;
    const options = (await this.modes.transitionConfigurations({ requestId: crypto.randomUUID(), taskId: this.task.taskId, toMode: selected.value })).options;
    if (!options.length) { await this.messages.warn(`Mode switch unavailable: no current ${MODE_LABEL[selected.value]} owner configuration is qualified.`); return; }
    const configuration = options.length === 1 ? options[0]! : (await this.quickInput.showQuickPick(options.map(option => ({ label: configurationSummary(option), value: option })), { placeholder: `Choose the exact ${MODE_LABEL[selected.value]} owner configuration` }))?.value;
    if (!configuration) return;
    await this.requestTransition(selected.value, configuration);
  }

  private async requestTransition(toMode: InteractionModeV1, configuration: ModeTransitionConfigurationV1): Promise<void> {
    const task = this.task!; const projection = this.projection!; const requestId = crypto.randomUUID(); const transitionId = crypto.randomUUID();
    console.info('[kogg:ui:mode-selector] mode.transition-requested', { requestId, taskId: task.taskId, fromMode: projection.selectedMode, toMode });
    try {
      const body = { transitionId, requestId, taskId: task.taskId, expectedSequence: projection.sequence, fromMode: projection.selectedMode, toMode,
        requestedConfigurationDigest: await configurationDigest(configuration) };
      this.pending = environment.electron.is() ? await this.modes.requestDesktopTransition(body) : await mutation('/kogg/modes/transitions/request', body);
      this.projection = this.pending.mode; await this.render('ready'); this.broadcast.postMessage({ kind: 'transition-changed' });
      console.info('[kogg:ui:mode-selector] mode.transition-approved', { requestId, taskId: task.taskId, fromMode: projection.selectedMode, toMode, safeCode: this.pending.safeCode });
      const choice = await this.messages.warn(`Confirm ${MODE_LABEL[projection.selectedMode]} → ${MODE_LABEL[toMode]} with ${configurationSummary(configuration)}. Effective authority remains disabled until every owner qualifies.`, 'Confirm switch', 'Keep pending', 'Cancel request');
      if (choice === 'Confirm switch') await this.confirmPending(configuration); else if (choice === 'Cancel request') await this.cancelPending();
    } catch (error) {
      console.error('[kogg:ui:mode-selector] mode.transition.refused', { requestId, taskId: task.taskId, fromMode: projection.selectedMode, toMode, safeCode: safeCode(error), errorType: errorName(error) });
      await this.messages.error(`Mode switch refused: ${safeCode(error)}.`); await this.refresh();
    }
  }

  private async handlePending(): Promise<void> {
    if (!this.pending) { await this.messages.warn('A durable mode transition is pending. Reopen the originating browser window or wait for expiry; no authority is active meanwhile.'); return; }
    const options = (await this.modes.transitionConfigurations({ requestId: crypto.randomUUID(), taskId: this.pending.taskId, toMode: this.pending.toMode })).options;
    const matching: ModeTransitionConfigurationV1[] = [];
    for (const option of options) if (await configurationDigest(option) === this.pending.configurationDigest) matching.push(option);
    const message = `Switching ${MODE_LABEL[this.pending.fromMode]} → ${MODE_LABEL[this.pending.toMode]}. Effective authority is disabled${matching.length === 1 ? ' until owner qualification completes' : '; the exact owner configuration is no longer available'}.`;
    const choice = matching.length === 1
      ? await this.messages.warn(message, 'Confirm switch', 'Keep pending', 'Cancel request')
      : await this.messages.warn(message, 'Keep pending', 'Cancel request');
    if (choice === 'Confirm switch') await this.confirmPending(matching[0]!); else if (choice === 'Cancel request') await this.cancelPending();
  }

  private async confirmPending(configuration: ModeTransitionConfigurationV1): Promise<void> {
    if (!this.pending) return; const prior = this.pending; const requestId = crypto.randomUUID();
    try {
      const body = { requestId, transitionId: prior.transitionId, taskId: prior.taskId, ...(prior.challengeDigest ? { challengeDigest: prior.challengeDigest } : {}), explicitGesture: true as const, configuration };
      const result = environment.electron.is() ? await this.modes.confirmDesktopTransition(body) : await mutation('/kogg/modes/transitions/confirm', body);
      this.pending = undefined; this.projection = result.mode; await this.render('ready'); this.broadcast.postMessage({ kind: 'transition-changed' });
      if (result.state === 'committed') await this.messages.info(`Mode switched to ${MODE_LABEL[result.mode.selectedMode]}.`);
      else await this.messages.error(`Mode switch refused: ${result.safeCode}. No new authority was granted.`);
      console.info('[kogg:ui:mode-selector] mode.transition-qualified', { requestId, taskId: prior.taskId, fromMode: prior.fromMode, toMode: prior.toMode, safeCode: result.safeCode });
    } catch (error) {
      console.error('[kogg:ui:mode-selector] mode.transition.refused', { requestId, taskId: prior.taskId, fromMode: prior.fromMode, toMode: prior.toMode, safeCode: safeCode(error), errorType: errorName(error) });
      await this.messages.error(`Mode switch qualification failed: ${safeCode(error)}.`); await this.refresh();
    }
  }

  private async cancelPending(): Promise<void> {
    if (!this.pending) return; const requestId = crypto.randomUUID(); const prior = this.pending;
    try {
      const cancel = { requestId, transitionId: prior.transitionId, taskId: prior.taskId };
      const result = environment.electron.is() ? await this.modes.cancelDesktopTransition(cancel) : await mutation('/kogg/modes/transitions/cancel', cancel);
      this.pending = undefined; this.projection = result.mode; await this.render('ready');
      this.broadcast.postMessage({ kind: 'transition-changed' });
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
async function configurationDigest(configuration: ModeTransitionConfigurationV1): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(configuration));
  const digest = await crypto.subtle.digest('SHA-256', bytes); return `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}
function configurationSummary(configuration: ModeTransitionConfigurationV1): string {
  if (configuration.kind === 'plan') return 'Plan read-only authority';
  if (configuration.kind === 'kogg') return `governed workflow ${configuration.workflowVersionId.slice(0, 8)}`;
  return `${configuration.adapterKey}@${configuration.adapterVersion} · ${configuration.providerId}/${configuration.modelId} · ${configuration.targetId}`;
}
function transitionDescription(from: InteractionModeV1, to: InteractionModeV1): string { const order = { plan: 0, build: 1, kogg: 2 }; return order[to] > order[from] ? 'Authority expansion requires explicit confirmation and fresh owner qualification.' : 'Authority reduction requires active-work cancellation and externally proved cleanup.'; }
function isInteractionMode(value: unknown): value is InteractionModeV1 { return value === 'plan' || value === 'build' || value === 'kogg'; }
class ModeUiError extends Error { constructor(readonly code: string) { super(code); this.name = 'ModeUiError'; } }
function safeCode(error: unknown): string { return error instanceof ModeUiError ? error.code : 'MODE_REGISTRY_UNAVAILABLE'; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
