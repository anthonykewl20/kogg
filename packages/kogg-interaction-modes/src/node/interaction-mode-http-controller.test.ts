import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserAuthContribution } from '@kogg/core/lib/node/browser-auth-contribution';
import type { TaskProjection } from '@kogg/tasks/lib/common/tasks-protocol';
import express from '@theia/core/shared/express';
import { InteractionModeHttpController } from './interaction-mode-http-controller';
import { InteractionModeRegistry } from './interaction-mode-registry';
import { ModeTransitionAuthority } from './mode-transition-authority';

// diagnostic-coverage: interaction-modes.transitions
test('admits transition intent only through authenticated same-origin CSRF-protected HTTP', { timeout: 20_000 }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-mode-http-'));
  const previous = { runtime: process.env.KOGG_RUNTIME, token: process.env.KOGG_AUTH_TOKEN, state: process.env.KOGG_STATE_DIR, origin: process.env.KOGG_PUBLIC_ORIGIN };
  process.env.KOGG_RUNTIME = 'browser'; process.env.KOGG_AUTH_TOKEN = 'http-test-token'; process.env.KOGG_STATE_DIR = root; delete process.env.KOGG_PUBLIC_ORIGIN;
  context.after(async () => { restore('KOGG_RUNTIME', previous.runtime); restore('KOGG_AUTH_TOKEN', previous.token); restore('KOGG_STATE_DIR', previous.state); restore('KOGG_PUBLIC_ORIGIN', previous.origin); await rm(root, { recursive: true, force: true }); });
  const browserAuth = new BrowserAuthContribution(); const transitionAuthority = new ModeTransitionAuthority();
  const registry = new InteractionModeRegistry(new TaskAuthority(), transitionAuthority); await registry.onStart(); context.after(() => registry.onStop());
  const controller = new InteractionModeHttpController(browserAuth, transitionAuthority, registry); const app = express(); browserAuth.configure(app); controller.configure(app);
  const server = createServer(app); const serverSockets = new Set<Socket>();
  server.on('connection', socket => { serverSockets.add(socket); socket.once('close', () => serverSockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeIdleConnections(); server.closeAllConnections(); for (const socket of serverSockets) socket.destroy(); await closed;
  });
  const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const login = await exchange(`${base}/kogg/auth/login`, 'POST', { 'content-type': 'application/x-www-form-urlencoded' }, 'token=http-test-token');
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';', 1)[0]; assert(cookie);
  const csrfResponse = await exchange(`${base}/kogg/auth/csrf`, 'GET', { cookie }); const csrf = String((csrfResponse.json() as { csrfToken?: string }).csrfToken ?? ''); assert(csrf);
  const request = { transitionId: '80000000-0000-4000-8000-000000000001', requestId: '80000000-0000-4000-8000-000000000002', taskId: TASK.taskId, expectedSequence: '0', fromMode: 'plan', toMode: 'build', requestedConfigurationDigest: `sha256:${'8'.repeat(64)}` };
  const refused = await post(`${base}/kogg/modes/transitions/request`, request, { cookie, origin: base, csrf: 'wrong' }); assert.equal(refused.status, 403); assert.equal(registry.diagnostics().transitionCount, 0);
  const accepted = await post(`${base}/kogg/modes/transitions/request`, request, { cookie, origin: base, csrf }); assert.equal(accepted.status, 200);
  const pending = accepted.json() as { state: string; safeCode: string; mode: { state: string } }; assert.equal(pending.state, 'awaiting-confirmation'); assert.equal(pending.safeCode, 'MODE_EXPANSION_CONFIRMATION_REQUIRED'); assert.equal(pending.mode.state, 'transition-pending');
  const cancel = { requestId: '80000000-0000-4000-8000-000000000003', transitionId: request.transitionId, taskId: TASK.taskId };
  const cancelled = await post(`${base}/kogg/modes/transitions/cancel`, cancel, { cookie, origin: base, csrf }); assert.equal(cancelled.status, 200); assert.equal((cancelled.json() as { state: string }).state, 'cancelled');
});

async function post(url: string, body: unknown, authority: { cookie: string; origin: string; csrf: string }): Promise<HttpResult> {
  return exchange(url, 'POST', { 'content-type': 'application/json', cookie: authority.cookie, origin: authority.origin, 'x-kogg-csrf': authority.csrf }, JSON.stringify(body));
}
interface HttpResult { readonly status: number; readonly headers: IncomingHttpHeaders; readonly bytes: Buffer; json(): unknown; }
function exchange(url: string, method: 'GET' | 'POST', headers: Readonly<Record<string, string>>, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, agent: false, headers: { ...headers, connection: 'close', ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject); response.once('end', () => {
        const bytes = Buffer.concat(chunks); response.destroy(); request.destroy(); resolve({ status: response.statusCode ?? 0, headers: response.headers, bytes, json: () => JSON.parse(bytes.toString('utf8')) as unknown });
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('HTTP test request timed out'))); request.once('error', reject); request.end(body);
  });
}
function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
class TaskAuthority { async get(taskId: string): Promise<TaskProjection> { return { ...TASK, taskId }; } }
const TASK: TaskProjection = { taskId: '90000000-0000-4000-8000-000000000001', projectId: '90000000-0000-4000-8000-000000000002', repositoryId: '90000000-0000-4000-8000-000000000003', bindingRevision: '1', taskRevision: '1', registryRevision: '1', lifecycle: 'active', currentSpecification: { specificationId: '90000000-0000-4000-8000-000000000004', sequence: '1', lifecycle: 'draft', content: 'canary', byteLength: 6, lineEnding: 'none', createdAt: '2026-08-27T00:00:00.000Z' } };
