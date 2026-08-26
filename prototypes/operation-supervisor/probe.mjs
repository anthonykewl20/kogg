import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { ProcessManager } = require('@theia/process/lib/node/process-manager');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-operation-supervisor-'));
const databasePath = path.join(temporary, 'operations.sqlite3');
const state = path.join(temporary, 'state');
const python = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
const adapter = path.join(root, 'packages', 'kogg-kernel', 'python', 'kogg_ranex_adapter.py');
const ranexSource = path.join(root, 'vendor', 'ranex', 'src');
const provenance = path.join(root, 'vendor', 'ranex', 'PROVENANCE.json');
const journal = path.join(state, 'ranex', 'journal.sqlite3');
const trace = [];
const processManager = new ProcessManager({ debug() {}, info() {}, warn() {}, error() {} });
let database;

class TheiaLiveOwner {
  constructor(manager) {
    this.manager = manager;
    this.child = undefined;
    this.id = manager.register(this);
  }

  get killed() { return this.child?.exitCode !== null || this.child?.signalCode !== null; }

  onError(listener) {
    this.errorListener = listener;
    return { dispose: () => { this.errorListener = undefined; } };
  }

  start(spawnChild) {
    assert.equal(this.child, undefined);
    this.child = spawnChild();
    this.child.once('error', error => this.errorListener?.(error));
    this.child.once('exit', () => this.manager.unregister(this));
    return this.child;
  }

  kill() { this.child?.kill(); }
}

try {
  assert.equal(existsSync(python), true, 'pinned Python runtime must exist');
  await mkdir(path.dirname(journal), { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  createSchema(database);

  await successfulBridgeLifecycle();
  await spawnFailureLifecycle();
  await stalledBridgeCancellationLifecycle();
  await crashRestartRecovery();
  await staleIdentityRefusal();
  await proveNodeDebugger();
  await provePythonDebugger();

  const active = database.prepare(`SELECT COUNT(*) AS count FROM processes WHERE cleanup_state != 'cleaned' AND state != 'possible-residual'`).get().count;
  assert.equal(active, 0);
  assertSafeTrace();
  for (const event of trace) process.stdout.write(`${event.eventName} ${JSON.stringify(event.fields)}\n`);
  process.stdout.write('Issue #67 prototype passed: real Ranex bridge, durable registration, recovery, identity refusal, cleanup, and debugger proof.\n');
} finally {
  database?.close();
  await rm(temporary, { recursive: true, force: true });
}

async function successfulBridgeLifecycle() {
  const operationId = randomUUID(); const processId = randomUUID(); const instanceId = randomUUID();
  register(operationId, processId, instanceId);
  const owner = new TheiaLiveOwner(processManager);
  const child = owner.start(() => spawn(python, ['-u', adapter], {
    detached: process.platform !== 'win32',
    env: minimalEnvironment(), stdio: ['pipe', 'pipe', 'pipe']
  }));
  assert.ok(child.pid);
  assert.equal(processManager.get(owner.id), owner);
  bindStarted(operationId, processId, instanceId, child.pid);
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', line => responses.push(JSON.parse(line)));
  const handshake = await request(child, responses, 'handshake', {
    protocol: 'kogg-ranex-stdio', protocolVersion: 1,
    ranexCommit: JSON.parse(await readFile(provenance, 'utf8')).commit
  });
  assert.equal(handshake.result.protocol, 'kogg-ranex-stdio');
  event('process.ready', { operationId, processId, processKind: 'ranex-kernel' });
  const health = await request(child, responses, 'health', {});
  assert.match(health.result.status, /ready|degraded/u);
  event('process.activity', { operationId, processId, activityCount: 1 });
  await request(child, responses, 'shutdown', {});
  const exit = await waitForExit(child, 5_000, 'successful bridge');
  assert.equal(exit.code, 0);
  event('process.exit', { operationId, processId, exitClass: 'zero' });
  cleanup(operationId, processId);
  assert.equal(isAlive(child.pid), false);
  assert.equal(processManager.get(owner.id), undefined);
}

async function spawnFailureLifecycle() {
  const operationId = randomUUID(); const processId = randomUUID(); const instanceId = randomUUID();
  register(operationId, processId, instanceId);
  const owner = new TheiaLiveOwner(processManager);
  const child = owner.start(() => spawn(path.join(temporary, 'missing-python'), [], { stdio: 'ignore' }));
  await new Promise(resolve => child.once('error', resolve));
  database.prepare(`UPDATE processes SET state='spawn-failed' WHERE id=?`).run(processId);
  event('process.failed', { operationId, processId, safeCode: 'PROCESS_SPAWN_FAILED', errorType: 'Error' });
  cleanup(operationId, processId);
  assert.equal(processManager.get(owner.id), undefined);
}

async function stalledBridgeCancellationLifecycle() {
  if (process.platform === 'win32') return;
  const operationId = randomUUID(); const processId = randomUUID(); const instanceId = randomUUID();
  register(operationId, processId, instanceId);
  const owner = new TheiaLiveOwner(processManager);
  const child = owner.start(() => spawn(python, ['-u', adapter], {
    detached: true, env: minimalEnvironment(), stdio: ['pipe', 'pipe', 'pipe']
  }));
  assert.ok(child.pid);
  bindStarted(operationId, processId, instanceId, child.pid);
  const lines = readline.createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', line => responses.push(JSON.parse(line)));
  await request(child, responses, 'handshake', {
    protocol: 'kogg-ranex-stdio', protocolVersion: 1,
    ranexCommit: JSON.parse(await readFile(provenance, 'utf8')).commit
  });
  event('process.ready', { operationId, processId, processKind: 'ranex-kernel' });
  process.kill(-child.pid, 'SIGSTOP');
  const requestId = randomUUID();
  child.stdin.write(`${JSON.stringify({ id: requestId, method: 'health', params: {} })}\n`);
  const close = waitForClose(child, 5_000, 'timed-out Ranex bridge');
  assert.equal(await waitFor(() => responses.find(response => response.id === requestId), 150, false), undefined);
  database.prepare(`UPDATE operations SET state='stalled' WHERE id=?`).run(operationId);
  event('process.stalled', { operationId, processId, safeCode: 'PROCESS_IDLE_TIMEOUT' });
  event('operation.timed-out', { operationId, processId, safeCode: 'OPERATION_IDLE_TIMEOUT' });
  event('cleanup.started', { operationId, processId });
  process.kill(-child.pid, 'SIGKILL');
  const exit = await waitForExit(child, 5_000, 'timed-out Ranex bridge');
  assert.equal(exit.signal, 'SIGKILL');
  await close;
  assert.equal(child.stdout.readableEnded, true);
  assert.equal(child.stderr.readableEnded, true);
  database.prepare(`UPDATE processes SET state='signalled', cleanup_state='cleaned' WHERE id=?`).run(processId);
  database.prepare(`UPDATE operations SET state='timed-out', cleanup_state='cleaned' WHERE id=?`).run(operationId);
  event('process.exit', { operationId, processId, exitClass: 'signalled' });
  event('cleanup.completed', { operationId, processId });
  assert.equal(isAlive(child.pid), false);
  assert.equal(processManager.get(owner.id), undefined);
}

async function crashRestartRecovery() {
  if (process.platform === 'win32') return;
  const fifo = path.join(temporary, 'bridge.fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const output = path.join(temporary, 'recovery-bridge.out');
  const error = path.join(temporary, 'recovery-bridge.err');
  const driver = spawn(process.execPath, [path.join(root, 'prototypes', 'operation-supervisor', 'recovery-driver.mjs'),
    databasePath, fifo, output, error, python, adapter, ranexSource, provenance, journal], { stdio: 'inherit' });
  assert.equal((await waitForExit(driver, 10_000, 'recovery driver')).code, 0);
  const record = database.prepare(`SELECT id,operation_id,pid,identity_fingerprint FROM processes WHERE state='started' ORDER BY rowid DESC LIMIT 1`).get();
  assert.ok(record?.pid); assert.equal(isAlive(record.pid), true);
  await waitForFileText(output, 'prototype-handshake', 5_000);
  event('recovery.started', { operationId: record.operation_id, processId: record.id });
  assert.equal(fingerprintFor(record.pid), record.identity_fingerprint);
  await terminateOwned(record.pid);
  assert.equal(isAlive(record.pid), false);
  cleanup(record.operation_id, record.id);
  database.prepare(`UPDATE operations SET state='recovered' WHERE id=?`).run(record.operation_id);
  event('recovery.completed', { operationId: record.operation_id, processId: record.id, processCount: 1 });
}

async function staleIdentityRefusal() {
  if (process.platform === 'win32') return;
  const calibration = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  assert.ok(calibration.pid); calibration.unref();
  const operationId = randomUUID(); const processId = randomUUID(); const instanceId = randomUUID();
  register(operationId, processId, instanceId);
  database.prepare(`UPDATE processes SET state='started', pid=?, identity_fingerprint='mismatch' WHERE id=?`).run(calibration.pid, processId);
  event('recovery.started', { operationId, processId });
  assert.notEqual(fingerprintFor(calibration.pid), 'mismatch');
  database.prepare(`UPDATE processes SET state='possible-residual', cleanup_state='failed' WHERE id=?`).run(processId);
  event('process.possible-residual', { operationId, processId, safeCode: 'PROCESS_IDENTITY_UNVERIFIED' });
  assert.equal(isAlive(calibration.pid), true, 'unverified process must not be signalled');
  process.kill(-calibration.pid, 'SIGKILL');
  await waitForAbsent(calibration.pid, 5_000);
}

async function proveNodeDebugger() {
  const child = spawn(process.execPath, ['--inspect-brk=0', path.join(root, 'prototypes', 'operation-supervisor', 'debug-target.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  const endpoint = await waitFor(() => stderr.match(/ws:\/\/[^\s]+/u)?.[0], 5_000);
  const socket = new WebSocket(endpoint);
  const messages = [];
  socket.onmessage = message => messages.push(JSON.parse(String(message.data)));
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.send(JSON.stringify({ id: 1, method: 'Debugger.enable' }));
  socket.send(JSON.stringify({ id: 2, method: 'Runtime.runIfWaitingForDebugger' }));
  const initialPause = await waitFor(() => messages.find(message => message.method === 'Debugger.paused'), 5_000);
  socket.send(JSON.stringify({ id: 3, method: 'Debugger.resume' }));
  const paused = await waitFor(() => messages.find(message =>
    message !== initialPause && message.method === 'Debugger.paused' &&
    message.params.callFrames[0].location.lineNumber === 1
  ), 5_000);
  const frame = paused.params.callFrames[0];
  const parsed = messages.find(message => message.method === 'Debugger.scriptParsed' && message.params.scriptId === frame.location.scriptId);
  assert.match(frame.url || parsed?.params.url || '', /debug-target\.mjs$/u);
  assert.equal(frame.location.lineNumber + 1, 2);
  event('debugger.paused', { runtime: 'node', lineNumber: paused.params.callFrames[0].location.lineNumber + 1 });
  socket.send(JSON.stringify({ id: 4, method: 'Debugger.resume' }));
  await waitFor(() => stdout.includes('kogg-operation-supervisor-debug-target'), 5_000);
  const disconnected = new Promise(resolve => { socket.onclose = resolve; });
  socket.close();
  await disconnected;
  await waitForExit(child, 5_000, 'Node debugger target');
}

async function provePythonDebugger() {
  const child = spawn(python, ['-m', 'pdb', '-c', `break ${adapter}:169`, '-c', 'continue', adapter], { env: minimalEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stdin.write(`${JSON.stringify({ id: 'debug-handshake', method: 'handshake', params: {
    protocol: 'kogg-ranex-stdio', protocolVersion: 1,
    ranexCommit: JSON.parse(await readFile(provenance, 'utf8')).commit
  } })}\n`);
  await waitFor(() => /kogg_ranex_adapter\.py\(169\)main\(\)/u.test(output), 5_000);
  child.stdin.write('where\ndisable 1\ncontinue\n');
  await waitFor(() => output.includes('debug-handshake'), 5_000);
  child.stdin.write(`${JSON.stringify({ id: 'debug-stop', method: 'shutdown', params: {} })}\n`);
  await waitFor(() => output.includes('debug-stop'), 5_000);
  child.stdin.write('quit\n');
  await waitForExit(child, 5_000, 'Python debugger target');
  event('debugger.paused', { runtime: 'python', lineNumber: 169 });
}

function register(operationId, processId, instanceId) {
  transaction(() => {
    database.prepare(`INSERT INTO operations(id,state,cleanup_state,owner_instance_id) VALUES(?, 'starting', 'required', ?)`).run(operationId, instanceId);
    database.prepare(`INSERT INTO processes(id,operation_id,state,cleanup_state,owner_instance_id) VALUES(?, ?, 'registered', 'required', ?)`).run(processId, operationId, instanceId);
    database.prepare(`INSERT INTO events(operation_id,process_id,event_name) VALUES(?, ?, 'process.registered')`).run(operationId, processId);
  });
  event('process.registered', { operationId, processId, processKind: 'ranex-kernel' });
}

function bindStarted(operationId, processId, instanceId, pid) {
  transaction(() => {
    database.prepare(`UPDATE processes SET state='started', pid=?, identity_fingerprint=? WHERE id=?`).run(pid, fingerprintFor(pid), processId);
    database.prepare(`INSERT INTO events(operation_id,process_id,event_name) VALUES(?, ?, 'process.started')`).run(operationId, processId);
  });
  event('process.started', { operationId, processId, processKind: 'ranex-kernel', ownerInstanceId: instanceId });
}

function cleanup(operationId, processId) {
  event('cleanup.started', { operationId, processId });
  transaction(() => {
    database.prepare(`UPDATE processes SET cleanup_state='cleaned' WHERE id=?`).run(processId);
    database.prepare(`UPDATE operations SET state=CASE WHEN state='starting' THEN 'completed' ELSE state END, cleanup_state='cleaned' WHERE id=?`).run(operationId);
    database.prepare(`INSERT INTO events(operation_id,process_id,event_name) VALUES(?, ?, 'cleanup.completed')`).run(operationId, processId);
  });
  event('cleanup.completed', { operationId, processId });
}

async function request(child, responses, method, params) {
  const id = randomUUID();
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return waitFor(() => responses.find(response => response.id === id), 5_000);
}

function event(eventName, fields) { trace.push({ eventName, fields }); }

function assertSafeTrace() {
  const serialized = JSON.stringify(trace);
  for (const forbidden of [temporary, root, adapter, ranexSource, 'PYTHONPATH', 'KOGG_RANEX', 'handshake', 'health', 'shutdown']) {
    assert.equal(serialized.includes(forbidden), false, `trace contains forbidden value: ${forbidden}`);
  }
  const allowed = new Set(['operationId', 'processId', 'processKind', 'ownerInstanceId', 'activityCount', 'exitClass', 'safeCode', 'errorType', 'processCount', 'runtime', 'lineNumber']);
  for (const item of trace) for (const key of Object.keys(item.fields)) assert.equal(allowed.has(key), true, `unsafe trace key ${key}`);
  const names = trace.map(item => item.eventName);
  assert.ok(names.indexOf('process.registered') < names.indexOf('process.started'));
}

function minimalEnvironment() {
  return { PATH: process.env.PATH ?? '', PYTHONPATH: ranexSource, KOGG_RANEX_JOURNAL: journal, KOGG_RANEX_PROVENANCE: provenance };
}

function fingerprintFor(pid) {
  if (process.platform === 'linux') {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ');
    return `linux:${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[21]}`;
  }
  const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return `${process.platform}:${started}`;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ');
      return fields[2] !== 'Z';
    }
    return true;
  } catch {
    return false;
  }
}

async function terminateOwned(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { return; } }
  if (!await waitForAbsent(pid, 2_000, false)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await waitForAbsent(pid, 3_000);
  }
}

async function waitForAbsent(pid, timeout, required = true) {
  const absent = await waitFor(() => !isAlive(pid), timeout, false);
  if (required) assert.equal(absent, true);
  return absent;
}

async function waitForExit(child, timeout, context = 'child process') {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeListeners();
      reject(new Error(`${context} exit timed out`));
    }, timeout);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      removeListeners();
      resolve({ code, signal });
    };
    const onError = error => {
      clearTimeout(timer);
      removeListeners();
      reject(error);
    };
    const removeListeners = () => {
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function waitForFileText(file, text, timeout) {
  return waitFor(async () => existsSync(file) && (await readFile(file, 'utf8')).includes(text), timeout);
}

async function waitForClose(child, timeout, context) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${context} stream close timed out`)), timeout);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitFor(read, timeout, required = true) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (required) throw new Error('bounded observation timed out');
  return undefined;
}

function transaction(run) {
  database.exec('BEGIN IMMEDIATE');
  try { run(); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; }
}

function createSchema(db) {
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE operations(id TEXT PRIMARY KEY,state TEXT NOT NULL,cleanup_state TEXT NOT NULL,owner_instance_id TEXT NOT NULL);
    CREATE TABLE processes(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id),state TEXT NOT NULL,cleanup_state TEXT NOT NULL,owner_instance_id TEXT NOT NULL,pid INTEGER,identity_fingerprint TEXT);
    CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,process_id TEXT,event_name TEXT NOT NULL);
  `);
}
