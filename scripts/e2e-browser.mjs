import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { captureSafeFailureArtifacts } from './e2e-artifact-manager.mjs';
import { HarnessAbsoluteDeadline } from './e2e-deadline.mjs';
import { INCOMPLETE_DIAGNOSTICS, verifyProductDiagnostics } from './e2e-diagnostics.mjs';
import { HarnessProcessRegistry } from './e2e-process-registry.mjs';
import { HarnessRunManifest } from './e2e-run-manifest.mjs';
import { discover, platformCapabilities, selectedScenario } from './e2e-readiness.mjs';
import { FAILED_VERIFICATION, verifyHarnessEvidence } from './e2e-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRoot = path.join(root, 'test-results');
const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kogg-browser-e2e-'));
const workspace = path.join(temporary, 'workspace');
const secondaryRepository = path.join(temporary, 'secondary-repository');
const relocatedRepository = path.join(temporary, 'secondary-repository-relocated');
const secondaryGitDirectory = path.join(temporary, 'secondary-git-dir');
const additionalRepository = path.join(temporary, 'additional-repository');
const invalidRepository = path.join(temporary, 'not-a-repository');
const state = path.join(temporary, 'state');
const registryPort = await freePort();
const browserPort = await freePort();
const registryUrl = `http://127.0.0.1:${registryPort}`;
const appUrl = `http://127.0.0.1:${browserPort}`;
const token = 'kogg-disposable-e2e-token';
const masterKey = 'kogg-disposable-e2e-master-key';
const providerSecret = 'kogg-disposable-provider-secret';
const providerAccount = 'e2e-browser';
const logs = [];
const processes = new HarnessProcessRegistry({ logger: line => logs.push(line) });
const run = await HarnessRunManifest.create({ root: resultRoot, runtime: 'browser', capabilities: platformCapabilities('browser'), logger: line => logs.push(line) });
await run.starting();
let registry;
let backend;
let browser;
let completionMessage;
let productDiagnostics = INCOMPLETE_DIAGNOSTICS;
let settlement;
const absoluteDeadline = new HarnessAbsoluteDeadline({ runId: run.runId, runtime: run.runtime, platform: run.platform, logger: line => logs.push(line), onTimeout: error => settleRun(error) });
absoluteDeadline.start();

try {
    await createWorkspace();
    await mkdir(resultRoot, { recursive: true });
    registry = launch('signed-registry', process.execPath, ['packages/kogg-marketplace/lib/node/dev-registry.js'], {
        KOGG_ROOT: root, KOGG_REGISTRY_PORT: String(registryPort)
    });
    await waitFor(`${registryUrl}/health`);
    processes.ready(registry);
    backend = launchBrowser(token);
    await waitFor(`${appUrl}/kogg/auth/status`, 401);
    processes.ready(backend);

    const anonymousHtml = await fetch(`${appUrl}/`, { redirect: 'manual', headers: { accept: 'text/html' } });
    assert.equal(anonymousHtml.status, 303);
    assert.equal(anonymousHtml.headers.get('location'), '/kogg/auth/login');
    assert.equal((await fetch(`${appUrl}/services`, { headers: { accept: 'application/json' } })).status, 401);
    await assertUpgradeRejected(browserPort);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', entry => logs.push(`[frontend:${entry.type()}] ${entry.text()}`));
    page.on('pageerror', error => logs.push(`[frontend:error] ${error.stack ?? error.message}`));

    await page.goto(appUrl);
    await page.waitForURL('**/kogg/auth/login');
    assert.equal(await page.locator('h1').innerText(), 'Welcome back');
    await page.getByText('Kogg', { exact: true }).waitFor();
    await page.getByLabel('Access token').waitFor();
    await page.getByRole('textbox').fill('invalid');
    await page.getByRole('button', { name: 'Open Kogg' }).click();
    await page.getByText('Invalid Kogg access token.').waitFor();
    await page.getByRole('textbox').fill(token);
    await Promise.all([
        page.waitForURL(`${appUrl}/`),
        page.getByRole('button', { name: 'Open Kogg' }).click()
    ]);

    await page.goto(`${appUrl}/#${workspace}`);
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
    await trust.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    if (await trust.isVisible().catch(() => false)) {
        const dialog = page.locator('.workspace-trust-dialog');
        assert.doesNotMatch(await dialog.innerText(), /Theia|Open VSX/iu);
        await trust.click();
    }
    await page.waitForTimeout(2_000);
    assert.match(await page.title(), /^workspace(?: - Kogg)?$/u);
    await run.active(selectedScenario('browser'));

    if (process.env.KOGG_E2E_EXECUTION_ONLY === '1') {
        await exerciseExecution(page);
        await completeEarly(page, 'Kogg browser execution-refusal E2E passed.');
    }

    if (process.env.KOGG_E2E_PROJECTS_ONLY === '1') {
        await exerciseProjects(page);
        await completeEarly(page, 'Kogg browser Projects-only E2E passed.');
    }

    if (process.env.KOGG_E2E_TASKS_ONLY === '1') {
        await exerciseProjects(page);
        await exerciseTasks(page);
        await createInteractionModeFixture(page);
        await exerciseInteractionModes(page);
        await completeEarly(page, 'Kogg browser governed-tasks E2E passed.');
    }

    if (process.env.KOGG_E2E_OPERATIONS_ONLY === '1') {
        await exerciseOperationsStream(page);
        await completeEarly(page, 'Kogg browser operations-stream E2E passed.');
    }

    if (process.env.KOGG_E2E_WORKFLOW_ONLY === '1') {
        await exerciseProjects(page);
        await createWorkflowAdmissionFixture(page);
        await exerciseWorkflowEditor(page);
        await completeEarly(page, 'Kogg browser workflow-editor E2E passed.');
    }

    if (process.env.KOGG_E2E_VERDICT_MERGE_ONLY === '1') {
        await exerciseVerdictMerge(page);
        await completeEarly(page, 'Kogg browser verdict-merge visible-refusal E2E passed.');
    }

    await openCommand(page, 'Kogg: Run Diagnostics');
    await page.getByText(/Diagnostics: FAIL/su).first().waitFor({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await openCommand(page, 'Kogg: Export Diagnostic Support Bundle');
    const supportFiles = await waitForSupportBundle(path.join(state, 'support'));
    assert.equal(supportFiles.length, 1);
    const supportBundle = await readFile(path.join(state, 'support', supportFiles[0]), 'utf8');
    assert.equal(supportBundle.includes(token), false);
    assert.equal(supportBundle.includes(masterKey), false);
    await page.keyboard.press('Escape');

    await openCommand(page, 'Kogg: Open Marketplace');
    const marketplace = page.locator('.kogg-marketplace-widget');
    await marketplace.getByLabel('Search Kogg Marketplace').fill('kogg');
    await marketplace.getByRole('button', { name: 'Search' }).click();
    await marketplace.getByText('kogg.fixture').waitFor();
    assert.match(await marketplace.innerText(), /Signature verified/u);
    await marketplace.getByRole('button', { name: 'Install' }).click();
    await marketplace.getByText('kogg.fixture 0.1.0').last().waitFor();
    // Theia synchronizes a newly deployed extension host immediately, but its
    // already-open command registry is populated during frontend startup.
    // Reconnect exactly as a user would after installing a contribution.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    await openCommand(page, 'Kogg: Fixture: Verify Activation');
    await page.getByText('Kogg signed fixture 0.1.0 is active.').first().waitFor({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.locator('.theia-notifications-overlay').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);

    await marketplace.getByLabel('Search Kogg Marketplace').fill('kogg');
    await marketplace.getByRole('button', { name: 'Search' }).click();
    await marketplace.getByRole('button', { name: 'Reinstall' }).click();
    await marketplace.getByText('kogg.fixture 0.1.0').last().waitFor();
    await clearNotifications(page);
    await marketplace.getByRole('button', { name: 'Update' }).waitFor();
    await marketplace.getByRole('button', { name: 'Update' }).click();
    await marketplace.getByText('kogg.fixture 0.2.0').last().waitFor();
    await page.keyboard.press('Escape');
    await marketplace.getByRole('button', { name: 'Rollback' }).click();
    await marketplace.getByText('kogg.fixture 0.1.0').last().waitFor();
    await page.keyboard.press('Escape');
    await marketplace.getByRole('button', { name: 'Refresh revocations' }).click();
    await page.getByText('Kogg Marketplace revocations refreshed.').first().waitFor();
    await page.keyboard.press('Escape');
    await marketplace.getByRole('button', { name: 'Remove' }).click();
    await marketplace.getByText('None').waitFor();
    await page.keyboard.press('Escape');
    await marketplace.getByRole('button', { name: 'Install' }).click();
    await marketplace.getByText('kogg.fixture 0.1.0').last().waitFor();
    await clearNotifications(page);

    let provider = page.locator('.kogg-provider-widget:visible');
    if (!await provider.count()) {
        await openCommand(page, 'View: Toggle Kogg AI');
        provider = page.locator('.kogg-provider-widget:visible');
    }
    await provider.getByText('Kogg AI').first().waitFor();
    await provider.getByLabel('Message Kogg').waitFor({ state: 'visible' });
    assert.equal(await provider.getByLabel('Message Kogg').isDisabled(), true);
    const chatModes = provider.getByRole('group', { name: 'Chat mode' });
    for (const mode of ['Plan', 'Build', 'Kogg']) await chatModes.getByRole('button', { name: mode, exact: true }).waitFor();
    await provider.getByRole('button', { name: 'Connect a provider' }).click();
    await provider.locator('[data-provider-option="openai"]').click();
    await provider.getByLabel('Account').fill(providerAccount);
    await provider.getByRole('button', { name: 'Test connection' }).click();
    const missingCredential = provider.getByText('Credential is not configured');
    await missingCredential.scrollIntoViewIfNeeded();
    await missingCredential.waitFor();
    await provider.getByLabel('API key').fill(providerSecret);
    await provider.getByRole('button', { name: 'Save credential' }).click();
    await provider.getByText(`openai / ${providerAccount}`).waitFor();
    assert.doesNotMatch(await provider.innerText(), new RegExp(providerSecret, 'u'));
    await provider.locator('[data-provider-option="llamafile"]').click();
    await provider.getByLabel('Endpoint (optional)').fill('http://127.0.0.1:1/models');
    await provider.getByRole('button', { name: 'Test connection' }).click();
    await provider.getByText(/fetch failed|Connection failed/iu).waitFor();
    await provider.getByLabel('Endpoint (optional)').fill(`${registryUrl}/provider/v1/models`);
    await provider.getByRole('button', { name: 'Discover models' }).click();
    await provider.getByText('Discovered 1 model(s).').waitFor();
    await provider.getByLabel('Message Kogg').fill('Verify the disposable provider path.');
    await provider.getByRole('button', { name: 'Send message' }).click();
    await provider.getByText('Kogg provider fixture responded successfully.').waitFor();
    assert.match(await provider.innerText(), /Advisory only.*governed mutation blocked/isu);
    await provider.locator('li').filter({ hasText: `openai / ${providerAccount}` }).getByRole('button', { name: 'Delete' }).click();
    await provider.getByText('None. Secret values are never displayed.').waitFor();
    const encryptedCredentialFile = await readFile(path.join(state, 'credentials', 'browser.enc.json'), 'utf8');
    assert.equal(encryptedCredentialFile.includes(providerSecret), false);
    assert.equal(logs.join('\n').includes(providerSecret), false);
    await assertNoHorizontalOverflow(provider);

    await openCommand(page, 'View: Toggle Explorer');
    const explorer = page.getByRole('tabpanel', { name: /Explorer/u });
    await explorer.getByText('README.md').dblclick();
    const editor = page.locator('.monaco-editor').last();
    await editor.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
    await page.keyboard.type('\nMonaco user edit.');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');

    await openCommand(page, 'Search: Find in Files');
    const search = page.locator('#search-input-field');
    await search.fill('Monaco user edit');
    await search.press('Enter');
    await page.getByText('README.md').last().waitFor();

    // Headless Chromium on hosted Windows runners does not reliably expose the
    // xterm canvas. The task workflow below still proves Windows shell execution;
    // macOS and Linux exercise direct terminal input and its filesystem effect.
    if (process.platform !== 'win32') {
        await openCommand(page, 'Terminal: Create New Terminal');
        const terminalSurface = page.locator('.xterm-screen:visible').last();
        await terminalSurface.waitFor({ state: 'visible', timeout: 15_000 });
        await terminalSurface.click();
        await page.keyboard.type("printf 'KOGG_TERMINAL_E2E\\n' | tee .kogg-terminal-proof");
        await page.keyboard.press('Enter');
        await waitForWorkspaceProof('.kogg-terminal-proof', 'KOGG_TERMINAL_E2E');
    }

    await openCommand(page, 'Task: Run Task...');
    const taskChoice = page.getByRole('option', { name: /Kogg E2E Task/u });
    await taskChoice.waitFor({ state: 'visible', timeout: 10_000 });
    await taskChoice.click();
    await waitForWorkspaceProof('.kogg-task-proof', 'KOGG_TASK_E2E');

    await openCommand(page, 'View: Toggle Source Control');
    const sourceControl = page.getByRole('tabpanel', { name: /Source Control/u });
    await sourceControl.getByText('README.md').waitFor({ timeout: 15_000 });
    await openCommand(page, 'Git: Stage All Changes');
    await sourceControl.getByText('STAGED CHANGES').waitFor();
    await sourceControl.getByRole('textbox', { name: /Message/u }).fill('verify automated Kogg Git workflow');
    await sourceControl.getByRole('button', { name: /Commit$/u }).click();
    await sourceControl.getByText('CHANGES\n0').waitFor().catch(() => undefined);
    assert.equal(spawnSync('git', ['-C', workspace, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).stdout.trim(), 'verify automated Kogg Git workflow');
    await openCommand(page, 'Git: Refresh');
    await openCommand(page, 'Git: Create Branch...');
    const branchInput = page.locator('.quick-input-widget input').last();
    await branchInput.waitFor({ state: 'visible' });
    await branchInput.fill('kogg-e2e-branch');
    await branchInput.press('Enter');
    await waitForGitBranch('kogg-e2e-branch');

    // Hosted Windows Chromium does not render the floating debug toolbar. The
    // native Windows Electron workflow still requires the complete debug controls.
    if (process.platform !== 'win32') await exerciseNodeDebug(page, 'Kogg E2E Debug', 'KOGG_E2E_READY');

    await exerciseProjects(page);
    await exerciseExecution(page);
    await exerciseTasks(page);
    await createInteractionModeFixture(page);
    await exerciseInteractionModes(page);
    await exerciseTaskArchive(page);
    await exerciseOperations(page);
    await exerciseOperationsStream(page);
    await exerciseVerdictMerge(page);

    for (let cycle = 0; cycle < 25; cycle++) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('body.kogg-application').waitFor({ timeout: 15_000 });
    }
    await page.waitForTimeout(2_000);
    assert.doesNotMatch(logs.join('\n'), /Uncaught Exception:\s+Error: transport error/iu);

    productDiagnostics = await captureProductDiagnostics(page);
    await openCommand(page, 'Kogg: Sign Out');
    await page.waitForURL('**/kogg/auth/login');
    await page.getByRole('textbox').fill(token);
    await Promise.all([
        page.waitForURL(`${appUrl}/`),
        page.getByRole('button', { name: 'Open Kogg' }).click()
    ]);

    await stop(backend);
    backend = launchBrowser('rotated-disposable-token');
    await waitFor(`${appUrl}/kogg/auth/status`, 401);
    processes.ready(backend);
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/kogg/auth/login', { timeout: 15_000 });
    assert.equal((await page.locator('h1').innerText()), 'Welcome back');
    await page.getByText('Kogg', { exact: true }).waitFor();
    await page.getByLabel('Access token').waitFor();

    completionMessage = 'Kogg browser E2E passed: auth, branding, marketplace, provider, Git, debug, projects, restoration, and 25 reconnect cycles.';
} catch (error) {
    await settleRun(error);
} finally {
    if ((await run.read()).state !== 'completed' && (await run.read()).state !== 'failed') await settleRun();
}

async function settleRun(scenarioError) {
    settlement ??= settleRunOnce(scenarioError);
    return settlement;
}

async function settleRunOnce(scenarioError) {
    absoluteDeadline.complete();
    let cleanupError; let artifactError; let artifacts = []; let verification = FAILED_VERIFICATION;
    const state = await run.read(); if (['completed','failed'].includes(state.state)) { if (scenarioError) throw scenarioError; return; }
    if (!scenarioError && productDiagnostics.coverage !== 'complete') scenarioError = safeDiagnosticsError();
    if (!scenarioError) { try { verification = await verifyHarnessEvidence({ root, repository: workspace, runId: run.runId, runtime: run.runtime, platform: run.platform, profile: state.scenarioId === 'portable-surface' ? 'browser-portable' : 'browser-baseline', logger: line => logs.push(line) }); } catch (error) { scenarioError = error; } }
    if (state.state === 'active' && state.scenarioState === 'active') { try { if (scenarioError) await run.scenarioFailed(); else await run.scenarioCompleted(); } catch (error) { cleanupError = error; } }
    await run.cleaning(processes.manifest()).catch(error => { cleanupError = error; });
    if (browser) { await browser.close().catch(error => { cleanupError ??= error; }); browser = undefined; }
    await processes.cleanup().catch(error => { cleanupError ??= error; });
    if (scenarioError || cleanupError) { try { ({ artifacts } = await captureSafeFailureArtifacts({ root: resultRoot, runtime: 'browser', runId: run.runId, lifecycleLines: logs, error: scenarioError ?? cleanupError, logger: line => logs.push(line) })); } catch (error) { artifactError = error; } }
    const fixtures = processes.manifest(); const residualCount = fixtures.filter(value => value.state === 'residual').length; const failure = artifactError ?? cleanupError ?? scenarioError;
    if (failure) await run.failed({ fixtures, artifacts, residualCount, verification, productDiagnostics, safeCode: artifactError ? 'E2E_ARTIFACT_UNSAFE' : cleanupError ? 'E2E_PROCESS_RESIDUAL' : safeScenarioCode(scenarioError), errorType: safeErrorType(failure) }); else await run.completed({ fixtures, artifacts, residualCount, verification, productDiagnostics });
    if (!cleanupError) await rm(temporary, { recursive: true, force: true }); if (!failure && completionMessage) process.stdout.write(`${completionMessage}\n`);
    if (failure) { const safe = new Error(artifactError ? 'E2E_ARTIFACT_UNSAFE' : cleanupError ? 'E2E_PROCESS_RESIDUAL' : 'E2E_SCENARIO_FAILED'); safe.stack = safe.message; throw safe; }
}

async function completeEarly(page, message) { productDiagnostics = await captureProductDiagnostics(page); completionMessage = message; await settleRun(); process.exit(0); }
function safeErrorType(error) { return error?.name === 'AssertionError' ? 'AssertionError' : error?.name === 'TimeoutError' ? 'TimeoutError' : 'Error'; }
function safeScenarioCode(error) { return ['E2E_ABSOLUTE_TIMEOUT','E2E_DIAGNOSTICS_INCOMPLETE','E2E_ORACLE_MISMATCH','E2E_SOURCE_MAP_MISSING'].includes(error?.message) ? error.message : 'E2E_SCENARIO_FAILED'; }
function safeDiagnosticsError() { const error = new Error('E2E_DIAGNOSTICS_INCOMPLETE'); error.stack = error.message; return error; }

function launchBrowser(authToken) {
    return launch('browser-backend', process.execPath, [path.join(root, 'apps/browser/lib/backend/main.js'), `--plugins=local-dir:${path.join(root, 'plugins')}`, '--hostname', '127.0.0.1', '--port', String(browserPort)], {
        KOGG_RUNTIME: 'browser', KOGG_ROOT: root, KOGG_STATE_DIR: state,
        THEIA_CONFIG_DIR: path.join(state, 'config'), KOGG_AUTH_TOKEN: authToken,
        KOGG_MASTER_KEY: masterKey, KOGG_REGISTRY_URL: registryUrl
    });
}

function launch(kind, command, args, additions) {
    const child = processes.launch(kind, command, args, { cwd: root, env: { ...process.env, ...additions }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => logs.push(`[backend] ${chunk}`));
    child.stderr.on('data', chunk => logs.push(`[backend:error] ${chunk}`));
    return child;
}

async function stop(child) {
    if (child) await processes.stop(child);
}

async function waitForWorkspaceProof(name, expected) {
    const target = path.join(workspace, name);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if ((await readFile(target, 'utf8').catch(() => '')).includes(expected)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for visible workflow proof ${name}`);
}

async function waitForSupportBundle(directory, minimumCount = 1) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const files = await readdir(directory).catch(() => []);
        if (files.length >= minimumCount) return files;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the diagnostic support bundle export');
}

async function captureProductDiagnostics(page) {
    const directory = path.join(state, 'support');
    const before = (await readdir(directory).catch(() => [])).length;
    await openCommand(page, 'Kogg: Run Diagnostics');
    await page.getByText(/Diagnostics: (?:FAIL|WARN|PASS)/u).first().waitFor({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await openCommand(page, 'Kogg: Export Diagnostic Support Bundle');
    const files = (await waitForSupportBundle(directory, before + 1)).sort();
    const report = JSON.parse(await readFile(path.join(directory, files.at(-1)), 'utf8'));
    await page.keyboard.press('Escape');
    await clearNotifications(page);
    return verifyProductDiagnostics({ root, report, runId: run.runId, runtime: run.runtime, platform: run.platform, logger: line => logs.push(line) });
}

async function waitForGitBranch(expected) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const branch = spawnSync('git', ['-C', workspace, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
        if (branch === expected) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for Git branch: ${expected}`);
}

async function exerciseNodeDebug(page, configuration, expectedOutput) {
    const pauseTimeout = process.platform === 'win32' ? 60_000 : 20_000;
    const start = async () => {
        await openCommand(page, 'Debug: Select and Start Debugging');
        const choice = page.locator('[role="option"]:visible').filter({ hasText: configuration });
        await choice.waitFor({ state: 'visible', timeout: 10_000 });
        await choice.click();
        await page.locator('[title="Continue (F5)"]').waitFor({ state: 'visible', timeout: pauseTimeout });
    };
    await start();
    for (const title of ['Step Over', 'Step Into', 'Step Out', 'Restart', 'Stop']) {
        await page.locator(`[title^="${title}"]:visible`).waitFor({ state: 'visible' });
    }
    await page.getByText('VARIABLES').first().waitFor();
    await page.getByText('CALL STACK').first().waitFor();
    await page.locator('[title^="Restart"]:visible').evaluate(element => element.click());
    await page.waitForTimeout(500);
    await page.locator('[title="Continue (F5)"]').waitFor({ state: 'visible', timeout: pauseTimeout });
    await page.locator('[title^="Stop"]:visible').evaluate(element => element.click());
    await page.locator('[title="Continue (F5)"]').waitFor({ state: 'hidden', timeout: 10_000 });
    const startAction = page.locator('[title="Start Debugging"]:visible');
    await startAction.waitFor({ state: 'visible', timeout: 10_000 });
    await startAction.evaluate(element => element.click());
    await page.locator('[title="Continue (F5)"]').waitFor({ state: 'visible', timeout: pauseTimeout });
    await page.locator('[title="Continue (F5)"]:visible').evaluate(element => element.click());
    await page.getByText(expectedOutput).waitFor({ timeout: 10_000 });
}

async function waitFor(url, expected = 200) {
    await discover({ reason: 'fixture-readiness', runId: run.runId, runtime: run.runtime, platform: run.platform, logger: line => logs.push(line), probe: async () => (await fetch(url, { redirect: 'manual' })).status === expected });
}

async function openCommand(page, label) {
    const input = page.getByRole('textbox', { name: 'Type to narrow down results.' });
    await page.locator('body').click({ position: { x: 600, y: 300 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
    await input.waitFor({ state: 'visible', timeout: 3_000 }).catch(async () => {
        await page.getByText('View', { exact: true }).click();
        await page.getByRole('menuitem', { name: /Command Palette/u }).click();
        await input.waitFor({ state: 'visible', timeout: 5_000 });
    });
    await input.fill(`>${label}`);
    let option = page.locator(`[role="option"][aria-label="${label.replaceAll('"', '\\"')}"]:visible`);
    if (!await option.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false)) {
        option = page.locator('[role="option"]:visible').filter({ hasText: label }).first();
        await option.waitFor();
    }
    // Monaco virtualizes command results; dispatch through the confirmed row
    // so deeply scrolled workbench content cannot invalidate pointer geometry.
    await option.evaluate(element => element.click());
}

async function clearNotifications(page) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const clear = page.locator('.theia-notifications-overlay [title="Clear"]:visible').first();
        if (!await clear.isVisible().catch(() => false)) break;
        await clear.evaluate(element => element.click()).catch(() => undefined);
    }
    await page.locator('.theia-notifications-overlay [title="Clear All Notifications"]:visible').click().catch(() => undefined);
    await page.locator('.theia-notification-toasts.open, .theia-notification-center.open').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
}

async function createWorkspace() {
    await mkdir(path.join(workspace, '.theia'), { recursive: true });
    await writeFile(path.join(workspace, 'verify.mjs'), "debugger;\nconst message = 'KOGG_E2E_READY';\nconsole.log(message);\n");
    await writeFile(path.join(workspace, 'README.md'), '# Kogg E2E\n');
    await writeFile(path.join(workspace, '.theia', 'launch.json'), JSON.stringify({
        version: '0.2.0', configurations: [{
            name: 'Kogg E2E Debug', type: 'node', request: 'launch',
            runtimeExecutable: process.execPath, program: path.join(workspace, 'verify.mjs'), cwd: workspace,
            stopOnEntry: false
        }]
    }, null, 2));
    await writeFile(path.join(workspace, '.theia', 'tasks.json'), JSON.stringify({
        version: '2.0.0', tasks: [{ label: 'Kogg E2E Task', type: 'shell', command: "printf 'KOGG_TASK_E2E\\n' | tee .kogg-task-proof", problemMatcher: [] }]
    }, null, 2));
    spawnSync('git', ['init', workspace], { stdio: 'ignore' });
    spawnSync('git', ['-C', workspace, 'config', 'user.name', 'Kogg E2E'], { stdio: 'ignore' });
    spawnSync('git', ['-C', workspace, 'config', 'user.email', 'kogg-e2e@example.invalid'], { stdio: 'ignore' });
    spawnSync('git', ['-C', workspace, 'add', '.'], { stdio: 'ignore' });
    spawnSync('git', ['-C', workspace, 'commit', '-m', 'initial fixture'], { stdio: 'ignore' });
    await writeFile(path.join(workspace, 'README.md'), '# Kogg E2E\nHuman workflow change.\n');
    await initializeGitRepository(secondaryRepository, 'secondary fixture', secondaryGitDirectory);
    await initializeGitRepository(additionalRepository, 'additional fixture');
    await mkdir(invalidRepository);
}

async function initializeGitRepository(repository, subject, separateGitDirectory) {
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, 'README.md'), `# ${subject}\n`);
    const initArguments = separateGitDirectory
        ? ['init', '--quiet', `--separate-git-dir=${separateGitDirectory}`, repository]
        : ['init', '--quiet', repository];
    spawnSync('git', initArguments, { stdio: 'ignore' });
    spawnSync('git', ['-C', repository, 'config', 'user.name', 'Kogg E2E'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repository, 'config', 'user.email', 'kogg-e2e@example.invalid'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repository, 'add', '.'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repository, 'commit', '-m', subject], { stdio: 'ignore' });
}

async function exerciseProjects(page) {
    await closeBottomPanel(page);
    assert.equal(spawnSync('git', ['-C', await realpath(workspace), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim(), 'true');
    let projects = await ensureProjectsWidget(page);
    await createProjectThroughPicker(page, projects, 'Alpha', workspace);
    await waitForProjectText(projects, /Alpha/u);
    await createProjectThroughPicker(page, projects, 'Beta', secondaryRepository);
    await waitForProjectText(projects, /Beta/u);

    const alpha = projects.locator('[data-project-row]').filter({ hasText: 'Alpha' });
    if (await alpha.getByRole('button', { name: 'Manage' }).isEnabled()) await alpha.getByRole('button', { name: 'Manage' }).click();
    await projects.getByLabel('Repository name').fill('Shared tools');
    await Promise.all([
        chooseFolder(page, additionalRepository),
        projects.getByRole('button', { name: 'Choose and add repository' }).click()
    ]);
    await waitForProjectText(projects, /2 repositories · available/u);
    await projects.getByLabel('Execution profile').selectOption('restricted');
    await waitForProjectText(projects, /Project registry updated/iu);
    await projects.getByLabel('Role').selectOption('worker');
    await projects.getByLabel('Provider configuration').fill('ollama:default');
    await projects.getByLabel('Model').fill('fixture-model');
    await projects.getByRole('button', { name: 'Assign role' }).click();
    await waitForProjectText(projects, /worker → ollama:default \/ fixture-model/u);
    await projects.getByLabel('Task ID').fill('task-alpha');
    await projects.getByLabel('Task repository').selectOption({ label: 'Shared tools' });
    await projects.getByRole('button', { name: 'Bind task' }).click();
    await waitForProjectText(projects, /task-alpha → Shared tools/u);
    await projects.getByLabel('Task ID').fill('task-alpha');
    await projects.getByLabel('Task repository').selectOption({ label: 'Alpha' });
    await projects.getByRole('button', { name: 'Bind task' }).click();
    await waitForProjectText(projects, /task-alpha → Alpha/u);
    assert.equal((await projects.textContent()).match(/task-alpha →/gu)?.length, 1);

    await createProjectThroughPicker(page, projects, 'Duplicate', workspace);
    await projects.getByRole('status').filter({ hasText: /already registered/iu }).waitFor();
    await createProjectThroughPicker(page, projects, 'Invalid', invalidRepository);
    await projects.getByRole('status').filter({ hasText: /valid Git worktree/iu }).waitFor();
    assert.equal(await projects.locator('[data-project-row]').count(), 2);
    await clearNotifications(page);

    await projects.locator('[data-project-row]').filter({ hasText: 'Beta' }).getByRole('button', { name: 'Switch' }).click();
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    await trustWorkspace(page);
    projects = await ensureProjectsWidget(page);
    projects = await retryProjectSwitchAfterRestoreRace(page, projects, 'Beta');
    await waitForProjectText(projects, /Beta[\s\S]*Active/u);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    projects = await ensureProjectsWidget(page);
    const manageAlpha = projects.locator('[data-project-row]').filter({ hasText: 'Alpha' }).getByRole('button', { name: 'Manage' });
    if (await manageAlpha.isEnabled()) await manageAlpha.click();
    await waitForProjectText(projects, /worker → ollama:default \/ fixture-model/u);
    await waitForProjectText(projects, /task-alpha → Alpha/u);
    await projects.locator('[data-project-row]').filter({ hasText: 'Alpha' }).getByRole('button', { name: 'Switch' }).click();
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    await trustWorkspace(page);
    projects = await ensureProjectsWidget(page);
    projects = await retryProjectSwitchAfterRestoreRace(page, projects, 'Alpha');
    await waitForProjectText(projects, /Alpha[\s\S]*Active/u);

    // Windows does not permit a watched workspace directory to be renamed.
    // Model the real offline-relocation workflow by closing Kogg before the
    // repository moves, then verify startup reconciliation after relaunch.
    await stop(backend);
    backend = undefined;
    await renameWhenReleased(secondaryRepository, relocatedRepository);
    backend = launchBrowser(token);
    await waitFor(`${appUrl}/kogg/auth/status`, 401);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    projects = await ensureProjectsWidget(page);
    let unavailableBeta = projects.locator('[data-project-row]').filter({ hasText: 'Beta' });
    await waitForProjectText(unavailableBeta, /unavailable/u);
    assert.equal(await unavailableBeta.locator('button[data-switch]').evaluate(button => button.disabled), true);
    assert.equal(await projects.locator('[data-project-row]').filter({ hasText: 'Alpha' }).locator('button[data-remove-project]').evaluate(button => button.disabled), true);

    await openCommand(page, 'Kogg: Run Diagnostics');
    await page.getByText(/Diagnostics: (?:WARN|FAIL)/u).first().waitFor({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    const supportDirectory = path.join(state, 'support');
    const supportCount = (await readdir(supportDirectory).catch(() => [])).length;
    await openCommand(page, 'Kogg: Export Diagnostic Support Bundle');
    const supportFiles = (await waitForSupportBundle(supportDirectory, supportCount + 1)).sort();
    const supportReport = JSON.parse(await readFile(path.join(supportDirectory, supportFiles.at(-1)), 'utf8'));
    assert.equal(supportReport.checks.find(check => check.id === 'projects.repositories')?.status, 'warn');
    assert.equal(supportReport.checks.find(check => check.id === 'projects.processes')?.status, 'pass');
    for (const id of ['operations.registry', 'operations.recovery', 'operations.processes', 'operations.cleanup', 'operations.admission']) {
        assert.equal(supportReport.checks.find(check => check.id === id)?.status, 'pass', id);
    }
    await page.keyboard.press('Escape');
    assert.match(logs.join('\n'), /repository\.revalidation\.completed/iu);
    assert.match(logs.join('\n'), /repository\.process\.cleanup\.completed/iu);

    projects = await ensureProjectsWidget(page);
    unavailableBeta = projects.locator('[data-project-row]').filter({ hasText: 'Beta' });
    await unavailableBeta.getByRole('button', { name: 'Manage' }).click();
    await Promise.all([
        chooseFolder(page, relocatedRepository),
        projects.getByRole('button', { name: 'Relocate' }).click()
    ]);
    await waitForProjectText(projects.locator('[data-project-row]').filter({ hasText: 'Beta' }), /· available/u);
    assert.equal(await projects.locator('[data-project-row]').filter({ hasText: 'Beta' }).locator('button[data-switch]').evaluate(button => button.disabled), false);

    await stop(backend);
    backend = launchBrowser(token);
    await waitFor(`${appUrl}/kogg/auth/status`, 401);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    projects = await ensureProjectsWidget(page);
    await waitForProjectText(projects, /Alpha[\s\S]*Active/u);
    await waitForProjectText(projects.locator('[data-project-row]').filter({ hasText: 'Beta' }), /· available/u);

    // Exercise every remaining Projects mutation with reversible fixture data.
    const manageActiveAlpha = projects.locator('[data-project-row]').filter({ hasText: 'Alpha' }).getByRole('button', { name: 'Manage' });
    if (await manageActiveAlpha.isEnabled()) await manageActiveAlpha.click();
    await projects.getByLabel('Project name', { exact: true }).fill('Alpha renamed');
    await projects.getByRole('button', { name: 'Rename' }).click();
    await waitForProjectText(projects, /Alpha renamed/u);
    await projects.getByLabel('Project name', { exact: true }).fill('Alpha');
    await projects.getByRole('button', { name: 'Rename' }).click();
    await waitForProjectText(projects, /Manage Alpha/u);
    await projects.locator('li').filter({ hasText: /worker →/u }).getByRole('button', { name: 'Clear' }).click();
    await waitForProjectText(projects, /No role assignments/u);
    await projects.getByLabel('Role').selectOption('worker');
    await projects.getByLabel('Provider configuration').fill('ollama:default');
    await projects.getByLabel('Model').fill('fixture-model');
    await projects.getByRole('button', { name: 'Assign role' }).click();
    await waitForProjectText(projects, /worker → ollama:default/u);
    await projects.locator('li').filter({ hasText: /task-alpha →/u }).getByRole('button', { name: 'Clear' }).click();
    await waitForProjectText(projects, /No task repository bindings/u);
    const sharedRepository = projects.locator('article').filter({ hasText: /Shared tools/u });
    await sharedRepository.getByRole('button', { name: 'Remove' }).click();
    await acceptConfirmation(page, /Remove repository from project/iu);
    await waitForProjectText(projects, /1 repository · available/u);
    const beta = projects.locator('[data-project-row]').filter({ hasText: 'Beta' });
    await beta.getByRole('button', { name: 'Remove' }).click();
    await acceptConfirmation(page, /Remove project from Kogg/iu);
    await beta.waitFor({ state: 'detached', timeout: 10_000 });
}

async function closeBottomPanel(page) {
    const bottom = page.locator('#theia-bottom-content-panel');
    if (!await bottom.count()) return;
    const height = await bottom.evaluate(element => element.getBoundingClientRect().height);
    if (height > 40) {
        await page.getByRole('button', { name: 'Toggle Bottom Panel' }).click();
        await page.waitForTimeout(250);
    }
}

async function renameWhenReleased(source, destination) {
    const deadline = Date.now() + 15_000;
    for (;;) {
        try {
            await rename(source, destination);
            return;
        } catch (error) {
            if (error?.code !== 'EBUSY' || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
}

async function waitForProjectText(locator, pattern) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (pattern.test(await locator.textContent().catch(() => ''))) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for visible Projects state: ${pattern}`);
}

async function trustWorkspace(page) {
    const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
    await trust.waitFor({ state: 'visible', timeout: 20_000 });
    await trust.click();
    await page.locator('.workspace-trust-dialog').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
}

async function ensureProjectsWidget(page) {
    const widgets = page.locator('.kogg-projects-widget');
    if (!await widgets.count()) {
        for (let attempt = 0; attempt < 3 && !await widgets.count(); attempt++) {
            await openCommand(page, 'View: Toggle Kogg Projects');
            await widgets.first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => undefined);
            if (!await widgets.count()) await page.waitForTimeout(500);
        }
        await widgets.first().waitFor({ state: 'attached', timeout: 30_000 });
    }
    let active = await renderedWidget(widgets);
    if (active.area === 0) {
        const existingTab = page.locator('.lm-TabBar-tab:visible, .p-TabBar-tab:visible, [role="tab"]:visible').filter({ hasText: 'Kogg Projects' }).first();
        if (await existingTab.isVisible().catch(() => false)) await existingTab.click();
        else await openCommand(page, 'View: Toggle Kogg Projects');
        await page.waitForTimeout(250);
        active = await renderedWidget(widgets);
    }
    assert(active.area > 0);
    const widget = widgets.nth(active.index);
    const deadline = Date.now() + 10_000;
    while (/Loading projects/iu.test(await widget.textContent().catch(() => 'Loading projects')) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.doesNotMatch(await widget.textContent(), /Loading projects/iu);
    return widget;
}

async function exerciseTasks(page) {
    const canary = 'KOGG_TASK_PRIVATE_CANARY_83';
    const planRepositoryBefore = repositorySnapshot(workspace);
    let tasks = await ensureTasksWidget(page);
    await tasks.getByLabel('Line endings').selectOption('crlf');
    await tasks.getByLabel('Initial specification').fill(canary + '\nInitial requirement\n');
    await tasks.getByRole('button', { name: 'Create task' }).click();
    await tasks.getByText(/Revision 1 · active · draft/iu).waitFor({ timeout: 10_000 });
    await tasks.locator('p').filter({ hasText: /bytes · CRLF/u }).waitFor();
    const second = await page.context().newPage();
    await second.goto(page.url(), { waitUntil: 'domcontentloaded' });
    await second.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    const secondTasks = await ensureTasksWidget(second);
    await secondTasks.locator('[data-task]').first().click();
    await tasks.locator('[data-specification]').fill(canary + '\nWinner edit\n');
    await tasks.getByRole('button', { name: 'Save draft' }).click();
    await tasks.getByText(/Revision 2 · active · draft/iu).waitFor();
    await secondTasks.locator('[data-specification]').fill(canary + '\nPreserved losing edit\n');
    await secondTasks.getByRole('button', { name: 'Save draft' }).click();
    await secondTasks.getByRole('status').filter({ hasText: /changed elsewhere/iu }).waitFor();
    assert.match(await secondTasks.locator('[data-specification]').inputValue(), /Preserved losing edit/u);
    await second.close();
    await tasks.getByRole('button', { name: 'Freeze exact revision' }).click();
    await tasks.getByText(/active · frozen/iu).waitFor();
    await tasks.getByRole('button', { name: 'Review for approval' }).click();
    await tasks.locator('.kogg-review').getByText(canary).waitFor();
    await tasks.getByRole('button', { name: 'Approve this exact revision' }).click();
    await tasks.getByRole('button', { name: /Revoke approval/u }).waitFor();
    assert.equal(repositorySnapshot(workspace), planRepositoryBefore, 'Plan task artifacts must not change production Git state');
    await tasks.getByLabel('Existing run ID').fill('44444444-4444-4444-8444-444444444444');
    await tasks.getByRole('button', { name: 'Authorize exact task admission' }).click();
    const admission = tasks.locator('[data-admission-id]');
    await admission.waitFor();
    const admissionId = (await admission.innerText()).match(/[0-9a-f-]{36}/u)?.[0];
    assert.ok(admissionId);
    await exerciseAgents(page, admissionId);
    tasks = await ensureTasksWidget(page);
    await tasks.getByRole('button', { name: /Revoke approval/u }).click();
    // Wait for the backend-confirmed revocation projection before issuing the
    // successor mutation. On slower Windows runners the previous test raced the
    // two RPCs and could exercise a legitimate revision conflict instead.
    await tasks.getByRole('button', { name: 'Review for approval' }).waitFor();
    await tasks.getByRole('button', { name: 'Create successor draft' }).click();
    await tasks.getByText(/active · draft/iu).waitFor();
    await stop(backend); backend = launchBrowser(token);
    await waitFor(appUrl + '/kogg/auth/status', 401);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2_000);
    tasks = await ensureTasksWidget(page);
    await tasks.getByText(/active · draft/iu).waitFor();
    assert.match(await tasks.locator('[data-specification]').inputValue(), /Winner edit/u);
    const agents = await ensureAgentsWidget(page);
    await agents.getByText(/cleaned · AGENT_OK/u).first().waitFor();
    await openCommand(page, 'Kogg: Run Diagnostics');
    await page.getByText(/Diagnostics: FAIL.*passed/iu).first().waitFor({ timeout: 15_000 });
    const supportDirectory = path.join(state, 'support');
    const supportCount = (await readdir(supportDirectory).catch(() => [])).length;
    await openCommand(page, 'Kogg: Export Diagnostic Support Bundle');
    const supportFiles = (await waitForSupportBundle(supportDirectory, supportCount + 1)).sort();
    const supportReport = JSON.parse(await readFile(path.join(supportDirectory, supportFiles.at(-1)), 'utf8'));
    for (const id of ['tasks.registry', 'tasks.revisions', 'tasks.bindings', 'tasks.approvals', 'agents.adapters', 'agents.attempts', 'agents.processes', 'agents.recovery', 'agents.logging', 'agents.source-maps']) {
        assert.equal(supportReport.checks.find(check => check.id === id)?.status, 'pass', id);
    }
    for (const id of ['claude.artifact', 'claude.legal', 'claude.settings', 'claude.protocol', 'claude.credentials']) {
        const check = supportReport.checks.find(candidate => candidate.id === id);
        assert.equal(check?.status, 'fail');
        assert.equal(check?.details?.safeCode, 'CLAUDE_LEGAL_APPROVAL_REQUIRED');
    }
    const claudeAuthority = supportReport.checks.find(check => check.id === 'claude.authority');
    assert.equal(claudeAuthority?.status, 'fail');
    assert.equal(claudeAuthority?.details?.safeCode, 'CLAUDE_ATTEMPT_INVALID');
    for (const id of ['claude.processes', 'claude.cleanup', 'claude.recovery']) {
        const check = supportReport.checks.find(candidate => candidate.id === id);
        assert.equal(check?.status, 'fail', id);
        assert.equal(check?.details?.safeCode, 'CLAUDE_RECOVERY_REQUIRED', id);
    }
    assert.equal(supportReport.checks.find(check => check.id === 'claude.source-maps')?.status, 'pass');
    for (const id of ['workflow.catalog', 'workflow.authority']) {
        assert.equal(supportReport.checks.find(check => check.id === id)?.status, 'fail', id);
    }
    for (const id of ['workflow.scheduler', 'workflow.accessibility']) {
        assert.equal(supportReport.checks.find(check => check.id === id)?.status, 'pass', id);
    }
    await page.keyboard.press('Escape');
    assert.equal(logs.join('\n').includes(canary), false);
}

async function createWorkflowAdmissionFixture(page) {
    const tasks = await ensureTasksWidget(page);
    await tasks.getByLabel('Initial specification').fill('Authorize the exact workflow UI admission fixture.');
    await tasks.getByRole('button', { name: 'Create task' }).click();
    await tasks.getByText(/Revision 1 · active · draft/iu).waitFor({ timeout: 10_000 });
    await tasks.getByRole('button', { name: 'Freeze exact revision' }).click();
    await tasks.getByRole('button', { name: 'Review for approval' }).click();
    await tasks.getByRole('button', { name: 'Approve this exact revision' }).click();
    await tasks.getByLabel('Existing run ID').fill('47474747-4747-4747-8747-474747474747');
    await tasks.getByRole('button', { name: 'Authorize exact task admission' }).click();
    await tasks.locator('[data-admission-id]').waitFor({ timeout: 10_000 });
}

function repositorySnapshot(repository) {
    const refs = spawnSync('git', ['-C', repository, 'for-each-ref', '--format=%(refname):%(objectname)'], { encoding: 'utf8' });
    const status = spawnSync('git', ['-C', repository, 'status', '--porcelain=v2', '--branch'], { encoding: 'utf8' });
    assert.equal(refs.status, 0); assert.equal(status.status, 0); return `${refs.stdout}\n${status.stdout}`;
}

async function exerciseAgents(page, admissionId) {
    const agents = await ensureAgentsWidget(page);
    await agents.locator('[data-adapter-row="codex-app-server@1.0.0"]').filter({ hasText: /disabled · codex\.app-server-v2 1\.0\.0/iu }).waitFor();
    await agents.locator('[data-adapter-row="claude-agent-sdk@1.0.0"]').filter({ hasText: /disabled · claude\.agent-sdk 1\.0\.0/iu }).waitFor();
    await agents.getByRole('button', { name: 'Save immutable revision' }).click();
    await agents.locator('section').filter({ hasText: 'Role Revisions' }).locator('li').filter({ hasText: /implementer · [0-9a-f-]{36}/u }).waitFor();
    await waitForAgentIdle(agents);
    const implementerRoleId = await roleOptionValue(agents, 'implementer');
    await agents.getByLabel('Task admission ID').fill(admissionId);
    await agents.getByLabel('Role revision').selectOption(implementerRoleId);
    await agents.getByLabel('Exact adapter and version').fill('kogg.fixture@1.0.0');
    await agents.getByLabel('Provider', { exact: true }).fill('kogg.fixture');
    await agents.getByLabel('Model', { exact: true }).fill('fixture.echo');
    await agents.getByLabel('Deadline policy').fill('interactive-v1');
    assert.equal(await agents.locator('form[data-start]').evaluate(form => form.checkValidity()), true);
    await agents.getByRole('button', { name: 'Confirm and start exact attempt' }).click();
    await agents.getByText(/cleaned · AGENT_OK.*deadline policy interactive-v1.*activity 1.*usage complete\/provider-cumulative.*resources 0/iu).waitFor({ timeout: 15_000 });
    await waitForAgentIdle(agents);
    await agents.getByLabel('Task admission ID').fill(admissionId);
    await agents.getByLabel('Exact adapter and version').fill('missing.adapter@1.0.0');
    await agents.getByRole('button', { name: 'Confirm and start exact attempt' }).click();
    await agents.getByText(/cleaned · ADAPTER_UNAVAILABLE.*resources 0/iu).waitFor({ timeout: 10_000 });
    await waitForAgentIdle(agents);

    await agents.getByLabel('Role key', { exact: true }).fill('codex-refusal');
    await agents.getByLabel('Display name').fill('Codex refusal probe');
    await agents.getByLabel('Provider IDs').fill('openai');
    await agents.getByLabel('Model IDs').fill('gpt-5');
    await agents.getByRole('button', { name: 'Save immutable revision' }).click();
    await agents.locator('section').filter({ hasText: 'Role Revisions' }).locator('li').filter({ hasText: /codex-refusal · [0-9a-f-]{36}/u }).waitFor();
    await waitForAgentIdle(agents);
    const codexRoleId = await roleOptionValue(agents, 'codex-refusal');
    await agents.getByLabel('Task admission ID').fill(admissionId);
    await agents.getByLabel('Role revision').selectOption(codexRoleId);
    await agents.getByLabel('Exact adapter and version').fill('codex-app-server@1.0.0');
    await agents.getByLabel('Provider', { exact: true }).fill('openai');
    await agents.getByLabel('Model', { exact: true }).fill('gpt-5');
    await agents.getByRole('button', { name: 'Confirm and start exact attempt' }).click();
    await agents.getByText(/cleaned · ADAPTER_DISABLED.*codex-app-server@1\.0\.0.*openai\/gpt-5.*resources 0/iu).waitFor({ timeout: 10_000 });
    await agents.getByText('The exact adapter is registered but disabled; no process or provider request was started.').waitFor();
    await waitForAgentIdle(agents);

    await agents.getByLabel('Role key', { exact: true }).fill('claude-refusal');
    await agents.getByLabel('Display name').fill('Claude refusal probe');
    await agents.getByLabel('Provider IDs').fill('anthropic');
    await agents.getByLabel('Model IDs').fill('claude-sonnet-4-5');
    await agents.getByRole('button', { name: 'Save immutable revision' }).click();
    await agents.locator('section').filter({ hasText: 'Role Revisions' }).locator('li').filter({ hasText: /claude-refusal · [0-9a-f-]{36}/u }).waitFor();
    await waitForAgentIdle(agents);
    const claudeRoleId = await roleOptionValue(agents, 'claude-refusal');
    await agents.getByLabel('Task admission ID').fill(admissionId);
    await agents.getByLabel('Role revision').selectOption(claudeRoleId);
    await agents.getByLabel('Exact adapter and version').fill('claude-agent-sdk@1.0.0');
    await agents.getByLabel('Provider', { exact: true }).fill('anthropic');
    await agents.getByLabel('Model', { exact: true }).fill('claude-sonnet-4-5');
    await agents.getByRole('button', { name: 'Confirm and start exact attempt' }).click();
    await agents.getByText(/cleaned · ADAPTER_DISABLED.*claude-agent-sdk@1\.0\.0.*anthropic\/claude-sonnet-4-5.*resources 0/iu).waitFor({ timeout: 10_000 });
    await waitForAgentIdle(agents);

    await agents.getByLabel('Role key', { exact: true }).fill('coordinator');
    await agents.getByLabel('Display name').fill('Coordinator');
    await agents.getByLabel('Model IDs').fill('fixture.hang,fixture.echo');
    await agents.getByLabel('Child creation').selectOption('true');
    await agents.getByLabel('Permitted child role keys').fill('implementer');
    await agents.getByLabel('Maximum child depth').fill('2');
    await agents.getByLabel('Maximum direct children').fill('2');
    await agents.getByRole('button', { name: 'Save immutable revision' }).click();
    await agents.locator('section').filter({ hasText: 'Role Revisions' }).locator('li').filter({ hasText: /coordinator · [0-9a-f-]{36}/u }).waitFor();
    await waitForAgentIdle(agents);
    const coordinatorRoleId = await roleOptionValue(agents, 'coordinator');
    await agents.getByLabel('Task admission ID').fill(admissionId);
    await agents.getByLabel('Role revision').selectOption(coordinatorRoleId);
    await agents.getByLabel('Model', { exact: true }).fill('fixture.hang');
    await agents.getByRole('button', { name: 'Confirm and start exact attempt' }).click();
    const parent = agents.locator('[data-attempt]').filter({ hasText: /ready.*fixture\.hang.*children 0.*resources 1/iu }).first();
    await parent.waitFor({ timeout: 15_000 }); const parentAttemptId = await parent.getAttribute('data-attempt'); assert.ok(parentAttemptId);
    await waitForAgentIdle(agents);

    await agents.getByLabel('Role key', { exact: true }).fill('implementer');
    await agents.getByLabel('Display name').fill('Expanded implementer');
    await agents.getByLabel('Tool policies').fill('read-only,write');
    await agents.getByRole('button', { name: 'Save immutable revision' }).click();
    await agents.locator('section').filter({ hasText: 'Role Revisions' }).locator('li').filter({ hasText: /implementer · [0-9a-f-]{36}/u }).nth(1).waitFor();
    await waitForAgentIdle(agents);
    await agents.getByLabel('Task admission ID').fill(admissionId);
    const expandedRoleId = await roleOptionValue(agents, 'implementer', new Set([implementerRoleId]));
    await agents.getByLabel('Role revision').selectOption(expandedRoleId);
    await agents.getByLabel('Parent attempt').selectOption(parentAttemptId);
    await agents.getByLabel('Model', { exact: true }).fill('fixture.echo');
    await agents.getByRole('button', { name: 'Confirm and start exact attempt' }).click();
    await agents.locator('[data-attempt]').filter({ hasText: /cleaned · CHILD_AUTHORITY_EXPANSION.*resources 0/iu }).waitFor({ timeout: 10_000 });
    await agents.locator(`[data-attempt="${parentAttemptId}"]`).filter({ hasText: /children 0.*resources 1/iu }).waitFor();
    await waitForAgentIdle(agents);

    await agents.getByLabel('Task admission ID').fill(admissionId);
    await agents.getByLabel('Role revision').selectOption(implementerRoleId);
    await agents.getByLabel('Parent attempt').selectOption(parentAttemptId);
    await agents.getByLabel('Model', { exact: true }).fill('fixture.echo');
    await agents.getByRole('button', { name: 'Confirm and start exact attempt' }).click();
    await agents.locator('[data-attempt]').filter({ hasText: new RegExp(`cleaned · AGENT_OK.*parent ${parentAttemptId.slice(0, 8)}.*resources 0`, 'iu') }).waitFor({ timeout: 15_000 });
    await waitForAgentIdle(agents);
    const currentParent = agents.locator(`[data-attempt="${parentAttemptId}"]`); await currentParent.filter({ hasText: /children 1.*resources 1/iu }).waitFor(); await currentParent.getByRole('button', { name: 'Cancel' }).click();
    await agents.locator(`[data-attempt="${parentAttemptId}"]`).filter({ hasText: /cleaned · CANCELLED.*children 1.*resources 0/iu }).waitFor({ timeout: 15_000 });
    await agents.getByRole('button', { name: 'Refresh' }).click();
    await agents.getByRole('status').filter({ hasText: /Agent registry ready/iu }).waitFor();
}

async function roleOptionValue(agents, roleKey, excluded = new Set()) {
    const options = agents.getByLabel('Role revision').locator('option');
    const count = await options.count();
    for (let index = 0; index < count; index++) {
        const option = options.nth(index); if ((await option.textContent())?.startsWith(`${roleKey} ·`)) { const value = await option.getAttribute('value'); if (value && !excluded.has(value)) return value; }
    }
    throw new Error(`Role option ${roleKey} is missing`);
}

async function waitForEnabled(locator, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await locator.isEnabled().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out waiting for enabled control');
}

async function waitForAgentIdle(agents) {
    await waitForEnabled(agents.getByRole('button', { name: 'Save immutable revision' }));
    await waitForEnabled(agents.getByRole('button', { name: 'Confirm and start exact attempt' }));
}

async function ensureAgentsWidget(page) {
    const widgets = page.locator('.kogg-agents-widget:visible');
    if (!await widgets.count()) {
        await openCommand(page, 'View: Toggle Kogg Agents');
        await widgets.first().waitFor({ state: 'visible', timeout: 30_000 });
    }
    const widget = widgets.first();
    const deadline = Date.now() + 10_000;
    while (/Loading agent registry/iu.test(await widget.textContent().catch(() => 'Loading agent registry')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.doesNotMatch(await widget.textContent(), /Loading agent registry/iu);
    return widget;
}

async function ensureTasksWidget(page) {
    const widgets = page.locator('.kogg-tasks-widget:visible');
    if (!await widgets.count()) {
        await openCommand(page, 'View: Toggle Kogg Tasks');
        // Windows CI can still be restoring the saved shell layout after the
        // command has resolved. Keep this aligned with the shell-start bound
        // used above instead of treating a slow render as a missing widget.
        await widgets.first().waitFor({ state: 'visible', timeout: 30_000 });
    }
    const widget = widgets.first();
    const deadline = Date.now() + 10_000;
    while (/Loading tasks/iu.test(await widget.textContent().catch(() => 'Loading tasks')) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.doesNotMatch(await widget.textContent(), /Loading tasks/iu);
    return widget;
}

async function ensureOperationsWidget(page) {
    const widgets = page.locator('.kogg-operations-widget:visible');
    if (!await widgets.count()) {
        await openCommand(page, 'Kogg: Show Operations').catch(() => openCommand(page, 'View: Toggle Kogg Operations'));
        await widgets.first().waitFor({ state: 'visible', timeout: 30_000 });
    }
    const widget = widgets.first();
    await widget.getByText(/Admission:\s+(?:enabled|recovering|blocked)/u).waitFor({ timeout: 15_000 });
    await widget.getByRole('status').filter({ hasText: /Stream: current.*sequence \d+/u }).waitFor({ timeout: 15_000 });
    return widget;
}

async function exerciseWorkflowEditor(page) {
    const widgets = page.locator('.kogg-workflow-editor-widget:visible');
    if (!await widgets.count()) {
        await openCommand(page, 'View: Toggle Kogg Workflow Editor');
        await widgets.first().waitFor({ state: 'visible', timeout: 30_000 });
    }
    let widget = widgets.first();
    await widget.getByText('Structured workflow outline ready.').waitFor({ timeout: 15_000 });
    assert.equal(await widget.locator('[data-workflow-node]').count(), 2);
    await widget.getByRole('button', { name: 'Show spatial canvas' }).click();
    assert.equal(await widget.locator('[data-workflow-canvas-node]').count(), 2);
    await widget.getByLabel('Node kind').selectOption('check.deterministic');
    await widget.getByRole('button', { name: 'Add node' }).click();
    await widget.getByRole('button', { name: 'Move check.deterministic earlier on canvas' }).click();
    await widget.getByRole('button', { name: 'Configure check.deterministic on canvas' }).click();
    let configuration = widget.locator('[data-config]');
    await configuration.getByLabel('Closed check ID').fill('suite.required-v1'); await configuration.getByLabel('External configuration digest').fill('a'.repeat(64));
    await configuration.getByRole('button', { name: 'Apply exact configuration' }).click();
    await widget.getByRole('button', { name: 'Configure implementation.agent on canvas' }).click();
    configuration = widget.locator('[data-config]');
    await configuration.getByLabel('Role revision ID').fill('60000000-0000-4000-8000-000000000001');
    await configuration.getByLabel('Provider ID').fill('kogg.fixture'); await configuration.getByLabel('Model ID').fill('fixture.echo');
    await configuration.getByLabel('Adapter key').fill('kogg.fixture'); await configuration.getByLabel('Adapter version').fill('1.0.0'); await configuration.getByLabel('Deadline policy').fill('interactive-v1');
    await configuration.getByRole('button', { name: 'Apply exact configuration' }).click();
    await widget.getByRole('button', { name: 'Configure research.agent on canvas' }).click(); configuration = widget.locator('[data-config]');
    await configuration.getByLabel('Role revision ID').fill('60000000-0000-4000-8000-000000000002'); await configuration.getByLabel('Provider ID').fill('kogg.fixture.read'); await configuration.getByLabel('Model ID').fill('fixture.research');
    await configuration.getByLabel('Adapter key').fill('kogg.fixture'); await configuration.getByLabel('Adapter version').fill('1.0.0'); await configuration.getByLabel('Deadline policy').fill('research-v1'); await configuration.getByLabel('Maximum attempts').selectOption('2'); await configuration.getByLabel('Retry backoff').selectOption('1000'); await configuration.getByLabel('Retry side-effect policy').selectOption('fresh-authority'); await configuration.getByRole('button', { name: 'Apply exact configuration' }).click();
    await widget.getByRole('button', { name: 'Show structured outline' }).click();
    assert.equal(await widget.locator('[data-workflow-node]').count(), 3);
    assert.match(await widget.locator('[data-workflow-node]').nth(1).innerText(), /check\.deterministic/u);
    configuration = widget.locator('[data-config]'); assert.equal(await configuration.getByLabel('Role revision ID').inputValue(), '60000000-0000-4000-8000-000000000002'); assert.equal(await configuration.getByLabel('Maximum attempts').inputValue(), '2'); assert.equal(await configuration.getByLabel('Retry backoff').inputValue(), '1000'); assert.equal(await configuration.getByLabel('Retry side-effect policy').inputValue(), 'fresh-authority');
    await widget.getByRole('button', { name: 'Configure check.deterministic' }).click(); configuration = widget.locator('[data-config]'); assert.equal(await configuration.getByLabel('Closed check ID').inputValue(), 'suite.required-v1'); assert.equal(await configuration.getByLabel('External configuration digest').inputValue(), 'a'.repeat(64));
    await widget.getByRole('button', { name: 'Disconnect connection 1' }).click();
    await widget.getByRole('button', { name: 'Disconnect connection 1' }).click();
    const connection = widget.locator('[data-connect]');
    await connection.getByLabel('Source node').selectOption({ label: '1. research.agent' });
    await connection.getByLabel('Source outcome').selectOption('failure');
    await connection.getByLabel('Target node').selectOption({ label: '2. check.deterministic' });
    await connection.getByRole('button', { name: 'Connect nodes' }).click();
    await connection.getByLabel('Source node').selectOption({ label: '2. check.deterministic' });
    await connection.getByLabel('Source outcome').selectOption('success');
    await connection.getByLabel('Target node').selectOption({ label: '3. implementation.agent' });
    await connection.getByRole('button', { name: 'Connect nodes' }).click();
    const failureRoute = widget.getByLabel('Route 1. research.agent to 2. check.deterministic');
    await failureRoute.selectOption('failure');
    await widget.getByRole('button', { name: 'Apply connection outcomes' }).click();
    await widget.getByText('Connection outcomes applied; validate before saving.').waitFor();
    assert.equal(await failureRoute.inputValue(), 'failure');
    await widget.getByRole('button', { name: 'Add parallel fork and join' }).click();
    await widget.getByText('Two-branch parallel fork and exact join added; configure branches and validate before saving.').waitFor();
    assert.equal(await widget.locator('[data-workflow-node]').count(), 7);
    await widget.getByRole('button', { name: 'Group selected with previous node' }).click();
    await widget.getByText('Visual group created with two explicit members; execution graph is unchanged.').waitFor();
    assert.match(await widget.getByLabel('Workflow visual groups').innerText(), /2 visible members/u);
    await widget.getByRole('button', { name: 'Validate workflow' }).click();
    await widget.getByText(/Workflow valid: 7 nodes and 7 edges/u).waitFor({ timeout: 10_000 });
    await widget.getByRole('button', { name: 'Save immutable version' }).click();
    await widget.getByText('Workflow version 1 saved immutably.').waitFor({ timeout: 10_000 });
    await widget.getByRole('button', { name: 'Compile current version' }).click();
    await widget.getByText(/Compiled plan [0-9a-f]{8} with 9 mandatory anchors/u).waitFor({ timeout: 10_000 });
    const admissionChoices = widget.getByLabel('Task admission').locator('option');
    if (await admissionChoices.count() > 1) {
        assert.match(await admissionChoices.nth(1).innerText(), /Task [0-9a-f]{8} · run [0-9a-f]{8}/u);
        await widget.getByRole('button', { name: 'Start governed workflow' }).click();
        await widget.getByText(/Workflow operation failed safely: WORKFLOW_AUTHORITY_EXPANSION/u).waitFor({ timeout: 10_000 });
        assert.match(logs.join('\n'), /\[kogg:interaction-modes:service\] mode\.operation\.refused[\s\S]*?operation: 'governed-entry'/u);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    widget = page.locator('.kogg-workflow-editor-widget:visible').filter({ hasText: 'Workflow version 1 is current.' }).first();
    await widget.waitFor({ state: 'visible', timeout: 15_000 });
    assert.match(logs.join('\n'), /\[kogg:workflow:editor\] ui\.operation\.completed/u);
    assert.match(logs.join('\n'), /\[kogg:interaction-modes:service\] mode\.selected[\s\S]*?selectedMode: 'plan'/u);
    assert.doesNotMatch(await widget.innerText(), /configurationDigest|requestedEffects|graphDigest|catalogDigest/u);
}

async function exerciseVerdictMerge(page) {
    const widgets = page.locator('.kogg-verdict-merge-widget:visible');
    if (!await widgets.count()) {
        await openCommand(page, 'View: Toggle Kogg Verdict & Merge');
        await widgets.first().waitFor({ state: 'visible', timeout: 30_000 });
    }
    const widget = widgets.first();
    await widget.getByRole('heading', { name: 'Verdict & controlled merge' }).waitFor({ timeout: 15_000 });
    await widget.getByRole('button', { name: 'Refresh verdicts' }).click();
    await widget.getByText('No governed verdicts are available.').waitFor({ timeout: 15_000 });
    assert.equal(await widget.getByRole('button', { name: 'Authorize and merge' }).count(), 0);
    assert.match(logs.join('\n'), /\[kogg:verdict:service\] candidates\.completed/u);
}

async function exerciseHostileModeTransitions(page) {
    // A manipulated frontend holding a fully valid session must still be
    // refused at the backend authority boundary.
    const refusals = await page.evaluate(async () => {
        const csrfResponse = await fetch('/kogg/auth/csrf', { cache: 'no-store', credentials: 'same-origin' });
        const csrfToken = csrfResponse.ok ? String((await csrfResponse.json()).csrfToken ?? '') : '';
        const post = async (path, body) => {
            const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-kogg-csrf': csrfToken }, body: JSON.stringify(body) });
            return { status: response.status, error: String((await response.json().catch(() => ({}))).error ?? '') };
        };
        const digest = `sha256:${'0'.repeat(64)}`;
        const invalidMode = await post('/kogg/modes/transitions/request', { transitionId: crypto.randomUUID(), requestId: crypto.randomUUID(), taskId: crypto.randomUUID(), expectedSequence: '0', fromMode: 'plan', toMode: 'override', requestedConfigurationDigest: digest });
        const unknownTask = await post('/kogg/modes/transitions/request', { transitionId: crypto.randomUUID(), requestId: crypto.randomUUID(), taskId: crypto.randomUUID(), expectedSequence: '0', fromMode: 'plan', toMode: 'build', requestedConfigurationDigest: digest });
        const configuration = { schemaVersion: 1, kind: 'build', roleRevisionId: crypto.randomUUID(), providerId: 'fixture', modelId: 'fixture.echo', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', deadlinePolicyId: 'standard', targetId: 'qualified-linux' };
        const fabricatedConfirm = await post('/kogg/modes/transitions/confirm', { requestId: crypto.randomUUID(), transitionId: crypto.randomUUID(), taskId: crypto.randomUUID(), explicitGesture: true, configuration });
        return { invalidMode, unknownTask, fabricatedConfirm };
    });
    assert.equal(`${refusals.invalidMode.status}:${refusals.invalidMode.error}`, '400:MODE_PROTOCOL_INVALID');
    assert.equal(`${refusals.unknownTask.status}:${refusals.unknownTask.error}`, '503:MODE_TASK_UNAVAILABLE');
    assert.equal(`${refusals.fabricatedConfirm.status}:${refusals.fabricatedConfirm.error}`, '409:MODE_TRANSITION_CONFLICT');
    assert.match(logs.join('\n'), /\[kogg:interaction-modes:http\] transition\.request\.failed[\s\S]*?safeCode: 'MODE_PROTOCOL_INVALID'/u);
    assert.match(logs.join('\n'), /\[kogg:interaction-modes:http\] transition\.confirm\.failed[\s\S]*?safeCode: 'MODE_TRANSITION_CONFLICT'/u);
}

async function exerciseInteractionModes(page) {
    const selector = page.getByLabel(/Mode: Plan; authority: \d+ bounded capabilities; stage: research/u);
    await selector.waitFor({ state: 'visible', timeout: 15_000 });
    await exerciseHostileModeTransitions(page);
    assert.match(logs.join('\n'), /\[kogg:interaction-modes:service\] mode\.operation\.approved[\s\S]*?operation: 'research'/u);
    let provider = page.locator('.kogg-provider-widget:visible');
    if (!await provider.count()) {
        await openCommand(page, 'View: Toggle Kogg AI');
        provider = page.locator('.kogg-provider-widget:visible');
    }
    const chatModes = provider.getByRole('group', { name: 'Chat mode' });
    await chatModes.getByRole('button', { name: 'Build', exact: true }).click();
    await page.getByRole('button', { name: 'Request switch' }).click();
    const pending = page.getByLabel(/Mode: Plan; authority: disabled during transition/u);
    const unavailable = page.getByText(/Mode switch unavailable: no current Build owner configuration is qualified/u).first();
    const deadline = Date.now() + 10_000;
    while (!await pending.isVisible().catch(() => false) && !await unavailable.isVisible().catch(() => false) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (!await pending.isVisible().catch(() => false)) {
        await unavailable.waitFor({ state: 'visible', timeout: 1_000 });
        await selector.waitFor({ state: 'visible', timeout: 1_000 });
        assert.match(logs.join('\n'), /\[kogg:interaction-modes:service\] transition\.configuration\.completed/u);
        assert.doesNotMatch(logs.join('\n'), /\[kogg:ui:mode-selector\] mode\.transition-requested/u);
        return;
    }
    const second = await page.context().newPage();
    await second.goto(page.url(), { waitUntil: 'domcontentloaded' });
    await second.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    const restoredPending = second.getByLabel(/Mode: Plan; authority: disabled during transition/u);
    await restoredPending.waitFor({ state: 'visible', timeout: 10_000 });
    await restoredPending.click();
    await second.getByRole('button', { name: 'Cancel request' }).click();
    await selector.waitFor({ state: 'visible', timeout: 10_000 });
    await second.close();
    assert.match(logs.join('\n'), /\[kogg:ui:mode-selector\] mode\.transition-requested/u);
    assert.match(logs.join('\n'), /\[kogg:interaction-modes:service\] mode\.transition\.restored/u);
    assert.match(logs.join('\n'), /\[kogg:interaction-modes:service\] mode\.transition\.cancelled/u);
}

async function exerciseTaskArchive(page) {
    const tasks = await ensureTasksWidget(page);
    await tasks.getByLabel('Initial specification').fill('Disposable archive-control acceptance fixture.');
    await tasks.getByRole('button', { name: 'Create task' }).click();
    const detail = tasks.locator('[data-task-detail]');
    await detail.getByRole('button', { name: 'Archive task' }).waitFor({ timeout: 10_000 });
    await detail.getByRole('button', { name: 'Archive task' }).click();
    await detail.getByText(/archived · draft/iu).waitFor({ timeout: 10_000 });
    assert.equal(await detail.getByRole('button', { name: 'Archive task' }).count(), 0);
}

async function createInteractionModeFixture(page) {
    let projects = await ensureProjectsWidget(page);
    let active = projects.locator('[data-project-row]').filter({ hasText: /Active/u });
    if (!await active.count()) {
        await createProjectThroughPicker(page, projects, 'Mode fixture', workspace);
        const row = projects.locator('[data-project-row]').filter({ hasText: 'Mode fixture' });
        await row.getByRole('button', { name: 'Switch' }).click();
        await page.waitForURL(/\.theia-workspace(?:$|[?#])/u, { timeout: 20_000 });
        await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
        const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
        await trust.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
        if (await trust.isVisible().catch(() => false)) await trust.click();
        projects = await ensureProjectsWidget(page);
        await waitForProjectText(projects, /Mode fixture[\s\S]*Active/u);
        active = projects.locator('[data-project-row]').filter({ hasText: /Active/u });
    }
    await active.first().waitFor({ state: 'visible', timeout: 10_000 });
    const tasks = await ensureTasksWidget(page);
    await tasks.getByLabel('Initial specification').fill('Create the disposable interaction-mode acceptance fixture.');
    await tasks.getByRole('button', { name: 'Create task' }).click();
    await tasks.getByText(/Revision 1 · active · draft/iu).waitFor({ timeout: 10_000 });
    // The selector intentionally preserves its current active task while a
    // window is open. Reconnect so it selects the newest fresh task, exactly as
    // a user does when changing task context after a prior binding degraded.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    projects = await ensureProjectsWidget(page);
    await projects.locator('[data-project-row]').filter({ hasText: /Active/u }).first().waitFor({ state: 'visible', timeout: 15_000 });
    // Project restoration and frontend contributions start concurrently. Reload
    // once the exact project is active so the task-scoped mode selector resolves
    // the newest task against the restored project binding instead of racing it.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
}

async function exerciseOperations(page) {
    const operations = await ensureOperationsWidget(page);
    await operations.getByRole('button', { name: 'Refresh' }).click();
    await operations.getByText('Admission: enabled').waitFor({ timeout: 10_000 });
    await operations.getByText('ranex-bridge').first().waitFor({ timeout: 10_000 });
    await operations.getByText('repository-probe').first().waitFor({ timeout: 10_000 });
    await operations.locator('[data-operation-row]').filter({ hasText: 'provider-connection' }).filter({ hasText: 'OPERATIONS_OK' }).first().waitFor({ timeout: 10_000 });
    await operations.locator('[data-operation-row]').filter({ hasText: 'repository-probe' }).filter({ hasText: 'PROCESS_EXIT_NONZERO' }).first().waitFor({ timeout: 10_000 });
    const visibleOperations = await operations.innerText();
    for (const kind of ['marketplace', 'provider-connection', 'provider-session', 'project-mutation', 'project-switch', 'diagnostics', 'support-export']) {
        assert.match(visibleOperations, new RegExp(kind, 'u'));
    }
    assert.doesNotMatch(visibleOperations, /pid|argv|environment|prompt|source code/iu);
    await assertNoHorizontalOverflow(operations);

    const diagnostics = operations.getByRole('button', { name: 'Run Diagnostics' });
    if (await diagnostics.count()) {
        await diagnostics.click();
        await page.getByText(/Diagnostics: (?:PASS|WARN|FAIL)/u).first().waitFor({ timeout: 15_000 });
        await page.keyboard.press('Escape');
    }
    await operations.getByRole('button', { name: 'Export safe support bundle' }).click();
    const exportAction = page.locator('button[data-action="Export bundle"]:visible').first();
    await exportAction.waitFor({ state: 'visible', timeout: 10_000 });
    const download = page.waitForEvent('download');
    await exportAction.click();
    const artifact = await download;
    assert.match(artifact.suggestedFilename(), /^kogg-operations-support-.*\.json$/u);
    await clearNotifications(page);
}

async function acceptConfirmation(page, title) {
    const dialog = page.locator('.dialogBlock').filter({ hasText: title });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: /OK|Remove/iu }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
}

async function assertNoHorizontalOverflow(surface) {
    const overflow = await surface.locator('.kogg-panel').first().evaluate(element => {
        const overflowX = getComputedStyle(element).overflowX;
        return {
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            contained: ['auto', 'scroll', 'hidden'].includes(overflowX),
            withinShell: element.getBoundingClientRect().right <= document.documentElement.clientWidth + 1
                && element.getBoundingClientRect().left >= -1
        };
    });
    assert(overflow.withinShell, 'Widget escapes the application shell horizontally');
    // Scrollable panels may scroll their own content; only uncontained
    // overflow visually breaks the layout.
    if (!overflow.contained) {
        assert(overflow.scrollWidth <= overflow.clientWidth + 1, `Horizontal overflow: ${overflow.scrollWidth}px > ${overflow.clientWidth}px`);
    }
}

async function exerciseExecution(page) {
    const widgets = page.locator('.kogg-execution-widget');
    if (!await widgets.count()) {
        await openCommand(page, 'View: Toggle Kogg Execution');
        await widgets.first().waitFor({ state: 'attached', timeout: 10_000 });
    }
    const active = await renderedWidget(widgets);
    const execution = widgets.nth(active.index);
    const start = execution.getByRole('button', { name: 'Start run' });
    await start.waitFor({ state: 'visible', timeout: 15_000 });
    const qualification = execution.getByRole('status'); let code; const deadline = Date.now() + 15_000;
    while (/Loading execution state/iu.test(await qualification.innerText()) && Date.now() < deadline) await page.waitForTimeout(50);
    while (Date.now() < deadline) {
        const titleCode = /QUALIFICATION_[A-Z_]+/u.exec(await start.getAttribute('title') ?? '')?.[0];
        const statusCode = /QUALIFICATION_[A-Z_]+/u.exec(await qualification.innerText())?.[0];
        if (titleCode && titleCode === statusCode) { code = titleCode; break; }
        await page.waitForTimeout(50);
    }
    assert(code);
    assert.equal(await start.evaluate(button => button.disabled), true);
    assert.equal(await start.getAttribute('title'), `Run start unavailable: ${code}.`);
    await qualification.getByText(code).waitFor({ timeout: 10_000 });
    await execution.getByRole('button', { name: 'Refresh' }).click();
    await execution.getByText(`Run start unavailable: ${code}.`).waitFor({ timeout: 10_000 });
    assert.match(logs.join('\n'), /\[kogg:execution:widget\] runs\.load\.completed/u);
    assert.doesNotMatch(await execution.innerText(), /worktreeId|bindingDigest|nonce|refs\/kogg|command|prompt|source code/iu);
}

async function exerciseOperationsStream(page) {
    const first = await ensureOperationsWidget(page);
    const secondPage = await page.context().newPage();
    await secondPage.goto(page.url(), { waitUntil: 'domcontentloaded' });
    await secondPage.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    let second = await ensureOperationsWidget(secondPage);
    const initialSequence = await synchronizeStreamSequences(first, second);

    await openCommand(page, 'Kogg: Run Diagnostics');
    const advancedFirst = await waitForStreamAdvance(first, initialSequence);
    const advancedSecond = await waitForStreamAdvance(second, initialSequence);
    const diagnosticMessage = page.getByText(/Diagnostics: (?:FAIL|WARN|PASS)/u).filter({ visible: true }).first();
    await diagnosticMessage.waitFor({ timeout: 15_000 });
    assert.doesNotMatch(await diagnosticMessage.innerText(), /operations\.(?:projection|owners|correlations|timeline|stream|metrics|retention|support|actions|source-maps)/u);
    await exerciseGovernedRunDetails(first, 'diagnostic');
    await auditRunDetailSurfaces(first);
    const beforeDiagnoseAction = await streamSequence(first);
    await first.getByRole('button', { name: 'Diagnose selected run' }).click();
    await page.getByText('Diagnostics completed for the selected run.').filter({ visible: true }).first().waitFor({ timeout: 20_000 });
    await waitForStreamAdvance(first, beforeDiagnoseAction);
    assert.match(logs.join('\n'), /\[kogg:operations:actions\] owner-result.*actionKind: 'diagnose'.*status: 'forwarded'/su);
    await clearNotifications(page);

    await secondPage.reload({ waitUntil: 'domcontentloaded' });
    await secondPage.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    second = await ensureOperationsWidget(secondPage);
    const reloadedSecond = await streamSequence(second);
    assert(reloadedSecond >= advancedSecond);
    const reloadedFirst = await waitForStreamAtLeast(first, reloadedSecond);
    await openCommand(page, 'Kogg: Run Diagnostics');
    await waitForStreamAdvance(first, reloadedFirst);
    const resumedSecond = await waitForStreamAdvance(second, reloadedSecond);
    await clearNotifications(page);

    await secondPage.evaluate(() => sessionStorage.setItem('kogg.operations.stream.cursor.v1', 'corrupt-e2e-cursor'));
    await secondPage.reload({ waitUntil: 'domcontentloaded' });
    await secondPage.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    second = await ensureOperationsWidget(secondPage);
    await second.getByRole('status').filter({ hasText: /Stream: current.*sequence \d+/u }).waitFor({ timeout: 10_000 });
    const recoveredSecond = await streamSequence(second);
    assert(recoveredSecond >= resumedSecond);
    await waitForStreamAtLeast(first, recoveredSecond);
    assert.match(logs.join('\n'), /\[kogg:operations:stream\] resync-required/u);
    await secondPage.close();
}

async function streamSequence(widget) {
    const current = widget.getByRole('status').filter({ hasText: /Stream: current.*sequence \d+/u });
    await current.waitFor({ timeout: 15_000 });
    const status = await current.innerText();
    const match = /sequence (\d+)/u.exec(status);
    assert(match, `Missing operations stream sequence in: ${status}`);
    return BigInt(match[1]);
}

async function auditRunDetailSurfaces(widget) {
    // Closure audit: every run-detail tab renders only closed safe
    // projections, and supervised process plus usage facts are visible
    // across the projected governed runs.
    const tabs = widget.getByRole('tablist', { name: 'Governed run details' });
    const rows = widget.locator('[data-projected-run]');
    await rows.first().waitFor({ state: 'visible', timeout: 15_000 });
    const emptyMarker = 'No matching safe timeline entries.';
    let sawProcesses = false;
    for (let index = 0; index < Math.min(await rows.count(), 8) && !sawProcesses; index += 1) {
        await rows.nth(index).getByRole('button').click();
        await tabs.waitFor({ state: 'visible', timeout: 10_000 });
        for (const name of ['Files / execution', 'Checks', 'Evidence / verdict', 'Merge', 'Usage', 'Processes']) {
            await tabs.getByRole('tab', { name }).click();
            const panel = widget.getByRole('tabpanel', { name: `${name} details` });
            await panel.waitFor({ state: 'visible' });
            const text = (await panel.innerText()).replace(/\s+/gu, ' ').trim();
            assert(text.includes(emptyMarker) || /\bnone\b|\b[A-Z][A-Z_]{4,}\b/u.test(text), `Unexpected ${name} detail schema`);
            assert.doesNotMatch(text, /pid|argv|environment|prompt|source code/iu);
            if (name === 'Processes' && !text.includes(emptyMarker)) sawProcesses = true;
        }
    }
    assert(sawProcesses, 'Expected supervised process facts in run details');
}

async function exerciseGovernedRunDetails(widget, ownerKind) {
    const row = widget.locator('[data-projected-run]').filter({ hasText: /failed|completed/u }).last();
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    // A terminal governed run must hold no live processes; a completed run
    // must additionally show zero abnormal process state.
    const rowCells = row.locator('td');
    const lifecycle = (await rowCells.nth(1).innerText()).trim();
    assert.match(lifecycle, /failed|completed/u);
    assert.equal((await rowCells.nth(4).innerText()).trim(), '0');
    if (/completed/u.test(lifecycle)) assert.equal((await rowCells.nth(5).innerText()).trim(), '0');
    await row.getByRole('button').click();
    const tabs = widget.getByRole('tablist', { name: 'Governed run details' });
    await tabs.waitFor({ state: 'visible', timeout: 10_000 });
    for (const name of ['Timeline', 'Files / execution', 'Checks', 'Evidence / verdict', 'Merge', 'Usage', 'Processes']) {
        const tab = tabs.getByRole('tab', { name });
        await tab.click();
        assert.equal(await tab.getAttribute('aria-selected'), 'true');
        await widget.getByRole('tabpanel', { name: `${name} details` }).waitFor({ state: 'visible' });
    }
    await tabs.getByRole('tab', { name: 'Timeline' }).click();
    const timeline = widget.getByRole('tabpanel', { name: 'Timeline details' });
    await timeline.getByRole('cell', { name: ownerKind, exact: true }).first().waitFor({ timeout: 10_000 });
    const timelineRows = timeline.locator('tbody').getByRole('row');
    const events = [];
    for (let index = 0; index < await timelineRows.count(); index += 1) events.push((await timelineRows.nth(index).innerText()).trim());
    assert(events.length > 0, 'Expected safe timeline entries for the selected governed run');
    assert.match(events[0], /requested|started/u);
    assert(events.some(event => /completed|failed|cancelled|timeout/u.test(event)), 'Expected a terminal lifecycle event');
    assert.match(events[events.length - 1], /completed|failed|cancelled|timeout|recovered/u);
}

async function synchronizeStreamSequences(first, second) {
    const expected = [await streamSequence(first), await streamSequence(second)].reduce((maximum, current) => current > maximum ? current : maximum, 0n);
    await Promise.all([waitForStreamAtLeast(first, expected), waitForStreamAtLeast(second, expected)]);
    return expected;
}

async function waitForStreamAdvance(widget, previous) {
    return waitForStreamAtLeast(widget, previous + 1n);
}

async function waitForStreamAtLeast(widget, expected) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const current = await streamSequence(widget);
        if (current >= expected) return current;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for operations stream sequence ${expected}`);
}

async function renderedWidget(widgets) {
    return widgets.evaluateAll(nodes => nodes.reduce((best, node, index) => {
        const rectangle = node.getBoundingClientRect();
        const area = rectangle.width * rectangle.height;
        return area > best.area ? { area, index } : best;
    }, { area: -1, index: 0 }));
}

async function retryProjectSwitchAfterRestoreRace(page, projects, projectName) {
    const row = projects.locator('[data-project-row]').filter({ hasText: projectName });
    if (/Active/u.test(await row.innerText())) return projects;
    const button = row.getByRole('button', { name: 'Switch' });
    if (await button.isEnabled().catch(() => false)) {
        await button.click();
        await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
        const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
        if (await trust.isVisible().catch(() => false)) await trustWorkspace(page);
        return ensureProjectsWidget(page);
    }
    return projects;
}

async function createProjectThroughPicker(page, projects, name, repository) {
    await projects.getByLabel('New project name').fill(name);
    await Promise.all([
        chooseFolder(page, repository),
        projects.getByRole('button', { name: 'Choose repository and add project' }).click()
    ]);
    await projects.getByRole('status').filter({ hasText: /updated|already registered|valid Git worktree/iu }).waitFor({ timeout: 15_000 });
}

async function chooseFolder(page, folder) {
    const dialog = page.locator('.dialogBlock');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('[title="Switch to text-based input"]').click();
    const location = dialog.locator('.theia-LocationTextInput');
    await location.fill(folder);
    await location.press('Enter');
    const locationList = dialog.locator('.theia-LocationList');
    await locationList.waitFor({ state: 'visible', timeout: 10_000 });
    const expectedLocations = new Set([normalizedPickerPath(folder), normalizedPickerPath(await realpath(folder))]);
    const folderDeadline = Date.now() + 10_000;
    while (!expectedLocations.has(normalizedPickerPath(await locationList.inputValue())) && Date.now() < folderDeadline) {
        await page.waitForTimeout(50);
    }
    assert.equal(expectedLocations.has(normalizedPickerPath(await locationList.inputValue())), true);
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
}

function normalizedPickerPath(value) {
    let candidate = decodeURIComponent(value).replace(/[\\/]+$/u, '');
    if (/^file:/iu.test(candidate)) candidate = fileURLToPath(candidate);
    else if (process.platform === 'win32' && /^\/[a-z]:[\\/]/iu.test(candidate)) candidate = candidate.slice(1);
    const normalized = path.normalize(candidate);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port')));
        });
    });
}

function assertUpgradeRejected(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Unauthenticated WebSocket upgrade remained open')); }, 2_000);
        socket.once('connect', () => socket.write(`GET /services HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
        socket.once('close', () => { clearTimeout(timeout); resolve(); });
        socket.once('error', error => { clearTimeout(timeout); reject(error); });
    });
}
