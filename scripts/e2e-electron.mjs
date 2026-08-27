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
    await writeFile(path.join(workspace, 'verify.mjs'), "debugger;\nconst message = 'KOGG_ELECTRON_E2E_READY';\nconsole.log(message);\n");
    await writeFile(path.join(workspace, '.theia', 'launch.json'), JSON.stringify({
        version: '0.2.0', configurations: [{
            name: 'Kogg Electron Debug', type: 'node', request: 'launch',
            runtimeExecutable: process.execPath, program: path.join(workspace, 'verify.mjs'), cwd: workspace,
            stopOnEntry: false
        }]
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

    if (process.env.KOGG_E2E_OPERATIONS_ONLY === '1') {
        await exerciseElectronOperations(page, application);
        process.stdout.write('Kogg Electron operations-stream E2E passed.\n');
    } else if (process.env.KOGG_E2E_WORKFLOW_ONLY === '1') {
        await exerciseElectronProjects(page, application);
        await exerciseElectronWorkflowEditor(page, application);
        process.stdout.write('Kogg Electron workflow-editor E2E passed.\n');
    } else {
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
    await openCommandWithRetry(page, 'Git: Create Branch...', application, 'Git: Create Branch');
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
    await exerciseElectronExecution(page, application);
    await exerciseElectronTasks(page, application);
    await exerciseElectronOperations(page, application);
    const visible = await page.locator('body').innerText();
    assert.doesNotMatch(visible, /Search Open VSX Registry|Learn more about Theia|custom-agent migration/iu);
    assert.doesNotMatch(logs.join('\n'), /Uncaught Exception:\s+Error: transport error/iu);
    assert.doesNotMatch(logs.join('\n'), /Command with id '_chat\.editSessions\.accept' is not registered/iu);
    process.stdout.write('Kogg Electron E2E passed: native window, marketplace, provider, Git, debug, projects, switching, and branding.\n');
    }
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

async function openCommand(page, label, electronApplication, query = label, optionTimeout = 30_000) {
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
    await input.fill(`>${query}`);
    let option = page.locator(`[role="option"][aria-label="${label.replaceAll('"', '\\"')}"]:visible`);
    if (!await option.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false)) {
        option = page.locator('[role="option"]:visible').filter({ hasText: label }).first();
        await option.waitFor({ timeout: optionTimeout });
    }
    await option.click();
}

async function openCommandWithRetry(page, label, electronApplication, query) {
    let lastError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
            await openCommand(page, label, electronApplication, query, 2_500);
            return;
        } catch (error) {
            lastError = error;
            await page.keyboard.press('Escape').catch(() => undefined);
            await page.waitForTimeout(1_000);
        }
    }
    throw lastError;
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

async function exerciseElectronTasks(page, electronApplication) {
    const canary = 'KOGG_ELECTRON_TASK_PRIVATE_CANARY_83';
    const tasks = page.locator('.kogg-tasks-widget').last();
    if (!await tasks.count()) {
        await openCommand(page, 'View: Toggle Kogg Tasks', electronApplication);
        await tasks.waitFor({ state: 'attached', timeout: 10_000 });
    }
    await tasks.getByLabel('Line endings').selectOption('lf');
    await tasks.getByLabel('Initial specification').fill(canary + '\nElectron requirement\n');
    await tasks.getByRole('button', { name: 'Create task' }).click();
    await tasks.getByText(/Revision 1 · active · draft/iu).waitFor({ timeout: 10_000 });
    await exerciseElectronInteractionModes(page);
    await tasks.getByRole('button', { name: 'Freeze exact revision' }).click();
    await tasks.getByRole('button', { name: 'Review for approval' }).click();
    await tasks.locator('.kogg-review').getByText(canary).waitFor();
    await tasks.getByRole('button', { name: 'Approve this exact revision' }).click();
    await tasks.getByRole('button', { name: /Revoke approval/u }).waitFor();
    await tasks.getByLabel('Existing run ID').fill('55555555-5555-4555-8555-555555555555');
    await tasks.getByRole('button', { name: 'Authorize exact task admission' }).click();
    const admission = tasks.locator('[data-admission-id]'); await admission.waitFor();
    const admissionId = (await admission.innerText()).match(/[0-9a-f-]{36}/u)?.[0]; assert.ok(admissionId);
    await exerciseElectronAgents(page, electronApplication, admissionId);
    await openCommand(page, 'View: Toggle Kogg Tasks', electronApplication);
    await tasks.getByRole('button', { name: /Revoke approval/u }).click();
    assert.equal(logs.join('\n').includes(canary), false);
}

async function exerciseElectronWorkflowEditor(page, electronApplication) {
    let widget = page.locator('.kogg-workflow-editor-widget:visible').first();
    if (!await widget.count()) {
        await openCommand(page, 'View: Toggle Kogg Workflow Editor', electronApplication);
        widget = page.locator('.kogg-workflow-editor-widget:visible').first();
    }
    await widget.getByText('Structured workflow outline ready.').waitFor({ timeout: 15_000 });
    assert.equal(await widget.locator('[data-workflow-node]').count(), 2);
    await widget.getByRole('button', { name: 'Show spatial canvas' }).click();
    assert.equal(await widget.locator('[data-workflow-canvas-node]').count(), 2);
    await widget.getByLabel('Node kind').selectOption('check.deterministic');
    await widget.getByRole('button', { name: 'Add node' }).click();
    await widget.getByRole('button', { name: 'Move check.deterministic earlier on canvas' }).click();
    await widget.getByRole('button', { name: 'Configure implementation.agent on canvas' }).click();
    let configuration = widget.locator('[data-config]');
    await configuration.getByLabel('Role revision ID').fill('60000000-0000-4000-8000-000000000001');
    await configuration.getByLabel('Provider ID').fill('kogg.fixture'); await configuration.getByLabel('Model ID').fill('fixture.echo');
    await configuration.getByLabel('Adapter key').fill('kogg.fixture'); await configuration.getByLabel('Adapter version').fill('1.0.0'); await configuration.getByLabel('Deadline policy').fill('interactive-v1');
    await configuration.getByRole('button', { name: 'Apply exact configuration' }).click();
    await widget.getByRole('button', { name: 'Configure research.agent on canvas' }).click(); configuration = widget.locator('[data-config]');
    await configuration.getByLabel('Role revision ID').fill('60000000-0000-4000-8000-000000000002'); await configuration.getByLabel('Provider ID').fill('kogg.fixture.read'); await configuration.getByLabel('Model ID').fill('fixture.research');
    await configuration.getByLabel('Adapter key').fill('kogg.fixture'); await configuration.getByLabel('Adapter version').fill('1.0.0'); await configuration.getByLabel('Deadline policy').fill('research-v1'); await configuration.getByRole('button', { name: 'Apply exact configuration' }).click();
    await widget.getByRole('button', { name: 'Show structured outline' }).click();
    assert.equal(await widget.locator('[data-workflow-node]').count(), 3);
    assert.match(await widget.locator('[data-workflow-node]').nth(1).innerText(), /check\.deterministic/u);
    configuration = widget.locator('[data-config]'); assert.equal(await configuration.getByLabel('Role revision ID').inputValue(), '60000000-0000-4000-8000-000000000002');
    await widget.getByRole('button', { name: 'Validate workflow' }).click();
    await widget.getByText(/Workflow valid: 3 nodes and 2 edges/u).waitFor({ timeout: 10_000 });
    await widget.getByRole('button', { name: 'Save immutable version' }).click();
    await widget.getByText('Workflow version 1 saved immutably.').waitFor({ timeout: 10_000 });
    await widget.getByRole('button', { name: 'Compile current version' }).click();
    await widget.getByText(/Compiled plan [0-9a-f]{8} with 9 mandatory anchors/u).waitFor({ timeout: 10_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    widget = page.locator('.kogg-workflow-editor-widget:visible').filter({ hasText: 'Workflow version 1 is current.' }).first();
    await widget.waitFor({ state: 'visible', timeout: 15_000 });
    assert.match(logs.join('\n'), /\[kogg:workflow:editor\] ui\.operation\.completed/u);
    assert.doesNotMatch(await widget.innerText(), /configurationDigest|requestedEffects|graphDigest|catalogDigest/u);
}

async function exerciseElectronInteractionModes(page) {
    const selector = page.getByLabel(/Mode: Plan; authority: \d+ bounded capabilities; stage: research/u);
    await selector.waitFor({ state: 'visible', timeout: 15_000 });
    await selector.click();
    const build = page.getByRole('option', { name: /Build\./u });
    await build.waitFor({ state: 'visible', timeout: 10_000 });
    await build.click();
    await page.getByRole('button', { name: 'Request switch' }).click();
    let pending = page.getByLabel(/Mode: Plan; authority: disabled during transition/u);
    await pending.waitFor({ state: 'visible', timeout: 10_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    pending = page.getByLabel(/Mode: Plan; authority: disabled during transition/u);
    await pending.waitFor({ state: 'visible', timeout: 10_000 });
    await pending.click();
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await selector.waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(logs.join('\n'), /\[kogg:interaction-modes:transition-authority\] authority\.mint\.completed.*electron/su);
    assert.match(logs.join('\n'), /\[kogg:interaction-modes:service\] mode\.transition\.cancelled/u);
    await clearNotifications(page);
}

async function exerciseElectronOperations(page, electronApplication) {
    let widget = await ensureElectronOperationsWidget(page, electronApplication);
    await widget.getByRole('button', { name: 'Refresh' }).click();
    await widget.getByText('Admission: enabled').waitFor({ timeout: 10_000 });
    const visibleOperations = await widget.innerText();
    if (process.env.KOGG_E2E_OPERATIONS_ONLY !== '1') {
        await widget.getByText('ranex-bridge').first().waitFor({ timeout: 10_000 });
        await widget.getByText('repository-probe').first().waitFor({ timeout: 10_000 });
        await widget.locator('[data-operation-row]').filter({ hasText: 'provider-connection' }).filter({ hasText: 'OWNER_UNAVAILABLE' }).first().waitFor({ timeout: 10_000 });
        for (const kind of ['marketplace', 'provider-connection', 'provider-session', 'project-mutation', 'project-switch']) {
            assert.match(visibleOperations, new RegExp(kind, 'u'));
        }
    }
    assert.doesNotMatch(visibleOperations, /pid|argv|environment|prompt|source code/iu);

    const secondWindow = electronApplication.waitForEvent('window');
    await openCommand(page, 'New Window', electronApplication);
    const secondPage = await secondWindow;
    secondPage.on('console', entry => logs.push(`[frontend:second:${entry.type()}] ${entry.text()}`));
    secondPage.on('pageerror', error => logs.push(`[frontend:second:error] ${error.stack ?? error.message}`));
    await secondPage.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    let secondWidget = await ensureElectronOperationsWidget(secondPage, electronApplication);
    const initialSequence = await synchronizeElectronStreamSequences(widget, secondWidget);
    await openCommand(page, 'Kogg: Run Diagnostics', electronApplication);
    const advancedFirst = await waitForElectronStreamAdvance(widget, initialSequence);
    await waitForElectronStreamAdvance(secondWidget, initialSequence);
    const diagnosticMessage = page.getByText(/Diagnostics: (?:FAIL|WARN|PASS)/u).filter({ visible: true }).first();
    await diagnosticMessage.waitFor({ timeout: 15_000 });
    assert.doesNotMatch(await diagnosticMessage.innerText(), /operations\.(?:stream|actions|source-maps)/u);
    await exerciseElectronGovernedRunDetails(widget);
    await clearNotifications(page);

    await secondPage.close();
    await openCommand(page, 'Kogg: Run Diagnostics', electronApplication);
    const afterClose = await waitForElectronStreamAdvance(widget, advancedFirst);
    await clearNotifications(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    widget = await ensureElectronOperationsWidget(page, electronApplication);
    assert(await electronStreamSequence(widget) >= afterClose);
    await page.evaluate(() => sessionStorage.setItem('kogg.operations.stream.cursor.v1', 'corrupt-electron-e2e-cursor'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('body.kogg-application').waitFor({ timeout: 20_000 });
    widget = await ensureElectronOperationsWidget(page, electronApplication);
    assert(await electronStreamSequence(widget) >= afterClose);
    assert.match(logs.join('\n'), /\[kogg:operations:stream\] resync-required/u);
}

async function ensureElectronOperationsWidget(page, electronApplication) {
    const widgets = page.locator('.kogg-operations-widget');
    if (!await widgets.count()) {
        await openCommand(page, 'Kogg: Show Operations', electronApplication);
        await widgets.first().waitFor({ state: 'attached', timeout: 10_000 });
    }
    const widget = widgets.filter({ visible: true }).first();
    await widget.getByRole('status').filter({ hasText: /Stream: current/u }).waitFor({ timeout: 10_000 });
    return widget;
}

async function electronStreamSequence(widget) {
    const status = await widget.getByRole('status').filter({ hasText: /Stream:/u }).innerText();
    const match = /sequence (\d+)/u.exec(status);
    assert(match, `Missing operations stream sequence in: ${status}`);
    return BigInt(match[1]);
}

async function exerciseElectronGovernedRunDetails(widget) {
    const row = widget.locator('[data-projected-run]').filter({ hasText: /failed|completed/u }).last();
    await row.waitFor({ state: 'visible', timeout: 15_000 });
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
    await widget.getByRole('tabpanel', { name: 'Timeline details' }).getByRole('cell', { name: 'diagnostic', exact: true }).first().waitFor({ timeout: 10_000 });
}

async function synchronizeElectronStreamSequences(first, second) {
    const expected = [await electronStreamSequence(first), await electronStreamSequence(second)].reduce((maximum, current) => current > maximum ? current : maximum, 0n);
    await Promise.all([waitForElectronStreamAtLeast(first, expected), waitForElectronStreamAtLeast(second, expected)]);
    return expected;
}

async function waitForElectronStreamAdvance(widget, previous) {
    return waitForElectronStreamAtLeast(widget, previous + 1n);
}

async function waitForElectronStreamAtLeast(widget, expected) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const current = await electronStreamSequence(widget);
        if (current >= expected) return current;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for Electron operations stream sequence ${expected}`);
}

async function exerciseElectronExecution(page, electronApplication) {
    const widget = page.locator('.kogg-execution-widget').last();
    if (!await widget.count()) {
        await openCommand(page, 'View: Toggle Kogg Execution', electronApplication);
        await widget.waitFor({ state: 'attached', timeout: 10_000 });
    }
    const start = widget.getByRole('button', { name: 'Start run' });
    await start.waitFor({ state: 'visible', timeout: 15_000 });
    const qualification = widget.getByRole('status'); let code; const deadline = Date.now() + 15_000;
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
    await widget.getByRole('button', { name: 'Refresh' }).click();
    await widget.getByText(`Run start unavailable: ${code}.`).waitFor({ timeout: 10_000 });
    assert.match(logs.join('\n'), /\[kogg:execution:widget\] runs\.load\.completed/u);
    assert.doesNotMatch(await widget.innerText(), /worktreeId|bindingDigest|nonce|refs\/kogg|command|prompt|source code/iu);
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
    const expectedLocations = new Set([normalizedPickerPath(folder), normalizedPickerPath(canonicalFolder)]);
    const folderDeadline = Date.now() + 10_000;
    let selectedLocation = '';
    while (Date.now() < folderDeadline) {
        selectedLocation = normalizedPickerPath(await locationList.inputValue());
        if (expectedLocations.has(selectedLocation)) break;
        await page.waitForTimeout(50);
    }
    assert.equal(expectedLocations.has(selectedLocation), true);
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
    const start = async () => {
        await openCommand(page, 'Debug: Select and Start Debugging', electronApplication);
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
    await page.waitForTimeout(500);
    await start();
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
