import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ProjectBindingAuthority, ProjectBindingSnapshot } from '@kogg/projects/lib/common/projects-protocol';
import { TaskDiagnosticContributor } from './task-diagnostic-contributor';
import { TaskRegistry } from './task-registry';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const REPOSITORY = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';

test('persists the governed draft, freeze, review, approval, revocation, conflicts, and diagnostics', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-tasks-test-'));
  const original = process.env.KOGG_STATE_DIR;
  process.env.KOGG_STATE_DIR = temporary;
  const authority = new FixtureAuthority();
  const registry = new TaskRegistry(authority);
  try {
    await registry.onStart();
    const requestId = crypto.randomUUID();
    const created = await registry.create({ requestId, projectId: PROJECT, repositoryId: REPOSITORY, content: 'Exact\r\nspecification\r\n' });
    assert.equal(created.kind, 'completed');
    assert.equal(created.projection?.currentSpecification.lineEnding, 'crlf');
    const replay = await registry.create({ requestId, projectId: PROJECT, repositoryId: REPOSITORY, content: 'Exact\r\nspecification\r\n' });
    assert.equal(replay.replay, true);
    const taskId = created.projection!.taskId;

    const frozen = await registry.freeze(expectation(created.projection!, taskId));
    assert.equal(frozen.projection?.currentSpecification.lifecycle, 'frozen');
    const stale = await registry.createSuccessorDraft(expectation(created.projection!, taskId));
    assert.equal(stale.kind, 'conflict');
    assert.equal(stale.code, 'REGISTRY_REVISION_CONFLICT');

    const review = await registry.beginApprovalReview({ requestId: crypto.randomUUID(), taskId, sessionId: SESSION });
    assert.equal(review.kind, 'completed');
    const forged = await registry.approve({ ...expectation(frozen.projection!, taskId), sessionId: crypto.randomUUID(), challenge: review.challenge! });
    assert.equal(forged.code, 'REVIEW_SESSION_CHANGED');
    const approved = await registry.approve({ ...expectation(frozen.projection!, taskId), sessionId: SESSION, challenge: review.challenge! });
    assert.equal(approved.projection?.currentApproval?.lifecycle, 'current');
    const revoked = await registry.revoke(expectation(approved.projection!, taskId));
    assert.equal(revoked.projection?.currentApproval, undefined);

    const checks = await new TaskDiagnosticContributor(registry).diagnose();
    assert.deepEqual(checks.map(check => [check.id, check.status]), [
      ['tasks.registry', 'pass'], ['tasks.revisions', 'pass'], ['tasks.bindings', 'pass'], ['tasks.approvals', 'pass']
    ]);
    await registry.onStop();

    const reopened = new TaskRegistry(authority);
    await reopened.onStart();
    assert.equal((await reopened.get(taskId)).currentApproval, undefined);
    await reopened.onStop();
  } finally {
    if (original === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = original;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('fails every task diagnostic safely when registry inspection fails', async () => {
  const contributor = new TaskDiagnosticContributor({ diagnostics: () => { throw new Error('fixture'); } } as unknown as TaskRegistry);
  const checks = await contributor.diagnose();
  assert.equal(checks.length, 4);
  assert.ok(checks.every(check => check.status === 'fail'));
});

test('publishes immutable safe task facts into the disposable operations projection', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-task-owner-projection-test-')); const original = process.env.KOGG_STATE_DIR; process.env.KOGG_STATE_DIR = temporary;
  const registry = new TaskRegistry(new FixtureAuthority()); const projection = new OperationsReadModel(path.join(temporary, 'operations', 'projection.sqlite3'));
  try {
    await registry.onStart(); projection.start(); projection.registerOwner('task'); registry.setOwnerSink(projection);
    const created = await registry.create({ requestId: crypto.randomUUID(), projectId: PROJECT, repositoryId: REPOSITORY, content: 'never copy this task content' }); const taskId = created.projection!.taskId;
    const frozen = await registry.freeze(expectation(created.projection!, taskId)); const review = await registry.beginApprovalReview({ requestId: crypto.randomUUID(), taskId, sessionId: SESSION });
    const approved = await registry.approve({ ...expectation(frozen.projection!, taskId), sessionId: SESSION, challenge: review.challenge! }); const runId = crypto.randomUUID();
    const admitted = await registry.authorizeAdmission({ ...expectation(approved.projection!, taskId), runId }); assert.equal(admitted.kind, 'completed');
    const run = projection.snapshot().runs.find(item => item.runId === runId); assert.equal(run?.taskId, taskId); assert.equal(run?.lifecycle, 'unknown');
    assert(projection.timeline(runId).some(event => event.eventKind === 'admission.authorized')); assert.equal(projection.diagnostics().ownerCount, 1);
    assert.doesNotMatch(JSON.stringify(projection.snapshot()), /never copy this task content/u);
  } finally { registry.setOwnerSink(undefined); await registry.onStop(); projection.stop(); if (original === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = original; await rm(temporary, { recursive: true, force: true }); }
});

test('refuses startup when immutable specification bytes no longer match their digest', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-tasks-corruption-test-'));
  const original = process.env.KOGG_STATE_DIR;
  process.env.KOGG_STATE_DIR = temporary;
  const registry = new TaskRegistry(new FixtureAuthority());
  try {
    await registry.onStart();
    const created = await registry.create({ requestId: crypto.randomUUID(), projectId: PROJECT, repositoryId: REPOSITORY, content: 'Original exact bytes\n' });
    assert.equal(created.kind, 'completed');
    await registry.onStop();

    const database = new DatabaseSync(path.join(temporary, 'tasks', 'registry.sqlite3'));
    database.exec('DROP TRIGGER tasks_immutable_specifications_update');
    database.prepare('UPDATE specifications SET content=? WHERE specification_id=?')
      .run(Buffer.from('Corrupted bytes\n'), created.projection!.currentSpecification.specificationId);
    database.close();

    const reopened = new TaskRegistry(new FixtureAuthority());
    await assert.rejects(reopened.onStart(), (error: unknown) => error instanceof Error && error.message === 'INTEGRITY_FAILED');
  } finally {
    if (original === undefined) delete process.env.KOGG_STATE_DIR; else process.env.KOGG_STATE_DIR = original;
    await rm(temporary, { recursive: true, force: true });
  }
});

class FixtureAuthority implements ProjectBindingAuthority {
  async resolveBinding(projectId: string, repositoryId: string): Promise<ProjectBindingSnapshot | undefined> {
    if (projectId !== PROJECT || repositoryId !== REPOSITORY) return undefined;
    return { projectId, repositoryId, registryRevision: 1, bindingRevision: 1, available: true, active: true, executionProfileId: 'default' };
  }
}
function expectation(projection: { registryRevision: string; taskRevision: string }, taskId: string) {
  return { requestId: crypto.randomUUID(), expectedRegistryRevision: projection.registryRevision, expectedTaskRevision: projection.taskRevision, taskId };
}
