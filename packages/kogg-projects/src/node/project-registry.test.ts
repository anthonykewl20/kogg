import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ILogger } from '@theia/core/lib/common/logger';
import type { ProviderRegistry } from '@kogg/contracts';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { ProjectRegistry } from './project-registry';
import { ProjectRepositoryProbe } from './project-repository-probe';
import type { OperationLease, OperationRegistryApi, ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import { ProjectWorkspaceProjection } from './project-workspace-projection';
import { ProjectError } from './project-errors';
import { ProjectDiagnosticContributor } from './project-diagnostic-contributor';

test('persists projects, settings, roles, switching, and restart restoration against real Git and SQLite', async () => {
  const fixture = await createFixture();
  try {
    const runtime = runtimeFor(fixture.state);
    await runtime.registry.onStart();
    let snapshot = await runtime.registry.createProject({
      requestId: randomUUID(), expectedRegistryRevision: 1, displayName: 'Alpha', repositoryPath: pathToFileURL(fixture.repository).toString()
    });
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0]?.repositories.length, 1);
    assert.equal(snapshot.projects[0]?.lifecycle, 'available');
    const projectId = snapshot.projects[0]!.id;
    const repositoryId = snapshot.projects[0]!.repositories[0]!.id;

    snapshot = await runtime.registry.setExecutionProfile({
      requestId: randomUUID(), expectedRegistryRevision: snapshot.revision, projectId, executionProfileId: 'restricted'
    });
    snapshot = await runtime.registry.setRoleAssignment({
      requestId: randomUUID(), expectedRegistryRevision: snapshot.revision, projectId, role: 'worker',
      assignment: { providerConfigurationId: 'ollama:default', modelId: 'fixture-model' }
    });
    assert.equal(snapshot.projects[0]?.executionProfileId, 'restricted');
    assert.equal(snapshot.projects[0]?.roleAssignments.worker?.modelId, 'fixture-model');

    const ticket = await runtime.registry.requestSwitch({ requestId: randomUUID(), expectedRegistryRevision: snapshot.revision, projectId });
    const reconciliation = await runtime.registry.reconcileWorkspace({ requestId: randomUUID(), currentWorkspaceUri: ticket.workspaceUri });
    assert.equal(reconciliation.snapshot.activeProjectId, projectId);
    assert.equal(reconciliation.action, 'none');
    const workspacePath = path.join(fixture.state, 'projects', 'workspaces', `${projectId}.theia-workspace`);
    const workspace = JSON.parse(await readFile(workspacePath, 'utf8')) as { folders: Array<{ path: string }> };
    assert.equal(workspace.folders.length, 1);
    assert.match(workspace.folders[0]!.path, /^file:/u);

    await assert.rejects(
      runtime.registry.removeRepository({ requestId: randomUUID(), expectedRegistryRevision: reconciliation.snapshot.revision, projectId, repositoryId }),
      (error: unknown) => error instanceof ProjectError && error.code === 'PROJECT_LAST_REPOSITORY_REMOVE_REFUSED'
    );
    await assert.rejects(
      runtime.registry.removeProject({ requestId: randomUUID(), expectedRegistryRevision: reconciliation.snapshot.revision, projectId }),
      (error: unknown) => error instanceof ProjectError && error.code === 'PROJECT_ACTIVE_REMOVE_REFUSED'
    );
    assert.deepEqual(runtime.registry.diagnostics(), {
      integrity: true, foreignKeys: true, repositoryCount: 1, unavailableCount: 0,
      activeConsistent: true, pendingConsistent: true, activeProcesses: 0
    });
    await runtime.registry.onStop();

    const restarted = runtimeFor(fixture.state);
    await restarted.registry.onStart();
    const restored = await restarted.registry.snapshot();
    assert.equal(restored.activeProjectId, projectId);
    assert.equal(restored.projects[0]?.roleAssignments.worker?.providerConfigurationId, 'ollama:default');
    assert.equal(restored.projects[0]?.executionProfileId, 'restricted');
    await restarted.registry.onStop();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects duplicate and non-Git repositories without mutating registry state', async () => {
  const fixture = await createFixture();
  try {
    const runtime = runtimeFor(fixture.state);
    await runtime.registry.onStart();
    const created = await runtime.registry.createProject({
      requestId: randomUUID(), expectedRegistryRevision: 1, displayName: 'Alpha', repositoryPath: fixture.repository
    });
    await assert.rejects(
      runtime.registry.createProject({
        requestId: randomUUID(), expectedRegistryRevision: created.revision, displayName: 'Duplicate', repositoryPath: fixture.repository
      }),
      (error: unknown) => error instanceof ProjectError && error.code === 'PROJECT_REPOSITORY_ALREADY_REGISTERED'
    );
    const notGit = path.join(fixture.root, 'not-git'); await mkdir(notGit);
    await assert.rejects(
      runtime.registry.createProject({
        requestId: randomUUID(), expectedRegistryRevision: created.revision, displayName: 'Invalid', repositoryPath: notGit
      }),
      (error: unknown) => error instanceof ProjectError && error.code === 'PROJECT_REPOSITORY_NOT_GIT'
    );
    const unchanged = await runtime.registry.snapshot();
    assert.equal(unchanged.revision, created.revision);
    assert.equal(unchanged.projects.length, 1);
    assert.equal(runtime.registry.diagnostics().activeProcesses, 0);
    await runtime.registry.onStop();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fails closed when the durable registry is corrupted', async () => {
  const fixture = await createFixture();
  try {
    const runtime = runtimeFor(fixture.state); await runtime.registry.onStart(); await runtime.registry.onStop();
    await writeFile(path.join(fixture.state, 'projects', 'registry.sqlite3'), 'not a sqlite database', 'utf8');
    const corrupted = runtimeFor(fixture.state);
    await assert.rejects(corrupted.registry.onStart(), (error: unknown) =>
      error instanceof ProjectError && error.code === 'PROJECT_REGISTRY_INTEGRITY_FAILED');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('refuses a registry schema created by a newer Kogg version without mutating it', async () => {
  const fixture = await createFixture();
  try {
    const runtime = runtimeFor(fixture.state); await runtime.registry.onStart(); await runtime.registry.onStop();
    const databasePath = path.join(fixture.state, 'projects', 'registry.sqlite3');
    const newer = new DatabaseSync(databasePath); newer.exec('PRAGMA user_version = 2;'); newer.close();
    const refused = runtimeFor(fixture.state);
    await assert.rejects(refused.registry.onStart(),
      (error: unknown) => error instanceof ProjectError && error.code === 'PROJECT_REGISTRY_SCHEMA_UNSUPPORTED');
    const verify = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((verify.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2); verify.close();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('marks a repository missing after restart and refuses stale workspace restoration', async () => {
  const fixture = await createFixture();
  try {
    const runtime = runtimeFor(fixture.state); await runtime.registry.onStart();
    const created = await runtime.registry.createProject({
      requestId: randomUUID(), expectedRegistryRevision: 1, displayName: 'Movable', repositoryPath: fixture.repository
    });
    const projectId = created.projects[0]!.id;
    const ticket = await runtime.registry.requestSwitch({ requestId: randomUUID(), expectedRegistryRevision: created.revision, projectId });
    await runtime.registry.reconcileWorkspace({ requestId: randomUUID(), currentWorkspaceUri: ticket.workspaceUri });
    await runtime.registry.onStop();
    await rename(fixture.repository, `${fixture.repository}-moved`);

    const restarted = runtimeFor(fixture.state); await restarted.registry.onStart();
    const unavailable = await restarted.registry.snapshot();
    assert.equal(unavailable.projects[0]?.lifecycle, 'unavailable');
    assert.equal(unavailable.projects[0]?.repositories[0]?.availability, 'missing');
    assert.equal(restarted.registry.diagnostics().unavailableCount, 1);
    const checks = await new ProjectDiagnosticContributor(restarted.registry).diagnose();
    assert.equal(checks.find(check => check.id === 'projects.repositories')?.status, 'warn');
    assert.equal(checks.find(check => check.id === 'projects.processes')?.status, 'pass');
    const reconciliation = await restarted.registry.reconcileWorkspace({ requestId: randomUUID() });
    assert.equal(reconciliation.action, 'none');
    await assert.rejects(
      restarted.registry.requestSwitch({ requestId: randomUUID(), expectedRegistryRevision: reconciliation.snapshot.revision, projectId }),
      (error: unknown) => error instanceof ProjectError && error.code === 'PROJECT_SWITCH_BLOCKED'
    );
    await restarted.registry.onStop();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('normalizes SQLite write contention and preserves the committed registry', async () => {
  const fixture = await createFixture();
  try {
    const runtime = runtimeFor(fixture.state); await runtime.registry.onStart();
    const created = await runtime.registry.createProject({
      requestId: randomUUID(), expectedRegistryRevision: 1, displayName: 'Contended', repositoryPath: fixture.repository
    });
    const competing = new DatabaseSync(path.join(fixture.state, 'projects', 'registry.sqlite3'));
    competing.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    await assert.rejects(
      runtime.registry.renameProject({
        requestId: randomUUID(), expectedRegistryRevision: created.revision,
        projectId: created.projects[0]!.id, displayName: 'Must not commit'
      }),
      (error: unknown) => error instanceof ProjectError && error.code === 'PROJECT_REGISTRY_BUSY'
    );
    competing.exec('ROLLBACK'); competing.close();
    const unchanged = await runtime.registry.snapshot();
    assert.equal(unchanged.projects[0]?.displayName, 'Contended');
    assert.equal(unchanged.revision, created.revision);
    await runtime.registry.onStop();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('diagnostics fail closed with the complete project catalog when registry inspection throws', async () => {
  const contributor = new ProjectDiagnosticContributor({ diagnostics: () => { throw new Error('fixture failure'); } } as unknown as ProjectRegistry);
  const checks = await contributor.diagnose();
  assert.deepEqual(checks.map(check => [check.id, check.status]), [
    ['projects.registry', 'fail'], ['projects.repositories', 'fail'],
    ['projects.restoration', 'fail'], ['projects.processes', 'fail']
  ]);
});

test('keeps exactly one repository binding per task while allowing an explicit rebind', async () => {
  const fixture = await createFixture();
  try {
    const secondRepository = path.join(fixture.root, 'second-repository');
    await initializeRepository(secondRepository);
    const runtime = runtimeFor(fixture.state); await runtime.registry.onStart();
    let snapshot = await runtime.registry.createProject({
      requestId: randomUUID(), expectedRegistryRevision: 1, displayName: 'Tasks', repositoryPath: fixture.repository
    });
    const projectId = snapshot.projects[0]!.id;
    const firstRepositoryId = snapshot.projects[0]!.repositories[0]!.id;
    snapshot = await runtime.registry.addRepository({
      requestId: randomUUID(), expectedRegistryRevision: snapshot.revision, projectId,
      displayName: 'Second', repositoryPath: secondRepository
    });
    const secondRepositoryId = snapshot.projects[0]!.repositories.find(repository => repository.displayName === 'Second')!.id;
    snapshot = await runtime.registry.bindTaskRepository({
      requestId: randomUUID(), expectedRegistryRevision: snapshot.revision, projectId, taskId: 'task-one', repositoryId: firstRepositoryId
    });
    snapshot = await runtime.registry.bindTaskRepository({
      requestId: randomUUID(), expectedRegistryRevision: snapshot.revision, projectId, taskId: 'task-one', repositoryId: secondRepositoryId
    });
    assert.deepEqual(snapshot.projects[0]?.taskBindings, [{ taskId: 'task-one', repositoryId: secondRepositoryId }]);
    await runtime.registry.onStop();
    const restarted = runtimeFor(fixture.state); await restarted.registry.onStart();
    assert.deepEqual((await restarted.registry.snapshot()).projects[0]?.taskBindings, [{ taskId: 'task-one', repositoryId: secondRepositoryId }]);
    await restarted.registry.onStop();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('registers the real Git process before start and emits bounded cleanup without paths or arguments', async () => {
  const fixture = await createFixture();
  const lines: string[] = [];
  const original = { info: console.info, warn: console.warn, error: console.error };
  console.info = (...args: unknown[]) => { lines.push(JSON.stringify(args)); };
  console.warn = (...args: unknown[]) => { lines.push(JSON.stringify(args)); };
  console.error = (...args: unknown[]) => { lines.push(JSON.stringify(args)); };
  try {
    const processManager = new ProcessManager(logger());
    const probe = new ProjectRepositoryProbe(processManager, logger(), operationRegistry());
    const result = await probe.probe(fixture.repository, randomUUID(), randomUUID());
    assert.match(result.rootUri, /^file:/u);
    assert.equal(probe.activeCount(), 0);
    const trace = lines.join('\n');
    const registered = trace.indexOf('repository.process.registered');
    const started = trace.indexOf('repository.validate.started');
    const completed = trace.indexOf('repository.validate.completed');
    const cleanup = trace.indexOf('repository.process.cleanup.completed');
    assert(registered >= 0 && registered < started && started < completed && completed < cleanup);
    assert.equal(trace.includes(fixture.repository), false);
    assert.equal(trace.includes('rev-parse'), false);
    processManager.onStop();
  } finally {
    console.info = original.info; console.warn = original.warn; console.error = original.error;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('times out and cancels real hanging Git children with terminal cleanup and no residual process', async () => {
  if (process.platform === 'win32') return;
  const fixture = await createFixture();
  const executableDirectory = path.join(fixture.root, 'bin'); await mkdir(executableDirectory);
  const fakeGit = path.join(executableDirectory, 'git');
  await writeFile(fakeGit, '#!/bin/sh\nexec /bin/sleep 30\n', 'utf8'); await chmod(fakeGit, 0o700);
  const previousPath = process.env.PATH; process.env.PATH = executableDirectory;
  const lines: string[] = []; const original = { info: console.info, warn: console.warn, error: console.error };
  console.info = (...args: unknown[]) => { lines.push(JSON.stringify(args)); };
  console.warn = (...args: unknown[]) => { lines.push(JSON.stringify(args)); };
  console.error = (...args: unknown[]) => { lines.push(JSON.stringify(args)); };
  try {
    const timeoutManager = new ProcessManager(logger()); const timeoutProbe = new ProjectRepositoryProbe(timeoutManager, logger(), operationRegistry(), 100);
    await assert.rejects(timeoutProbe.probe(fixture.repository, randomUUID(), randomUUID()),
      (error: unknown) => error instanceof ProjectError && error.code === 'PROJECT_REPOSITORY_PROBE_TIMEOUT');
    assert.equal(timeoutProbe.activeCount(), 0); timeoutManager.onStop();

    const cancelManager = new ProcessManager(logger()); const cancelProbe = new ProjectRepositoryProbe(cancelManager, logger(), operationRegistry(), 30_000);
    const pending = cancelProbe.probe(fixture.repository, randomUUID(), randomUUID());
    await new Promise(resolve => setTimeout(resolve, 50)); await cancelProbe.shutdown();
    await assert.rejects(pending, (error: unknown) => error instanceof ProjectError && error.code === 'PROJECT_REPOSITORY_PROBE_CANCELLED');
    assert.equal(cancelProbe.activeCount(), 0); cancelManager.onStop();
    const trace = lines.join('\n');
    assert.match(trace, /repository\.validate\.timeout/u);
    assert.match(trace, /repository\.validate\.cancelled/u);
    assert.match(trace, /"exitClass":"cancelled"/u);
    assert.equal((trace.match(/repository\.process\.cleanup\.completed/gu) ?? []).length, 2);
    assert.equal(trace.includes(fixture.repository), false);
  } finally {
    process.env.PATH = previousPath;
    console.info = original.info; console.warn = original.warn; console.error = original.error;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<{ root: string; state: string; repository: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-project-registry-test-'));
  const state = path.join(root, 'state'); const repository = path.join(root, 'repository');
  await initializeRepository(repository);
  return { root, state, repository };
}

async function initializeRepository(repository: string): Promise<void> {
  await mkdir(repository);
  const initialized = spawnSync('git', ['init', '--quiet', repository], { env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' } });
  assert.equal(initialized.status, 0);
}

function runtimeFor(state: string): { registry: ProjectRegistry } {
  process.env.KOGG_STATE_DIR = state;
  const processManager = new ProcessManager(logger());
  const probe = new ProjectRepositoryProbe(processManager, logger(), operationRegistry());
  const projection = new ProjectWorkspaceProjection();
  const providers = {
    getProvider: (id: string) => id === 'ollama' ? { id: 'ollama' } : undefined
  } as unknown as ProviderRegistry;
  return { registry: new ProjectRegistry(probe, projection, providers, operationRegistry()) };
}

function logger(): ILogger {
  return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as ILogger;
}

function operationRegistry(): OperationRegistryApi {
  const processLease: ProcessLease = { id: randomUUID(), spawning() {}, started() {}, ready() {}, activity() {}, failed() {}, exited() {}, cleanup() {} };
  const lease: OperationLease = {
    id: randomUUID(), cancellable: true, start() {}, active() {}, waiting() {}, activity() {}, refuse() {}, complete() {}, fail() {}, timeout() {},
    async cancel() {}, async cleanup(run) { await run?.(); }, registerProcess() { return processLease; }
  };
  return {
    async startOperation() { return lease; },
    async snapshot() { throw new Error('unused'); },
    async cancel() { throw new Error('unused'); },
    async recoveryResult() { return { status: 'missing' }; },
    diagnostics() { throw new Error('unused'); }
  };
}
