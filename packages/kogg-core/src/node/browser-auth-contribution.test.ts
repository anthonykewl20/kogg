import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import test from 'node:test';
import express from '@theia/core/shared/express';
import { BrowserAuthContribution, BrowserMutationAuthorizationError } from './browser-auth-contribution';

test('browser authentication protects HTTP and WebSocket access with hardened cookies', async context => {
  const previous = {
    runtime: process.env.KOGG_RUNTIME,
    token: process.env.KOGG_AUTH_TOKEN,
    origin: process.env.KOGG_PUBLIC_ORIGIN
  };
  context.after(() => {
    restore('KOGG_RUNTIME', previous.runtime);
    restore('KOGG_AUTH_TOKEN', previous.token);
    restore('KOGG_PUBLIC_ORIGIN', previous.origin);
  });

  process.env.KOGG_RUNTIME = 'browser';
  process.env.KOGG_AUTH_TOKEN = 'unit-test-token';
  delete process.env.KOGG_PUBLIC_ORIGIN;

  const app = express();
  const contribution = new BrowserAuthContribution();
  contribution.configure(app);
  app.get('/protected', (_request, response) => response.status(200).send('ok'));
  app.post('/mutation', (request, response) => {
    try { response.status(200).json(contribution.verifyMutation(request)); }
    catch (error) { response.status(error instanceof BrowserMutationAuthorizationError && error.code === 'authentication_required' ? 401 : 403).json({ error: error instanceof BrowserMutationAuthorizationError ? error.code : 'unknown' }); }
  });
  const server = createServer(app);
  contribution.onStart(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(`${base}/protected`, { redirect: 'manual' });
  assert.equal(unauthorized.status, 303);
  assert.equal(unauthorized.headers.get('location'), '/kogg/auth/login');

  const invalid = await fetch(`${base}/kogg/auth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=wrong'
  });
  assert.equal(invalid.status, 401);

  const login = await fetch(`${base}/kogg/auth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=unit-test-token'
  });
  assert.equal(login.status, 303);
  const setCookie = login.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /; Secure/);
  const cookie = setCookie.split(';', 1)[0];
  assert(cookie);
  assert.equal((await fetch(`${base}/protected`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/protected`, { headers: { authorization: 'Bearer unit-test-token' } })).status, 200);
  const csrfResponse = await fetch(`${base}/kogg/auth/csrf`, { headers: { cookie } }); assert.equal(csrfResponse.status, 200);
  const csrf = String((await csrfResponse.json() as { csrfToken?: string }).csrfToken ?? ''); assert(csrf);
  const mutation = await fetch(`${base}/mutation`, { method: 'POST', headers: { cookie, origin: base, 'x-kogg-csrf': csrf } });
  assert.equal(mutation.status, 200); const actor = await mutation.json() as Record<string, unknown>;
  assert.deepEqual({ role: actor.role, originVerified: actor.originVerified, csrfVerified: actor.csrfVerified }, { role: 'owner', originVerified: true, csrfVerified: true });
  assert.equal((await fetch(`${base}/mutation`, { method: 'POST', headers: { cookie, origin: 'https://attacker.invalid', 'x-kogg-csrf': csrf } })).status, 403);
  assert.equal((await fetch(`${base}/mutation`, { method: 'POST', headers: { cookie, origin: base, 'x-kogg-csrf': 'wrong' } })).status, 403);
  assert.equal((await fetch(`${base}/mutation`, { method: 'POST', headers: { authorization: 'Bearer unit-test-token', origin: base, 'x-kogg-csrf': csrf } })).status, 401);

  await assertUpgradeIsRejected(address.port);

  process.env.KOGG_PUBLIC_ORIGIN = 'http://kogg.example';
  assert.throws(() => new BrowserAuthContribution(), /must use HTTPS/);
  process.env.KOGG_PUBLIC_ORIGIN = 'https://kogg.example';
  const secureApp = express();
  new BrowserAuthContribution().configure(secureApp);
  const secureServer = createServer(secureApp);
  await new Promise<void>(resolve => secureServer.listen(0, '127.0.0.1', resolve));
  context.after(() => secureServer.close());
  const secureAddress = secureServer.address();
  assert(secureAddress && typeof secureAddress !== 'string');
  const secureLogin = await fetch(`http://127.0.0.1:${secureAddress.port}/kogg/auth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=unit-test-token'
  });
  assert.match(secureLogin.headers.get('set-cookie') ?? '', /; Secure/);
});

function assertUpgradeIsRejected(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Unauthenticated WebSocket upgrade was not rejected'));
    }, 2_000);
    socket.once('connect', () => socket.write(
      'GET /services HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    ));
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
