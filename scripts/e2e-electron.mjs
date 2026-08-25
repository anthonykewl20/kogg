import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-electron-e2e-'));
const workspace = path.join(temporary, 'workspace');
const secondaryRepository = path.join(temporary, 'secondary-repository');
const registryPort = await freePort();
const registryUrl = `http://127.0.0.1:${registryPort}`;
const results = path.join(root, 'test-results', 'electron');
const logs = [];
const providerSecret = randomBytes(24).toString('base64url');
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
    await initializeGitRepository(secondaryRepository, 'secondary Electron fixture');
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
        args: [path.join(root, 'apps/electron/lib/backend/electron-main.js'), `--electronUserData=${path.join(temporary, 'electron-user-data')}`, workspace],
        env: {
            ...process.env, KOGG_RUNTIME: 'electron', KOGG_ROOT: root,
            KOGG_ELECTRON_UNBUNDLED: '1',
            KOGG_ELECTRON_ENTRYPOINT: path.join(root, 'apps/electron/lib/backend/electron-main.js'),
            KOGG_STATE_DIR: path.join(temporary, 'state'),
            THEIA_CONFIG_DIR: path.join(temporary, 'state', 'config'),
            KOGG_REGISTRY_URL: registryUrl,
            THEIA_ELECTRON_DISABLE_NATIVE_ELEMENTS: '1'
        },
        timeout: 30_000
    });
    application.process().stdout?.on('data', chunk => logs.push(`[electron] ${chunk}`));
    application.process().stderr?.on('data', chunk => logs.push(`[electron:error] ${chunk}`));
    const argumentShape = await application.evaluate(({ app }) => process.argv.slice(1).map(argument => {
        if (argument.startsWith('--electronUserData=')) return 'user-data-option';
        if (argument.startsWith('--')) return 'option';
        if (argument === app.getAppPath()) return 'application-path';
        if (/[\\/]electron-main\.js$/u.test(argument)) return 'application-entrypoint';
        return 'positional';
    }));
    logs.push(`[electron] [kogg:e2e:electron] argv.shape ${JSON.stringify(argumentShape)}`);
    await application.firstWindow({ timeout: 30_000 });
    const page = await waitForKoggWindow(application);
    page.on('console', entry => logs.push(`[frontend:${entry.type()}] ${entry.text()}`));
    page.on('pageerror', error => logs.push(`[frontend:error] ${error.stack ?? error.message}`));
    assert.match(await page.title(), /Kogg|workspace/iu);
    const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
    await trust.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    if (await trust.isVisible().catch(() => false)) await trust.click();

    // Exercise a real editor save before Git actions. This activates filesystem
    // and repository watchers through the same path a person uses on a clean
    // profile, without relying on an externally modified pre-launch fixture.
    const explorer = page.getByRole('tabpanel', { name: /Explorer/u });
    if (!await explorer.isVisible().catch(() => false)) await openCommand(page, 'View: Toggle Explorer', application);
    const readme = explorer.getByText('README.md');
    if (await readme.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await readme.dblclick();
    } else {
        // A clean Linux profile can leave the workspace root collapsed. Expand
        // the visible root just as a person would; absence of a workspace still
        // fails because there will be no expansion toggle or README entry.
        const collapsedNodes = explorer.locator('.theia-ExpansionToggle.theia-mod-collapsed:visible');
        for (let attempt = 0; attempt < 10 && !await readme.isVisible().catch(() => false); attempt += 1) {
            const next = collapsedNodes.first();
            if (!await next.isVisible().catch(() => false)) break;
            await next.click();
            await readme.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
        }
        await readme.waitFor({ state: 'visible', timeout: 10_000 });
        await readme.dblclick();
    }
    const editor = page.locator('.monaco-editor').last();
    await editor.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
    await page.keyboard.type('\nMonaco user edit.');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');

    await openCommand(page, 'View: Toggle Source Control', application);
    const sourceControl = page.getByRole('tabpanel', { name: /Source Control/u });
    await sourceControl.getByText('README.md').waitFor({ timeout: 30_000 });
    await openCommand(page, 'Git: Stage All Changes', application);
    await sourceControl.getByText('STAGED CHANGES').waitFor();
    await sourceControl.getByRole('textbox', { name: /Message/u }).fill('verify Electron Kogg Git workflow');
    await sourceControl.getByRole('button', { name: /Commit$/u }).click();
    await waitForGitSubject('verify Electron Kogg Git workflow');
    await openCommand(page, 'Git: Create Branch...', application);
    const branchInput = page.locator('.quick-input-widget input').last();
    await branchInput.waitFor({ state: 'visible' });
    await branchInput.fill('kogg-electron-e2e-branch');
    await branchInput.press('Enter');
    await waitForGitBranch('kogg-electron-e2e-branch');

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
    await clearNotifications(page);
    await openCommand(page, 'View: Toggle Kogg AI', application);
    const provider = page.locator('.kogg-provider-widget');
    await provider.getByText('Advisory only').waitFor();
    await provider.getByLabel('Provider').selectOption('openai');
    await provider.getByRole('button', { name: 'Test connection' }).click();
    await provider.getByText('Credential is not configured').waitFor();
    await provider.getByLabel('Credential').fill(providerSecret);
    await provider.getByRole('button', { name: 'Save credential' }).click();
    await provider.getByText('openai / default').waitFor();
    assert.doesNotMatch(await provider.innerText(), new RegExp(providerSecret, 'u'));
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
    await provider.locator('li').filter({ hasText: 'openai / default' }).getByRole('button', { name: 'Delete' }).click();
    await provider.getByText('None. Secret values are never displayed.').waitFor();
    assert.equal(logs.join('\n').includes(providerSecret), false);

    await exerciseNodeDebug(page, application, 'Kogg Electron Debug', 'KOGG_ELECTRON_E2E_READY');
    await exerciseElectronProjects(page, application);
    const visible = await page.locator('body').innerText();
    assert.doesNotMatch(visible, /Search Open VSX Registry|Learn more about Theia|custom-agent migration/iu);
    assert.doesNotMatch(logs.join('\n'), /Uncaught Exception:\s+Error: transport error/iu);
    assert.doesNotMatch(logs.join('\n'), /Command with id '_chat\.editSessions\.accept' is not registered/iu);
    process.stdout.write('Kogg Electron E2E passed: native window, marketplace, provider, Git, debug, projects, switching, and branding.\n');
} catch (error) {
    process.stderr.write(`${logs.join('\n')}\n`);
    if (application) {
        const windows = application.windows();
        if (windows[0]) await windows[0].screenshot({ path: path.join(results, 'failure.png'), fullPage: true }).catch(() => undefined);
    }
    await writeFile(path.join(results, 'failure.log'), `${logs.join('\n')}\n${error.stack ?? error}\n`).catch(() => undefined);
    throw error;
} finally {
    if (application) {
        const closed = await Promise.race([
            application.close().then(() => true, () => false),
            new Promise(resolve => setTimeout(() => resolve(false), 10_000))
        ]);
        if (!closed) {
            console.warn('[kogg:e2e:electron] application.close.timed-out');
            application.process().kill();
        }
    }
    await stop(registry);
    await rm(temporary, { recursive: true, force: true });
}

async function openCommand(page, label, electronApplication) {
    const input = page.getByRole('textbox', { name: 'Type to narrow down results.' });
    const body = page.locator('body');
    if (label === 'Go to File...') {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            await page.bringToFront();
            await body.click({ position: { x: 600, y: 300 } });
            await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
            if (await input.waitFor({ state: 'visible', timeout: 2_500 }).then(() => true, () => false)) return;
        }
        throw new Error('Electron Go to File input did not become visible');
    }
    const shortcuts = [process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P', 'F1', 'F1', 'F1'];
    let opened = false;
    for (const shortcut of shortcuts) {
        await page.bringToFront();
        await body.click({ position: { x: 600, y: 300 } });
        await page.keyboard.press(shortcut);
        opened = await input.waitFor({ state: 'visible', timeout: 2_500 }).then(() => true, () => false);
        if (opened) break;
    }
    if (!opened) {
        // Headless Linux can still drop key events while its native window is
        // gaining focus. Use the visible Electron menu command as a bounded
        // fallback, then give the rendered palette time to attach.
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
        await input.waitFor({ state: 'visible', timeout: 10_000 });
    }
    await input.fill(`>${label}`);
    let option = page.locator(`[role="option"][aria-label="${label.replaceAll('"', '\\"')}"]:visible`);
    if (!await option.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false)) {
        option = page.locator('[role="option"]:visible').filter({ hasText: label }).first();
        await option.waitFor();
    }
    await option.click();
}

async function initializeGitRepository(repository, subject) {
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, 'README.md'), `# ${subject}\n`);
    spawnSync('git', ['init', '--quiet', repository], { stdio: 'ignore' });
    spawnSync('git', ['-C', repository, 'config', 'user.name', 'Kogg E2E'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repository, 'config', 'user.email', 'kogg-e2e@example.invalid'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repository, 'add', '.'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repository, 'commit', '-m', subject], { stdio: 'ignore' });
}

async function exerciseElectronProjects(page, electronApplication) {
    assert.equal(spawnSync('git', ['-C', await realpath(workspace), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim(), 'true');
    let projects = await ensureElectronProjectsWidget(page, electronApplication);
    await createElectronProject(page, projects, 'Electron Alpha', workspace);
    await createElectronProject(page, projects, 'Electron Beta', secondaryRepository);
    await waitForElectronProjectText(projects, /Electron Alpha[\s\S]*Electron Beta/u);
    await projects.locator('[data-project-row]').filter({ hasText: 'Electron Beta' }).getByRole('button', { name: 'Switch' }).click();
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
    await trust.waitFor({ state: 'visible', timeout: 20_000 });
    await trust.click();
    projects = await ensureElectronProjectsWidget(page, electronApplication);
    await waitForElectronProjectText(projects, /Electron Beta[\s\S]*Active/u);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    projects = await ensureElectronProjectsWidget(page, electronApplication);
    await waitForElectronProjectText(projects, /Electron Beta[\s\S]*Active/u);
}

async function ensureElectronProjectsWidget(page, electronApplication) {
    const widget = page.locator('.kogg-projects-widget').last();
    if (!await widget.count()) {
        await openCommand(page, 'View: Toggle Kogg Projects', electronApplication);
        await widget.waitFor({ state: 'attached', timeout: 10_000 });
    }
    const deadline = Date.now() + 10_000;
    while (/Loading projects/iu.test(await widget.textContent().catch(() => 'Loading projects')) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.doesNotMatch(await widget.textContent(), /Loading projects/iu);
    return widget;
}

async function createElectronProject(page, projects, name, repository) {
    await projects.getByLabel('New project name').fill(name);
    await Promise.all([
        chooseElectronFolder(page, repository),
        projects.getByRole('button', { name: 'Choose repository and add project' }).click()
    ]);
    await waitForElectronProjectText(projects, new RegExp(name, 'u'));
}

async function chooseElectronFolder(page, folder) {
    const dialog = page.locator('.dialogBlock');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('[title="Switch to text-based input"]').click();
    const location = dialog.locator('.theia-LocationTextInput');
    const canonicalFolder = await realpath(folder);
    await location.fill(canonicalFolder);
    await location.press('Enter');
    const locationList = dialog.locator('.theia-LocationList');
    await locationList.waitFor({ state: 'visible', timeout: 10_000 });
    const folderDeadline = Date.now() + 10_000;
    let selectedLocation = '';
    while (Date.now() < folderDeadline) {
        selectedLocation = decodeURIComponent(await locationList.inputValue()).replace(/\/$/u, '');
        if (selectedLocation.endsWith(folder) || selectedLocation.endsWith(canonicalFolder)) break;
        await page.waitForTimeout(50);
    }
    assert.ok(
        selectedLocation.endsWith(folder) || selectedLocation.endsWith(canonicalFolder),
        `Electron folder dialog did not navigate to ${canonicalFolder}; current location is ${selectedLocation}`
    );
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
}

async function waitForElectronProjectText(locator, pattern) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (pattern.test(await locator.textContent().catch(() => ''))) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for Electron Projects state: ${pattern}`);
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
    const pauseTimeout = process.platform === 'win32' ? 60_000 : 20_000;
    const waitForPause = async () => {
        const paused = page.locator('[title="Continue (F5)"]').waitFor({ state: 'visible', timeout: pauseTimeout }).then(() => true);
        if (process.platform !== 'win32') return paused;
        const completed = page.getByText(expectedOutput).waitFor({ timeout: pauseTimeout }).then(() => false);
        return Promise.race([paused, completed]);
    };
    const start = async () => {
        await openCommand(page, 'Debug: Select and Start Debugging', electronApplication);
        const choice = page.locator('[role="option"]:visible').filter({ hasText: configuration });
        await choice.waitFor({ state: 'visible', timeout: 10_000 });
        await choice.click();
        return waitForPause();
    };
    if (!await start()) return;
    for (const title of ['Step Over', 'Step Into', 'Step Out', 'Restart', 'Stop']) {
        await page.locator(`[title^="${title}"]:visible`).waitFor({ state: 'visible' });
    }
    await page.getByText('VARIABLES').first().waitFor();
    await page.getByText('CALL STACK').first().waitFor();
    await page.locator('[title^="Restart"]:visible').evaluate(element => element.click());
    await page.waitForTimeout(500);
    if (!await waitForPause()) return;
    await page.locator('[title^="Stop"]:visible').evaluate(element => element.click());
    await page.locator('[title="Continue (F5)"]').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.keyboard.press('F5');
    if (!await waitForPause()) return;
    await page.locator('[title="Continue (F5)"]:visible').evaluate(element => element.click());
    await page.getByText(expectedOutput).waitFor({ timeout: 10_000 });
}

async function clearNotifications(page) {
    await page.locator('.theia-notifications-overlay [title="Clear"]:visible').evaluateAll(elements => {
        for (const element of elements) element.click();
    }).catch(() => undefined);
    await page.locator('.theia-notifications-overlay [title="Clear All Notifications"]:visible').evaluateAll(elements => {
        for (const element of elements) element.click();
    }).catch(() => undefined);
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
