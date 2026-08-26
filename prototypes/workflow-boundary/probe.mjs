// diagnostic-exempt: Disposable real-boundary prototype retained off production branches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-workflow-probe-'));
const workspace = path.join(temporary, 'workspace'); const state = path.join(temporary, 'state');
const workflowState = path.join(temporary, 'workflow-state'); const port = await freePort();
const appUrl = `http://127.0.0.1:${port}`; const token = 'workflow-probe-auth-token';
const contentCanary = 'WORKFLOW-PROBE-CONTENT-CANARY'; const logs = [];
let backend; let browser;

try {
  await mkdir(workspace, { recursive: true }); await writeFile(path.join(workspace, 'README.md'), 'workflow probe\n');
  backend = launchBackend(); await waitFor(`${appUrl}/kogg/auth/status`, 401);
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext(); const page = await context.newPage();
  page.on('console', entry => logs.push(`[frontend:${entry.type()}] ${entry.text()}`)); page.on('pageerror', error => logs.push(`[frontend:error] ${error.message}`));
  await login(page); await openWidget(page); let widget = page.locator('.kogg-workflow-prototype-widget:visible');
  const initialDigest = extractDigest(await widget.getByText(/template workflow-prototype-v1/u).innerText());

  await widget.getByRole('button', { name: 'Refuse cycle' }).click(); await widget.locator('[data-run-state]').filter({ hasText: 'WORKFLOW_CYCLE' }).waitFor();
  await widget.getByRole('button', { name: 'Refuse anchor bypass' }).click(); await widget.locator('[data-run-state]').filter({ hasText: 'WORKFLOW_ANCHOR_BYPASS' }).waitFor();
  await widget.getByRole('button', { name: 'Refuse authority expansion' }).click(); await widget.locator('[data-run-state]').filter({ hasText: 'WORKFLOW_AUTHORITY_EXPANSION' }).waitFor();

  await widget.getByRole('button', { name: /Run serial/u }).click(); await widget.locator('[data-run-state]').filter({ hasText: 'Run completed · WORKFLOW_OK' }).waitFor({ timeout: 15_000 });
  assert.match(await widget.innerText(), /implementation\.agent · completed/u); assert.match(await widget.innerText(), /control\.condition · completed/u);
  await widget.getByRole('button', { name: 'Run bounded retry' }).click(); await widget.locator('[data-node="parallel-b"]').filter({ hasText: 'attempt 2' }).waitFor({ timeout: 15_000 });
  assert.match(await widget.locator('[data-run-state]').innerText(), /Run completed · WORKFLOW_OK/u);
  await widget.getByRole('button', { name: 'Run cancellation' }).click(); await widget.locator('[data-run-state]').filter({ hasText: 'Run cancelled · WORKFLOW_CANCELLED' }).waitFor({ timeout: 15_000 });
  assert.match(await widget.locator('[data-run-state]').innerText(), /processes 0/u);

  const registrationCount = logs.filter(line => line.includes('[kogg:workflow:prototype] node.process.registered')).length;
  const pending = widget.getByRole('button', { name: 'Run cancellation' }).click();
  await widget.getByText(/Cancelling registered child/u).waitFor(); await waitForLogCount('[kogg:workflow:prototype] node.process.registered', registrationCount + 1); backend.kill('SIGKILL'); await waitForExit(backend, 5_000); await pending.catch(() => undefined);
  backend = launchBackend(); await waitFor(`${appUrl}/kogg/auth/status`, 401); await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('body.kogg-application').waitFor({ timeout: 20_000 }); await page.waitForTimeout(2_500); await openWidget(page); widget = page.locator('.kogg-workflow-prototype-widget:visible');
  await widget.locator('[data-run-state]').filter({ hasText: 'Run recovered · WORKFLOW_BACKEND_RESTARTED' }).waitFor({ timeout: 15_000 });
  assert.match(await widget.locator('[data-run-state]').innerText(), /processes 0/u);
  assert.equal(extractDigest(await widget.getByText(/template workflow-prototype-v1/u).innerText()), initialDigest);

  await stop(backend); backend = undefined; const joined = logs.join('\n');
  assert.doesNotMatch(joined, new RegExp(contentCanary, 'u'));
  for (const expected of ['[kogg:workflow:prototype] compile.refused', '[kogg:workflow:prototype] node.process.registered', '[kogg:workflow:prototype] node.cleanup.completed', '[kogg:workflow:prototype] recovery.completed', '[kogg:operations:process] process.registered']) assert.match(joined, new RegExp(escapeRegex(expected), 'u'));
  const maps = await readdir(path.join(root, 'apps/browser/lib/frontend')); assert(maps.some(name => name.endsWith('.map')));
  assert.match(joined, /Debugger listening on/u); assert.doesNotMatch(joined, /possible-residual|PROCESS_RESIDUAL/u);
  process.stdout.write('Kogg workflow real-boundary prototype passed.\n');
} catch (error) { process.stderr.write(`${logs.join('\n')}\n`); throw error; }
finally { if (browser) await browser.close().catch(() => undefined); await stop(backend); await rm(temporary, { recursive: true, force: true }); }

function launchBackend() {
  const child = spawn(process.execPath, ['--inspect=0', path.join(root, 'apps/browser/lib/backend/main.js'), '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env: { ...process.env, KOGG_RUNTIME: 'browser', KOGG_ROOT: root, KOGG_STATE_DIR: state, THEIA_CONFIG_DIR: path.join(state, 'config'), KOGG_AUTH_TOKEN: token, KOGG_MASTER_KEY: 'workflow-probe-master-key', KOGG_WORKFLOW_PROTOTYPE_DATA_DIR: workflowState }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => logs.push(`[backend] ${chunk}`)); child.stderr.on('data', chunk => logs.push(`[backend:error] ${chunk}`)); return child;
}
async function login(page) { await page.goto(appUrl); await page.waitForURL('**/kogg/auth/login'); await page.getByRole('textbox').fill(token); await Promise.all([page.waitForURL(`${appUrl}/`), page.getByRole('button', { name: 'Open Kogg' }).click()]); await page.goto(`${appUrl}/#${workspace}`); await page.locator('body.kogg-application').waitFor({ timeout: 20_000 }); const trust = page.getByRole('button', { name: 'Yes, I trust the authors' }); await trust.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined); if (await trust.isVisible().catch(() => false)) await trust.click(); }
async function openWidget(page) { const visible = page.locator('.kogg-workflow-prototype-widget:visible'); if (!await visible.count()) { const input = page.getByRole('textbox', { name: 'Type to narrow down results.' }); await page.locator('body').click({ position: { x: 600, y: 300 } }); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P'); await input.waitFor({ state: 'visible', timeout: 3_000 }).catch(async () => { await page.getByText('View', { exact: true }).click(); await page.getByRole('menuitem', { name: /Command Palette/u }).click(); await input.waitFor({ state: 'visible', timeout: 5_000 }); }); await input.fill('>View: Toggle Kogg Workflow Probe'); const option = page.locator('[role="option"]:visible').filter({ hasText: 'View: Toggle Kogg Workflow Probe' }).first(); await option.waitFor(); await option.click(); } await page.locator('.kogg-workflow-prototype-widget:visible').waitFor({ timeout: 10_000 }); }
function extractDigest(text) { assert.match(text, /template workflow-prototype-v1/u); return text.match(/digest ([0-9a-f]{64})/u)?.[1] ?? ''; }
async function waitFor(url, status) { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.status === status) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(`Timeout waiting for ${url}`); }
async function waitForLogCount(pattern, count) { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { if (logs.filter(line => line.includes(pattern)).length >= count) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`Timeout waiting for ${pattern}`); }
async function stop(child) { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await waitForExit(child, 5_000); if (child.exitCode === null) { child.kill('SIGKILL'); await waitForExit(child, 5_000); } }
async function waitForExit(child, timeout) { const deadline = Date.now() + timeout; while (child && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50)); }
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port'))); }); }); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
