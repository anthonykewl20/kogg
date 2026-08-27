import { MessageService } from '@theia/core';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { KoggVerdictMergeServiceToken, type KoggVerdictMergeService, type MergeAuthorizationResultV1, type MergeCandidateProjectionV1, type MergeChallengeProjectionV1, type MergeChallengeResultV1, type MergeExecuteResultV1 } from '../common/verdict-merge-protocol';

// The destructive authority remains HTTP-only; this widget receives only safe projections and never handles cookies directly.
// diagnostic-coverage: verdict.explanation, verdict.currentness, merge.authorization, merge.preflight, merge.atomicity, merge.source-maps
@injectable()
export class VerdictMergeWidget extends BaseWidget {
  static readonly ID = 'kogg-verdict-merge'; static readonly LABEL = 'Kogg Verdict & Merge';
  private candidates: readonly MergeCandidateProjectionV1[] = []; private challenge: MergeChallengeProjectionV1 | undefined;
  private selected: MergeCandidateProjectionV1 | undefined; private status = 'Loading governed verdicts…'; private busy = false;
  constructor(@inject(KoggVerdictMergeServiceToken) private readonly service: KoggVerdictMergeService, @inject(MessageService) private readonly messages: MessageService) { super(); }
  @postConstruct() protected init(): void { this.id = VerdictMergeWidget.ID; this.title.label = VerdictMergeWidget.LABEL; this.title.caption = 'Current Ranex verdicts and explicit controlled merge'; this.title.closable = true; this.addClass('kogg-verdict-merge-widget'); this.render(); void this.refresh(); }
  private async refresh(): Promise<void> {
    try { this.candidates = await this.service.mergeCandidates(); this.status = this.candidates.length ? 'Select one current verdict.' : 'No governed verdicts are available.'; }
    catch (error) { console.error('[kogg:merge:widget] candidates.failed', { errorType: errorName(error) }); this.status = 'Verdicts could not be loaded.'; }
    finally { this.render(); }
  }
  private render(): void {
    const rows = this.candidates.map(candidate => { const enabled = mergeEnabled(candidate); return `<article data-candidate="${escapeHtml(candidate.explanationId)}"><h3>${escapeHtml(candidate.destinationRef)}</h3><p><strong>Ranex:</strong> ${escapeHtml(candidate.ranexDecision.toUpperCase())} · <strong>Currentness:</strong> ${escapeHtml(candidate.currentness)}</p><p>Base ${abbreviate(candidate.expectedBaseOid)} → subject ${abbreviate(candidate.subjectOid)} · two-parent, no fast-forward</p><p>Required gates: ${candidate.passCount}/${candidate.requiredCount} pass · ${candidate.failCount} fail · ${candidate.blockedCount} blocked</p><p>Expires ${escapeHtml(candidate.expiresAt)}</p><button data-prepare="${escapeHtml(candidate.explanationId)}" ${enabled && !this.busy ? '' : 'disabled'}>Review controlled merge</button></article>`; }).join('');
    const confirmation = this.challenge && this.selected ? `<section class="kogg-merge-confirmation" aria-label="Controlled merge confirmation"><h3>Confirm controlled merge</h3><p>Destination <strong>${escapeHtml(this.challenge.destinationRef)}</strong></p><p>Base ${abbreviate(this.challenge.expectedBaseOid)} → subject ${abbreviate(this.challenge.subjectOid)}</p><p>Method: two-parent, no fast-forward · current Ranex PASS</p><p>Authorization expires ${escapeHtml(this.challenge.expiresAt)}</p><p>Challenge <code>${escapeHtml(this.challenge.challengeDigest.slice(0, 19))}</code></p><p>This action creates one local merge commit and atomically updates this exact destination ref. It does not push.</p><button data-authorize ${this.busy ? 'disabled' : ''}>Authorize and merge</button><button data-dismiss ${this.busy ? 'disabled' : ''}>Cancel</button></section>` : '';
    this.node.innerHTML = `<div class="kogg-panel"><header><h2>Verdict & controlled merge</h2><p>Ranex owns PASS/FAIL. Only a fresh human gesture can authorize one exact local merge.</p></header><p role="status">${escapeHtml(this.status)}</p><button data-refresh ${this.busy ? 'disabled' : ''}>Refresh verdicts</button>${confirmation}<section class="kogg-package-list">${rows || '<p>No current PASS is available for merge.</p>'}</section></div>`;
    this.node.querySelector<HTMLElement>('[data-refresh]')?.addEventListener('click', () => void this.refresh());
    this.node.querySelectorAll<HTMLElement>('[data-prepare]').forEach(button => button.addEventListener('click', () => void this.prepare(button.dataset.prepare!)));
    this.node.querySelector<HTMLElement>('[data-authorize]')?.addEventListener('click', () => void this.authorize());
    this.node.querySelector<HTMLElement>('[data-dismiss]')?.addEventListener('click', () => { this.challenge = undefined; this.selected = undefined; this.status = 'Merge authorization cancelled.'; this.render(); });
  }
  private async prepare(explanationId: string): Promise<void> {
    const candidate = this.candidates.find(value => value.explanationId === explanationId); if (!candidate || !mergeEnabled(candidate)) return;
    this.busy = true; this.status = 'Revalidating the current PASS…'; this.render();
    try { const result = await this.mutate<MergeChallengeResultV1>('challenge', { requestId: crypto.randomUUID(), explanationId }); if (result.kind !== 'created') throw new UiRefusal(result.safeCode); this.selected = candidate; this.challenge = result.challenge; this.status = 'Review the exact merge and activate the authorization button.'; console.info('[kogg:merge:widget] challenge.rendered', { explanationId, challengeId: result.challenge.challengeId }); }
    catch (error) { console.warn('[kogg:merge:widget] challenge.refused', { explanationId, safeCode: safeCode(error), errorType: errorName(error) }); this.status = `Merge review refused: ${safeCode(error)}`; void this.messages.warn('The current verdict cannot be authorized. Refresh and inspect diagnostics.'); }
    finally { this.busy = false; this.render(); }
  }
  private async authorize(): Promise<void> {
    if (!this.challenge || !this.selected) return; const challenge = this.challenge; this.busy = true; this.status = 'Authorizing one exact merge…'; this.render();
    try {
      const authorization = await this.mutate<MergeAuthorizationResultV1>('authorize', { requestId: crypto.randomUUID(), challengeId: challenge.challengeId, displayedChallengeDigest: challenge.challengeDigest, explicitHumanGesture: true });
      if (authorization.kind !== 'authorized') throw new UiRefusal(authorization.safeCode);
      const execution = await this.mutate<MergeExecuteResultV1>('execute', { requestId: crypto.randomUUID(), authorizationId: authorization.authorization.authorizationId }); if (execution.kind !== 'accepted') throw new UiRefusal(execution.safeCode);
      this.status = `Controlled merge ${execution.intent.mergeId.slice(0, 8)} entered supervised preflight.`; this.challenge = undefined; this.selected = undefined; console.info('[kogg:merge:widget] merge.accepted', { mergeId: execution.intent.mergeId, safeCode: execution.safeCode }); void this.messages.info('Controlled merge entered supervised preflight.');
    } catch (error) { console.warn('[kogg:merge:widget] merge.refused', { challengeId: challenge.challengeId, safeCode: safeCode(error), errorType: errorName(error) }); this.status = `Controlled merge refused: ${safeCode(error)}`; this.challenge = undefined; this.selected = undefined; void this.messages.warn('The controlled merge was refused without synthesizing success.'); }
    finally { this.busy = false; this.render(); }
  }
  private async mutate<T>(action: 'challenge' | 'authorize' | 'execute', body: unknown): Promise<T> {
    const csrfResponse = await fetch('/kogg/auth/csrf', { credentials: 'same-origin', headers: { accept: 'application/json' } }); if (!csrfResponse.ok) throw new UiRefusal('AUTHORIZATION_REQUIRED');
    const csrf = String((await csrfResponse.json() as { csrfToken?: unknown }).csrfToken ?? ''); if (!csrf) throw new UiRefusal('AUTHORIZATION_REQUIRED');
    const response = await fetch(`/kogg/merge/authorization/${action}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-kogg-csrf': csrf }, body: JSON.stringify(body) });
    const result = await response.json() as T; if (!response.ok && (!result || typeof result !== 'object')) throw new UiRefusal('INTERNAL_FAILURE'); return result;
  }
}
class UiRefusal extends Error { constructor(readonly code: string) { super(code); this.name = 'UiRefusal'; } }
function mergeEnabled(candidate: MergeCandidateProjectionV1): boolean { return candidate.ranexDecision === 'pass' && candidate.currentness === 'current' && Date.parse(candidate.expiresAt) > Date.now(); }
function abbreviate(value: string): string { return escapeHtml(value.slice(0, 12)); }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/gu, character => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[character]!); }
function safeCode(error: unknown): string { return error instanceof UiRefusal ? error.code : 'INTERNAL_FAILURE'; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
