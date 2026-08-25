import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const prototypeDirectory = path.dirname(fileURLToPath(import.meta.url));
const writerPath = path.join(prototypeDirectory, 'writer.mjs');
const workDirectory = await mkdtemp(path.join(tmpdir(), 'kogg-projects-probe-'));
const databasePath = path.join(workDirectory, 'registry.sqlite3');
const repositoryPath = path.join(workDirectory, 'repository');
const liveProcesses = new Map();
const trace = [];

function emit(event, fields = {}) {
  const allowed = new Set([
    'operationId', 'repositoryId', 'registrationId', 'terminalState', 'safeCode',
    'exitClass', 'durationClass', 'count', 'runtime', 'node', 'electron', 'sqlite'
  ]);
  for (const key of Object.keys(fields)) assert(allowed.has(key), `unsafe trace field: ${key}`);
  const record = { event, ...fields };
  trace.push(record);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function classifyDuration(milliseconds) {
  if (milliseconds < 100) return 'lt-100ms';
  if (milliseconds < 1_000) return 'lt-1s';
  return 'gte-1s';
}

function register(operationId) {
  const registrationId = randomUUID();
  liveProcesses.set(registrationId, { operationId, child: undefined });
  emit('repository.process.registered', { operationId, registrationId });
  return registrationId;
}

async function managedProcess({ command, args, cwd, timeoutMilliseconds, operationId, repositoryId }) {
  const registrationId = register(operationId);
  const startedAt = Date.now();
  let terminalState = 'failed';
  let safeCode = 'PROJECT_REPOSITORY_PROBE_FAILED';
  let stdout = '';
  let stderrBytes = 0;
  let timer;

  try {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    liveProcesses.get(registrationId).child = child;
    emit('repository.validate.started', { operationId, repositoryId, registrationId });

    const completion = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        if (Buffer.byteLength(stdout) > 16 * 1024) reject(new Error('OUTPUT_LIMIT'));
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > 16 * 1024) reject(new Error('OUTPUT_LIMIT'));
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMilliseconds);
    });

    const result = await Promise.race([completion, timeout]);
    if (result.code !== 0) throw new Error('NONZERO');
    terminalState = 'completed';
    safeCode = 'OK';
    emit('repository.validate.completed', {
      operationId, repositoryId, registrationId, terminalState, safeCode,
      exitClass: 'zero', durationClass: classifyDuration(Date.now() - startedAt)
    });
    return stdout;
  } catch (error) {
    terminalState = error instanceof Error && error.message === 'TIMEOUT' ? 'timeout' : 'failed';
    safeCode = terminalState === 'timeout' ? 'PROJECT_REPOSITORY_PROBE_TIMEOUT' : 'PROJECT_REPOSITORY_PROBE_FAILED';
    emit(terminalState === 'timeout' ? 'repository.validate.timeout' : 'repository.validate.failed', {
      operationId, repositoryId, registrationId, terminalState, safeCode,
      exitClass: 'nonzero-or-signal', durationClass: classifyDuration(Date.now() - startedAt)
    });
    throw Object.assign(new Error(safeCode), { safeCode });
  } finally {
    if (timer) clearTimeout(timer);
    emit('repository.process.cleanup.started', { operationId, repositoryId, registrationId });
    const managed = liveProcesses.get(registrationId);
    if (managed?.child && managed.child.exitCode === null && managed.child.signalCode === null) {
      if (process.platform !== 'win32' && managed.child.pid) {
        try { process.kill(-managed.child.pid, 'SIGKILL'); } catch { /* already exited */ }
      } else {
        managed.child.kill('SIGKILL');
      }
      await new Promise(resolve => managed.child.once('close', resolve));
    }
    liveProcesses.delete(registrationId);
    emit('repository.process.cleanup.completed', { operationId, repositoryId, registrationId, count: liveProcesses.size });
  }
}

async function waitForReady(child) {
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('READY\n')) resolve();
    });
    child.once('error', reject);
    child.once('close', code => reject(new Error(`holder exited early: ${code}`)));
  });
}

async function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('close', resolve));
}

function openDatabase() {
  const database = new DatabaseSync(databasePath, { timeout: 150 });
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

try {
  emit('registry.start.requested');
  const database = openDatabase();
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE registry_meta(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE probe_events(id INTEGER PRIMARY KEY, marker TEXT NOT NULL UNIQUE, stage TEXT NOT NULL);
    INSERT INTO registry_meta(singleton, schema_version, revision) VALUES (1, 1, 1);
  `);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  database.close();
  emit('registry.start.completed', { terminalState: 'completed', safeCode: 'OK' });

  await mkdir(repositoryPath);
  const init = spawnSync('git', ['init', '--quiet', repositoryPath], { env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C' } });
  assert.equal(init.status, 0);

  const repositoryId = randomUUID();
  const gitOperationId = randomUUID();
  const output = await managedProcess({
    command: 'git',
    args: ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--is-bare-repository', '--is-inside-work-tree'],
    cwd: repositoryPath,
    timeoutMilliseconds: 10_000,
    operationId: gitOperationId,
    repositoryId
  });
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[2], 'false');
  assert.equal(lines[3], 'true');
  assert.equal(await realpath(lines[0]), await realpath(repositoryPath));
  const identityDigest = createHash('sha256').update(`kogg-git-dir-v1\0${pathToFileURL(await realpath(lines[1])).href}`).digest('hex');
  assert.equal(identityDigest.length, 64);

  const beforeMarker = randomUUID();
  const before = spawn(process.execPath, [writerPath, databasePath, 'kill-before-commit', beforeMarker], { stdio: ['ignore', 'ignore', 'ignore'] });
  await waitForClose(before);
  const afterBeforeKill = openDatabase();
  assert.equal(afterBeforeKill.prepare('SELECT count(*) AS count FROM probe_events WHERE marker = ?').get(beforeMarker).count, 0);
  assert.equal(afterBeforeKill.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  afterBeforeKill.close();
  emit('registry.recovery.completed', { operationId: randomUUID(), terminalState: 'completed', safeCode: 'ROLLBACK_PROVED', count: 0 });

  const afterMarker = randomUUID();
  const after = spawn(process.execPath, [writerPath, databasePath, 'kill-after-commit', afterMarker], { stdio: ['ignore', 'ignore', 'ignore'] });
  await waitForClose(after);
  const afterCommitKill = openDatabase();
  assert.equal(afterCommitKill.prepare('SELECT count(*) AS count FROM probe_events WHERE marker = ?').get(afterMarker).count, 1);
  assert.equal(afterCommitKill.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  afterCommitKill.close();
  emit('registry.recovery.completed', { operationId: randomUUID(), terminalState: 'completed', safeCode: 'COMMIT_PROVED', count: 1 });

  const holdMarker = randomUUID();
  const holder = spawn(process.execPath, [writerPath, databasePath, 'hold', holdMarker], { stdio: ['ignore', 'pipe', 'ignore'] });
  await waitForReady(holder);
  const contender = openDatabase();
  let busy = false;
  try {
    contender.exec('BEGIN IMMEDIATE');
  } catch (error) {
    busy = error && typeof error === 'object' && error.code === 'ERR_SQLITE_ERROR';
  } finally {
    contender.close();
  }
  assert.equal(busy, true);
  emit('registry.write.timeout', { operationId: randomUUID(), terminalState: 'timeout', safeCode: 'PROJECT_REGISTRY_BUSY' });
  holder.kill('SIGKILL');
  await waitForClose(holder);
  const afterContention = openDatabase();
  assert.equal(afterContention.prepare('SELECT count(*) AS count FROM probe_events WHERE marker = ?').get(holdMarker).count, 0);
  assert.equal(afterContention.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  afterContention.close();

  const timeoutHelper = path.join(workDirectory, 'timeout-helper.mjs');
  await writeFile(timeoutHelper, 'setInterval(() => undefined, 1000);\n', { mode: 0o600 });
  await assert.rejects(
    managedProcess({
      command: process.execPath,
      args: [timeoutHelper],
      cwd: workDirectory,
      timeoutMilliseconds: 100,
      operationId: randomUUID(),
      repositoryId
    }),
    error => error.safeCode === 'PROJECT_REPOSITORY_PROBE_TIMEOUT'
  );

  const traceText = trace.map(record => JSON.stringify(record)).join('\n');
  assert.equal(traceText.includes(workDirectory), false);
  assert.equal(traceText.includes(repositoryPath), false);
  assert.equal(traceText.includes('rev-parse'), false);
  assert.equal(liveProcesses.size, 0);
  emit('probe.completed', { terminalState: 'completed', safeCode: 'OK', count: trace.length });
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
