import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-electron-e2e-'));
const workspace = path.join(temporary, 'workspace');
const registryPort = await freePort();
const registryUrl = `http://127.0.0.1:${registryPort}`;
const results = path.join(root, 'test-results', 'electron');
const logs = [];
let registry;
let application;

try {
    await mkdir(workspace, { recursive: true });
    await mkdir(results, { recursive: true });
    await writeFile(path.join(workspace, 'README.md'), '# Kogg Electron E2E\n');
    await mkdir(path.join(workspace, '.theia'), { recursive: true });
    await writeFile(path.join(workspace, 'verify.mjs'), "const message = 'KOGG_ELECTRON_E2E_READY';\nconsole.log(message);\n");
    await writeFile(path.join(workspace, '.theia', 'launch.json'), JSON.stringify({
        version: '0.2.0', configurations: [{ name: 'Kogg Electron Debug', type: 'node', request: 'launch', program: '${workspaceFolder}/verify.mjs', stopOnEntry: true }]
    }, null, 2));
    spawnSync('git', ['init', workspace], { stdio: 'ignore' });
    spawnSync('git', ['-C', workspace, 'config', 'user.name', 'Kogg E2E'], { stdio: 'ignore' });
    spawnSync('git', ['-C', workspace, 'config', 'user.email', 'kogg-e2e@example.invalid'], { stdio: 'ignore' });
    spawnSync('git', ['-C', workspace, 'add', '.'], { stdio: 'ignore' });
    spawnSync('git', ['-C', workspace, 'commit', '-m', 'initial Electron fixture'], { stdio: 'ignore' });
    await writeFile(path.join(workspace, 'README.md'), '# Kogg Electron E2E\nHuman workflow change.\n');
    registry = spawn(process.execPath, ['packages/kogg-marketplace/lib/node/dev-registry.js'], {
        cwd: root,
        env: { ...process.env, KOGG_ROOT: root, KOGG_REGISTRY_PORT: String(registryPort) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    registry.stdout.on('data', chunk => logs.push(`[registry] ${chunk}`));
    registry.stderr.on('data', chunk => logs.push(`[registry:error] ${chunk}`));
    await waitFor(`${registryUrl}/health`);

    application = await electron.launch({
        executablePath: require('electron'),
        args: [path.join(root, 'apps/electron'), '--electronUserData', path.join(temporary, 'electron-user-data'), workspace],
        env: {
            ...process.env, KOGG_RUNTIME: 'electron', KOGG_ROOT: root,
            KOGG_STATE_DIR: path.join(temporary, 'state'),
            THEIA_CONFIG_DIR: path.join(temporary, 'state', 'config'),
            KOGG_REGISTRY_URL: registryUrl
        },
        timeout: 30_000
    });
    application.process().stdout?.on('data', chunk => logs.push(`[electron] ${chunk}`));
    application.process().stderr?.on('data', chunk => logs.push(`[electron:error] ${chunk}`));
    await application.firstWindow({ timeout: 30_000 });
    const page = await waitForKoggWindow(application);
    page.on('console', entry => logs.push(`[frontend:${entry.type()}] ${entry.text()}`));
    page.on('pageerror', error => logs.push(`[frontend:error] ${error.stack ?? error.message}`));
    assert.match(await page.title(), /Kogg|workspace/iu);
    const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
    await trust.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    if (await trust.isVisible().catch(() => false)) await trust.click();

    await openCommand(page, 'Kogg: Open Marketplace', application);
    const marketplace = page.locator('.kogg-marketplace-widget');
    await marketplace.getByText('Kogg Marketplace').first().waitFor();
    await marketplace.getByLabel('Search Kogg Marketplace').fill('kogg');
    await marketplace.getByRole('button', { name: 'Search' }).click();
    await marketplace.getByText('kogg.fixture').waitFor();
    await marketplace.getByRole('button', { name: 'Install' }).click();
    await marketplace.getByText('kogg.fixture 0.1.0').last().waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    await openCommand(page, 'Kogg: Fixture: Verify Activation', application);
    await page.getByText('Kogg signed fixture 0.1.0 is active.').first().waitFor();
    await page.keyboard.press('Escape');
    await marketplace.getByLabel('Search Kogg Marketplace').fill('kogg');
    await marketplace.getByRole('button', { name: 'Search' }).click();
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
    await openCommand(page, 'View: Toggle Kogg AI', application);
    const provider = page.locator('.kogg-provider-widget');
    await provider.getByText('Advisory only').waitFor();
    await provider.getByLabel('Provider').selectOption('openai');
    await provider.getByRole('button', { name: 'Test connection' }).click();
    await provider.getByText('Credential is not configured').waitFor();
    await provider.getByLabel('Provider').selectOption('llamafile');
    await provider.getByLabel('Endpoint (optional)').fill('http://127.0.0.1:1/models');
    await provider.getByRole('button', { name: 'Test connection' }).click();
    await provider.getByText(/fetch failed|Connection failed/iu).waitFor();
    await provider.getByLabel('Endpoint (optional)').fill(`${registryUrl}/provider/v1/models`);
    await provider.getByRole('button', { name: 'Discover models' }).click();
    await provider.getByText('Discovered 1 model(s).').waitFor();
    await provider.getByLabel('Advisory prompt').fill('Verify the Electron provider path.');
    await provider.getByRole('button', { name: 'Send advisory request' }).click();
    await provider.getByText('Kogg provider fixture responded successfully.').waitFor();

    await openCommand(page, 'View: Toggle Source Control', application);
    const sourceControl = page.getByRole('tabpanel', { name: /Source Control/u });
    await openCommand(page, 'Git: Refresh', application);
    await sourceControl.getByText('README.md').waitFor({ timeout: 30_000 });
    await openCommand(page, 'Git: Stage All Changes', application);
    await sourceControl.getByText('STAGED CHANGES').waitFor();
    await sourceControl.getByRole('textbox', { name: /Message/u }).fill('verify Electron Kogg Git workflow');
    await sourceControl.getByRole('button', { name: /Commit$/u }).click();
    await waitForGitSubject('verify Electron Kogg Git workflow');
    await openCommand(page, 'Git: Refresh', application);
    await openCommand(page, 'Git: Create Branch...', application);
    const branchInput = page.locator('.quick-input-widget input').last();
    await branchInput.waitFor({ state: 'visible' });
    await branchInput.fill('kogg-electron-e2e-branch');
    await branchInput.press('Enter');
    await waitForGitBranch('kogg-electron-e2e-branch');

    await exerciseNodeDebug(page, application, 'Kogg Electron Debug', 'KOGG_ELECTRON_E2E_READY');
    const visible = await page.locator('body').innerText();
    assert.doesNotMatch(visible, /Search Open VSX Registry|Learn more about Theia|custom-agent migration/iu);
    assert.doesNotMatch(logs.join('\n'), /Uncaught Exception:\s+Error: transport error/iu);
    process.stdout.write('Kogg Electron E2E passed: native window, marketplace, provider, Git, debug, and branding.\n');
} catch (error) {
    process.stderr.write(`${logs.join('\n')}\n`);
    if (application) {
        const windows = application.windows();
        if (windows[0]) await windows[0].screenshot({ path: path.join(results, 'failure.png'), fullPage: true }).catch(() => undefined);
    }
    await writeFile(path.join(results, 'failure.log'), `${logs.join('\n')}\n${error.stack ?? error}\n`).catch(() => undefined);
    throw error;
} finally {
    if (application) await application.close().catch(() => undefined);
    await stop(registry);
    await rm(temporary, { recursive: true, force: true });
}

async function openCommand(page, label, electronApplication) {
    const input = page.getByRole('textbox', { name: 'Type to narrow down results.' });
    await page.bringToFront();
    await page.locator('body').click({ position: { x: 600, y: 300 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
    await input.waitFor({ state: 'visible', timeout: 3_000 }).catch(async () => {
        // Electron on a headless Linux display can drop modified key chords
        // while its native window is still gaining focus. F1 is Theia's
        // platform-independent command-palette binding and avoids that race.
        await page.keyboard.press('F1');
        if (await input.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) return;
        await electronApplication.evaluate(({ Menu }) => {
            const visit = items => {
                for (const item of items) {
                    if (/Command Palette/u.test(item.label ?? '')) { item.click(); return true; }
                    if (item.submenu && visit(item.submenu.items)) return true;
                }
                return false;
            };
            if (!visit(Menu.getApplicationMenu()?.items ?? [])) throw new Error('Electron Command Palette menu item not found');
        });
        await input.waitFor({ state: 'visible', timeout: 5_000 });
    });
    await input.fill(`>${label}`);
    const option = page.locator(`[role="option"][aria-label="${label.replaceAll('"', '\\"')}"]:visible`);
    await option.waitFor();
    await option.click();
}

async function waitForKoggWindow(electronApplication) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        for (const window of electronApplication.windows()) {
            if (!window.isClosed() && await window.locator('body.kogg-application').count().catch(() => 0)) return window;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the Kogg Electron workbench window');
}

async function waitForGitSubject(expected) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const subject = spawnSync('git', ['-C', workspace, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).stdout.trim();
        if (subject === expected) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for Git commit: ${expected}`);
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

async function exerciseNodeDebug(page, electronApplication, configuration, expectedOutput) {
    const start = async () => {
        await openCommand(page, 'Debug: Select and Start Debugging', electronApplication);
        const choice = page.locator('[role="option"]:visible').filter({ hasText: configuration });
        await choice.waitFor({ state: 'visible', timeout: 10_000 });
        await choice.click();
        await page.locator('[title="Continue (F5)"]').waitFor({ state: 'visible', timeout: 20_000 });
    };
    await start();
    for (const title of ['Step Over', 'Step Into', 'Step Out', 'Restart', 'Stop']) {
        await page.locator(`[title^="${title}"]:visible`).waitFor({ state: 'visible' });
    }
    await page.getByText('VARIABLES').first().waitFor();
    await page.getByText('CALL STACK').first().waitFor();
    await page.locator('[title^="Restart"]:visible').evaluate(element => element.click());
    await page.waitForTimeout(500);
    await page.locator('[title="Continue (F5)"]').waitFor({ state: 'visible' });
    await page.locator('[title^="Stop"]:visible').evaluate(element => element.click());
    await page.locator('[title="Continue (F5)"]').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.keyboard.press('F5');
    await page.locator('[title="Continue (F5)"]').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('[title="Continue (F5)"]:visible').evaluate(element => element.click());
    await page.getByText(expectedOutput).waitFor({ timeout: 10_000 });
}

async function clearNotifications(page) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const clear = page.locator('.theia-notifications-overlay [title="Clear"]:visible').first();
        if (!await clear.isVisible().catch(() => false)) break;
        await clear.evaluate(element => element.click()).catch(() => undefined);
    }
    await page.locator('.theia-notifications-overlay [title="Clear All Notifications"]:visible').click().catch(() => undefined);
}

async function waitFor(url) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for ${url}`);
}

async function stop(child) {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await waitForExit(child, 5_000);
    if (child.exitCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child, 5_000);
    }
}

async function waitForExit(child, timeout) {
    const deadline = Date.now() + timeout;
    while (child.exitCode === null && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
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
