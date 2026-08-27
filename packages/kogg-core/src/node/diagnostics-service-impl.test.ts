import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import type { KoggDiagnosticContributor } from '@kogg/contracts';
import type { OperationRegistryApi, StartOperation } from '@kogg/operations/lib/common/operations-protocol';
import { KoggDiagnosticsServiceImpl } from './diagnostics-service-impl';
import { DiagnosticOwnerJournal } from './diagnostic-owner-journal';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';

test('diagnostics aggregate failures and export a redacted private support bundle', async context => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'kogg-diagnostics-'));
  const previous = process.env.KOGG_STATE_DIR;
  process.env.KOGG_STATE_DIR = state;
  const projection = new OperationsReadModel(path.join(state, 'operations', 'projection.sqlite3'));
  projection.start();
  const owner = new DiagnosticOwnerJournal(projection);
  await owner.onStart();
  context.after(async () => {
    owner.onStop();
    projection.stop();
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
  const startedOperations: StartOperation[] = [];
  const operations = {
    startOperation: async (input: StartOperation) => {
      startedOperations.push(input);
      return {
      id: input.id!, cancellable: false, start() {}, active() {}, waiting() {}, activity() {}, refuse() {},
      complete() {}, fail() {}, timeout() {}, cancel: async () => undefined, cleanup: async () => undefined,
      registerProcess() { throw new Error('No process is expected in this diagnostics test'); }
    }; }
  } as unknown as OperationRegistryApi;
  const service = new KoggDiagnosticsServiceImpl(provider, operations, owner);

  const report = await service.run();
  assert.equal(report.overall, 'fail');
  assert.equal(report.checks.find(check => check.id === 'broken.contributor')?.status, 'fail');
  assert.equal(projection.diagnostics().acceptedEventCount, 2);
  assert.equal(startedOperations[0]?.id, startedOperations[0]?.correlations?.runId);
  assert.equal(projection.snapshot().runs.length, 1);
  assert.equal(projection.snapshot().runs[0]?.lifecycle, 'failed');
  assert.deepEqual(projection.timeline(startedOperations[0]!.id!), projection.timeline(startedOperations[0]!.id!).filter(entry => entry.ownerKind === 'diagnostic'));

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
  assert.equal(projection.diagnostics().acceptedEventCount, 4);
  assert.equal(projection.snapshot().runs.length, 2);
  const journalBytes = await fs.readFile(path.join(state, 'diagnostics', 'owner.sqlite3'));
  assert.equal(journalBytes.includes(Buffer.from('hidden-value')), false);
  assert.equal(journalBytes.includes(Buffer.from('should-not-survive')), false);
  assert.equal(journalBytes.includes(Buffer.from('sensitive failure body')), false);
});

test('diagnostic owner journal fails closed when its immutable fact chain is corrupted', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'kogg-diagnostic-owner-corrupt-'));
  const previous = process.env.KOGG_STATE_DIR;
  process.env.KOGG_STATE_DIR = state;
  const projection = new OperationsReadModel(path.join(state, 'operations', 'projection.sqlite3'));
  projection.start();
  const owner = new DiagnosticOwnerJournal(projection);
  try {
    await owner.onStart();
    owner.started(randomUUID(), new Date().toISOString());
    owner.onStop();
    const database = new DatabaseSync(path.join(state, 'diagnostics', 'owner.sqlite3'));
    database.exec("DROP TRIGGER diagnostic_events_immutable_update; UPDATE diagnostic_events SET fact_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE event_sequence=1;");
    database.close();
    const corrupted = new DiagnosticOwnerJournal(projection);
    await assert.rejects(corrupted.onStart(), /integrity/iu);
  } finally {
    owner.onStop();
    projection.stop();
    if (previous === undefined) delete process.env.KOGG_STATE_DIR;
    else process.env.KOGG_STATE_DIR = previous;
    await fs.rm(state, { recursive: true, force: true });
  }
});
