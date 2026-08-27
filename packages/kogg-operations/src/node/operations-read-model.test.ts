import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { KoggDiagnosticsService } from '@kogg/contracts';
import { OWNER_KINDS, type OwnerEventV1, type OwnerKind, type SafeCorrelationsV1, type SafeOwnerPayloadV1 } from '../common/operations-read-model-protocol';
import { OperationsReadModel, ProjectionFault } from './operations-read-model';
import { OperationsSupportExporter } from './operations-support-export';
import { OperationsActionRouter } from './operations-action-router';
import type { OperationRegistryApi } from '../common/operations-protocol';
import { OperationRegistry } from './operation-registry';

// diagnostic-coverage: operations.projection, operations.owners, operations.correlations, operations.timeline, operations.processes, operations.metrics, operations.retention, operations.source-maps

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
    assert.deepEqual(fixture.model.diagnostics(), { integrity: true, foreignKeys: true, lifecycle: 'current', ownerCount: 3, acceptedEventCount: 7, faultCount: 0, causalGapCount: 0, processAbnormalCount: 0, metricViolationCount: 0, retainedMetricEpochCount: 2, retainedActivityAggregateCount: 0, activityAggregateViolationCount: 0, activeRetentionHoldCount: 0, retentionViolationCount: 0 });
  } finally { await fixture.close(); }
});

test('projects correlated diagnostic lifecycle as a governed run', async () => {
  const fixture = await createFixture();
  try {
    const runId = randomUUID(); const owner = fixture.owner('diagnostic');
    fixture.model.ingest(owner.event('diagnostic.started', { runId }, { resultClass: 'pending' }));
    assert.equal(fixture.model.snapshot().runs[0]?.lifecycle, 'active');
    fixture.model.ingest(owner.event('diagnostic.failed', { runId }, { resultClass: 'failed', safeCode: 'DIAGNOSTIC_FAILED' }));
    assert.equal(fixture.model.snapshot().runs[0]?.lifecycle, 'failed');
    assert.deepEqual(fixture.model.timeline(runId).map(entry => entry.eventKind), ['diagnostic.started', 'diagnostic.failed']);
  } finally { await fixture.close(); }
});

test('coalesces only matching process activity buckets with exact counts and deterministic rebuilds', async () => {
  const fixture = await createFixture();
  try {
    const runId = randomUUID(); const attemptId = randomUUID(); const processId = randomUUID(); const operation = fixture.owner('operation');
    const correlations = { runId, attemptId, processId };
    fixture.model.ingest(operation.event('process.ready', correlations, { processKind: 'provider-cli', processState: 'ready', cleanupState: 'required' }, undefined, '2026-08-28T00:00:05.000Z'));
    fixture.model.ingest(operation.event('process.activity', correlations, { processKind: 'provider-cli', processState: 'activity', cleanupState: 'required', safeCode: 'PROVIDER_BUSY', count: 2 }, undefined, '2026-08-28T00:00:10.000Z'));
    fixture.model.ingest(operation.event('process.activity', correlations, { processKind: 'provider-cli', processState: 'activity', cleanupState: 'required', safeCode: 'PROVIDER_BUSY', count: 3 }, undefined, '2026-08-28T00:00:40.000Z'));
    fixture.model.ingest(operation.event('process.activity', correlations, { processKind: 'provider-cli', processState: 'activity', cleanupState: 'required', safeCode: 'PROVIDER_WAITING' }, undefined, '2026-08-28T00:00:45.000Z'));
    fixture.model.ingest(operation.event('process.activity', correlations, { processKind: 'provider-cli', processState: 'activity', cleanupState: 'required', safeCode: 'PROVIDER_BUSY' }, undefined, '2026-08-28T00:01:00.000Z'));
    const before = fixture.model.timeline(runId);
    assert.equal(before.length, 4); assert.equal(before[0]?.eventKind, 'process.ready');
    assert.deepEqual(before.slice(1).map(entry => ({ safeCode: entry.safeCode, count: entry.count, first: entry.firstDisplayTime, last: entry.lastDisplayTime })), [
      { safeCode: 'PROVIDER_BUSY', count: 5, first: '2026-08-28T00:00:10.000Z', last: '2026-08-28T00:00:40.000Z' },
      { safeCode: 'PROVIDER_WAITING', count: 1, first: '2026-08-28T00:00:45.000Z', last: '2026-08-28T00:00:45.000Z' },
      { safeCode: 'PROVIDER_BUSY', count: 1, first: '2026-08-28T00:01:00.000Z', last: '2026-08-28T00:01:00.000Z' }
    ]);
    assert.equal(fixture.model.diagnostics().retainedActivityAggregateCount, 3); assert.equal(fixture.model.diagnostics().activityAggregateViolationCount, 0);
    fixture.model.rebuild(); assert.deepEqual(fixture.model.timeline(runId), before);
  } finally { await fixture.close(); }
});

test('retains activity aggregates for 90 days and extends them under owner holds', async () => {
  const fixture = await createFixture(); const observedAt = '2026-01-01T00:00:00.000Z';
  try {
    const runId = randomUUID(); const processId = randomUUID(); const operation = fixture.owner('operation'); const workflow = fixture.owner('workflow'); const ranex = fixture.owner('ranex');
    fixture.model.ingest(operation.event('process.activity', { runId, processId }, { processKind: 'provider-cli', processState: 'activity', cleanupState: 'required', count: 4 }, undefined, observedAt));
    fixture.model.ingest(operation.event('process.cleaned', { runId, processId }, { processKind: 'provider-cli', processState: 'cleaned', cleanupState: 'cleaned' }, undefined, observedAt));
    fixture.model.ingest(workflow.event('run.completed', { runId }, { lifecycle: 'completed' }, undefined, observedAt));
    assert.equal(fixture.model.applyRetention(Date.parse('2026-02-01T00:00:00.001Z')), 1);
    assert.equal(fixture.model.snapshot().runs.some(run => run.runId === runId), false);
    assert.equal(fixture.model.timeline(runId)[0]?.count, 4); assert.equal(fixture.model.diagnostics().retainedActivityAggregateCount, 1);
    fixture.model.applyRetention(Date.parse('2026-04-02T00:00:00.001Z'));
    assert.equal(fixture.model.timeline(runId).length, 0); assert.equal(fixture.model.diagnostics().retainedActivityAggregateCount, 0);

    const heldRunId = randomUUID(); const heldProcessId = randomUUID();
    fixture.model.ingest(operation.event('process.activity', { runId: heldRunId, processId: heldProcessId }, { processKind: 'provider-cli', processState: 'activity', cleanupState: 'required' }, undefined, observedAt));
    fixture.model.ingest(operation.event('process.cleaned', { runId: heldRunId, processId: heldProcessId }, { processKind: 'provider-cli', processState: 'cleaned', cleanupState: 'cleaned' }, undefined, observedAt));
    fixture.model.ingest(workflow.event('run.completed', { runId: heldRunId }, { lifecycle: 'completed' }, undefined, observedAt));
    fixture.model.ingest(ranex.event('evidence.requested', { runId: heldRunId }, { resultClass: 'pending' }, undefined, observedAt));
    fixture.model.applyRetention(Date.parse('2026-04-02T00:00:00.001Z')); assert.equal(fixture.model.diagnostics().retainedActivityAggregateCount, 1);
    fixture.model.ingest(ranex.event('evidence.retention-released', { runId: heldRunId }, { resultClass: 'not-applicable' }, undefined, observedAt));
    fixture.model.applyRetention(Date.parse('2026-04-02T00:00:00.001Z')); assert.equal(fixture.model.diagnostics().retainedActivityAggregateCount, 0);
  } finally { await fixture.close(); }
});

test('rejects zero-count activity before it can corrupt an aggregate', async () => {
  const fixture = await createFixture();
  try {
    const operation = fixture.owner('operation');
    assert.throws(() => fixture.model.ingest(operation.event('process.activity', { runId: randomUUID(), processId: randomUUID() }, { processKind: 'provider-cli', processState: 'activity', cleanupState: 'required', count: 0 })), /OWNER_PAYLOAD_INVALID/u);
    assert.equal(fixture.model.diagnostics().retainedActivityAggregateCount, 0);
  } finally { await fixture.close(); }
});

test('treats a verified empty owner store as available without inventing an event cursor', async () => {
  const fixture = await createFixture();
  try {
    for (const owner of OWNER_KINDS) fixture.model.registerOwner(owner);
    assert.equal(fixture.model.diagnostics().ownerCount, OWNER_KINDS.length);
    assert.equal(fixture.model.diagnostics().acceptedEventCount, 0);
    assert.equal(fixture.model.snapshot().lifecycle, 'current');
  } finally { await fixture.close(); }
});

test('requires every configured owner to reverify after projection restart', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-owner-reverify-test-')); const databasePath = path.join(temporary, 'projection.sqlite3');
  const first = new OperationsReadModel(databasePath); const second = new OperationsReadModel(databasePath);
  try {
    first.start(); first.registerOwner('task'); assert.equal(first.snapshot().lifecycle, 'current'); first.stop();
    second.start(); assert.equal(second.diagnostics().ownerCount, 0); assert.equal(second.snapshot().lifecycle, 'degraded');
    second.registerOwner('task'); assert.equal(second.diagnostics().ownerCount, 1); assert.equal(second.snapshot().lifecycle, 'current');
  } finally { first.stop(); second.stop(); await rm(temporary, { recursive: true, force: true }); }
});

test('fails metric projection closed and diagnoses undeclared high-cardinality labels', async () => {
  const fixture = await createFixture(); const originalError = console.error; const logs: string[] = []; console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try {
    const owner = fixture.owner('workflow'); fixture.model.ingest(owner.event('run.completed', { runId: randomUUID() }, { lifecycle: 'completed' }));
    const database = (fixture.model as unknown as { db(): { prepare(sql: string): { run(...values: unknown[]): unknown } } }).db();
    database.prepare("UPDATE metric_values SET labels_json=? WHERE metric_name='kogg_operations_total'").run(`{"run_id":"${randomUUID()}"}`);
    assert.equal(fixture.model.diagnostics().metricViolationCount, 1);
    assert.throws(() => fixture.model.metrics(), (error: unknown) => error instanceof ProjectionFault && error.safeCode === 'METRIC_CONTRACT_INVALID');
    assert.match(logs.join('\n'), /METRIC_CONTRACT_INVALID/u); assert.doesNotMatch(logs.join('\n'), /run_id/u);
  } finally { console.error = originalError; await fixture.close(); }
});

test('retains historical metric epochs for 90 days and never exposes them as the current snapshot', async () => {
  const fixture = await createFixture();
  try {
    fixture.model.ingest(fixture.owner('workflow').event('run.completed', { runId: randomUUID() }, { lifecycle: 'completed' }));
    const prior = fixture.model.metrics(); fixture.model.rebuild(); const current = fixture.model.metrics();
    assert.notEqual(current.projectionEpoch, prior.projectionEpoch); assert.deepEqual(current.values, prior.values);
    assert.equal(fixture.model.diagnostics().retainedMetricEpochCount, 2);
    const database = (fixture.model as unknown as { db(): { prepare(sql: string): { run(...values: unknown[]): unknown } } }).db();
    database.prepare('UPDATE metric_values SET updated_at=? WHERE projection_epoch=?').run('2025-01-01T00:00:00.000Z', prior.projectionEpoch);
    assert.equal(fixture.model.applyRetention(Date.parse('2025-05-01T00:00:00.000Z')), 0);
    assert.equal(fixture.model.diagnostics().retainedMetricEpochCount, 1); assert.deepEqual(fixture.model.metrics(), current);
  } finally { await fixture.close(); }
});

test('keeps expired metric epochs while any owner retention hold remains active', async () => {
  const fixture = await createFixture(); const runId = randomUUID();
  try {
    fixture.model.ingest(fixture.owner('workflow').event('run.completed', { runId }, { lifecycle: 'completed' }));
    const ranex = fixture.owner('ranex'); fixture.model.ingest(ranex.event('evidence.requested', { runId }, { resultClass: 'pending' }));
    const priorEpoch = fixture.model.metrics().projectionEpoch; fixture.model.rebuild();
    const database = (fixture.model as unknown as { db(): { prepare(sql: string): { run(...values: unknown[]): unknown } } }).db();
    database.prepare('UPDATE metric_values SET updated_at=? WHERE projection_epoch=?').run('2025-01-01T00:00:00.000Z', priorEpoch);
    fixture.model.applyRetention(Date.parse('2025-05-01T00:00:00.000Z')); assert.equal(fixture.model.diagnostics().retainedMetricEpochCount, 2);
    fixture.model.ingest(ranex.event('evidence.retention-released', { runId }, { resultClass: 'not-applicable' }));
    fixture.model.applyRetention(Date.parse('2025-05-01T00:00:00.000Z')); assert.equal(fixture.model.diagnostics().retainedMetricEpochCount, 1);
  } finally { await fixture.close(); }
});

test('upgrades pre-retention metric rows without losing the historical epoch', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-metric-migration-test-')); const databasePath = path.join(temporary, 'projection.sqlite3');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE metric_values(projection_epoch TEXT NOT NULL,metric_name TEXT NOT NULL,metric_kind TEXT NOT NULL,labels_json TEXT NOT NULL,bucket_upper_bound INTEGER NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(projection_epoch,metric_name,labels_json,bucket_upper_bound)) STRICT;
    INSERT INTO metric_values VALUES('legacy-epoch','kogg_operations_total','counter','{"operation_kind":"workflow-run","owner_kind":"workflow","terminal_class":"completed"}',-1,1);`); legacy.close();
  const model = new OperationsReadModel(databasePath);
  try { model.start(); assert.equal(model.diagnostics().retainedMetricEpochCount, 1); }
  finally { model.stop(); await rm(temporary, { recursive: true, force: true }); }
});

test('expires only terminal zero-residual derived details while preserving accepted owner history', async () => {
  const fixture = await createFixture(); const runId = randomUUID(); const observedAt = '2026-01-01T00:00:00.000Z';
  try {
    fixture.model.ingest(fixture.owner('workflow').event('run.completed', { runId }, { lifecycle: 'completed' }, undefined, observedAt));
    const before = fixture.model.subscribe();
    assert.equal(fixture.model.applyRetention(Date.parse('2026-02-01T00:00:00.001Z')), 1);
    assert.equal(fixture.model.snapshot().runs.some(run => run.runId === runId), false);
    assert.equal(fixture.model.timeline(runId).length, 0);
    assert.equal(fixture.model.diagnostics().acceptedEventCount, 1);
    const changes = fixture.model.subscribe(before.cursor).changes;
    assert.equal(changes.at(-1)?.kind, 'retention'); assert.equal(changes.at(-1)?.protected, true);
    fixture.model.rebuild();
    assert.equal(fixture.model.snapshot().runs.some(run => run.runId === runId), false);
    assert.equal(fixture.model.diagnostics().acceptedEventCount, 1);
  } finally { await fixture.close(); }
});

test('keeps old derived details under an owner hold until that exact owner releases it', async () => {
  const fixture = await createFixture(); const runId = randomUUID(); const observedAt = '2026-01-01T00:00:00.000Z';
  try {
    fixture.model.ingest(fixture.owner('workflow').event('run.completed', { runId }, { lifecycle: 'completed' }, undefined, observedAt));
    const ranex = fixture.owner('ranex');
    fixture.model.ingest(ranex.event('evidence.requested', { runId }, { resultClass: 'pending' }, undefined, observedAt));
    assert.equal(fixture.model.applyRetention(Date.parse('2026-03-15T00:00:00.000Z')), 0);
    assert.equal(fixture.model.snapshot().runs.some(run => run.runId === runId), true);
    assert.equal(fixture.model.diagnostics().activeRetentionHoldCount, 1);
    fixture.model.ingest(new OwnerBuilder('ranex').event('evidence.retention-released', { runId }, { resultClass: 'not-applicable' }, undefined, observedAt));
    assert.equal(fixture.model.applyRetention(Date.parse('2026-03-15T00:00:00.000Z')), 0);
    assert.equal(fixture.model.diagnostics().activeRetentionHoldCount, 1);
    fixture.model.ingest(ranex.event('evidence.retention-released', { runId }, { resultClass: 'not-applicable' }, undefined, observedAt));
    assert.equal(fixture.model.applyRetention(Date.parse('2026-03-15T00:00:00.000Z')), 1);
    assert.equal(fixture.model.snapshot().runs.some(run => run.runId === runId), false);
    assert.deepEqual({ acceptedEventCount: fixture.model.diagnostics().acceptedEventCount, retentionViolationCount: fixture.model.diagnostics().retentionViolationCount }, { acceptedEventCount: 4, retentionViolationCount: 0 });
  } finally { await fixture.close(); }
});

test('fails retention closed with a safe diagnostic classification', async () => {
  const fixture = await createFixture(); const lines: string[] = []; const original = console.error;
  console.error = (...values: unknown[]) => lines.push(JSON.stringify(values));
  try {
    const database = (fixture.model as unknown as { db(): { exec(sql: string): void } }).db(); database.exec('DROP TABLE retention_holds');
    assert.throws(() => fixture.model.applyRetention(), /no such table/u);
    assert.match(lines.join('\n'), /PROJECTION_RETENTION_FAILED/u); assert.doesNotMatch(lines.join('\n'), /SELECT|retention_holds/u);
  } finally { console.error = original; await fixture.close(); }
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
    const corrupt = fixture.model.subscribe('corrupt-cursor'); assert.equal(corrupt.state, 'resync-required'); assert.deepEqual(corrupt.changes, []);
    assert.deepEqual(fixture.model.streamDiagnostics(), { clientCount: 1, cursorRoundTrip: true, resyncRecovery: true, bounded: true });
    fixture.model.rebuild();
    const stale = fixture.model.subscribe(resumed.cursor); assert.equal(stale.state, 'resync-required'); assert.deepEqual(stale.changes, []);
  } finally { fixture.model.setClient(undefined); await fixture.close(); }
});

test('caps durable stream history and requires resync across a retention gap', async () => {
  const fixture = await createFixture(); const originalInfo = console.info; const originalDebug = console.debug;
  console.info = () => undefined; console.debug = () => undefined;
  try {
    const before = fixture.model.subscribe(); const owner = fixture.owner('workflow'); const runId = randomUUID();
    for (let index = 0; index < 1_001; index++) fixture.model.ingest(owner.event('node.started', { runId, nodeId: `node-${index}` }, { lifecycle: 'started' }));
    const retained = fixture.model.subscribe(); assert.equal(retained.state, 'current'); assert.equal(retained.changes.length, 1_000); assert.equal(retained.changes[0]?.sequence, '2');
    const expired = fixture.model.subscribe(before.cursor); assert.equal(expired.state, 'resync-required'); assert.deepEqual(expired.changes, []);
    assert.equal(fixture.model.streamDiagnostics().bounded, true);
  } finally { console.info = originalInfo; console.debug = originalDebug; await fixture.close(); }
});

test('broadcasts to independent windows and removes closed or failed clients', async () => {
  const fixture = await createFixture(); const first: string[] = []; const second: string[] = []; let failedCalls = 0;
  const closeFirst = fixture.model.addClient({ projectionChanged(change) { first.push(change.sequence); } });
  fixture.model.addClient({ projectionChanged(change) { second.push(change.sequence); } });
  fixture.model.addClient({ projectionChanged() { failedCalls++; throw new Error('window closed'); } });
  try {
    const owner = fixture.owner('workflow'); fixture.model.ingest(owner.event('run.queued', { runId: randomUUID() }, { lifecycle: 'queued' }));
    assert.deepEqual(first, ['1']); assert.deepEqual(second, ['1']); assert.equal(failedCalls, 1);
    closeFirst(); fixture.model.ingest(owner.event('run.started', { runId: randomUUID() }, { lifecycle: 'active' }));
    assert.deepEqual(first, ['1']); assert.deepEqual(second, ['1', '2']); assert.equal(failedCalls, 1);
  } finally { closeFirst(); await fixture.close(); }
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
    fixture.model.ingest(fixture.owner('operation').event('process.activity', { runId, processId: randomUUID() }, { processKind: 'provider-cli', processState: 'activity', cleanupState: 'required', count: 6 }));
    const exporter = new OperationsSupportExporter(fixture.model, supportDirectory); const receipt = await exporter.export({ requestId: randomUUID(), runId });
    const exported = await exporter.read(receipt.exportId); assert.equal(exported.sha256, receipt.sha256); assert.equal(exported.byteLength, receipt.byteLength);
    const document = JSON.parse(exported.content) as { timelines: Record<string, Array<{ eventKind: string; count?: number }>> };
    assert.deepEqual(document.timelines[runId]?.find(entry => entry.eventKind === 'process.activity')?.count, 6);
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
    const router = new OperationsActionRouter(fixture.model, operations, diagnostics()); const request = { requestId: randomUUID(), action: 'cancel' as const, runId, operationId, expectedProjectionSequence: fixture.model.snapshot().changeSequence };
    const first = await router.request(request); assert.equal(first.status, 'forwarded'); assert.equal(first.safeCode, 'ACTION_OWNER_ACCEPTED');
    assert.deepEqual(router.diagnostics(), { cancelRouteAvailable: true, diagnoseRouteAvailable: true, unsynchronizedOutcomeCount: 0 });
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
    const router = new OperationsActionRouter(fixture.model, operations, diagnostics()); const request = { requestId: randomUUID(), action: 'cancel' as const, runId, operationId, expectedProjectionSequence: fixture.model.snapshot().changeSequence };
    await assert.rejects(router.request(request), /transport lost/u); const replay = await router.request(request);
    assert.equal(replay.status, 'unknown'); assert.equal(replay.safeCode, 'ACTION_OUTCOME_UNKNOWN'); assert.equal(calls, 1);
    assert.deepEqual(router.diagnostics(), { cancelRouteAvailable: true, diagnoseRouteAvailable: true, unsynchronizedOutcomeCount: 1 });
  } finally { await fixture.close(); }
});

test('routes selected-run diagnostics once and keeps the projection unchanged until owner facts arrive', async () => {
  const fixture = await createFixture(); let calls = 0; let router!: OperationsActionRouter;
  try {
    const runId = randomUUID(); fixture.model.ingest(fixture.owner('workflow').event('run.started', { runId }, { lifecycle: 'active' }));
    const owner = diagnostics(async () => { calls++; assert.equal(router.diagnostics().unsynchronizedOutcomeCount, 0); });
    router = new OperationsActionRouter(fixture.model, { cancel: async () => { throw new Error('unused'); } } as unknown as OperationRegistryApi, owner);
    const request = { requestId: randomUUID(), action: 'diagnose' as const, runId, expectedProjectionSequence: fixture.model.snapshot().changeSequence };
    const first = await router.request(request); assert.equal(first.status, 'forwarded'); assert.equal(first.safeCode, 'ACTION_OWNER_ACCEPTED');
    assert.equal(fixture.model.snapshot().runs[0]?.lifecycle, 'active'); assert.deepEqual(await router.request(request), first); assert.equal(calls, 1);
    const unsupported = await router.request({ ...request, requestId: randomUUID(), action: 'pause', expectedProjectionSequence: fixture.model.snapshot().changeSequence });
    assert.equal(unsupported.status, 'refused'); assert.equal(unsupported.safeCode, 'ACTION_OWNER_UNAVAILABLE');
  } finally { await fixture.close(); }
});

test('keeps a failed diagnose outcome unknown and recovers interrupted forwarding as unsynchronized', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-diagnose-recovery-test-')); const databasePath = path.join(temporary, 'projection.sqlite3');
  const first = new OperationsReadModel(databasePath); let calls = 0;
  try {
    first.start(); const runId = randomUUID(); first.ingest(new OwnerBuilder('workflow').event('run.started', { runId }, { lifecycle: 'active' }));
    const router = new OperationsActionRouter(first, { cancel: async () => { throw new Error('unused'); } } as unknown as OperationRegistryApi, diagnostics(async () => { calls++; throw new Error('diagnostic owner disconnected'); }));
    const request = { requestId: randomUUID(), action: 'diagnose' as const, runId, expectedProjectionSequence: first.snapshot().changeSequence };
    await assert.rejects(router.request(request), /disconnected/u); assert.equal((await router.request(request)).safeCode, 'ACTION_OUTCOME_UNKNOWN'); assert.equal(calls, 1);
    const interrupted = { ...request, requestId: randomUUID() }; first.recordAction(interrupted, 'a'.repeat(64), 'unknown', 'ACTION_FORWARDING'); assert.equal(first.actionDiagnostics().unsynchronizedOutcomeCount, 1); first.stop();
    const second = new OperationsReadModel(databasePath); second.start(); assert.equal(second.actionDiagnostics().unsynchronizedOutcomeCount, 2); assert.equal(second.actionReceipt(interrupted.requestId)?.safeCode, 'ACTION_OUTCOME_UNKNOWN'); second.stop();
  } finally { first.stop(); await rm(temporary, { recursive: true, force: true }); }
});

test('projects the real durable operation owner lifecycle without copying process details', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-operation-owner-adapter-test-')); process.env.KOGG_STATE_DIR = temporary;
  const registry = new OperationRegistry(); const model = new OperationsReadModel(path.join(temporary, 'operations', 'projection.sqlite3'));
  try {
    await registry.onStart(); model.start(); registry.setOwnerSink(model);
    const runId = randomUUID(); const operation = await registry.startOperation({ kind: 'test', correlations: { runId } }); operation.start();
    const processLease = operation.registerProcess({ kind: 'test', owner: 'kogg-supervisor' }); processLease.spawning(); processLease.failed('PROCESS_SPAWN_FAILED', 'Error'); processLease.cleanup();
    await operation.cleanup(); operation.fail('PROCESS_SPAWN_FAILED', 'Error');
    const run = model.snapshot().runs.find(item => item.runId === runId); assert(run); assert.equal(run.lifecycle, 'unknown'); assert.equal(run.liveProcessCount, 0); assert.equal(run.abnormalProcessCount, 0);
    assert(model.timeline(runId).some(event => event.eventKind === 'process.spawn-failed')); assert(model.timeline(runId).some(event => event.eventKind === 'process.cleaned'));
    assert.equal(model.diagnostics().ownerCount, 1); assert.doesNotMatch(JSON.stringify(model.snapshot()), /pid|argv|command|environment|Error/u);
  } finally { registry.setOwnerSink(undefined); await registry.onStop(); model.stop(); await rm(temporary, { recursive: true, force: true }); }
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
  event(eventKind: string, correlations: SafeCorrelationsV1, safePayload: SafeOwnerPayloadV1, causalParent?: OwnerEventV1, observedAt = new Date().toISOString()): OwnerEventV1 {
    const unsigned: Omit<OwnerEventV1, 'eventDigest'> = { ownerKind: this.kind, ownerInstanceId: this.instanceId, ownerSchemaVersion: 1, epochId: this.epochId, sequence: String(++this.sequence), eventId: randomUUID(), eventKind, factId: randomUUID(), factDigest: 'a'.repeat(64), previousEventDigest: this.previous, causalParents: causalParent ? [{ ownerInstanceId: causalParent.ownerInstanceId, epochId: causalParent.epochId, sequence: causalParent.sequence, eventDigest: causalParent.eventDigest }] : [], correlations, observedAt, safePayload };
    const event = { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) }; this.previous = event.eventDigest; return event;
  }
}

function diagnostics(run?: () => Promise<void>): KoggDiagnosticsService {
  return { async run() { await run?.(); return { schemaVersion: 1, generatedAt: new Date().toISOString(), overall: 'pass', checks: [] }; }, async createSupportBundle() { throw new Error('unused'); } };
}
