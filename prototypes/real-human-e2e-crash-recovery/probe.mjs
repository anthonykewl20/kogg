import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-e2e-recovery-prototype-'));
const workspace = path.join(temporary, 'repository');
const state = path.join(temporary, 'state');
const userData = path.join(temporary, 'electron-user-data');
const registryPort = await freePort();
const registryUrl = `http://127.0.0.1:${registryPort}`;
const runId = randomUUID();
const providerCanary = randomBytes(24).toString('base64url');
const python = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
const adapter = path.join(root, 'packages', 'kogg-kernel', 'python', 'kogg_ranex_adapter.py');
const provenance = path.join(root, 'vendor', 'ranex', 'PROVENANCE.json');
const events = [];
const fixtures = new Map();
let registry;
let application;
let preCrashDescendants = [];

try {
  await createRepository();
  registry = startFixture('provider-registry', process.execPath, ['packages/kogg-marketplace/lib/node/dev-registry.js'], {
    ...process.env, KOGG_ROOT: root, KOGG_REGISTRY_PORT: String(registryPort)
  });
  await waitForHttp(`${registryUrl}/health`, 30_000);
  readyFixture('provider-registry');

  application = await launchApplication();
  const first = await readyApplication(application);
  await trustWorkspace(first.page);
  await proveProviderBoundary(first.page, application);
  const debuggerProofs = [await attachRendererDebugger(first.page), await proveNodeDebugger(), await provePythonDebugger()];
  const before = await operationsPanel(first.page, application);
  const bridge = before.locator('[data-operation-row]').filter({ hasText: 'ranex-bridge' }).filter({ hasText: 'active' }).first();
  await bridge.waitFor({ timeout: 30_000 });
  assert.equal(await before.locator('section').first().locator('[data-operation-row]').count(), 1, 'the new-work queue must otherwise be empty');
  const operationShortId = operationIdFrom(await bridge.innerText());
  const oldTopLevel = await privateIdentity(application.process().pid);
  preCrashDescendants = await descendantIdentities(application.process().pid);
  events.push({ eventName: 'scenario.step.completed', stepId: 'active-child-visible', operationShortId });

  events.push({ eventName: 'application.crash.started', applicationKind: 'electron' });
  application.process().kill('SIGKILL');
  await waitForIdentityAbsent(oldTopLevel, 15_000);
  await Promise.race([application.close().catch(() => undefined), delay(5_000)]);
  application = undefined;
  events.push({ eventName: 'application.crash.completed', applicationKind: 'electron' });

  application = await launchApplication();
  const second = await readyApplication(application);
  await trustWorkspace(second.page);
  const after = await operationsPanel(second.page, application);
  const linuxQualified = process.platform === 'linux';
  const recoveryOutcome = linuxQualified ? 'recovered' : await visibleRecoveryOutcome(after);
  if (recoveryOutcome === 'recovered') {
    await after.getByText('Admission: enabled').waitFor({ timeout: 30_000 });
    const recovered = after.locator('[data-operation-row]').filter({ hasText: 'ranex-bridge' }).filter({ hasText: operationShortId }).filter({ hasText: 'recovered' }).first();
    await recovered.waitFor({ timeout: 30_000 });
    await after.locator('[data-operation-row]').filter({ hasText: 'ranex-bridge' }).filter({ hasText: 'active' }).first().waitFor({ timeout: 30_000 });
    events.push({ eventName: 'recovery.completed', operationShortId, admission: 'enabled' });
  } else {
    await after.getByText('Admission: blocked').waitFor({ timeout: 30_000 });
    const refused = after.locator('[data-operation-row]').filter({ hasText: 'ranex-bridge' }).filter({ hasText: operationShortId }).filter({ hasText: 'failed' }).filter({ hasText: 'PROCESS_IDENTITY_UNVERIFIED' }).first();
    await refused.waitFor({ timeout: 30_000 });
    events.push({ eventName: 'recovery.refused', operationShortId, admission: 'blocked', safeCode: 'PROCESS_IDENTITY_UNVERIFIED' });
  }

  await openCommand(second.page, 'Kogg: Run Diagnostics', application);
  const diagnosticsMessage = second.page.getByText(/Diagnostics: (?:PASS|WARN|FAIL)/u).first();
  await diagnosticsMessage.waitFor({ timeout: 30_000 });
  const diagnosticsOverall = (await diagnosticsMessage.innerText()).match(/Diagnostics: (PASS|WARN|FAIL)/u)?.[1]?.toLowerCase();
  assert.ok(diagnosticsOverall);
  if (recoveryOutcome === 'recovered') assert.notEqual(diagnosticsOverall, 'fail', 'successful reconciliation must not produce failing diagnostics');
  else assert.equal(diagnosticsOverall, 'fail', 'blocked admission must produce failing diagnostics');
  await second.page.keyboard.press('Escape');
  events.push({ eventName: 'scenario.step.completed', stepId: 'diagnostics-visible', diagnosticsOverall });

  await identityMismatchCalibration();
  const productResidualCount = await liveIdentityCount(preCrashDescendants);
  if (recoveryOutcome === 'recovered') assert.equal(productResidualCount, 0, 'successful recovery must leave no product residual');
  else assert.ok(productResidualCount > 0, 'unqualified recovery must preserve unverifiable product descendants');
  events.push({ eventName: 'residual-check.completed', residualCount: productResidualCount });

  await closeApplication(application);
  application = undefined;
  await cleanupFixture('provider-registry');
  registry = undefined;

  const manifest = {
    schemaVersion: 1, runId, platform: platform(), runtime: 'electron', state: recoveryOutcome === 'recovered' ? 'completed' : 'capability-refused',
    operationShortId, debugger: debuggerProofs, fixtures: [...fixtures.values()], events,
    residualCount: productResidualCount, artifactDecision: 'retained',
    productionDecision: linuxQualified ? 'retain-qualified-linux-reconciliation'
      : recoveryOutcome === 'recovered' ? 'retain-contained-lifetime-after-matrix-confirmation' : 'require-native-identity-or-contained-lifetime-before-production'
  };
  const serialized = JSON.stringify(manifest, null, 2);
  assertSafeArtifact(serialized);
  await writeFile(path.join(temporary, 'safe-manifest.json'), serialized, { mode: 0o600 });
  assert.deepEqual(JSON.parse(await readFile(path.join(temporary, 'safe-manifest.json'), 'utf8')), manifest);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
  process.stdout.write(`Issue #65 prototype passed: native crash/relaunch, visible ${recoveryOutcome}, ownership separation, identity calibration, and renderer/Node/Python debugger proof.\n`);
} finally {
  if (application) await closeApplication(application).catch(() => application?.process().kill());
  if (registry) await cleanupFixture('provider-registry').catch(() => registry?.kill());
  // Branch-only disposal safety net. A production harness must not use this to
  // convert the observed macOS/Windows capability refusal into a passing result.
  await disposeExactPrototypeDescendants(preCrashDescendants);
  await rm(temporary, { recursive: true, force: true });
}

async function createRepository() {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Kogg recovery prototype\n');
  assert.equal(spawnSync('git', ['init', '--quiet', workspace], { stdio: 'ignore' }).status, 0);
  assert.equal(spawnSync('git', ['-C', workspace, 'config', 'user.name', 'Kogg Prototype'], { stdio: 'ignore' }).status, 0);
  assert.equal(spawnSync('git', ['-C', workspace, 'config', 'user.email', 'kogg-prototype@example.invalid'], { stdio: 'ignore' }).status, 0);
  assert.equal(spawnSync('git', ['-C', workspace, 'add', '.'], { stdio: 'ignore' }).status, 0);
  assert.equal(spawnSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'prototype base'], { stdio: 'ignore' }).status, 0);
}

function startFixture(kind, command, args, env) {
  events.push({ eventName: 'fixture.registered', fixtureKind: kind });
  fixtures.set(kind, { kind, state: 'starting' });
  events.push({ eventName: 'fixture.started', fixtureKind: kind });
  const child = spawn(command, args, { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' });
  assert.ok(child.pid);
  if (kind === 'provider-registry') registry = child;
  return child;
}

function readyFixture(kind) {
  fixtures.set(kind, { kind, state: 'ready' });
  events.push({ eventName: 'fixture.ready', fixtureKind: kind });
}

async function cleanupFixture(kind) {
  const child = kind === 'provider-registry' ? registry : undefined;
  if (!child) return;
  events.push({ eventName: 'fixture.cleanup.started', fixtureKind: kind });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await waitForExit(child, 10_000);
  fixtures.set(kind, { kind, state: 'cleaned' });
  events.push({ eventName: 'fixture.cleanup.completed', fixtureKind: kind });
}

async function launchApplication() {
  events.push({ eventName: 'application.started', applicationKind: 'electron' });
  return electron.launch({
    executablePath: require('electron'),
    args: [path.join(root, 'apps/electron/lib/backend/electron-main.js'), `--electronUserData=${userData}`, workspace],
    env: {
      ...process.env, KOGG_RUNTIME: 'electron', KOGG_ROOT: root, KOGG_ELECTRON_UNBUNDLED: '1',
      KOGG_ELECTRON_ENTRYPOINT: path.join(root, 'apps/electron/lib/backend/electron-main.js'),
      KOGG_STATE_DIR: state, THEIA_CONFIG_DIR: path.join(state, 'config'), KOGG_REGISTRY_URL: registryUrl,
      THEIA_ELECTRON_DISABLE_NATIVE_ELEMENTS: '1'
    },
    timeout: 30_000
  });
}

async function readyApplication(app) {
  await app.firstWindow({ timeout: 30_000 });
  const page = await waitForKoggWindow(app);
  events.push({ eventName: 'application.ready', applicationKind: 'electron' });
  return { page };
}

async function closeApplication(app) {
  events.push({ eventName: 'application.close.started', applicationKind: 'electron' });
  const closed = await Promise.race([app.close().then(() => true, () => false), delay(15_000).then(() => false)]);
  if (!closed) {
    events.push({ eventName: 'application.close.timed-out', applicationKind: 'electron' });
    app.process().kill();
    throw new Error('Electron did not close within the prototype bound');
  }
  events.push({ eventName: 'application.close.completed', applicationKind: 'electron' });
}

async function proveProviderBoundary(page, app) {
  await openCommand(page, 'View: Toggle Kogg AI', app);
  const provider = page.locator('.kogg-provider-widget');
  await provider.getByText('Advisory only').waitFor({ timeout: 30_000 });
  await provider.getByLabel('Provider').selectOption('llamafile');
  await provider.getByLabel('Endpoint (optional)').fill(`${registryUrl}/provider/v1/models`);
  await provider.getByRole('button', { name: 'Discover models' }).click();
  await provider.getByText('Discovered 1 model(s).').waitFor({ timeout: 30_000 });
  events.push({ eventName: 'scenario.step.completed', stepId: 'provider-visible' });
}

async function attachRendererDebugger(page) {
  const session = await page.context().newCDPSession(page);
  const parsed = new Map();
  let resolvePause;
  const paused = new Promise(resolve => { resolvePause = resolve; });
  session.on('Debugger.scriptParsed', event => parsed.set(event.scriptId, event));
  session.on('Debugger.paused', event => {
    const frame = event.callFrames[0];
    resolvePause({ frame, script: parsed.get(frame.location.scriptId) });
    void session.send('Debugger.resume');
  });
  await session.send('Debugger.enable');
  await openCommand(page, 'Kogg: Show Operations', application);
  const proof = await Promise.race([paused, delay(15_000).then(() => { throw new Error('Renderer debugger marker was not reached'); })]);
  await session.detach();
  assert.match(proof.frame.functionName, /refresh/u);
  assert.ok(proof.script?.sourceMapURL, 'renderer script must expose a source map');
  events.push({ eventName: 'debugger.paused', runtime: 'electron-renderer', mappedSource: 'operations-widget.ts' });
  return { runtime: 'electron-renderer', mappedSource: 'operations-widget.ts', line: 31 };
}

async function proveNodeDebugger() {
  const target = path.join(root, 'prototypes', 'real-human-e2e-crash-recovery', 'debug-target.mjs');
  const child = spawn(process.execPath, ['--inspect-brk=0', target], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  const endpoint = await waitForValue(() => stderr.match(/ws:\/\/[^\s]+/u)?.[0], 5_000, 'Node inspector endpoint');
  const socket = new WebSocket(endpoint);
  const messages = [];
  socket.onmessage = message => messages.push(JSON.parse(String(message.data)));
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.send(JSON.stringify({ id: 1, method: 'Debugger.enable' }));
  socket.send(JSON.stringify({ id: 2, method: 'Runtime.runIfWaitingForDebugger' }));
  const initialPause = await waitForValue(() => messages.find(message => message.method === 'Debugger.paused'), 5_000, 'Node initial debugger pause');
  socket.send(JSON.stringify({ id: 3, method: 'Debugger.resume' }));
  const paused = await waitForValue(() => messages.find(message => message !== initialPause && message.method === 'Debugger.paused' && message.params.callFrames[0].location.lineNumber === 3), 5_000, 'Node source debugger pause');
  const registryScript = await waitForValue(() => messages.find(message => message.method === 'Debugger.scriptParsed' && /operation-registry\.js$/u.test(message.params.url)), 5_000, 'operation registry debug script');
  assert.ok(registryScript.params.sourceMapURL, 'Node operation registry must expose a source map');
  const map = JSON.parse(await readFile(path.join(root, 'packages', 'kogg-operations', 'lib', 'node', registryScript.params.sourceMapURL), 'utf8'));
  assert.ok(map.sources.some(source => /operation-registry\.ts$/u.test(source)), 'Node source map must name operation-registry.ts');
  assert.equal(paused.params.callFrames[0].location.lineNumber + 1, 4);
  events.push({ eventName: 'debugger.paused', runtime: 'node-backend', mappedSource: 'operation-registry.ts' });
  socket.send(JSON.stringify({ id: 4, method: 'Debugger.resume' }));
  await waitForValue(() => stdout.includes('kogg-e2e-recovery-debug-target'), 5_000, 'Node debugger target output');
  socket.close();
  await waitForExit(child, 5_000);
  return { runtime: 'node-backend', mappedSource: 'operation-registry.ts', line: 4 };
}

async function provePythonDebugger() {
  const child = spawn(python, ['-m', 'pdb', '-c', `break ${adapter}:169`, '-c', 'continue', adapter], {
    env: { ...process.env, PYTHONPATH: path.join(root, 'vendor', 'ranex', 'src'), KOGG_RANEX_PROVENANCE: provenance },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  const ranexCommit = JSON.parse(await readFile(provenance, 'utf8')).commit;
  child.stdin.write(`${JSON.stringify({ id: 'debug-handshake', method: 'handshake', params: { protocol: 'kogg-ranex-stdio', protocolVersion: 1, ranexCommit } })}\n`);
  await waitForValue(() => /kogg_ranex_adapter\.py\(169\)main\(\)/u.test(output), 5_000, 'Python source debugger pause');
  child.stdin.write('where\ndisable 1\ncontinue\n');
  await waitForValue(() => output.includes('debug-handshake'), 5_000, 'Python debug handshake');
  child.stdin.write(`${JSON.stringify({ id: 'debug-stop', method: 'shutdown', params: {} })}\n`);
  await waitForValue(() => output.includes('debug-stop'), 5_000, 'Python debug shutdown');
  child.stdin.write('quit\n');
  await waitForExit(child, 5_000);
  events.push({ eventName: 'debugger.paused', runtime: 'python-ranex', mappedSource: 'kogg_ranex_adapter.py' });
  return { runtime: 'python-ranex', mappedSource: 'kogg_ranex_adapter.py', line: 169 };
}

async function operationsPanel(page, app) {
  const widget = page.locator('.kogg-operations-widget').last();
  if (!await widget.count()) await openCommand(page, 'Kogg: Show Operations', app);
  await widget.waitFor({ state: 'attached', timeout: 30_000 });
  await widget.getByRole('button', { name: 'Refresh' }).click();
  return widget;
}

async function visibleRecoveryOutcome(panel) {
  return Promise.race([
    panel.getByText('Admission: enabled').waitFor({ timeout: 30_000 }).then(() => 'recovered'),
    panel.getByText('Admission: blocked').waitFor({ timeout: 30_000 }).then(() => 'refused')
  ]);
}

async function trustWorkspace(page) {
  const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
  await trust.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  if (await trust.isVisible().catch(() => false)) await trust.click();
}

async function openCommand(page, label, app) {
  const input = page.getByRole('textbox', { name: 'Type to narrow down results.' });
  const shortcuts = [process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P', 'F1', 'F1'];
  let visible = false;
  for (const shortcut of shortcuts) {
    await page.bringToFront();
    await page.locator('body').click({ position: { x: 600, y: 300 } });
    await page.keyboard.press(shortcut);
    visible = await input.waitFor({ state: 'visible', timeout: 2_500 }).then(() => true, () => false);
    if (visible) break;
  }
  if (!visible) {
    await app.evaluate(({ Menu }) => {
      const visit = items => items.some(item => /Command Palette/u.test(item.label ?? '') ? (item.click(), true) : item.submenu ? visit(item.submenu.items) : false);
      if (!visit(Menu.getApplicationMenu()?.items ?? [])) throw new Error('Command Palette menu item not found');
    });
    await input.waitFor({ state: 'visible', timeout: 10_000 });
  }
  await input.fill(`>${label}`);
  const option = page.locator('[role="option"]:visible').filter({ hasText: label }).first();
  await option.waitFor({ timeout: 30_000 });
  await option.click();
}

async function waitForKoggWindow(app) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) if (await page.locator('body.kogg-application').count().catch(() => 0)) return page;
    await delay(100);
  }
  throw new Error('Kogg Electron window did not become ready');
}

async function identityMismatchCalibration() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  assert.ok(child.pid);
  const identity = await privateIdentity(child.pid);
  const mismatch = { ...identity, fingerprint: `${identity.fingerprint}:mismatch` };
  assert.equal(await identityMatches(mismatch), false);
  assert.equal(await identityMatches(identity), true);
  events.push({ eventName: 'identity.calibration.refused', safeCode: 'PROCESS_IDENTITY_UNVERIFIED' });
  child.kill('SIGKILL');
  await waitForExit(child, 10_000);
}

async function descendantIdentities(rootPid) {
  const rows = processRows();
  const descendants = [];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const row of rows.filter(candidate => candidate.ppid === parent)) {
      queue.push(row.pid);
      descendants.push(await privateIdentity(row.pid));
    }
  }
  return descendants;
}

function processRows() {
  if (process.platform === 'win32') {
    const output = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8' }).stdout;
    const values = JSON.parse(output || '[]');
    return (Array.isArray(values) ? values : [values]).map(value => ({ pid: Number(value.ProcessId), ppid: Number(value.ParentProcessId) }));
  }
  return spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout.trim().split('\n').map(line => {
    const [pid, ppid] = line.trim().split(/\s+/u).map(Number); return { pid, ppid };
  }).filter(row => Number.isSafeInteger(row.pid));
}

async function privateIdentity(pid) {
  let fingerprint;
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    fingerprint = `linux:${boot}:${fields[19]}`;
  } else if (process.platform === 'win32') {
    fingerprint = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8' }).stdout.trim();
  } else {
    fingerprint = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  }
  assert.ok(fingerprint);
  return { pid, fingerprint };
}

async function identityMatches(identity) {
  try { return (await privateIdentity(identity.pid)).fingerprint === identity.fingerprint; }
  catch { return false; }
}

async function waitForIdentityAbsent(identity, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await identityMatches(identity)) return;
    await delay(100);
  }
  throw new Error('A pre-crash process identity remained live');
}

async function liveIdentityCount(identities) {
  let count = 0;
  for (const identity of identities) if (await identityMatches(identity)) count += 1;
  return count;
}

async function disposeExactPrototypeDescendants(identities) {
  for (const identity of identities) {
    if (!await identityMatches(identity)) continue;
    try { process.kill(identity.pid, 'SIGTERM'); } catch { continue; }
    await waitForIdentityAbsent(identity, 2_000).catch(() => {
      try { process.kill(identity.pid, 'SIGKILL'); } catch { /* already absent */ }
    });
    await waitForIdentityAbsent(identity, 2_000).catch(() => undefined);
  }
}

function operationIdFrom(text) {
  const id = text.match(/\b[0-9a-f]{8}\b/u)?.[0];
  assert.ok(id, 'visible operation row must expose a short correlation ID');
  return id;
}

function assertSafeArtifact(text) {
  assert.equal(text.includes(providerCanary), false);
  assert.doesNotMatch(text, /(?:\/Users\/|\/home\/|[A-Z]:\\|argv|environment|authorization|cookie|prompt|source code|provider body)/iu);
  assert.doesNotMatch(text, /(?:BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_|sk-[a-z0-9])/iu);
}

async function waitForHttp(url, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* bounded retry */ }
    await delay(100);
  }
  throw new Error('Fixture readiness timed out');
}

async function waitForValue(read, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`${label} timed out`);
}

async function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }),
    delay(timeout).then(() => { throw new Error('Harness-owned process cleanup timed out'); })
  ]);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); });
  });
}

function platform() { return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'; }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
