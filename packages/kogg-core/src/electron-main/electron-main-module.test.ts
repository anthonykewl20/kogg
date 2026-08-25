import assert from 'node:assert/strict';
import test from 'node:test';
import { isBundledElectronApplication, normalizeUnbundledElectronArgv } from './electron-main-module';

test('uses Electron packaging state instead of process.defaultApp', () => {
  const developmentArgv = ['/electron', '/apps/electron', '--electronUserData=/tmp/profile', '/tmp/workspace'];
  const packagedArgv = ['/Kogg', '--electronUserData=/tmp/profile', '/tmp/workspace'];
  assert.equal(isBundledElectronApplication(true, false, developmentArgv, '/apps/electron'), false);
  assert.equal(isBundledElectronApplication(true, true, developmentArgv, '/apps/electron'), false);
  assert.equal(isBundledElectronApplication(true, true, packagedArgv, '/app.asar'), true);
  assert.equal(isBundledElectronApplication(true, true, packagedArgv, '/app.asar', true), false);
  assert.equal(isBundledElectronApplication(false, true, packagedArgv, '/app.asar'), false);
});

test('normalizes Playwright switches before the Electron application directory', () => {
  const result = normalizeUnbundledElectronArgv([
    '/electron', '--inspect=0', '--remote-debugging-port=0', '/apps/electron',
    '--electronUserData=/tmp/profile', '/tmp/workspace'
  ]);

  assert.deepEqual(result, {
    args: ['--electronUserData=/tmp/profile', '/tmp/workspace'],
    debugSwitches: 2,
    applicationDirectoryRemoved: true
  });
});

test('normalizes Playwright switches after the Electron application directory', () => {
  const result = normalizeUnbundledElectronArgv([
    '/electron', '/apps/electron', '--inspect=0', '--remote-debugging-port=0',
    '--electronUserData=/tmp/profile', '/tmp/workspace'
  ]);

  assert.deepEqual(result, {
    args: ['--electronUserData=/tmp/profile', '/tmp/workspace'],
    debugSwitches: 2,
    applicationDirectoryRemoved: true
  });
});

test('retains the first Kogg option for a packaged Playwright launch', () => {
  const result = normalizeUnbundledElectronArgv([
    '/Kogg', '--inspect=0', '--remote-debugging-port=0',
    '--electronUserData=/tmp/profile', '/tmp/workspace'
  ]);

  assert.deepEqual(result, {
    args: ['--electronUserData=/tmp/profile', '/tmp/workspace'],
    debugSwitches: 2,
    applicationDirectoryRemoved: false
  });
});
