import { createHmac, timingSafeEqual } from 'node:crypto';
import { Server } from 'node:http';
import { Socket } from 'node:net';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { Application, NextFunction, Request, Response, urlencoded } from '@theia/core/shared/express';
import { injectable } from '@theia/core/shared/inversify';

const COOKIE_NAME = 'kogg_session';

@injectable()
export class BrowserAuthContribution implements BackendApplicationContribution {
  private readonly enabled = process.env.KOGG_RUNTIME === 'browser';
  private readonly token = this.enabled ? this.required('KOGG_AUTH_TOKEN') : '';
  private readonly session = this.enabled
    ? createHmac('sha256', this.token).update('kogg-browser-session-v1').digest('base64url')
    : '';

  configure(app: Application): void {
    if (!this.enabled) return;
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
    app.use((request: Request, response: Response, next: NextFunction) => {
      if (this.authorized(request.headers.cookie, request.headers.authorization)) next();
      else if (request.accepts('html')) response.redirect(303, '/kogg/auth/login');
      else response.status(401).json({ error: 'authentication_required' });
    });
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
    const cookies = new Map((cookieHeader ?? '').split(';').map(item => {
      const separator = item.indexOf('=');
      return separator < 0 ? [item.trim(), ''] : [item.slice(0, separator).trim(), item.slice(separator + 1)];
    }));
    return this.equal(cookies.get(COOKIE_NAME) ?? '', this.session);
  }

  private equal(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  }

  private cookie(value: string, maxAge: number): string {
    const origin = process.env.KOGG_PUBLIC_ORIGIN ?? '';
    const secure = origin.startsWith('https://') ? '; Secure' : '';
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
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
