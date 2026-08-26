// diagnostic-exempt: Disposable issue #115 operations projection probe retained off production branches.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

assert(process.debugPort > 0, 'probe must run with --inspect=0');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-operations-projection-probe-'));
process.env.KOGG_STATE_DIR = path.join(temporary, 'state');
const { OperationRegistry } = await import('../../packages/kogg-operations/lib/node/operation-registry.js');
const registry = new OperationRegistry(3_000); const trace = []; const events = [];
const ownerInstanceId = randomUUID(); const epochId = randomUUID(); const runId = randomUUID();
let previousDigest = '0'.repeat(64); let sequence = 0;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function append(eventKind, safePayload) {
  const unsigned = { ownerInstanceId, epochId, sequence: ++sequence, eventKind, runId, previousDigest, safePayload };
  const event = { ...unsigned, eventDigest: digest(unsigned) }; previousDigest = event.eventDigest; events.push(event); return event;
}
function emit(event, fields) { const line = `[kogg:operations:prototype] ${event} ${JSON.stringify(fields)}`; trace.push(line); console.info(line); }

const projectionDb = new DatabaseSync(path.join(temporary, 'projection.sqlite3'));
projectionDb.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
  CREATE TABLE owner_events(sequence INTEGER PRIMARY KEY,event_digest TEXT UNIQUE NOT NULL,event_json TEXT NOT NULL);
  CREATE TABLE owner_cursor(owner_instance_id TEXT PRIMARY KEY,epoch_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_digest TEXT NOT NULL);`);

try {
  await registry.onStart();
  const operation = await registry.startOperation({ kind: 'check', correlations: { runId } }); operation.start();
  const attemptOne = randomUUID(); const attemptTwo = randomUUID();
  append('run.queued', { lifecycle: 'queued' }); append('attempt.requested', { attemptId: attemptOne, retry: 0 });

  const runReal = async (command, args, attemptId, cancellation) => {
    let child;
    const processLease = operation.registerProcess({ kind: command.endsWith('git') ? 'git' : 'check', owner: 'kogg-supervisor', cancel: async () => { if (child?.exitCode === null) child.kill('SIGKILL'); } });
    append('process.registered', { attemptId, processId: processLease.id, processKind: command.endsWith('git') ? 'git' : 'check' });
    processLease.spawning(); child = spawn(command, args, { cwd: temporary, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' }, stdio: 'ignore' });
    assert(child.pid); processLease.started(child.pid); processLease.ready(); append('process.started', { attemptId, processId: processLease.id });
    if (cancellation) await cancellation(child, processLease.id);
    const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    processLease.exited(outcome.signal ? 'signal' : outcome.code === 0 ? 'zero' : 'nonzero'); append('process.exited', { attemptId, processId: processLease.id, exitClass: outcome.signal ? 'signal' : outcome.code === 0 ? 'zero' : 'nonzero' });
    return { child, outcome, processLease };
  };

  const failed = await runReal('/usr/bin/git', ['rev-parse', '--verify', 'refs/heads/absent'], attemptOne);
  assert.notEqual(failed.outcome.code, 0); failed.processLease.cleanup(); append('process.cleaned', { attemptId: attemptOne, processId: failed.processLease.id }); append('attempt.failed', { attemptId: attemptOne, safeCode: 'CHECK_PROCESS_FAILED' });
  emit('retry.visible', { runId, failedAttemptCount: 1, retryCount: 1 });

  append('attempt.requested', { attemptId: attemptTwo, retry: 1 });
  const hung = await runReal(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], attemptTwo, async (child, processId) => {
    append('cancel.requested', { attemptId: attemptTwo }); await new Promise(resolve => setTimeout(resolve, 50)); child.kill('SIGTERM'); append('run.owner-terminal', { lifecycle: 'cancelled' });
    ingest(events); rebuild(); const preCleanup = currentProjection(); assert.equal(preCleanup.lifecycle, 'cleaning'); assert.equal(preCleanup.abnormalProcessCount, 1);
    emit('terminal.degraded', { runId, lifecycle: preCleanup.lifecycle, abnormalProcessCount: 1, processId });
  });
  assert.equal(hung.outcome.signal, 'SIGTERM'); hung.processLease.cleanup(); append('process.cleaned', { attemptId: attemptTwo, processId: hung.processLease.id }); append('attempt.cancelled', { attemptId: attemptTwo, safeCode: 'OPERATION_CANCELLED' });
  assert.throws(() => process.kill(hung.child.pid, 0), error => error?.code === 'ESRCH');

  ingest(events); rebuild(); const finalProjection = currentProjection(); assert.equal(finalProjection.lifecycle, 'cancelled'); assert.equal(finalProjection.abnormalProcessCount, 0); assert.equal(finalProjection.retryCount, 1); assert.equal(finalProjection.attemptCount, 2);
  const beforeRebuild = projectionDigest(); emit('projection.current', { runId, attemptCount: 2, retryCount: 1, abnormalProcessCount: 0 });

  const duplicate = events[2]; projectionDb.prepare('INSERT OR IGNORE INTO owner_events VALUES(?,?,?)').run(duplicate.sequence, duplicate.eventDigest, canonical(duplicate));
  assert.equal(projectionDb.prepare('SELECT COUNT(*) AS count FROM owner_events WHERE sequence=?').get(duplicate.sequence).count, 1);
  const conflictingDigest = digest({ conflict: true });
  const stored = projectionDb.prepare('SELECT event_digest FROM owner_events WHERE sequence=?').get(duplicate.sequence);
  assert.notEqual(stored.event_digest, conflictingDigest); emit('owner.conflict.refused', { runId, safeCode: 'OWNER_SEQUENCE_CONFLICT', cursorAdvanced: false });

  projectionDb.exec('DROP TABLE run_projection; DROP TABLE attempt_projection; DROP TABLE process_projection;');
  rebuild(); assert.equal(projectionDigest(), beforeRebuild); emit('projection.rebuilt', { runId, replayedCount: events.length, duplicateTerminalCount: 0 });
  const metrics = { attempts_total_failed: 1, attempts_total_cancelled: 1, retries_total: 1, processes_active: 0 };
  assert.deepEqual(Object.keys(metrics), ['attempts_total_failed', 'attempts_total_cancelled', 'retries_total', 'processes_active']); emit('metrics.validated', metrics);

  operation.active(); await operation.cleanup(); operation.complete();
  const diagnostics = registry.diagnostics(); assert.equal(diagnostics.activeCount, 0); assert.equal(diagnostics.residualCount, 0); assert.equal(diagnostics.cleanupFailureCount, 0);
  emit('cleanup.completed', { runId, processCount: 2, residualCount: 0, cleanupFailureCount: 0 });
  const joined = trace.join('\n');
  for (const event of ['retry.visible', 'terminal.degraded', 'projection.current', 'owner.conflict.refused', 'projection.rebuilt', 'metrics.validated', 'cleanup.completed']) assert.match(joined, new RegExp(event.replaceAll('.', '\\.')));
  assert.doesNotMatch(joined, /\/Users|prompt|source|diff|credential|authorization|commandArgument|environmentValue|rawBody/iu);
  process.stdout.write('Kogg operations read-model real-boundary probe passed.\n');
} finally {
  projectionDb.close(); await registry.onStop().catch(() => undefined); await rm(temporary, { recursive: true, force: true });
}

function ingest(source) {
  const insert = projectionDb.prepare('INSERT OR IGNORE INTO owner_events VALUES(?,?,?)');
  for (const event of source) insert.run(event.sequence, event.eventDigest, canonical(event));
  const last = source.at(-1); projectionDb.prepare('INSERT OR REPLACE INTO owner_cursor VALUES(?,?,?,?)').run(ownerInstanceId, epochId, last.sequence, last.eventDigest);
}
function rebuild() {
  projectionDb.exec(`CREATE TABLE IF NOT EXISTS run_projection(run_id TEXT PRIMARY KEY,lifecycle TEXT NOT NULL,attempt_count INTEGER NOT NULL,retry_count INTEGER NOT NULL,abnormal_process_count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempt_projection(attempt_id TEXT PRIMARY KEY,state TEXT NOT NULL,retry INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS process_projection(process_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,state TEXT NOT NULL,abnormal INTEGER NOT NULL); DELETE FROM run_projection; DELETE FROM attempt_projection; DELETE FROM process_projection;`);
  let ownerTerminal = 'active';
  const rows = projectionDb.prepare('SELECT event_json FROM owner_events ORDER BY sequence').all();
  for (const row of rows) {
    const event = JSON.parse(row.event_json); const payload = event.safePayload;
    if (event.eventKind === 'run.queued') ownerTerminal = 'queued';
    if (event.eventKind === 'attempt.requested') { ownerTerminal = 'active'; projectionDb.prepare('INSERT OR REPLACE INTO attempt_projection VALUES(?,?,?)').run(payload.attemptId, 'active', payload.retry); }
    if (event.eventKind === 'process.registered') projectionDb.prepare('INSERT OR REPLACE INTO process_projection VALUES(?,?,?,1)').run(payload.processId, payload.attemptId, 'registered');
    if (event.eventKind === 'process.started') projectionDb.prepare("UPDATE process_projection SET state='started',abnormal=1 WHERE process_id=?").run(payload.processId);
    if (event.eventKind === 'process.exited') projectionDb.prepare("UPDATE process_projection SET state='exited',abnormal=1 WHERE process_id=?").run(payload.processId);
    if (event.eventKind === 'process.cleaned') projectionDb.prepare("UPDATE process_projection SET state='cleaned',abnormal=0 WHERE process_id=?").run(payload.processId);
    if (event.eventKind === 'attempt.failed') projectionDb.prepare("UPDATE attempt_projection SET state='failed' WHERE attempt_id=?").run(payload.attemptId);
    if (event.eventKind === 'attempt.cancelled') projectionDb.prepare("UPDATE attempt_projection SET state='cancelled' WHERE attempt_id=?").run(payload.attemptId);
    if (event.eventKind === 'run.owner-terminal') ownerTerminal = payload.lifecycle;
  }
  const attemptSummary = projectionDb.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(retry),0) AS retries FROM attempt_projection').get();
  const abnormal = projectionDb.prepare('SELECT COUNT(*) AS count FROM process_projection WHERE abnormal=1').get().count;
  const lifecycle = abnormal > 0 && ['completed', 'cancelled', 'failed'].includes(ownerTerminal) ? 'cleaning' : ownerTerminal;
  projectionDb.prepare('INSERT INTO run_projection VALUES(?,?,?,?,?)').run(runId, lifecycle, attemptSummary.count, attemptSummary.retries, abnormal);
}
function currentProjection() { return projectionDb.prepare('SELECT lifecycle,attempt_count AS attemptCount,retry_count AS retryCount,abnormal_process_count AS abnormalProcessCount FROM run_projection WHERE run_id=?').get(runId); }
function projectionDigest() { return digest({ run: projectionDb.prepare('SELECT * FROM run_projection ORDER BY run_id').all(), attempts: projectionDb.prepare('SELECT * FROM attempt_projection ORDER BY attempt_id').all(), processes: projectionDb.prepare('SELECT * FROM process_projection ORDER BY process_id').all() }); }
