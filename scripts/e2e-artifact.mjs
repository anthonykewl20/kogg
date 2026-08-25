import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-artifact-e2e-'));
const workspace = path.join(temporary, 'workspace');
let application;

try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'README.md'), '# Packaged Kogg smoke\n');
    application = await electron.launch({
        executablePath: await packagedExecutable(),
        args: [`--electronUserData=${path.join(temporary, 'electron-user-data')}`, workspace],
        env: {
            ...process.env,
            KOGG_RUNTIME: 'electron',
            KOGG_STATE_DIR: path.join(temporary, 'state'),
            THEIA_CONFIG_DIR: path.join(temporary, 'state', 'config'),
            KOGG_REGISTRY_URL: 'https://registry.invalid/packaged-smoke'
        },
        timeout: 30_000
    });
    await application.firstWindow({ timeout: 30_000 });
    const page = await waitForKoggWindow(application);
    assert.match(await page.title(), /Kogg|workspace/iu);
    const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
    await trust.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    if (await trust.isVisible().catch(() => false)) await trust.click();
    await openCommand(page, 'Kogg: Open Marketplace', application);
    await page.locator('.kogg-marketplace-widget').getByText('Kogg Marketplace').first().waitFor();
    await openCommand(page, 'View: Toggle Kogg AI', application);
    await page.locator('.kogg-provider-widget').getByText('Advisory only').waitFor();
    await openCommand(page, 'Kogg: Run Diagnostics', application);
    await page.getByText(/Diagnostics:/u).first().waitFor({ timeout: 20_000 });
    assert.doesNotMatch(await page.locator('body').innerText(), /Search Open VSX Registry|Learn more about Theia|custom-agent migration/iu);
    process.stdout.write('Packaged Kogg application smoke passed: native launch, embedded runtime diagnostics, marketplace, provider, and branding.\n');
} finally {
    if (application) await application.close().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
}

async function packagedExecutable() {
    const candidates = process.platform === 'darwin'
        ? [path.join(root, 'apps/electron/dist/mac-arm64/Kogg.app/Contents/MacOS/Kogg'), path.join(root, 'apps/electron/dist/mac/Kogg.app/Contents/MacOS/Kogg')]
        : process.platform === 'win32'
            ? [path.join(root, 'apps/electron/dist/win-unpacked/Kogg.exe')]
            : [path.join(root, 'apps/electron/dist/linux-unpacked/Kogg'), path.join(root, 'apps/electron/dist/linux-unpacked/kogg')];
    for (const candidate of candidates) {
        try { await access(candidate); return candidate; } catch { /* try the next target */ }
    }
    throw new Error(`No packaged Kogg executable found for ${process.platform}`);
}

async function waitForKoggWindow(electronApplication) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        for (const window of electronApplication.windows()) {
            if (!window.isClosed() && await window.locator('body.kogg-application').count().catch(() => 0)) return window;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for packaged Kogg workbench');
}

async function openCommand(page, label, electronApplication) {
    const input = page.getByRole('textbox', { name: 'Type to narrow down results.' });
    await page.bringToFront();
    await page.locator('body').click({ position: { x: 600, y: 300 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
    await input.waitFor({ state: 'visible', timeout: 3_000 }).catch(async () => {
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
    await page.getByRole('option', { name: label, exact: true }).click();
}
