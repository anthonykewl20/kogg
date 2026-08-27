import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { OwnerEventV1, OwnerKind, SafeCorrelationsV1, SafeOwnerPayloadV1 } from '../common/operations-read-model-protocol';
import { OperationsReadModel, ProjectionFault } from './operations-read-model';
import { OperationsSupportExporter } from './operations-support-export';
import { OperationsActionRouter } from './operations-action-router';
import type { OperationRegistryApi } from '../common/operations-protocol';

// diagnostic-coverage: operations.projection, operations.owners, operations.correlations, operations.timeline, operations.processes, operations.metrics, operations.source-maps

test('accepts a chained owner stream idempotently and rebuilds an identical safe projection', async () => {
  const fixture = await createFixture();
  try {
    const runId = randomUUID(); const taskId = randomUUID(); const attemptId = randomUUID(); const processId = randomUUID();
    const workflow = fixture.owner('workflow'); const adapter = fixture.owner('adapter'); const operation = fixture.owner('operation');
    const queued = workflow.event('run.queued', { runId, taskId }, { lifecycle: 'queued' });
    assert.equal(fixture.model.ingest(queued), 'accepted'); assert.equal(fixture.model.ingest(queued), 'duplicate');
    fixture.model.ingest(adapter.event('attempt.requested', { runId, taskId, attemptId }, { retryOrdinal: 0 }, queued));
    fixture.model.ingest(operation.event('process.reserved', { runId, taskId, attemptId, processId }, { processKind: 'provider-cli', cleanupState: 'required' }));
    fixture.model.ingest(operation.event('process.started', { runId, taskId, attemptId, processId }, { processKind: 'provider-cli', cleanupState: 'required' }));
    fixture.model.ingest(workflow.event('run.completed', { runId, taskId }, { lifecycle: 'completed' }));
    let projection = fixture.model.snapshot().runs[0]!;
    assert.equal(projection.lifecycle, 'cleaning'); assert.equal(projection.liveProcessCount, 1);
    fixture.model.ingest(operation.event('process.exited', { runId, taskId, attemptId, processId }, { processKind: 'provider-cli', cleanupState: 'required' }));
    projection = fixture.model.snapshot().runs[0]!;
    assert.equal(projection.lifecycle, 'cleaning'); assert.equal(projection.abnormalProcessCount, 1);
    fixture.model.ingest(operation.event('process.cleaned', { runId, taskId, attemptId, processId }, { processKind: 'provider-cli', cleanupState: 'cleaned' }));
    const before = fixture.model.snapshot();
    assert.deepEqual(before.runs[0], { runId, taskId, lifecycle: 'completed', attemptCount: 1, retryCount: 0, liveProcessCount: 0, abnormalProcessCount: 0, checkSummary: 'unknown', evidenceSummary: 'unknown', verdictSummary: 'unknown', mergeSummary: 'unknown', freshness: 'current', degradedOwners: [] });
    assert.equal(fixture.model.timeline(runId).length, 7);
    const beforeMetrics = fixture.model.metrics();
    assert(beforeMetrics.values.some(metric => metric.name === 'kogg_operations_total' && metric.value === 1));
    assert(beforeMetrics.values.some(metric => metric.name === 'kogg_runs_active' && metric.labels.lifecycle_class === 'completed' && metric.value === 1));
    assert.doesNotMatch(JSON.stringify(beforeMetrics.values.map(metric => metric.labels)), new RegExp([runId, taskId, attemptId, processId].join('|'), 'u'));
    fixture.model.rebuild();
    const after = fixture.model.snapshot();
    assert.deepEqual(after.runs, before.runs); assert.notEqual(after.projectionEpoch, before.projectionEpoch);
    const afterMetrics = fixture.model.metrics(); assert.notEqual(afterMetrics.projectionEpoch, beforeMetrics.projectionEpoch); assert.deepEqual(afterMetrics.values, beforeMetrics.values);
    assert.deepEqual(fixture.model.diagnostics(), { integrity: true, foreignKeys: true, lifecycle: 'current', ownerCount: 3, faultCount: 0, causalGapCount: 0, processAbnormalCount: 0, metricViolationCount: 0 });
  } finally { await fixture.close(); }
});

test('persists chain conflicts as degraded faults without cursor advance', async () => {
  const fixture = await createFixture();
  try {
    const owner = fixture.owner('workflow'); const runId = randomUUID();
    fixture.model.ingest(owner.event('run.queued', { runId }, { lifecycle: 'queued' }));
    const gap = owner.event('run.started', { runId }, { lifecycle: 'active' });
    const skipped = owner.event('run.waiting', { runId }, { lifecycle: 'waiting' });
    await assert.rejects(async () => fixture.model.ingest(skipped), (error: unknown) => error instanceof ProjectionFault && error.safeCode === 'OWNER_CURSOR_GAP');
    assert.equal(fixture.model.snapshot().lifecycle, 'degraded'); assert.equal(fixture.model.snapshot().faultCount, 1);
    assert.equal(fixture.model.ingest(gap), 'accepted');
    assert.equal(fixture.model.snapshot().runs[0]?.lifecycle, 'active');
  } finally { await fixture.close(); }
});

test('binds bounded pagination cursors to query and projection epoch', async () => {
  const fixture = await createFixture();
  try {
    const owner = fixture.owner('workflow'); const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const runId of ids) fixture.model.ingest(owner.event('run.queued', { runId }, { lifecycle: 'queued' }));
    const first = fixture.model.listRuns({ sort: 'run-id-asc', pageSize: 1 }); assert.deepEqual(first.items.map(item => item.runId), [ids[0]]); assert(first.nextCursor);
    const second = fixture.model.listRuns({ sort: 'run-id-asc', pageSize: 1, pageCursor: first.nextCursor }); assert.deepEqual(second.items.map(item => item.runId), [ids[1]]);
    assert.throws(() => fixture.model.listRuns({ lifecycle: 'queued', sort: 'run-id-asc', pageSize: 1, pageCursor: first.nextCursor }), /PROJECTION_CURSOR_RESYNC_REQUIRED/u);
    fixture.model.rebuild();
    assert.throws(() => fixture.model.listRuns({ sort: 'run-id-asc', pageSize: 1, pageCursor: first.nextCursor }), /PROJECTION_CURSOR_RESYNC_REQUIRED/u);
    assert.throws(() => fixture.model.listRuns({ sort: 'run-id-asc', pageSize: 101 }), /PROJECTION_QUERY_INVALID/u);
  } finally { await fixture.close(); }
});

test('resumes bounded projection changes and requires resync after rebuild', async () => {
  const fixture = await createFixture(); const delivered: string[] = [];
  fixture.model.setClient({ projectionChanged(change) { delivered.push(change.sequence); } });
  try {
    const initial = fixture.model.subscribe(); assert.equal(initial.state, 'current'); assert.deepEqual(initial.changes, []);
    const owner = fixture.owner('workflow'); fixture.model.ingest(owner.event('run.queued', { runId: randomUUID() }, { lifecycle: 'queued' }));
    assert.deepEqual(delivered, ['1']);
    const resumed = fixture.model.subscribe(initial.cursor); assert.equal(resumed.state, 'current'); assert.equal(resumed.changes.length, 1); assert.equal(resumed.changes[0]?.protected, true);
    fixture.model.rebuild();
    const stale = fixture.model.subscribe(resumed.cursor); assert.equal(stale.state, 'resync-required'); assert.deepEqual(stale.changes, []);
  } finally { fixture.model.setClient(undefined); await fixture.close(); }
});

test('refuses missing causal parents and content-shaped payload fields', async () => {
  const fixture = await createFixture();
  try {
    const owner = fixture.owner('workflow'); const runId = randomUUID();
    const missing = owner.event('run.queued', { runId }, { lifecycle: 'queued' }, {
      ownerKind: 'task', ownerInstanceId: randomUUID(), ownerSchemaVersion: 1, epochId: randomUUID(), sequence: '1', eventId: randomUUID(), eventKind: 'task.created', factId: randomUUID(), factDigest: 'a'.repeat(64), previousEventDigest: '0'.repeat(64), causalParents: [], correlations: {}, observedAt: new Date().toISOString(), safePayload: {}, eventDigest: 'b'.repeat(64)
    });
    assert.throws(() => fixture.model.ingest(missing), /CAUSAL_PARENT_MISSING/u);
    const unsafe = owner.event('run.queued', { runId }, { lifecycle: 'queued' }) as OwnerEventV1 & { safePayload: Record<string, unknown> };
    unsafe.safePayload = { prompt: 'secret' };
    assert.throws(() => fixture.model.ingest(unsafe), /OWNER_PAYLOAD_INVALID/u);
    assert.equal(fixture.model.snapshot().runs.length, 0);
  } finally { await fixture.close(); }
});

test('read-model failure logs contain safe classifications and not rejected content', async () => {
  const fixture = await createFixture(); const lines: string[] = []; const original = console.warn;
  console.warn = (...values: unknown[]) => lines.push(JSON.stringify(values));
  try {
    const owner = fixture.owner('workflow'); const event = owner.event('run.queued', { runId: randomUUID() }, { lifecycle: 'queued' }) as OwnerEventV1 & { safePayload: Record<string, unknown> };
    event.safePayload = { prompt: 'deliberate-canary-value' };
    assert.throws(() => fixture.model.ingest(event));
    const output = lines.join('\n'); assert.match(output, /OWNER_PAYLOAD_INVALID/u); assert.doesNotMatch(output, /deliberate-canary-value|prompt/u);
  } finally { console.warn = original; await fixture.close(); }
});

test('writes a bounded private checksummed support export without raw content', async () => {
  const fixture = await createFixture(); const supportDirectory = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-support-test-'));
  try {
    const runId = randomUUID(); fixture.model.ingest(fixture.owner('workflow').event('run.queued', { runId }, { lifecycle: 'queued' }));
    const exporter = new OperationsSupportExporter(fixture.model, supportDirectory); const receipt = await exporter.export({ requestId: randomUUID(), runId });
    const exported = await exporter.read(receipt.exportId); assert.equal(exported.sha256, receipt.sha256); assert.equal(exported.byteLength, receipt.byteLength);
    assert.doesNotMatch(exported.content, /prompt|source|diff|command|environment|credential|authorization|cookie|rawBody/u);
    const mode = (await stat(path.join(supportDirectory, `kogg-operations-support-${receipt.exportId}.json`))).mode & 0o077; if (process.platform !== 'win32') assert.equal(mode, 0);
    await assert.rejects(exporter.read(randomUUID()), /SUPPORT_EXPORT_UNAVAILABLE/u);
  } finally { await fixture.close(); await rm(supportDirectory, { recursive: true, force: true }); }
});

test('refuses prohibited support content before creating an export', async () => {
  const supportDirectory = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-support-canary-test-'));
  const unsafe = { snapshot: () => ({ schemaVersion: 1, projectionEpoch: randomUUID(), changeSequence: '0', lifecycle: 'current', faultCount: 0, runs: [{ runId: randomUUID(), prompt: 'canary' }] }), timeline: () => [], metrics: () => ({ schemaVersion: 1, projectionEpoch: randomUUID(), values: [] }), diagnostics: () => ({}) } as unknown as OperationsReadModel;
  try {
    const exporter = new OperationsSupportExporter(unsafe, supportDirectory);
    await assert.rejects(exporter.export({ requestId: randomUUID() }), /SUPPORT_CONTENT_PROHIBITED/u);
    assert.deepEqual(await readdir(supportDirectory), []);
  } finally { await rm(supportDirectory, { recursive: true, force: true }); }
});

test('routes exact cancel authority once without optimistic lifecycle mutation', async () => {
  const fixture = await createFixture(); let calls = 0;
  try {
    const runId = randomUUID(); const operationId = randomUUID(); const processId = randomUUID();
    fixture.model.ingest(fixture.owner('workflow').event('run.started', { runId }, { lifecycle: 'active' }));
    fixture.model.ingest(fixture.owner('operation').event('process.reserved', { runId, operationId, processId }, { processKind: 'governed-command', cleanupState: 'required' }));
    const operations = { async cancel(request: { requestId: string; operationId: string }) { calls++; assert.equal(request.operationId, operationId); return { schemaVersion: 1, revision: 1, admission: 'enabled', active: [], recent: [] }; } } as unknown as OperationRegistryApi;
    const router = new OperationsActionRouter(fixture.model, operations); const request = { requestId: randomUUID(), action: 'cancel' as const, runId, operationId, expectedProjectionSequence: fixture.model.snapshot().changeSequence };
    const first = await router.request(request); assert.equal(first.status, 'forwarded'); assert.equal(first.safeCode, 'ACTION_OWNER_ACCEPTED');
    assert.equal(fixture.model.snapshot().runs[0]?.lifecycle, 'active');
    assert.deepEqual(await router.request(request), first); assert.equal(calls, 1);
    await assert.rejects(router.request({ ...request, action: 'retry' }), /ACTION_REQUEST_REPLAY_MISMATCH/u);
  } finally { await fixture.close(); }
});

test('keeps failed owner action outcome unknown and never retries it automatically', async () => {
  const fixture = await createFixture(); let calls = 0;
  try {
    const runId = randomUUID(); const operationId = randomUUID(); const processId = randomUUID();
    fixture.model.ingest(fixture.owner('workflow').event('run.started', { runId }, { lifecycle: 'active' }));
    fixture.model.ingest(fixture.owner('operation').event('process.reserved', { runId, operationId, processId }, { processKind: 'governed-command', cleanupState: 'required' }));
    const operations = { async cancel(): Promise<never> { calls++; throw new Error('transport lost after send'); } } as unknown as OperationRegistryApi;
    const router = new OperationsActionRouter(fixture.model, operations); const request = { requestId: randomUUID(), action: 'cancel' as const, runId, operationId, expectedProjectionSequence: fixture.model.snapshot().changeSequence };
    await assert.rejects(router.request(request), /transport lost/u); const replay = await router.request(request);
    assert.equal(replay.status, 'unknown'); assert.equal(replay.safeCode, 'ACTION_OUTCOME_UNKNOWN'); assert.equal(calls, 1);
  } finally { await fixture.close(); }
});

test('production operations read model emits a TypeScript source map', async () => {
  const sourceMap = JSON.parse(await readFile(path.join(__dirname, 'operations-read-model.js.map'), 'utf8')) as { sources?: string[] };
  assert(sourceMap.sources?.some(source => source.endsWith('/src/node/operations-read-model.ts')));
});

async function createFixture(): Promise<{ model: OperationsReadModel; owner(kind: OwnerKind): OwnerBuilder; close(): Promise<void> }> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-read-model-test-'));
  const model = new OperationsReadModel(path.join(temporary, 'projection.sqlite3')); model.start();
  const owners = new Map<OwnerKind, OwnerBuilder>();
  return { model, owner(kind) { let owner = owners.get(kind); if (!owner) { owner = new OwnerBuilder(kind); owners.set(kind, owner); } return owner; }, async close() { model.stop(); await rm(temporary, { recursive: true, force: true }); } };
}

class OwnerBuilder {
  private sequence = 0n; private previous = '0'.repeat(64);
  private readonly instanceId = randomUUID(); private readonly epochId = randomUUID();
  constructor(private readonly kind: OwnerKind) {}
  event(eventKind: string, correlations: SafeCorrelationsV1, safePayload: SafeOwnerPayloadV1, causalParent?: OwnerEventV1): OwnerEventV1 {
    const unsigned: Omit<OwnerEventV1, 'eventDigest'> = { ownerKind: this.kind, ownerInstanceId: this.instanceId, ownerSchemaVersion: 1, epochId: this.epochId, sequence: String(++this.sequence), eventId: randomUUID(), eventKind, factId: randomUUID(), factDigest: 'a'.repeat(64), previousEventDigest: this.previous, causalParents: causalParent ? [{ ownerInstanceId: causalParent.ownerInstanceId, epochId: causalParent.epochId, sequence: causalParent.sequence, eventDigest: causalParent.eventDigest }] : [], correlations, observedAt: new Date().toISOString(), safePayload };
    const event = { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) }; this.previous = event.eventDigest; return event;
  }
}
