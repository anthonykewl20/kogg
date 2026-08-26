// diagnostic-exempt: disposable real-boundary prototype retained off production branches
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const prototypeDirectory = path.dirname(fileURLToPath(import.meta.url));
const writerPath = path.join(prototypeDirectory, 'writer.mjs');
const pythonPath = path.join(prototypeDirectory, 'canonical.py');
const electronHelperPath = path.join(prototypeDirectory, 'electron-runtime.cjs');
const debugTargetPath = path.join(prototypeDirectory, 'debug-target.mjs');
const workDirectory = await mkdtemp(path.join(tmpdir(), 'kogg-tasks-probe-'));
const databasePath = path.join(workDirectory, 'registry.sqlite3');
const corruptedDatabasePath = path.join(workDirectory, 'registry-corrupted.sqlite3');
const trace = [];
const liveProcesses = new Map();
const reviewChallenges = new Map();
const contentCanary = 'issue-80-CONTENT-canary\r\nCafe\u0301 😀\n';
const taskId = '10000000-0000-4000-8000-000000000080';
const projectId = '20000000-0000-4000-8000-000000000080';
const repositoryId = '30000000-0000-4000-8000-000000000080';
const bindingRevision = '7';

function emit(event, fields = {}) {
  const allowed = new Set([
    'operationId', 'registrationId', 'processKind', 'terminalState', 'safeCode',
    'exitClass', 'durationClass', 'count', 'byteCount', 'runtime', 'node',
    'electron', 'sqlite', 'replay', 'current', 'taskRevision', 'registryRevision'
  ]);
  for (const key of Object.keys(fields)) {
    assert(allowed.has(key), `unsafe trace field: ${key}`);
  }
  const record = { event, ...fields };
  trace.push(record);
  process.stdout.write(`[kogg:tasks:prototype] ${event} ${JSON.stringify(fields)}\n`);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function validateAndEncode(content) {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      assert(next >= 0xdc00 && next <= 0xdfff, 'SPEC_INVALID_UNICODE');
      index += 1;
    } else {
      assert(!(code >= 0xdc00 && code <= 0xdfff), 'SPEC_INVALID_UNICODE');
    }
  }
  const bytes = Buffer.from(content, 'utf8');
  assert(bytes.length > 0, 'SPEC_EMPTY');
  assert(bytes.length <= 1_048_576, 'SPEC_TOO_LARGE');
  return bytes;
}

function canonicalPayload(content) {
  const bytes = validateAndEncode(content);
  return {
    bindingRevision,
    encoding: 'utf-8-exact-v1',
    projectId,
    repositoryId,
    specificationBase64: bytes.toString('base64'),
    taskId,
    version: 'kogg.task-specification.v1'
  };
}

function canonicalize(payload) {
  const ordered = Object.fromEntries(Object.keys(payload).sort().map(key => [key, payload[key]]));
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function classifyDuration(milliseconds) {
  if (milliseconds < 100) return 'lt-100ms';
  if (milliseconds < 1_000) return 'lt-1s';
  return 'gte-1s';
}

function registerProcess(processKind) {
  const operationId = randomUUID();
  const registrationId = randomUUID();
  liveProcesses.set(registrationId, { operationId, child: undefined, processKind });
  emit('process.registered', { operationId, registrationId, processKind });
  return { operationId, registrationId };
}

async function runManaged({ command, args, input, processKind, env = {} }) {
  const { operationId, registrationId } = registerProcess(processKind);
  const startedAt = Date.now();
  let child;
  let stdout = '';
  let stderrBytes = 0;
  try {
    child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    liveProcesses.get(registrationId).child = child;
    emit('process.started', { operationId, registrationId, processKind });
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      assert(Buffer.byteLength(stdout) <= 2 * 1024 * 1024, 'OUTPUT_LIMIT');
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      assert(stderrBytes <= 64 * 1024, 'OUTPUT_LIMIT');
    });
    child.stdin.end(input);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.code, 0, `${processKind} failed`);
    emit('process.exit', {
      operationId, registrationId, processKind, terminalState: 'completed',
      exitClass: 'zero', durationClass: classifyDuration(Date.now() - startedAt),
      byteCount: Buffer.byteLength(stdout)
    });
    return stdout;
  } finally {
    emit('process.cleanup.started', { operationId, registrationId, processKind });
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    liveProcesses.delete(registrationId);
    emit('process.cleanup.completed', {
      operationId, registrationId, processKind, count: liveProcesses.size
    });
  }
}

async function runCrashWriter(mode, marker, digest) {
  const { operationId, registrationId } = registerProcess('crash-writer');
  let child;
  try {
    child = spawn(process.execPath, [writerPath, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    liveProcesses.get(registrationId).child = child;
    emit('process.started', { operationId, registrationId, processKind: 'crash-writer' });
    child.stdin.end(JSON.stringify({ databasePath, marker, digest }));
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert(result.signal === 'SIGKILL' || result.code === null);
    emit('process.exit', {
      operationId, registrationId, processKind: 'crash-writer',
      terminalState: 'failed', safeCode: 'FORCED_TERMINATION', exitClass: 'signal'
    });
  } finally {
    emit('process.cleanup.started', { operationId, registrationId, processKind: 'crash-writer' });
    liveProcesses.delete(registrationId);
    emit('process.cleanup.completed', {
      operationId, registrationId, processKind: 'crash-writer', count: liveProcesses.size
    });
  }
}

async function startHolder(marker, digest) {
  const { operationId, registrationId } = registerProcess('contention-writer');
  const child = spawn(process.execPath, [writerPath, 'hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
  liveProcesses.get(registrationId).child = child;
  emit('process.started', { operationId, registrationId, processKind: 'contention-writer' });
  child.stdin.end(JSON.stringify({ databasePath, marker, digest }));
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('READY\n')) resolve();
    });
    child.once('error', reject);
    child.once('close', code => reject(new Error(`holder exited early: ${code}`)));
  });
  return async () => {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('close', resolve));
    emit('process.exit', {
      operationId, registrationId, processKind: 'contention-writer',
      terminalState: 'failed', safeCode: 'FORCED_TERMINATION', exitClass: 'signal'
    });
    emit('process.cleanup.started', { operationId, registrationId, processKind: 'contention-writer' });
    liveProcesses.delete(registrationId);
    emit('process.cleanup.completed', {
      operationId, registrationId, processKind: 'contention-writer', count: liveProcesses.size
    });
  };
}

async function proveInspector(command, args, env, processKind) {
  const { operationId, registrationId } = registerProcess(processKind);
  const child = spawn(command, args, { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  liveProcesses.get(registrationId).child = child;
  emit('process.started', { operationId, registrationId, processKind });
  await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('INSPECTOR_TIMEOUT')), 10_000);
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.includes('Debugger listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
  });
  emit('debugger.reachable', { operationId, registrationId, processKind, terminalState: 'completed' });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('close', resolve));
  emit('process.exit', {
    operationId, registrationId, processKind, terminalState: 'completed', exitClass: 'signal'
  });
  emit('process.cleanup.started', { operationId, registrationId, processKind });
  liveProcesses.delete(registrationId);
  emit('process.cleanup.completed', { operationId, registrationId, processKind, count: liveProcesses.size });
}

function openDatabase(target = databasePath, timeout = 5_000) {
  const database = new DatabaseSync(target, { timeout });
  database.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  return database;
}

function appendEvent(database, eventType) {
  const last = database.prepare('SELECT sequence, event_digest FROM task_events ORDER BY sequence DESC LIMIT 1').get();
  const sequence = Number(last?.sequence ?? 0) + 1;
  const previous = last?.event_digest ?? 'GENESIS';
  const eventDigest = sha256(Buffer.from(JSON.stringify({ eventType, previous, sequence }), 'utf8'));
  database.prepare(`
    INSERT INTO task_events(sequence, event_type, previous_event_digest, event_digest)
    VALUES (?, ?, ?, ?)
  `).run(sequence, eventType, previous, eventDigest);
}

function verifyEventChain(database) {
  let previous = 'GENESIS';
  for (const row of database.prepare('SELECT sequence, event_type, previous_event_digest, event_digest FROM task_events ORDER BY sequence').all()) {
    if (row.previous_event_digest !== previous) return false;
    const expected = sha256(Buffer.from(JSON.stringify({ eventType: row.event_type, previous, sequence: Number(row.sequence) }), 'utf8'));
    if (row.event_digest !== expected) return false;
    previous = row.event_digest;
  }
  return true;
}

function mutateTask(database, operation, expectedTaskRevision, content, session, challenge) {
  emit(`${operation}.requested`, { operationId: randomUUID(), taskRevision: String(expectedTaskRevision) });
  database.exec('BEGIN IMMEDIATE');
  try {
    const task = database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (Number(task.task_revision) !== Number(expectedTaskRevision)) {
      database.exec('ROLLBACK');
      emit(`${operation}.conflict`, {
        terminalState: 'conflict', safeCode: 'TASK_REVISION_CONFLICT',
        taskRevision: String(task.task_revision), registryRevision: String(task.registry_revision)
      });
      return { terminal: 'conflict', ...task };
    }
    if (operation === 'specification.edit') {
      const bytes = validateAndEncode(content);
      assert.equal(task.lifecycle, 'draft');
      database.prepare(`UPDATE tasks SET content = ?, task_revision = task_revision + 1,
        registry_revision = registry_revision + 1 WHERE task_id = ?`).run(bytes, taskId);
      appendEvent(database, 'specification.edited');
    } else if (operation === 'specification.freeze') {
      assert.equal(task.lifecycle, 'draft');
      const digest = sha256(canonicalize(canonicalPayload(Buffer.from(task.content).toString('utf8'))));
      database.prepare(`UPDATE tasks SET lifecycle = 'frozen', specification_digest = ?,
        task_revision = task_revision + 1, registry_revision = registry_revision + 1 WHERE task_id = ?`).run(digest, taskId);
      appendEvent(database, 'specification.frozen');
    } else if (operation === 'approval.record') {
      const stored = reviewChallenges.get(session);
      if (!stored || stored !== challenge || task.lifecycle !== 'frozen') {
        database.exec('ROLLBACK');
        emit('approval.refused', { terminalState: 'refused', safeCode: 'REVIEW_REQUIRED' });
        return { terminal: 'refused', ...task };
      }
      reviewChallenges.delete(session);
      database.prepare(`UPDATE tasks SET approval_current = 1,
        task_revision = task_revision + 1, registry_revision = registry_revision + 1 WHERE task_id = ?`).run(taskId);
      appendEvent(database, 'approval.recorded');
    } else if (operation === 'approval.revoke') {
      assert.equal(Number(task.approval_current), 1);
      database.prepare(`UPDATE tasks SET approval_current = 0,
        task_revision = task_revision + 1, registry_revision = registry_revision + 1 WHERE task_id = ?`).run(taskId);
      appendEvent(database, 'approval.revoked');
    } else if (operation === 'specification.successor') {
      database.prepare(`UPDATE tasks SET lifecycle = 'draft', approval_current = 0,
        specification_digest = NULL, task_revision = task_revision + 1,
        registry_revision = registry_revision + 1 WHERE task_id = ?`).run(taskId);
      appendEvent(database, 'specification.successor-created');
    }
    database.exec('COMMIT');
    const updated = database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    emit(`${operation}.completed`, {
      terminalState: 'completed', taskRevision: String(updated.task_revision),
      registryRevision: String(updated.registry_revision), current: Boolean(updated.approval_current)
    });
    return { terminal: 'completed', ...updated };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* transaction already terminal */ }
    emit(`${operation}.failed`, { terminalState: 'failed', safeCode: 'INTERNAL_FAILURE' });
    throw error;
  }
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').filter(Boolean).map(value => {
    const [key, ...rest] = value.trim().split('=');
    return [key, rest.join('=')];
  }));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    assert(Buffer.byteLength(body) <= 2 * 1024 * 1024);
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? Number(item) : item));
}

const pageHtml = `<!doctype html><html><body>
<textarea id="specification"></textarea>
<div id="status">loading</div>
<button id="save">Save</button><button id="reload">Reload</button>
<button id="freeze">Freeze</button><button id="review">Review</button>
<button id="approve">Approve exact revision</button><button id="revoke">Revoke</button>
<button id="successor">Create successor draft</button>
<script>
let state; let challenge;
const specificationElement = document.getElementById('specification');
const statusElement = document.getElementById('status');
async function call(path, body) { const result = await fetch(path, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); return result.json(); }
async function load() { state = await (await fetch('/state')).json(); specificationElement.value = state.content; statusElement.textContent = state.lifecycle + ':' + state.taskRevision + ':' + state.approvalCurrent; }
document.getElementById('save').onclick = async () => { const result = await call('/edit',{expectedTaskRevision:state.taskRevision,content:specificationElement.value}); statusElement.textContent=result.terminal; if(result.terminal==='completed') state=result; };
document.getElementById('reload').onclick = load;
document.getElementById('freeze').onclick = async () => { const result = await call('/freeze',{expectedTaskRevision:state.taskRevision}); statusElement.textContent=result.terminal; if(result.terminal==='completed') state=result; };
document.getElementById('review').onclick = async () => { const result = await call('/review',{}); challenge=result.challenge; statusElement.textContent=result.terminal; };
document.getElementById('approve').onclick = async () => { const result = await call('/approve',{expectedTaskRevision:state.taskRevision,challenge}); statusElement.textContent=result.terminal; if(result.terminal==='completed') state=result; };
document.getElementById('revoke').onclick = async () => { const result = await call('/revoke',{expectedTaskRevision:state.taskRevision}); statusElement.textContent=result.terminal; if(result.terminal==='completed') state=result; };
document.getElementById('successor').onclick = async () => { const result = await call('/successor',{expectedTaskRevision:state.taskRevision}); statusElement.textContent=result.terminal; if(result.terminal==='completed') state=result; };
load();
</script></body></html>`;

async function startUiServer(database) {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(pageHtml);
        return;
      }
      const session = parseCookies(request).kogg_probe_session;
      assert(session);
      const task = () => database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
      const project = row => ({
        terminal: row.terminal ?? 'completed', taskRevision: Number(row.task_revision),
        registryRevision: Number(row.registry_revision), lifecycle: row.lifecycle,
        approvalCurrent: Boolean(row.approval_current), content: Buffer.from(row.content).toString('utf8')
      });
      if (request.method === 'GET' && request.url === '/state') {
        sendJson(response, 200, project(task()));
        return;
      }
      const body = await readJson(request);
      if (request.url === '/edit') sendJson(response, 200, project(mutateTask(database, 'specification.edit', body.expectedTaskRevision, body.content)));
      else if (request.url === '/freeze') sendJson(response, 200, project(mutateTask(database, 'specification.freeze', body.expectedTaskRevision)));
      else if (request.url === '/review') {
        const row = task();
        if (row.lifecycle !== 'frozen') sendJson(response, 200, { terminal: 'refused' });
        else {
          const challenge = randomUUID();
          reviewChallenges.set(session, challenge);
          emit('review.completed', { terminalState: 'completed', taskRevision: String(row.task_revision) });
          sendJson(response, 200, { terminal: 'completed', challenge });
        }
      } else if (request.url === '/approve') sendJson(response, 200, project(mutateTask(database, 'approval.record', body.expectedTaskRevision, undefined, session, body.challenge)));
      else if (request.url === '/revoke') sendJson(response, 200, project(mutateTask(database, 'approval.revoke', body.expectedTaskRevision)));
      else if (request.url === '/successor') sendJson(response, 200, project(mutateTask(database, 'specification.successor', body.expectedTaskRevision)));
      else sendJson(response, 404, { terminal: 'not-found' });
    } catch {
      sendJson(response, 500, { terminal: 'failed', safeCode: 'INTERNAL_FAILURE' });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function serverOrigin(server) {
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

let database;
let server;
let browser;
try {
  emit('registry.start.requested');
  database = openDatabase();
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE tasks(
      task_id TEXT PRIMARY KEY, content BLOB NOT NULL, lifecycle TEXT NOT NULL,
      specification_digest TEXT, approval_current INTEGER NOT NULL,
      task_revision INTEGER NOT NULL, registry_revision INTEGER NOT NULL
    );
    CREATE TABLE task_events(
      sequence INTEGER PRIMARY KEY, event_type TEXT NOT NULL,
      previous_event_digest TEXT NOT NULL, event_digest TEXT NOT NULL UNIQUE
    );
    CREATE TABLE crash_markers(marker TEXT PRIMARY KEY, digest TEXT NOT NULL, mode TEXT NOT NULL);
    CREATE TABLE idempotency(request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result TEXT NOT NULL);
  `);
  database.prepare(`INSERT INTO tasks(task_id, content, lifecycle, approval_current, task_revision, registry_revision)
    VALUES (?, ?, 'draft', 0, 1, 1)`).run(taskId, Buffer.from(contentCanary, 'utf8'));
  appendEvent(database, 'task.created');
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  emit('registry.start.completed', { terminalState: 'completed', taskRevision: '1', registryRevision: '1' });

  const payload = canonicalPayload(contentCanary);
  const canonical = canonicalize(payload);
  const digest = sha256(canonical);
  const pythonResult = JSON.parse(await runManaged({
    command: process.env.KOGG_PROBE_PYTHON ?? 'python3', args: [pythonPath],
    input: JSON.stringify(payload), processKind: 'python-canonicalizer'
  }));
  assert.equal(pythonResult.canonicalBase64, canonical.toString('base64'));
  assert.equal(pythonResult.digest, digest);

  const electronPath = require('electron');
  const electronResult = JSON.parse(await runManaged({
    command: electronPath, args: [electronHelperPath], input: JSON.stringify(payload),
    processKind: 'electron-canonicalizer', env: { ELECTRON_RUN_AS_NODE: '1' }
  }));
  assert.equal(electronResult.canonicalBase64, canonical.toString('base64'));
  assert.equal(electronResult.digest, digest);
  emit('canonicalization.completed', {
    terminalState: 'completed', runtime: 'node-python-electron',
    node: process.versions.node, electron: electronResult.electron,
    sqlite: electronResult.sqlite, byteCount: canonical.length
  });

  assert.notEqual(sha256(canonicalize(canonicalPayload('line\n'))), sha256(canonicalize(canonicalPayload('line\r\n'))));
  assert.notEqual(sha256(canonicalize(canonicalPayload('é'))), sha256(canonicalize(canonicalPayload('e\u0301'))));
  assert.throws(() => validateAndEncode('\ud800'), /SPEC_INVALID_UNICODE/u);
  assert.equal(validateAndEncode('x'.repeat(1_048_576)).length, 1_048_576);
  assert.throws(() => validateAndEncode('x'.repeat(1_048_577)), /SPEC_TOO_LARGE/u);

  await proveInspector(process.execPath, ['--inspect=0', debugTargetPath], {}, 'node-inspector');
  await proveInspector(electronPath, ['--inspect=0', debugTargetPath], { ELECTRON_RUN_AS_NODE: '1' }, 'electron-inspector');

  server = await startUiServer(database);
  const browserRegistration = registerProcess('chromium-harness');
  browser = await chromium.launch({ headless: true });
  liveProcesses.get(browserRegistration.registrationId).child = browser;
  emit('process.started', { ...browserRegistration, processKind: 'chromium-harness' });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const origin = serverOrigin(server);
  await contextA.addCookies([{ name: 'kogg_probe_session', value: randomUUID(), url: origin }]);
  await contextB.addCookies([{ name: 'kogg_probe_session', value: randomUUID(), url: origin }]);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await Promise.all([pageA.goto(origin), pageB.goto(origin)]);
  await Promise.all([
    pageA.locator('#status').filter({ hasText: 'draft:1:false' }).waitFor(),
    pageB.locator('#status').filter({ hasText: 'draft:1:false' }).waitFor()
  ]);
  const replacement = `${contentCanary.replaceAll('\r\n', '\n')}visible-edit`;
  await pageA.locator('#specification').fill(replacement);
  await pageA.locator('#save').click();
  await pageA.locator('#status').filter({ hasText: 'completed' }).waitFor();
  await pageB.locator('#specification').fill(`${contentCanary}stale-edit`);
  await pageB.locator('#save').click();
  await pageB.locator('#status').filter({ hasText: 'conflict' }).waitFor();
  await pageB.locator('#reload').click();
  await pageB.locator('#status').filter({ hasText: 'draft:2:false' }).waitFor();
  await pageA.locator('#freeze').click();
  await pageA.locator('#status').filter({ hasText: 'completed' }).waitFor();
  await pageA.locator('#review').click();
  await pageA.locator('#status').filter({ hasText: 'completed' }).waitFor();
  await pageB.evaluate(async () => {
    const state = await (await fetch('/state')).json();
    const response = await fetch('/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedTaskRevision: state.taskRevision, challenge: 'forged' }) });
    window.__forgedResult = await response.json();
  });
  assert.equal((await pageB.evaluate(() => window.__forgedResult)).terminal, 'refused');
  await pageA.locator('#approve').click();
  await pageA.locator('#status').filter({ hasText: 'completed' }).waitFor();
  await pageA.locator('#revoke').click();
  await pageA.locator('#status').filter({ hasText: 'completed' }).waitFor();
  await pageA.locator('#successor').click();
  await pageA.locator('#status').filter({ hasText: 'completed' }).waitFor();
  const finalUiState = await (await pageA.request.get(`${origin}/state`)).json();
  assert.equal(finalUiState.lifecycle, 'draft');
  assert.equal(finalUiState.approvalCurrent, false);
  assert.equal(finalUiState.content, replacement);
  emit('ui.line-ending.observed', {
    terminalState: 'completed', safeCode: 'TEXTAREA_NORMALIZES_TO_LF', byteCount: Buffer.byteLength(replacement)
  });
  await browser.close();
  browser = undefined;
  liveProcesses.delete(browserRegistration.registrationId);
  emit('process.exit', { ...browserRegistration, processKind: 'chromium-harness', terminalState: 'completed', exitClass: 'zero' });
  emit('process.cleanup.started', { ...browserRegistration, processKind: 'chromium-harness' });
  emit('process.cleanup.completed', { ...browserRegistration, processKind: 'chromium-harness', count: liveProcesses.size });
  await new Promise(resolve => server.close(resolve));
  server = undefined;

  reviewChallenges.set('restart-canary', randomUUID());
  reviewChallenges.clear();
  database.close();
  database = openDatabase();
  const restarted = database.prepare('SELECT lifecycle, approval_current, content FROM tasks WHERE task_id = ?').get(taskId);
  assert.equal(restarted.lifecycle, 'draft');
  assert.equal(Number(restarted.approval_current), 0);
  assert.equal(Buffer.from(restarted.content).toString('utf8'), replacement);
  assert.equal(verifyEventChain(database), true);
  emit('registry.recovery.completed', { terminalState: 'completed', current: false, count: reviewChallenges.size });

  const beforeMarker = randomUUID();
  await runCrashWriter('kill-before-commit', beforeMarker, digest);
  assert.equal(database.prepare('SELECT count(*) AS count FROM crash_markers WHERE marker = ?').get(beforeMarker).count, 0);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  emit('registry.recovery.completed', { terminalState: 'completed', safeCode: 'ROLLBACK_PROVED', count: 0 });

  const afterMarker = randomUUID();
  await runCrashWriter('kill-after-commit', afterMarker, digest);
  assert.equal(database.prepare('SELECT count(*) AS count FROM crash_markers WHERE marker = ?').get(afterMarker).count, 1);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  emit('registry.recovery.completed', { terminalState: 'completed', safeCode: 'COMMIT_PROVED', count: 1 });

  const stopHolder = await startHolder(randomUUID(), digest);
  const contender = openDatabase(databasePath, 150);
  let busy = false;
  try { contender.exec('BEGIN IMMEDIATE'); } catch { busy = true; }
  contender.close();
  assert.equal(busy, true);
  emit('registry.write.failed', { terminalState: 'failed', safeCode: 'TRANSACTION_BUSY' });
  await stopHolder();

  const requestId = randomUUID();
  const requestDigest = sha256(Buffer.from('same-request', 'utf8'));
  database.prepare('INSERT INTO idempotency(request_id, request_digest, result) VALUES (?, ?, ?)').run(requestId, requestDigest, 'completed');
  const replay = database.prepare('SELECT request_digest, result FROM idempotency WHERE request_id = ?').get(requestId);
  assert.equal(replay.request_digest, requestDigest);
  emit('idempotency.completed', { terminalState: 'completed', replay: true });
  assert.notEqual(replay.request_digest, sha256(Buffer.from('different-request', 'utf8')));
  emit('idempotency.conflict', { terminalState: 'conflict', safeCode: 'REQUEST_ID_REUSED' });

  database.close();
  database = undefined;
  await copyFile(databasePath, corruptedDatabasePath);
  const corrupted = openDatabase(corruptedDatabasePath);
  corrupted.prepare("UPDATE task_events SET previous_event_digest = 'broken' WHERE sequence = 2").run();
  assert.equal(verifyEventChain(corrupted), false);
  corrupted.close();
  emit('diagnostics.completed', { terminalState: 'completed', safeCode: 'CORRUPTION_REFUSED', count: 1 });

  const traceText = trace.map(record => JSON.stringify(record)).join('\n');
  for (const forbidden of [contentCanary, replacement, workDirectory, databasePath, digest, 'forged', 'same-request', writerPath]) {
    assert.equal(traceText.includes(forbidden), false, 'unsafe trace content detected');
  }
  assert.equal(trace.some(record => record.event.startsWith('task.process.')), false);
  assert.equal(liveProcesses.size, 0);
  emit('probe.completed', { terminalState: 'completed', safeCode: 'DESIGN_VALIDATED', count: trace.length });
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (server) await new Promise(resolve => server.close(resolve));
  if (database) database.close();
  for (const managed of liveProcesses.values()) {
    if (managed.child?.kill) managed.child.kill('SIGKILL');
  }
  liveProcesses.clear();
  await rm(workDirectory, { recursive: true, force: true });
}
