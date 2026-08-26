import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import type { KoggDiagnosticContributor } from '@kogg/contracts';
import type { OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import { KoggDiagnosticsServiceImpl } from './diagnostics-service-impl';

test('diagnostics aggregate failures and export a redacted private support bundle', async context => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'kogg-diagnostics-'));
  const previous = process.env.KOGG_STATE_DIR;
  process.env.KOGG_STATE_DIR = state;
  context.after(async () => {
    if (previous === undefined) delete process.env.KOGG_STATE_DIR;
    else process.env.KOGG_STATE_DIR = previous;
    await fs.rm(state, { recursive: true, force: true });
  });

  const contributors: KoggDiagnosticContributor[] = [
    {
      id: 'safe',
      async diagnose() {
        return [{
          id: 'core.runtime', status: 'pass' as const, summary: 'Bearer should-not-survive',
          details: { authorization: 'Bearer hidden-value', harmless: 'visible' }
        }];
      }
    },
    { id: 'broken', async diagnose() { throw new Error('sensitive failure body'); } }
  ];
  const provider = { getContributions: () => contributors } as ContributionProvider<KoggDiagnosticContributor>;
  const operations = {
    startOperation: async () => ({
      id: 'diagnostics-test-operation', cancellable: false, start() {}, active() {}, waiting() {}, activity() {}, refuse() {},
      complete() {}, fail() {}, timeout() {}, cancel: async () => undefined, cleanup: async () => undefined,
      registerProcess() { throw new Error('No process is expected in this diagnostics test'); }
    })
  } as unknown as OperationRegistryApi;
  const service = new KoggDiagnosticsServiceImpl(provider, operations);

  const report = await service.run();
  assert.equal(report.overall, 'fail');
  assert.equal(report.checks.find(check => check.id === 'broken.contributor')?.status, 'fail');

  const bundle = await service.createSupportBundle();
  const files = await fs.readdir(path.join(state, 'support'));
  assert.equal(files.length, 1);
  const destination = path.join(state, 'support', files[0]!);
  const contents = await fs.readFile(destination, 'utf8');
  assert.equal(contents.includes('hidden-value'), false);
  assert.equal(contents.includes('should-not-survive'), false);
  assert.equal(contents.includes('sensitive failure body'), false);
  assert.equal(contents.includes('[redacted]'), true);
  if (process.platform !== 'win32') assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  assert.match(bundle.uri, /^file:/u);
});
