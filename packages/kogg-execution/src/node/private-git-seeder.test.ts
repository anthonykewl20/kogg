import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationRegistry } from '@kogg/operations/lib/node/operation-registry';
import { ControllerGitRunner, GitRunError } from './controller-git-runner';
import { PrivateGitSeeder, SeedError, type PrivateGitSeedRequest } from './private-git-seeder';

// diagnostic-coverage: execution.git-independence, execution.source-integrity, execution.process-cleanup
const IDS = {
  projectId: '10000000-0000-4000-8000-000000000001', repositoryId: '10000000-0000-4000-8000-000000000002',
  runId: '10000000-0000-4000-8000-000000000003', worktreeId: '10000000-0000-4000-8000-000000000004'
};

test('seeds only the approved commit into an independent private repository without leaking private values', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const fixture = await setup('success');
  const logs: string[] = [];
  const original = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  const capture = (...values: unknown[]): void => { logs.push(JSON.stringify(values)); };
  console.debug = capture; console.info = capture; console.warn = capture; console.error = capture;
  try {
    const sourceStatus = git(fixture.binary, fixture.sourceRoot, ['status', '--porcelain=v1']);
    const result = await fixture.seeder.seed(fixture.request);
    assert.equal(result.baseCommit, fixture.request.baseCommit);
    assert.equal(result.baseTree, fixture.request.baseTree);
    assert.match(result.branchRefDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(result.alternateCount, 0);
    assert.equal(git(fixture.binary, fixture.privateRoot, ['rev-parse', 'HEAD']), fixture.request.baseCommit);
    assert.equal(git(fixture.binary, fixture.privateRoot, ['rev-parse', 'HEAD^{tree}']), fixture.request.baseTree);
    assert.equal(git(fixture.binary, fixture.privateRoot, ['remote']), '');
    assert.equal(git(fixture.binary, fixture.privateRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads']), `refs/heads/kogg-run/${IDS.runId.replaceAll('-', '')}`);
    assert.equal(git(fixture.binary, fixture.sourceRoot, ['rev-parse', 'HEAD']), fixture.request.baseCommit);
    assert.equal(git(fixture.binary, fixture.sourceRoot, ['status', '--porcelain=v1']), sourceStatus);
    assert.equal(fixture.registry.diagnostics().activeCount, 0);
    assert.equal(fixture.registry.diagnostics().residualCount, 0);
    const transcript = logs.join('\n');
    assert.equal(transcript.includes(fixture.sourceRoot), false);
    assert.equal(transcript.includes(fixture.privateRoot), false);
    assert.equal(transcript.includes('private-source-canary'), false);
  } finally {
    console.debug = original.debug; console.info = original.info; console.warn = original.warn; console.error = original.error;
    await fixture.registry.onStop(); await rm(fixture.root, { recursive: true, force: true });
  }
});

test('refuses a changed base before creating a bundle or private repository and leaves no registered process', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const fixture = await setup('base-change');
  try {
    const request = { ...fixture.request, baseCommit: 'f'.repeat(40) };
    await assert.rejects(() => fixture.seeder.seed(request), (error: unknown) => error instanceof SeedError && error.code === 'GIT_BASE_CHANGED');
    await assert.rejects(() => import('node:fs/promises').then(fs => fs.lstat(fixture.privateRoot)), { code: 'ENOENT' });
    await assert.rejects(() => import('node:fs/promises').then(fs => fs.lstat(fixture.bundlePath)), { code: 'ENOENT' });
    assert.equal(fixture.registry.diagnostics().activeCount, 0);
    assert.equal(fixture.registry.diagnostics().residualCount, 0);
    assert.equal(git(fixture.binary, fixture.sourceRoot, ['status', '--porcelain=v1']), '');
  } finally { await fixture.registry.onStop(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('kills and records controller Git commands that exceed their idle deadline', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-git-timeout-'));
  const binary = path.join(root, 'git-timeout');
  const home = path.join(root, 'home'); const templateDirectory = path.join(root, 'template');
  await Promise.all([mkdir(home), mkdir(templateDirectory)]);
  await writeFile(binary, '#!/bin/sh\nwhile :; do :; done\n'); await chmod(binary, 0o700);
  const globalConfig = path.join(home, 'global.gitconfig'); await writeFile(globalConfig, '', { mode: 0o600 });
  process.env.KOGG_STATE_DIR = path.join(root, 'state');
  const registry = new OperationRegistry(); await registry.onStart();
  try {
    const operation = await registry.startOperation({ kind: 'worktree' }); operation.start(); operation.active();
    const runner = new ControllerGitRunner(binary, { home, globalConfig, templateDirectory }, 50, 250, 1024);
    await assert.rejects(() => runner.run(operation, 'private-verify', root, runner.protectedArguments(['rev-parse', '--verify', 'HEAD'])),
      (error: unknown) => error instanceof GitRunError && error.code === 'GIT_SEED_TIMEOUT');
    await operation.cleanup(); operation.fail('PROCESS_EXIT_NONZERO', 'GitRunError');
    assert.equal(registry.diagnostics().activeCount, 0); assert.equal(registry.diagnostics().residualCount, 0);
  } finally { await registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('kills and records controller Git commands that exceed the closed output limit', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-git-output-'));
  const binary = path.join(root, 'git-output');
  const home = path.join(root, 'home'); const templateDirectory = path.join(root, 'template');
  await Promise.all([mkdir(home), mkdir(templateDirectory)]);
  await writeFile(binary, '#!/bin/sh\nprintf 0123456789abcdef\n'); await chmod(binary, 0o700);
  const globalConfig = path.join(home, 'global.gitconfig'); await writeFile(globalConfig, '', { mode: 0o600 });
  process.env.KOGG_STATE_DIR = path.join(root, 'state');
  const registry = new OperationRegistry(); await registry.onStart();
  try {
    const operation = await registry.startOperation({ kind: 'worktree' }); operation.start(); operation.active();
    // Preserve the output-limit assertion under full-suite CPU contention: the
    // fixture emits immediately, while these deadlines only bound a broken test.
    const runner = new ControllerGitRunner(binary, { home, globalConfig, templateDirectory }, 5_000, 10_000, 8);
    await assert.rejects(() => runner.run(operation, 'private-verify', root, runner.protectedArguments(['rev-parse', '--verify', 'HEAD'])),
      (error: unknown) => error instanceof GitRunError && error.code === 'GIT_SEED_OUTPUT_LIMIT');
    await operation.cleanup(); operation.fail('PROCESS_EXIT_NONZERO', 'GitRunError');
    assert.equal(registry.diagnostics().activeCount, 0); assert.equal(registry.diagnostics().residualCount, 0);
  } finally { await registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('refuses a Git argument vector outside the closed phase catalog before spawning', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-git-catalog-')); const home = path.join(root, 'home'); const templateDirectory = path.join(root, 'template');
  await Promise.all([mkdir(home), mkdir(templateDirectory)]); const binary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(); const globalConfig = path.join(home, 'global.gitconfig'); await writeFile(globalConfig, '', { mode: 0o600 });
  process.env.KOGG_STATE_DIR = path.join(root, 'state'); const registry = new OperationRegistry(); await registry.onStart();
  try {
    const operation = await registry.startOperation({ kind: 'worktree' }); operation.start(); operation.active(); const runner = new ControllerGitRunner(binary, { home, globalConfig, templateDirectory });
    await assert.rejects(() => runner.run(operation, 'private-verify', root, runner.protectedArguments(['config', '--global', '--list'])), (error: unknown) => error instanceof GitRunError && error.code === 'GIT_SEED_FAILED');
    await operation.cleanup(); operation.fail('PROCESS_EXIT_NONZERO', 'GitRunError'); assert.equal(registry.diagnostics().residualCount, 0);
  } finally { await registry.onStop(); await rm(root, { recursive: true, force: true }); }
});

async function setup(name: string): Promise<{
  root: string; sourceRoot: string; privateRoot: string; bundlePath: string; binary: string;
  registry: OperationRegistry; seeder: PrivateGitSeeder; request: PrivateGitSeedRequest;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `kogg-git-seed-${name}-`));
  const sourceRoot = path.join(root, 'private-source-canary');
  const privateRoot = path.join(root, 'allocation', 'worktree');
  const bundlePath = path.join(root, 'allocation', 'seed.bundle');
  const home = path.join(root, 'home'); const templateDirectory = path.join(root, 'template');
  await Promise.all([mkdir(sourceRoot), mkdir(path.dirname(privateRoot)), mkdir(home), mkdir(templateDirectory)]);
  const globalConfig = path.join(home, 'global.gitconfig'); await writeFile(globalConfig, '', { mode: 0o600 });
  const binary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  git(binary, sourceRoot, ['init', '--initial-branch=source-private-name']);
  await writeFile(path.join(sourceRoot, 'private-file-name.txt'), 'private-source-canary\n');
  git(binary, sourceRoot, ['add', 'private-file-name.txt']);
  git(binary, sourceRoot, ['-c', 'user.name=Kogg Test', '-c', 'user.email=kogg@example.invalid', 'commit', '-m', 'private commit message']);
  const baseCommit = git(binary, sourceRoot, ['rev-parse', 'HEAD']);
  const baseTree = git(binary, sourceRoot, ['rev-parse', 'HEAD^{tree}']);
  const sourceGitDirectory = git(binary, sourceRoot, ['rev-parse', '--absolute-git-dir']);
  process.env.KOGG_STATE_DIR = path.join(root, 'state');
  const registry = new OperationRegistry(); await registry.onStart();
  const runner = new ControllerGitRunner(binary, { home, globalConfig, templateDirectory }, 5_000, 20_000);
  const seeder = new PrivateGitSeeder(registry, runner);
  return {
    root, sourceRoot, privateRoot, bundlePath, binary, registry, seeder,
    request: { ...IDS, sourceRoot, sourceGitDirectory, privateRoot, bundlePath, baseCommit, baseTree, objectFormat: 'sha1' }
  };
}

function git(binary: string, cwd: string, args: readonly string[]): string {
  return execFileSync(binary, [...args], {
    cwd, encoding: 'utf8', env: { PATH: path.dirname(binary), LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}
