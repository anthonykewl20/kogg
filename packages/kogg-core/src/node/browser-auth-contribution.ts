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
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><title>Kogg Sign In</title><style>
      :root{color-scheme:dark;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;background:#0b0b0e;color:#f4f4f5;-webkit-font-smoothing:antialiased}
      body:before,body:after{content:"";position:fixed;pointer-events:none;border-radius:999px;filter:blur(1px)}
      body:before{width:42rem;height:42rem;top:-24rem;right:-12rem;background:radial-gradient(circle,rgba(139,92,246,.16),transparent 68%)}
      body:after{width:34rem;height:34rem;bottom:-25rem;left:-10rem;background:radial-gradient(circle,rgba(91,33,182,.1),transparent 68%)}
      .noise{position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.09'/%3E%3C/svg%3E")}
      main{position:relative;width:min(25rem,calc(100% - 2rem));padding:1px;border-radius:18px;background:linear-gradient(145deg,rgba(255,255,255,.15),rgba(255,255,255,.035));box-shadow:0 32px 100px rgba(0,0,0,.55)}
      .card{padding:30px;border-radius:17px;background:linear-gradient(150deg,rgba(24,24,30,.97),rgba(16,16,20,.98));backdrop-filter:blur(20px)}
      .brand{display:flex;align-items:center;gap:10px;margin-bottom:32px;color:#d9d9e0;font-size:13px;font-weight:650;letter-spacing:-.01em}
      .mark{display:grid;place-items:center;width:29px;height:29px;border:1px solid rgba(167,139,250,.34);border-radius:9px;background:rgba(139,92,246,.13);box-shadow:inset 0 1px rgba(255,255,255,.08),0 0 24px rgba(139,92,246,.12)}
      .mark:before{content:"";width:9px;height:9px;border:2px solid #a78bfa;border-radius:3px;transform:rotate(45deg)}
      .eyebrow{margin:0 0 9px;color:#8b5cf6;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.12em}
      h1{margin:0 0 10px;font-size:25px;line-height:1.15;letter-spacing:-.035em;font-weight:680}
      .intro{margin:0 0 24px;color:#9696a1;font-size:13px;line-height:1.6}
      label{display:block;margin-bottom:7px;color:#b6b6bf;font-size:11px;font-weight:620;letter-spacing:.015em}
      input,button{width:100%;height:42px;border-radius:9px;font:inherit;outline:0;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease,transform .15s cubic-bezier(.2,.8,.2,1)}
      input{padding:0 12px;color:#f4f4f5;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12)}
      input:hover{border-color:rgba(255,255,255,.2)}input:focus{border-color:rgba(139,92,246,.85);box-shadow:0 0 0 3px rgba(139,92,246,.15)}
      button{margin-top:11px;color:white;background:#8b5cf6;border:1px solid rgba(255,255,255,.1);font-weight:630;cursor:pointer;box-shadow:inset 0 1px rgba(255,255,255,.14),0 5px 18px rgba(91,33,182,.22)}
      button:hover{background:#9d75f7;transform:translateY(-1px)}button:active{transform:translateY(0) scale(.99)}
      .error{margin:0 0 15px;padding:9px 11px;color:#fda4af;background:rgba(251,113,133,.08);border:1px solid rgba(251,113,133,.2);border-radius:8px;font-size:12px}
      .meta{display:flex;align-items:center;gap:7px;margin:18px 0 0;color:#666672;font-size:10px}.meta:before{content:"";width:6px;height:6px;border-radius:50%;background:#42d392;box-shadow:0 0 10px rgba(66,211,146,.5)}
      @media(prefers-reduced-motion:reduce){*{transition:none!important}}@media(max-width:420px){.card{padding:24px}.brand{margin-bottom:26px}}
    </style></head><body><div class="noise"></div><main><div class="card"><div class="brand"><span class="mark" aria-hidden="true"></span>Kogg</div><p class="eyebrow">Private workspace</p><h1>Welcome back</h1><p class="intro">Enter the single-user access token to open your governed engineering workspace.</p>${error ? `<p class="error" role="alert">${error}</p>` : ''}<form method="post" action="/kogg/auth/login"><label for="token">Access token</label><input id="token" name="token" type="password" autocomplete="current-password" placeholder="Enter workspace token" required autofocus><button type="submit">Open Kogg</button></form><p class="meta">Local, encrypted session</p></div></main></body></html>`;
  }
}
