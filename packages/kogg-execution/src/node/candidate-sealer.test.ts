import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationRegistry } from '@kogg/operations/lib/node/operation-registry';
import type { SealCandidateV1 } from '../common/execution-protocol';
import { CandidateSealer, SealError } from './candidate-sealer';
import { ControllerGitRunner } from './controller-git-runner';
import { executionLog, executionLoggingDiagnostics } from './execution-logger';

// diagnostic-coverage: execution.git-independence, execution.source-integrity, execution.process-cleanup
test('seals a clean descendant with safe content into an immutable candidate without leaking content-bearing values', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const fixture = await setup('success');
  const canary = 'private-candidate-filename.txt'; await writeFile(path.join(fixture.privateRoot, canary), 'private-candidate-content\n');
  await mkdir(path.join(fixture.privateRoot, 'links')); await symlink(`../${canary}`, path.join(fixture.privateRoot, 'links', 'safe-link'));
  git(fixture.binary, fixture.privateRoot, ['add', canary, 'links/safe-link']); git(fixture.binary, fixture.privateRoot, ['commit', '-m', 'private candidate message']);
  const logs: string[] = []; const original = { info: console.info, error: console.error };
  console.info = (...values: unknown[]) => { logs.push(JSON.stringify(values)); }; console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  try {
    const candidate = await fixture.sealer.seal(fixture.request);
    assert.equal(candidate.baseCommit, fixture.request.baseCommit); assert.equal(candidate.baseTree, fixture.request.baseTree);
    assert.equal(candidate.candidateCommit, git(fixture.binary, fixture.privateRoot, ['rev-parse', 'HEAD']));
    assert.equal(candidate.candidateTree, git(fixture.binary, fixture.privateRoot, ['rev-parse', 'HEAD^{tree}']));
    assert.notEqual(candidate.candidateTree, candidate.baseTree); assert.match(candidate.objectClosureDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(candidate.mutationPolicyDigest, /^sha256:[0-9a-f]{64}$/u); assert.equal(candidate.retentionClass, 'pending-evidence');
    assert.equal(fixture.registry.diagnostics().activeCount, 0); assert.equal(fixture.registry.diagnostics().residualCount, 0);
    const transcript = logs.join('\n'); assert.equal(transcript.includes(canary), false); assert.equal(transcript.includes('private-candidate-content'), false); assert.equal(transcript.includes(fixture.privateRoot), false);
  } finally { console.info = original.info; console.error = original.error; await fixture.registry.onStop(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('refuses a dirty private worktree without leaving a registered process', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const fixture = await setup('dirty'); await writeFile(path.join(fixture.privateRoot, 'untracked-canary.txt'), 'private\n');
  try {
    await assert.rejects(() => fixture.sealer.seal(fixture.request), (error: unknown) => error instanceof SealError && error.code === 'SEAL_DIRTY');
    assert.equal(fixture.registry.diagnostics().activeCount, 0); assert.equal(fixture.registry.diagnostics().residualCount, 0);
  } finally { await fixture.registry.onStop(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('refuses an escaping symlink committed in the candidate tree', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const fixture = await setup('symlink'); await symlink('../outside-private-root', path.join(fixture.privateRoot, 'escape-canary'));
  git(fixture.binary, fixture.privateRoot, ['add', 'escape-canary']); git(fixture.binary, fixture.privateRoot, ['commit', '-m', 'unsafe symlink candidate']);
  try {
    await assert.rejects(() => fixture.sealer.seal(fixture.request), (error: unknown) => error instanceof SealError && error.code === 'SEAL_MUTATION_POLICY');
    assert.equal(fixture.registry.diagnostics().activeCount, 0); assert.equal(fixture.registry.diagnostics().residualCount, 0);
  } finally { await fixture.registry.onStop(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('closed candidate logging rejects undeclared content-bearing fields', () => {
  const canary = `candidate-secret-${Date.now()}`; const logs: string[] = []; const original = console.error;
  console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  try {
    executionLog('seal.refused', {
      eventVersion: 1, operationId: '10000000-0000-4000-8000-000000000001', runId: '10000000-0000-4000-8000-000000000002',
      attemptId: '10000000-0000-4000-8000-000000000003', worktreeId: '10000000-0000-4000-8000-000000000004', safeCode: 'SEAL_FAILED', errorType: 'Error', content: canary
    } as never);
    assert.equal(logs.join('\n').includes(canary), false); assert.equal(executionLoggingDiagnostics().violationCount > 0, true);
  } finally { console.error = original; }
});

async function setup(name: string): Promise<{ root: string; privateRoot: string; binary: string; registry: OperationRegistry; sealer: CandidateSealer; request: SealCandidateV1 }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `kogg-candidate-${name}-`)); const privateRoot = path.join(root, 'private-worktree');
  const home = path.join(root, 'home'); const templateDirectory = path.join(root, 'template');
  await Promise.all([mkdir(privateRoot), mkdir(home), mkdir(templateDirectory)]); const globalConfig = path.join(home, 'global.gitconfig'); await writeFile(globalConfig, '', { mode: 0o600 });
  const binary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(); git(binary, privateRoot, ['init', '--initial-branch=bootstrap']);
  await writeFile(path.join(privateRoot, 'base.txt'), 'base\n'); git(binary, privateRoot, ['add', 'base.txt']); git(binary, privateRoot, ['commit', '-m', 'base']);
  const baseCommit = git(binary, privateRoot, ['rev-parse', 'HEAD']); const baseTree = git(binary, privateRoot, ['rev-parse', 'HEAD^{tree}']);
  const runId = '10000000-0000-4000-8000-000000000003'; git(binary, privateRoot, ['switch', '-c', `kogg-run/${runId.replaceAll('-', '')}`]); git(binary, privateRoot, ['branch', '-D', 'bootstrap']);
  process.env.KOGG_STATE_DIR = path.join(root, 'state'); const registry = new OperationRegistry(); await registry.onStart();
  const runner = new ControllerGitRunner(binary, { home, globalConfig, templateDirectory }, 5_000, 20_000); const sealer = new CandidateSealer(registry, runner);
  return { root, privateRoot, binary, registry, sealer, request: { projectId: '10000000-0000-4000-8000-000000000001', runId, attemptId: '10000000-0000-4000-8000-000000000004', worktreeId: '10000000-0000-4000-8000-000000000005', privateRoot, baseCommit, baseTree, objectFormat: 'sha1', maximumTreeBytes: '1073741824' } };
}

function git(binary: string, cwd: string, args: readonly string[]): string { return execFileSync(binary, ['-c', 'user.name=Kogg Test', '-c', 'user.email=kogg@example.invalid', ...args], { cwd, encoding: 'utf8', env: { PATH: path.dirname(binary), LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
