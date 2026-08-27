import { BrowserAuthContribution, BrowserMutationAuthorizationError, type BrowserMutationActorV1 } from '@kogg/core/lib/node/browser-auth-contribution';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { Application, json, type Request, type Response } from '@theia/core/shared/express';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  InteractionModeError, InteractionModeRegistry, type ModeTransitionCancelRequestV1, type ModeTransitionRequestV1
} from './interaction-mode-registry';
import { ModeTransitionAuthority, transitionScopeDigest } from './mode-transition-authority';

// Browser transition mutation is intentionally HTTP-only so authenticated request facts never cross JSON-RPC serialization.
// diagnostic-coverage: interaction-modes.transitions
@injectable()
export class InteractionModeHttpController implements BackendApplicationContribution {
  constructor(
    @inject(BrowserAuthContribution) private readonly browserAuth: BrowserAuthContribution,
    @inject(ModeTransitionAuthority) private readonly authority: ModeTransitionAuthority,
    @inject(InteractionModeRegistry) private readonly registry: InteractionModeRegistry
  ) {}

  configure(app: Application): void {
    if (!this.browserAuth.browserMutationsEnabled()) return;
    app.use('/kogg/modes/transitions', json({ limit: '8kb', strict: true }));
    app.post('/kogg/modes/transitions/request', (request, response) => void this.request(request, response));
    app.post('/kogg/modes/transitions/cancel', (request, response) => void this.cancel(request, response));
    console.info('[kogg:interaction-modes:http] controller.enabled');
  }

  private async request(httpRequest: Request, response: Response): Promise<void> {
    try {
      const request = httpRequest.body as ModeTransitionRequestV1; const actor = this.browserAuth.verifyMutation(httpRequest);
      const result = await this.registry.requestTransition(request, this.context(actor, transitionScopeDigest('request', request)));
      console.info('[kogg:interaction-modes:http] transition.request.completed', { transitionId: result.transitionId, taskId: result.taskId, safeCode: result.safeCode });
      response.status(200).json(result);
    } catch (error) {
      // observability-exempt: failure() emits the bounded transition.request.failed event before returning a safe response.
      this.failure(response, error, 'transition.request.failed');
    }
  }

  private async cancel(httpRequest: Request, response: Response): Promise<void> {
    try {
      const request = httpRequest.body as ModeTransitionCancelRequestV1; const actor = this.browserAuth.verifyMutation(httpRequest);
      const result = await this.registry.cancelTransition(request, this.context(actor, transitionScopeDigest('cancel', request)));
      console.info('[kogg:interaction-modes:http] transition.cancel.completed', { transitionId: result.transitionId, taskId: result.taskId, safeCode: result.safeCode });
      response.status(200).json(result);
    } catch (error) {
      // observability-exempt: failure() emits the bounded transition.cancel.failed event before returning a safe response.
      this.failure(response, error, 'transition.cancel.failed');
    }
  }

  private context(actor: BrowserMutationActorV1, scopeDigest: string) { return this.authority.mint(actor, scopeDigest); }

  private failure(response: Response, error: unknown, event: 'transition.request.failed' | 'transition.cancel.failed'): void {
    const safeCode = error instanceof BrowserMutationAuthorizationError ? error.code
      : error instanceof InteractionModeError ? error.code : 'MODE_REGISTRY_UNAVAILABLE';
    const status = error instanceof BrowserMutationAuthorizationError ? (error.code === 'authentication_required' ? 401 : 403)
      : error instanceof InteractionModeError && error.code === 'MODE_PROTOCOL_INVALID' ? 400
        : error instanceof InteractionModeError && (error.code === 'MODE_REQUEST_CONFLICT' || error.code === 'MODE_TRANSITION_CONFLICT') ? 409 : 503;
    console.error('[kogg:interaction-modes:http]', event, { safeCode, errorType: error instanceof Error ? error.name : 'UnknownError' });
    response.status(status).json({ error: safeCode });
  }
}
