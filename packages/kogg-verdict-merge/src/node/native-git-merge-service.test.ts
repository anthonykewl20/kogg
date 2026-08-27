import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { ILogger } from '@theia/core/lib/common/logger';
import type { OperationLease, OperationRegistryApi, ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import type { ProjectBindingAuthority } from '@kogg/projects/lib/common/projects-protocol';
import type { MergeAuthorizationRegistry, MergeLifecycleState, PrivateMergeIntent } from './merge-authorization-registry';
import { NativeGitMergeService } from './native-git-merge-service';

// diagnostic-coverage: merge.preflight, merge.processes, merge.atomicity, merge.recovery
const run = promisify(execFile);

test('constructs a deterministic two-parent commit and performs one exact ref CAS without touching the worktree', { timeout: 30_000 }, async () => {
  const root = await repository();
  try {
    const base = await git(root, 'rev-parse', 'refs/heads/main'); const subject = await git(root, 'rev-parse', 'refs/heads/subject'); const tree = await git(root, 'rev-parse', `${subject}^{tree}`); const indexTree = await git(root, 'write-tree');
    const registry = new FixtureRegistry(intent(base, subject, tree)); const service = new NativeGitMergeService(registry as unknown as MergeAuthorizationRegistry, projects(root), operations(), logger());
    await service.execute(registry.value.mergeId);
    assert.equal(registry.state, 'completed');
    const merged = await git(root, 'rev-parse', 'refs/heads/main'); assert.notEqual(merged, base);
    assert.deepEqual((await git(root, 'show', '-s', '--format=%P', merged)).split(' '), [base, subject]);
    assert.equal(await git(root, 'show', '-s', '--format=%B', merged), 'Kogg controlled merge');
    assert.equal(await git(root, 'write-tree'), indexTree);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses destination drift before construction and never updates the ref', { timeout: 30_000 }, async () => {
  const root = await repository();
  try {
    const actual = await git(root, 'rev-parse', 'refs/heads/main'); const subject = await git(root, 'rev-parse', 'refs/heads/subject'); const tree = await git(root, 'rev-parse', `${subject}^{tree}`);
    const registry = new FixtureRegistry(intent('f'.repeat(40), subject, tree)); const service = new NativeGitMergeService(registry as unknown as MergeAuthorizationRegistry, projects(root), operations(), logger());
    await service.execute(registry.value.mergeId);
    assert.equal(registry.state, 'refused'); assert.equal(await git(root, 'rev-parse', 'refs/heads/main'), actual);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup recovery never retries CAS and classifies exact old, exact new, and third-ref drift', { timeout: 30_000 }, async () => {
  const root = await repository();
  try {
    const base = await git(root, 'rev-parse', 'refs/heads/main'); const subject = await git(root, 'rev-parse', 'refs/heads/subject'); const tree = await git(root, 'rev-parse', `${subject}^{tree}`); const value = intent(base, subject, tree);
    const first = new FixtureRegistry(value); const executor = new NativeGitMergeService(first as unknown as MergeAuthorizationRegistry, projects(root), operations(), logger()); await executor.execute(value.mergeId); const merged = await git(root, 'rev-parse', 'refs/heads/main');
    first.state = 'recovery-required'; first.expectedMergeOid = merged; first.recover = true; await executor.onStart(); assert.equal(first.state, 'completed');
    await git(root, 'update-ref', value.destinationRef, base, merged);
    const old = new FixtureRegistry(value, true); old.state = 'cas-started'; old.expectedMergeOid = merged; await new NativeGitMergeService(old as unknown as MergeAuthorizationRegistry, projects(root), operations(), logger()).onStart(); assert.equal(old.state, 'refused'); assert.equal(await git(root, 'rev-parse', value.destinationRef), base);
    await git(root, 'update-ref', value.destinationRef, subject, base);
    const drift = new FixtureRegistry(value, true); drift.state = 'recovery-required'; drift.expectedMergeOid = merged; await new NativeGitMergeService(drift as unknown as MergeAuthorizationRegistry, projects(root), operations(), logger()).onStart(); assert.equal(drift.state, 'quarantined'); assert.equal(await git(root, 'rev-parse', value.destinationRef), subject);
  } finally { await rm(root, { recursive: true, force: true }); }
});

class FixtureRegistry {
  state = 'preflight-pending';
  expectedMergeOid: string | undefined; recover: boolean;
  constructor(readonly value: PrivateMergeIntent, recover = false) { this.recover = recover; }
  pendingIntent(): PrivateMergeIntent | undefined { return this.state === 'preflight-pending' ? this.value : undefined; }
  revalidateIntent(): Promise<boolean> { return Promise.resolve(true); }
  transitionMerge(_mergeId: string, state: MergeLifecycleState, expected: string | readonly string[]): void { const allowed = typeof expected === 'string' ? [expected] : expected; assert(allowed.includes(this.state)); this.state = state; }
  mergeState(): string { return this.state; }
  recoveryCandidates(): readonly { intent: PrivateMergeIntent; state: string; expectedMergeOid?: string }[] { return this.recover ? [{ intent: this.value, state: this.state, ...(this.expectedMergeOid ? { expectedMergeOid: this.expectedMergeOid } : {}) }] : []; }
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-native-merge-')); await git(root, 'init', '-b', 'main');
  await writeFile(path.join(root, 'base.txt'), 'base\n'); await git(root, 'add', 'base.txt'); await commit(root, 'base');
  await git(root, 'checkout', '-b', 'subject'); await writeFile(path.join(root, 'subject.txt'), 'subject\n'); await git(root, 'add', 'subject.txt'); await commit(root, 'subject'); await git(root, 'checkout', 'main');
  return root;
}
async function commit(root: string, message: string): Promise<void> { await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-m', message); }
async function git(root: string, ...args: string[]): Promise<string> { const result = await run('git', args, { cwd: root, env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C' } }); return result.stdout.trim(); }
function intent(base: string, subject: string, tree: string): PrivateMergeIntent { return { mergeId:'90000000-0000-4000-8000-000000000001',requestId:'90000000-0000-4000-8000-000000000002',authorizationId:'90000000-0000-4000-8000-000000000003',authorizationDigest:`sha256:${'1'.repeat(64)}`,exactBindingsDigest:`sha256:${'2'.repeat(64)}`,repositoryIdentityDigest:`sha256:${'3'.repeat(64)}`,taskId:'90000000-0000-4000-8000-000000000004',taskRevisionId:'90000000-0000-4000-8000-000000000005',generation:'1',explanationId:'90000000-0000-4000-8000-000000000006',projectId:'90000000-0000-4000-8000-000000000007',repositoryId:'90000000-0000-4000-8000-000000000008',destinationRef:'refs/heads/main',expectedOldOid:base,subjectOid:subject,expectedTreeOid:tree,mergePolicyId:'local-two-parent-no-ff-v1',state:'preflight-pending',createdAt:'2026-08-27T00:00:10.000Z' }; }
function projects(root: string): ProjectBindingAuthority { return { resolveBinding: async () => ({ projectId:'90000000-0000-4000-8000-000000000007',repositoryId:'90000000-0000-4000-8000-000000000008',registryRevision:1,bindingRevision:1,available:true,active:true,executionProfileId:'default',rootUri:pathToFileURL(root).href,repositoryIdentityDigest:'3'.repeat(64) }) }; }
function operations(): OperationRegistryApi { return { startOperation: async () => lease(), snapshot: async () => ({ schemaVersion:1,revision:1,admission:'enabled',active:[],recent:[] }), cancel: async () => ({ schemaVersion:1,revision:1,admission:'enabled',active:[],recent:[] }), recoveryResult: async () => ({ status:'cleaned' }), processExecutionAttestation: async () => undefined, diagnostics: () => ({ integrity:true,foreignKeys:true,permissions:true,recoveryComplete:true,activeCount:0,stalledCount:0,residualCount:0,cleanupFailureCount:0,admission:'enabled' }) }; }
function lease(): OperationLease { return { id:'operation',cancellable:false,refuse(){},start(){},active(){},waiting(){},activity(){},fail(){},complete(){},timeout(){},cancel:async()=>{},cleanup:async action=>{ await action?.(); },registerProcess:()=>processLease() }; }
function processLease(): ProcessLease { return { id:'process',spawning(){},started(){},ready(){},activity(){},failed(){},exited(){},cleanup(){} }; }
function logger(): ILogger { return { setLogLevel:async()=>{},getLogLevel:async()=>0,isEnabled:()=>false,log(){},debug(){},info(){},warn(){},error(){},fatal(){},child:()=>logger() } as unknown as ILogger; }
