import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUnbundledElectronArgv } from './electron-main-module';

test('normalizes Playwright switches before the Electron application directory', () => {
  const result = normalizeUnbundledElectronArgv([
    '/electron', '--inspect=0', '--remote-debugging-port=0', '/apps/electron',
    '--electronUserData=/tmp/profile', '/tmp/workspace'
  ]);

  assert.deepEqual(result, {
    args: ['--electronUserData=/tmp/profile', '/tmp/workspace'],
    debugSwitches: 2
  });
});

test('normalizes Playwright switches after the Electron application directory', () => {
  const result = normalizeUnbundledElectronArgv([
    '/electron', '/apps/electron', '--inspect=0', '--remote-debugging-port=0',
    '--electronUserData=/tmp/profile', '/tmp/workspace'
  ]);

  assert.deepEqual(result, {
    args: ['--electronUserData=/tmp/profile', '/tmp/workspace'],
    debugSwitches: 2
  });
});
