import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultRoot = path.join(root, 'test-results', 'browser');
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
const logs = [];
let registry;
let backend;
let browser;

try {
    await createWorkspace();
    await mkdir(resultRoot, { recursive: true });
    registry = launch(process.execPath, ['packages/kogg-marketplace/lib/node/dev-registry.js'], {
        KOGG_ROOT: root, KOGG_REGISTRY_PORT: String(registryPort)
    });
    await waitFor(`${registryUrl}/health`);
    backend = launchBrowser(token);
    await waitFor(`${appUrl}/kogg/auth/status`, 401);

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
    assert.equal(await page.locator('h1').innerText(), 'Kogg');
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

    if (process.env.KOGG_E2E_MODES_ONLY === '1') {
        await createInteractionModeFixture(page);
        await exerciseInteractionModes(page);
        process.stdout.write('Kogg browser interaction-mode selector E2E passed.\n');
        await browser.close(); browser = undefined;
        await stop(backend); backend = undefined;
        await stop(registry); registry = undefined;
        await rm(temporary, { recursive: true, force: true });
        process.exit(0);
    }

    if (process.env.KOGG_E2E_PROJECTS_ONLY === '1') {
        await exerciseProjects(page);
        process.stdout.write('Kogg browser Projects-only E2E passed.\n');
        await browser.close(); browser = undefined;
        await stop(backend); backend = undefined;
        await stop(registry); registry = undefined;
        await rm(temporary, { recursive: true, force: true });
        process.exit(0);
    }

    if (process.env.KOGG_E2E_TASKS_ONLY === '1') {
        await exerciseProjects(page);
        await exerciseTasks(page);
        await exerciseInteractionModes(page);
        process.stdout.write('Kogg browser governed-tasks E2E passed.\n');
        await browser.close(); browser = undefined;
        await stop(backend); backend = undefined;
        await stop(registry); registry = undefined;
        await rm(temporary, { recursive: true, force: true });
        process.exit(0);
    }

    await openCommand(page, 'Kogg: Run Diagnostics');
    await page.getByText(/Diagnostics: FAIL.*kernel\.journal/su).first().waitFor({ timeout: 15_000 });
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

    await openCommand(page, 'View: Toggle Kogg AI');
    const provider = page.locator('.kogg-provider-widget');
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
    await provider.getByLabel('Advisory prompt').fill('Verify the disposable provider path.');
    await provider.getByRole('button', { name: 'Send advisory request' }).click();
    await provider.getByText('Kogg provider fixture responded successfully.').waitFor();
    assert.match(await provider.innerText(), /Advisory only.*governed mutation blocked/isu);
    await provider.locator('li').filter({ hasText: 'openai / default' }).getByRole('button', { name: 'Delete' }).click();
    await provider.getByText('None. Secret values are never displayed.').waitFor();
    const encryptedCredentialFile = await readFile(path.join(state, 'credentials', 'browser.enc.json'), 'utf8');
    assert.equal(encryptedCredentialFile.includes(providerSecret), false);
    assert.equal(logs.join('\n').includes(providerSecret), false);

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
    await exerciseTasks(page);
    await exerciseInteractionModes(page);
    await exerciseOperations(page);

    for (let cycle = 0; cycle < 25; cycle++) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('body.kogg-application').waitFor({ timeout: 15_000 });
    }
    await page.waitForTimeout(2_000);
    assert.doesNotMatch(logs.join('\n'), /Uncaught Exception:\s+Error: transport error/iu);

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
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/kogg/auth/login', { timeout: 15_000 });
    assert.equal((await page.locator('h1').innerText()), 'Kogg');

    process.stdout.write('Kogg browser E2E passed: auth, branding, marketplace, provider, Git, debug, projects, restoration, and 25 reconnect cycles.\n');
} catch (error) {
    if (browser) {
        const pages = browser.contexts().flatMap(context => context.pages());
        if (pages[0]) await pages[0].screenshot({ path: path.join(resultRoot, 'failure.png'), fullPage: true }).catch(() => undefined);
    }
    await writeFile(path.join(resultRoot, 'failure.log'), `${logs.join('\n')}\n${error.stack ?? error}\n`).catch(() => undefined);
    throw error;
} finally {
    if (browser) await browser.close().catch(() => undefined);
    await stop(backend);
    await stop(registry);
    await rm(temporary, { recursive: true, force: true });
}

function launchBrowser(authToken) {
    return launch(process.execPath, [path.join(root, 'apps/browser/lib/backend/main.js'), `--plugins=local-dir:${path.join(root, 'plugins')}`, '--hostname', '127.0.0.1', '--port', String(browserPort)], {
        KOGG_RUNTIME: 'browser', KOGG_ROOT: root, KOGG_STATE_DIR: state,
        THEIA_CONFIG_DIR: path.join(state, 'config'), KOGG_AUTH_TOKEN: authToken,
        KOGG_MASTER_KEY: masterKey, KOGG_REGISTRY_URL: registryUrl
    });
}

function launch(command, args, additions) {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...additions }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => logs.push(`[backend] ${chunk}`));
    child.stderr.on('data', chunk => logs.push(`[backend:error] ${chunk}`));
    return child;
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
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try { if ((await fetch(url, { redirect: 'manual' })).status === expected) return; } catch { /* retry */ }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for ${url}`);
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
    await option.click();
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
    await waitForProjectText(projects, /Beta[\s\S]*Active/u);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    projects = await ensureProjectsWidget(page);
    await projects.locator('[data-project-row]').filter({ hasText: 'Alpha' }).getByRole('button', { name: 'Manage' }).click();
    await waitForProjectText(projects, /worker → ollama:default \/ fixture-model/u);
    await waitForProjectText(projects, /task-alpha → Alpha/u);
    await projects.locator('[data-project-row]').filter({ hasText: 'Alpha' }).getByRole('button', { name: 'Switch' }).click();
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    await trustWorkspace(page);
    projects = await ensureProjectsWidget(page);
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
    const unavailableBeta = projects.locator('[data-project-row]').filter({ hasText: 'Beta' });
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
        assert.equal(supportReport.checks.find(check => check.id === id)?.status, 'pass');
    }
    await page.keyboard.press('Escape');
    assert.match(logs.join('\n'), /repository\.revalidation\.completed/iu);
    assert.match(logs.join('\n'), /repository\.process\.cleanup\.completed/iu);

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
        await openCommand(page, 'View: Toggle Kogg Projects');
        await widgets.first().waitFor({ state: 'attached', timeout: 10_000 });
    }
    let active = await renderedWidget(widgets);
    if (active.area === 0) {
        await openCommand(page, 'View: Toggle Kogg Projects');
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
    await openCommand(page, 'Kogg: Run Diagnostics');
    await page.getByText(/Diagnostics: FAIL.*passed/iu).first().waitFor({ timeout: 15_000 });
    const supportDirectory = path.join(state, 'support');
    const supportCount = (await readdir(supportDirectory).catch(() => [])).length;
    await openCommand(page, 'Kogg: Export Diagnostic Support Bundle');
    const supportFiles = (await waitForSupportBundle(supportDirectory, supportCount + 1)).sort();
    const supportReport = JSON.parse(await readFile(path.join(supportDirectory, supportFiles.at(-1)), 'utf8'));
    for (const id of ['tasks.registry', 'tasks.revisions', 'tasks.bindings', 'tasks.approvals']) {
        assert.equal(supportReport.checks.find(check => check.id === id)?.status, 'pass');
    }
    await page.keyboard.press('Escape');
    assert.equal(logs.join('\n').includes(canary), false);
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

async function exerciseInteractionModes(page) {
    const selector = page.getByLabel(/Mode: Plan; authority: \d+ bounded capabilities; stage: research/u);
    await selector.waitFor({ state: 'visible', timeout: 15_000 });
    await selector.click();
    const build = page.getByRole('option', { name: /Build\./u });
    await build.waitFor({ state: 'visible', timeout: 10_000 });
    await build.click();
    await page.getByRole('button', { name: 'Request switch' }).click();
    const pending = page.getByLabel(/Mode: Plan; authority: disabled during transition/u);
    await pending.waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await selector.waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(logs.join('\n'), /\[kogg:ui:mode-selector\] mode\.transition-requested/u);
    assert.match(logs.join('\n'), /\[kogg:interaction-modes:service\] mode\.transition\.cancelled/u);
}

async function createInteractionModeFixture(page) {
    let projects = await ensureProjectsWidget(page);
    await createProjectThroughPicker(page, projects, 'Mode fixture', workspace);
    const row = projects.locator('[data-project-row]').filter({ hasText: 'Mode fixture' });
    if (await row.getByRole('button', { name: 'Switch' }).isVisible().catch(() => false)) {
        await row.getByRole('button', { name: 'Switch' }).click();
        await page.waitForURL(/\.theia-workspace(?:$|[?#])/u, { timeout: 20_000 });
        await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
        const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
        await trust.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
        if (await trust.isVisible().catch(() => false)) await trust.click();
        projects = await ensureProjectsWidget(page);
    }
    await waitForProjectText(projects, /Mode fixture[\s\S]*Active/u);
    const tasks = await ensureTasksWidget(page);
    await tasks.getByLabel('Initial specification').fill('Create the disposable interaction-mode acceptance fixture.');
    await tasks.getByRole('button', { name: 'Create task' }).click();
    await tasks.getByText(/Revision 1 · active · draft/iu).waitFor({ timeout: 10_000 });
}

async function exerciseOperations(page) {
    const widgets = page.locator('.kogg-operations-widget');
    if (!await widgets.count()) {
        await openCommand(page, 'Kogg: Show Operations');
        await widgets.first().waitFor({ state: 'attached', timeout: 10_000 });
    }
    const active = await renderedWidget(widgets);
    const operations = widgets.nth(active.index);
    await operations.getByRole('button', { name: 'Refresh' }).click();
    await operations.getByText('Admission: enabled').waitFor({ timeout: 10_000 });
    await operations.getByText('ranex-bridge').first().waitFor({ timeout: 10_000 });
    await operations.getByText('repository-probe').first().waitFor({ timeout: 10_000 });
    await operations.locator('[data-operation-row]').filter({ hasText: 'provider-connection' }).filter({ hasText: 'OWNER_UNAVAILABLE' }).first().waitFor({ timeout: 10_000 });
    await operations.locator('[data-operation-row]').filter({ hasText: 'repository-probe' }).filter({ hasText: 'PROCESS_EXIT_NONZERO' }).first().waitFor({ timeout: 10_000 });
    const visibleOperations = await operations.innerText();
    for (const kind of ['marketplace', 'provider-connection', 'provider-session', 'project-mutation', 'project-switch', 'diagnostics', 'support-export']) {
        assert.match(visibleOperations, new RegExp(kind, 'u'));
    }
    assert.doesNotMatch(visibleOperations, /pid|argv|environment|prompt|source code/iu);
}

async function renderedWidget(widgets) {
    return widgets.evaluateAll(nodes => nodes.reduce((best, node, index) => {
        const rectangle = node.getBoundingClientRect();
        const area = rectangle.width * rectangle.height;
        return area > best.area ? { area, index } : best;
    }, { area: -1, index: 0 }));
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
