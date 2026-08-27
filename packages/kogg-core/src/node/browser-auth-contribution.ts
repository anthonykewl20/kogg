import { createHmac, timingSafeEqual } from 'node:crypto';
import { Server } from 'node:http';
import { Socket } from 'node:net';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node';
import { Application, NextFunction, Request, Response, Router, urlencoded } from '@theia/core/shared/express';
import { inject, injectable, optional } from '@theia/core/shared/inversify';

// diagnostic-coverage: core.browser-auth

const COOKIE_NAME = 'kogg_session';

export interface BrowserMutationActorV1 {
  readonly sessionId: string; readonly actorAuthorityDigest: string; readonly role: 'owner';
  readonly originVerified: true; readonly csrfVerified: true;
}

export class BrowserMutationAuthorizationError extends Error {
  constructor(readonly code: 'authentication_required' | 'mutation_authority_refused') { super(code); this.name = 'BrowserMutationAuthorizationError'; }
}

@injectable()
export class BrowserAuthContribution implements BackendApplicationContribution {
  @inject(EarlyExpressMiddleware) @optional()
  private readonly earlyMiddleware?: EarlyExpressMiddleware;
  private readonly enabled = process.env.KOGG_RUNTIME === 'browser';
  private readonly token = this.enabled ? this.required('KOGG_AUTH_TOKEN') : '';
  private readonly secureCookie = this.enabled ? this.resolveSecureCookie() : false;
  private readonly session = this.enabled
    ? createHmac('sha256', this.token).update('kogg-browser-session-v1').digest('base64url')
    : '';
  private readonly csrf = this.enabled ? createHmac('sha256', this.token).update('kogg-browser-csrf-v1').digest('base64url') : '';

  initialize(): void {
    if (!this.enabled || !this.earlyMiddleware) return;
    const router = Router();
    this.install(router as unknown as Application);
    this.earlyMiddleware.handlers.push(router);
  }

  configure(app: Application): void {
    if (this.earlyMiddleware) return;
    this.install(app);
  }

  private install(app: Application): void {
    if (!this.enabled) return;
    console.info('[kogg:core:browser-auth] middleware.enabled');
    app.use('/kogg/auth', urlencoded({ extended: false, limit: '4kb' }));
    app.get('/kogg/auth/login', (_request, response) => response.type('html').send(this.loginPage()));
    app.post('/kogg/auth/login', (request, response) => this.login(request, response));
    app.post('/kogg/auth/logout', (_request, response) => {
      response.setHeader('Set-Cookie', this.cookie('', 0));
      response.status(204).end();
    });
    app.get('/kogg/auth/status', (request, response) => {
      response.status(this.authorized(request.headers.cookie, request.headers.authorization) ? 204 : 401).end();
    });
    app.get('/kogg/auth/csrf', (request, response) => {
      if (!this.cookieAuthorized(request.headers.cookie)) { response.status(401).json({ error: 'authentication_required' }); return; }
      response.setHeader('Cache-Control', 'no-store'); response.status(200).json({ csrfToken: this.csrf });
      console.info('[kogg:core:browser-auth] csrf.issued');
    });
    app.use((request: Request, response: Response, next: NextFunction) => {
      if (this.authorized(request.headers.cookie, request.headers.authorization)) next();
      else if (request.accepts('html')) response.redirect(303, '/kogg/auth/login');
      else response.status(401).json({ error: 'authentication_required' });
    });
  }

  browserMutationsEnabled(): boolean { return this.enabled; }

  verifyMutation(request: Request): BrowserMutationActorV1 {
    if (!this.enabled || !this.cookieAuthorized(request.headers.cookie)) {
      console.warn('[kogg:core:browser-auth] mutation.refused', { safeCode: 'authentication_required' });
      throw new BrowserMutationAuthorizationError('authentication_required');
    }
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
    const csrf = typeof request.headers['x-kogg-csrf'] === 'string' ? request.headers['x-kogg-csrf'] : '';
    if (origin !== this.expectedOrigin(request) || !this.equal(csrf, this.csrf)) {
      console.warn('[kogg:core:browser-auth] mutation.refused', { safeCode: 'mutation_authority_refused' });
      throw new BrowserMutationAuthorizationError('mutation_authority_refused');
    }
    console.info('[kogg:core:browser-auth] mutation.authorized', { role: 'owner' });
    return {
      sessionId: createHmac('sha256', this.token).update('kogg-browser-session-id-v1').digest('base64url'),
      actorAuthorityDigest: `sha256:${createHmac('sha256', this.token).update('kogg-browser-owner-authority-v1').digest('hex')}`,
      role: 'owner', originVerified: true, csrfVerified: true
    };
  }

  onStart(server: Server): void {
    if (!this.enabled) return;
    server.prependListener('upgrade', (request, socket: Socket) => {
      if (!this.authorized(request.headers.cookie, request.headers.authorization)) socket.destroy();
    });
  }

  private login(request: Request, response: Response): void {
    const submitted = typeof request.body?.token === 'string' ? request.body.token : '';
    if (!this.equal(submitted, this.token)) {
      response.status(401).type('html').send(this.loginPage('Invalid Kogg access token.'));
      return;
    }
    response.setHeader('Set-Cookie', this.cookie(this.session, 28_800));
    response.redirect(303, '/');
  }

  private authorized(cookieHeader?: string, authorization?: string): boolean {
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (bearer && this.equal(bearer, this.token)) return true;
    return this.cookieAuthorized(cookieHeader);
  }

  private cookieAuthorized(cookieHeader?: string): boolean {
    const cookies = new Map((cookieHeader ?? '').split(';').map(item => {
      const separator = item.indexOf('=');
      return separator < 0 ? [item.trim(), ''] : [item.slice(0, separator).trim(), item.slice(separator + 1)];
    }));
    return this.equal(cookies.get(COOKIE_NAME) ?? '', this.session);
  }

  private expectedOrigin(request: Request): string {
    const configured = process.env.KOGG_PUBLIC_ORIGIN; if (configured) return new URL(configured).origin;
    const host = request.headers.host ?? ''; let parsed: URL;
    try { parsed = new URL(`${request.protocol}://${host}`); } catch {
      // observability-exempt: An invalid Host is intentionally normalized to an origin mismatch and logged by verifyMutation.
      return '';
    }
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) return '';
    return parsed.origin;
  }

  private equal(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  }

  private cookie(value: string, maxAge: number): string {
    const secure = this.secureCookie ? '; Secure' : '';
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  private resolveSecureCookie(): boolean {
    const configured = process.env.KOGG_PUBLIC_ORIGIN;
    if (!configured) return false;
    const origin = new URL(configured);
    const loopback = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '::1';
    if (!loopback && origin.protocol !== 'https:') {
      throw new Error('KOGG_PUBLIC_ORIGIN must use HTTPS outside loopback development');
    }
    return origin.protocol === 'https:';
  }

  private required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for Kogg browser mode`);
    return value;
  }

  private loginPage(error = ''): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kogg Sign In</title><style>body{margin:0;background:#0b1020;color:#eef2ff;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{width:min(28rem,calc(100% - 3rem));padding:2rem;background:#151c31;border:1px solid #2d3858;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:.8rem;margin-top:.8rem;border-radius:8px}button{background:#7c5cff;color:white;border:0;font-weight:700}.error{color:#ff9f9f}</style></head><body><main><h1>Kogg</h1><p>Enter the single-user access token for this Kogg workspace.</p>${error ? `<p class="error">${error}</p>` : ''}<form method="post" action="/kogg/auth/login"><input name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">Open Kogg</button></form></main></body></html>`;
  }
}
