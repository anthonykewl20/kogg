import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { OperationRegistry } from '@kogg/operations/lib/node/operation-registry';
import type { ExecutionBindingV1, ReserveExecutionAllocationV1 } from '../common/execution-protocol';
import { ExecutionAllocationRegistry } from './execution-allocation-registry';
import { NativeAllocationController, NativeAllocationError } from './native-allocation-controller';

// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.capacity, execution.recovery, execution.process-cleanup
test('verifies, registers, and commits one native helper allocation', async () => {
  const fixture = await setup('success');
  try {
    const result = await fixture.controller.allocate(fixture.request);
    assert.equal(result.state, 'allocated'); assert.equal(result.revision, '2');
    assert.equal(fixture.allocations.diagnostics().activeQuotaProjectLeaseCount, 1); assert.equal(fixture.allocations.diagnostics().quarantinedQuotaProjectLeaseCount, 0);
    const operations = await fixture.operations.snapshot(); assert.equal(operations.active.length, 0); assert.equal(operations.recent[0]?.processCount, 1);
    assert.equal(fixture.operations.diagnostics().residualCount, 0); assert.equal(fixture.operations.diagnostics().cleanupFailureCount, 0);
    const database = new DatabaseSync(path.join(process.env.KOGG_STATE_DIR!, 'operations', 'registry.sqlite3'));
    const events = database.prepare('SELECT event_name FROM operation_events WHERE process_id IS NOT NULL ORDER BY sequence').all().map(row => String(row.event_name)); database.close();
    assert.ok(events.indexOf('process.registered') < events.indexOf('process.spawn.started')); assert.ok(events.includes('cleanup.completed'));
  } finally { await fixture.close(); }
});

test('atomically quarantines a closed helper refusal and leaves no process residual', async () => {
  const fixture = await setup('refusal');
  try {
    await assert.rejects(() => fixture.controller.allocate(fixture.request), (error: unknown) => error instanceof NativeAllocationError && error.code === 'ALLOCATION_QUALIFICATION_INVALID');
    const replay = await fixture.allocations.reserve(fixture.request); assert.equal(replay.state, 'quarantined'); assert.equal(replay.safeCode, 'ALLOCATION_QUALIFICATION_INVALID');
    assert.equal(fixture.allocations.diagnostics().quarantinedQuotaProjectLeaseCount, 1); assert.equal(fixture.operations.diagnostics().residualCount, 0);
  } finally { await fixture.close(); }
});

test('refuses a changed helper artifact before reserving durable allocation state', async () => {
  const fixture = await setup('success');
  try {
    await chmod(fixture.binary, 0o700); await writeFile(fixture.binary, `${await fakeHelper('success')}\n// changed\n`); await chmod(fixture.binary, 0o500);
    await assert.rejects(() => fixture.controller.allocate(fixture.request), (error: unknown) => error instanceof NativeAllocationError && error.code === 'ALLOCATION_QUALIFICATION_INVALID');
    assert.equal(fixture.allocations.diagnostics().reservationCount, 0); assert.equal((await fixture.operations.snapshot()).active.length, 0);
  } finally { await fixture.close(); }
});

async function setup(mode: 'success' | 'refusal') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-native-controller-')); process.env.KOGG_STATE_DIR = path.join(root, 'state');
  const native = path.join(root, 'native'); const allocationRoot = path.join(root, 'allocations'); await mkdir(native, { recursive: true });
  const binary = path.join(native, 'helper'); const manifest = path.join(native, 'manifest.json'); const source = await fakeHelper(mode);
  await writeFile(binary, source); await chmod(binary, 0o500); const helperDigest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
  await writeFile(manifest, `${JSON.stringify({ schemaVersion: 1, platform: 'linux', architecture: 'x64', sourceDigest: `sha256:${'1'.repeat(64)}`, artifactDigest: helperDigest })}\n`); await chmod(manifest, 0o400);
  const authorized = { authorize: async () => true, authorizePhysicalAllocation: async (_binding: ExecutionBindingV1, candidate: string, mount: string) => candidate === helperDigest && mount === `sha256:${'2'.repeat(64)}` };
  const allocations = new ExecutionAllocationRegistry(authorized as never); const operations = new OperationRegistry();
  await operations.onStart(); await allocations.onStart();
  const targets = { physicalAllocationAuthority: async () => ({ helperDigest, mountQuotaDigest: `sha256:${'2'.repeat(64)}` }) };
  const controller = new NativeAllocationController(allocations, targets, operations, { platform: 'linux', arch: 'x64', allocationRoot, binary, manifest, timeoutMs: 5_000 }); controller.onStart();
  return { root, binary, allocations, operations, controller, request: allocationRequest(), async close() { controller.onStop(); allocations.onStop(); await operations.onStop(); await rm(root, { recursive: true, force: true }); } };
}

async function fakeHelper(mode: 'success' | 'refusal'): Promise<string> {
  const result = mode === 'success'
    ? `process.stdout.write(JSON.stringify({schemaVersion:1,ok:true,safeCode:'ALLOCATION_OK',filesystemDevice:'2049',filesystemInode:'4001',ownerUid:String(process.geteuid()),mode:'0700',mountId:'55',quotaProjectId:request.quotaProjectId})+'\\n');`
    : `process.stdout.write(JSON.stringify({schemaVersion:1,ok:false,safeCode:'ALLOCATION_QUALIFICATION_INVALID'})+'\\n'); process.exitCode=1;`;
  return `#!${process.execPath}\nconst fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{if(!fs.fstatSync(3).isDirectory())process.exit(2);const request=JSON.parse(input);${result}});\n`;
}

function allocationRequest(): ReserveExecutionAllocationV1 {
  const digest = `sha256:${'a'.repeat(64)}`;
  return { requestId: '60000000-0000-4000-8000-000000000001', quotaBytes: '1073741824', quotaInodes: '100000', binding: {
    schemaVersion: 1, projectId: '60000000-0000-4000-8000-000000000002', projectRevision: '1', repositoryId: '60000000-0000-4000-8000-000000000003', repositoryBindingRevision: '1',
    taskId: '60000000-0000-4000-8000-000000000004', taskRevisionId: '60000000-0000-4000-8000-000000000005', taskRevisionDigest: digest, approvalDigest: digest,
    runId: '60000000-0000-4000-8000-000000000006', attemptId: '60000000-0000-4000-8000-000000000007', workflowPlanDigest: digest,
    baseCommit: 'b'.repeat(40), baseTree: 'c'.repeat(40), gitObjectFormat: 'sha1', targetId: 'local-qualified-linux', qualificationId: '60000000-0000-4000-8000-000000000008',
    qualificationDigest: digest, profileId: 'kogg-writable-agent-v1', profileDigest: digest
  } };
}
