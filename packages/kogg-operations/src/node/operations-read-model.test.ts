import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { OwnerEventV1, OwnerKind, SafeCorrelationsV1, SafeOwnerPayloadV1 } from '../common/operations-read-model-protocol';
import { OperationsReadModel, ProjectionFault } from './operations-read-model';

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
    fixture.model.rebuild();
    const after = fixture.model.snapshot();
    assert.deepEqual(after.runs, before.runs); assert.notEqual(after.projectionEpoch, before.projectionEpoch);
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
