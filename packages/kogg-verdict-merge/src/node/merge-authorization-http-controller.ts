import { BrowserAuthContribution, BrowserMutationAuthorizationError } from '@kogg/core/lib/node/browser-auth-contribution';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { Application, json, type Request, type Response } from '@theia/core/shared/express';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { MergeAuthorizeRequestV1, MergeChallengeRequestV1 } from '../common/verdict-merge-protocol';
import { MergeAuthorizationAuthority, mergeAuthorizationScopeDigest } from './merge-authorization-authority';
import { MergeAuthorizationError, MergeAuthorizationRegistry } from './merge-authorization-registry';

// Human merge authority is browser HTTP-only so cookie, origin, and CSRF facts never cross JSON-RPC serialization.
// diagnostic-coverage: merge.authorization
@injectable()
export class MergeAuthorizationHttpController implements BackendApplicationContribution {
  constructor(
    @inject(BrowserAuthContribution) private readonly browserAuth: BrowserAuthContribution,
    @inject(MergeAuthorizationAuthority) private readonly authority: MergeAuthorizationAuthority,
    @inject(MergeAuthorizationRegistry) private readonly registry: MergeAuthorizationRegistry
  ) {}

  configure(app: Application): void {
    if (!this.browserAuth.browserMutationsEnabled()) return;
    app.use('/kogg/merge/authorization', json({ limit: '8kb', strict: true }));
    app.post('/kogg/merge/authorization/challenge', (request, response) => void this.challenge(request, response));
    app.post('/kogg/merge/authorization/authorize', (request, response) => void this.authorize(request, response));
    console.info('[kogg:merge:authorization-http] controller.enabled');
  }

  private async challenge(httpRequest: Request, response: Response): Promise<void> {
    try {
      const request = httpRequest.body as MergeChallengeRequestV1; const actor = this.browserAuth.verifyMutation(httpRequest);
      const context = this.authority.mint(actor, mergeAuthorizationScopeDigest('challenge', request));
      const result = await this.registry.createChallenge(request, context); response.status(result.kind === 'created' ? 200 : 409).json(result);
      console.info('[kogg:merge:authorization-http] challenge.completed', { requestId: request.requestId, safeCode: result.safeCode });
    } catch (error) {
      // observability-exempt: failure() emits the bounded challenge failure before returning a closed response.
      this.failure(response, error, 'challenge.failed');
    }
  }

  private async authorize(httpRequest: Request, response: Response): Promise<void> {
    try {
      const request = httpRequest.body as MergeAuthorizeRequestV1; const actor = this.browserAuth.verifyMutation(httpRequest);
      const context = this.authority.mint(actor, mergeAuthorizationScopeDigest('authorize', request));
      const result = await this.registry.authorize(request, context); response.status(result.kind === 'authorized' ? 200 : 409).json(result);
      console.info('[kogg:merge:authorization-http] authorization.completed', { requestId: request.requestId, challengeId: request.challengeId, safeCode: result.safeCode });
    } catch (error) {
      // observability-exempt: failure() emits the bounded authorization failure before returning a closed response.
      this.failure(response, error, 'authorization.failed');
    }
  }

  private failure(response: Response, error: unknown, event: 'challenge.failed' | 'authorization.failed'): void {
    const safeCode = error instanceof BrowserMutationAuthorizationError ? error.code : error instanceof MergeAuthorizationError ? error.safeCode : 'INTERNAL_FAILURE';
    const status = error instanceof BrowserMutationAuthorizationError ? (error.code === 'authentication_required' ? 401 : 403) : error instanceof MergeAuthorizationError && error.safeCode === 'PROTOCOL_INVALID' ? 400 : 503;
    console.error('[kogg:merge:authorization-http]', event, { safeCode, errorType: error instanceof Error ? error.name : 'UnknownError' }); response.status(status).json({ error: safeCode });
  }
}
