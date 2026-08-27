import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationRegistry } from '@kogg/operations/lib/node/operation-registry';
import type { ImportCandidateV1, SealCandidateV1 } from '../common/execution-protocol';
import { CandidateImporter, ImportError } from './candidate-importer';
import { CandidateSealer } from './candidate-sealer';
import { ControllerGitRunner } from './controller-git-runner';

// diagnostic-coverage: execution.source-integrity, execution.git-independence, execution.process-cleanup
test('imports only the sealed candidate into quarantine while preserving source-visible state and safe logs', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const fixture = await setup('success'); const sourceBefore = sourceState(fixture.binary, fixture.sourceRoot);
  const canary = 'private-import-canary.txt'; await writeFile(path.join(fixture.privateRoot, canary), 'private import content\n');
  git(fixture.binary, fixture.privateRoot, ['add', canary]); git(fixture.binary, fixture.privateRoot, ['commit', '-m', 'private import candidate']);
  const candidate = await fixture.sealer.seal(fixture.sealRequest); const request = { ...fixture.importRequest, candidate };
  const logs: string[] = []; const original = { info: console.info, error: console.error };
  console.info = (...values: unknown[]) => { logs.push(JSON.stringify(values)); }; console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  try {
    const imported = await fixture.importer.import(request); const refs = git(fixture.binary, fixture.sourceRoot, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/kogg/quarantine']);
    assert.equal(refs.split(' ')[1], candidate.candidateCommit); assert.match(imported.quarantineRefDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(imported.safeCode, 'IMPORT_OK'); assert.equal(sourceState(fixture.binary, fixture.sourceRoot), `${sourceBefore}\n${refs}`);
    await assert.rejects(() => fixture.importer.import(request), (error: unknown) => error instanceof ImportError && error.code === 'IMPORT_REF_EXISTS');
    assert.equal(logs.join('\n').includes(canary), false); assert.equal(logs.join('\n').includes(fixture.sourceRoot), false); assert.equal(logs.join('\n').includes(fixture.privateRoot), false);
    assert.equal(fixture.registry.diagnostics().activeCount, 0); assert.equal(fixture.registry.diagnostics().residualCount, 0);
  } finally { console.info = original.info; console.error = original.error; await fixture.registry.onStop(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('refuses a source-base race before transferring or creating a quarantine ref', {
  skip: process.platform === 'win32' ? 'The qualified execution controller is Linux-only' : false
}, async () => {
  const fixture = await setup('source-race'); await writeFile(path.join(fixture.privateRoot, 'candidate.txt'), 'candidate\n');
  git(fixture.binary, fixture.privateRoot, ['add', 'candidate.txt']); git(fixture.binary, fixture.privateRoot, ['commit', '-m', 'candidate']);
  const candidate = await fixture.sealer.seal(fixture.sealRequest);
  await writeFile(path.join(fixture.sourceRoot, 'source-race.txt'), 'race\n'); git(fixture.binary, fixture.sourceRoot, ['add', 'source-race.txt']); git(fixture.binary, fixture.sourceRoot, ['commit', '-m', 'source race']);
  try {
    await assert.rejects(() => fixture.importer.import({ ...fixture.importRequest, candidate }), (error: unknown) => error instanceof ImportError && error.code === 'IMPORT_SOURCE_CHANGED');
    assert.equal(git(fixture.binary, fixture.sourceRoot, ['for-each-ref', '--format=%(refname)', 'refs/kogg/quarantine']), '');
    assert.equal(fixture.registry.diagnostics().activeCount, 0); assert.equal(fixture.registry.diagnostics().residualCount, 0);
  } finally { await fixture.registry.onStop(); await rm(fixture.root, { recursive: true, force: true }); }
});

async function setup(name: string): Promise<{ root: string; sourceRoot: string; privateRoot: string; binary: string; registry: OperationRegistry; sealer: CandidateSealer; importer: CandidateImporter; sealRequest: SealCandidateV1; importRequest: Omit<ImportCandidateV1, 'candidate'> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `kogg-import-${name}-`)); const sourceRoot = path.join(root, 'source'); const allocation = path.join(root, 'allocation'); const privateRoot = path.join(allocation, 'private');
  const home = path.join(root, 'home'); const templateDirectory = path.join(root, 'template'); await Promise.all([mkdir(sourceRoot), mkdir(allocation), mkdir(home), mkdir(templateDirectory)]);
  const globalConfig = path.join(home, 'global.gitconfig'); await writeFile(globalConfig, '', { mode: 0o600 }); const binary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  git(binary, sourceRoot, ['init', '--initial-branch=main']); await writeFile(path.join(sourceRoot, 'base.txt'), 'base\n'); git(binary, sourceRoot, ['add', 'base.txt']); git(binary, sourceRoot, ['commit', '-m', 'base']);
  git(binary, root, ['clone', '--no-local', sourceRoot, privateRoot]); git(binary, privateRoot, ['remote', 'remove', 'origin']);
  const baseCommit = git(binary, sourceRoot, ['rev-parse', 'HEAD']); const baseTree = git(binary, sourceRoot, ['rev-parse', 'HEAD^{tree}']); const runId = '10000000-0000-4000-8000-000000000003';
  git(binary, privateRoot, ['switch', '-c', `kogg-run/${runId.replaceAll('-', '')}`]); git(binary, privateRoot, ['branch', '-D', 'main']);
  process.env.KOGG_STATE_DIR = path.join(root, 'state'); const registry = new OperationRegistry(); await registry.onStart();
  const runner = new ControllerGitRunner(binary, { home, globalConfig, templateDirectory }, 5_000, 20_000); const sealer = new CandidateSealer(registry, runner); const importer = new CandidateImporter(registry, runner);
  const ids = { projectId: '10000000-0000-4000-8000-000000000001', repositoryId: '10000000-0000-4000-8000-000000000002', runId, attemptId: '10000000-0000-4000-8000-000000000004', worktreeId: '10000000-0000-4000-8000-000000000005' };
  return { root, sourceRoot, privateRoot, binary, registry, sealer, importer,
    sealRequest: { projectId: ids.projectId, runId, attemptId: ids.attemptId, worktreeId: ids.worktreeId, privateRoot, baseCommit, baseTree, objectFormat: 'sha1', maximumTreeBytes: '1073741824' },
    importRequest: { projectId: ids.projectId, repositoryId: ids.repositoryId, sourceRoot, sourceGitDirectory: path.join(sourceRoot, '.git'), privateRoot, bundlePath: path.join(allocation, 'candidate.bundle'), expectedSourceHead: baseCommit, expectedSourceTree: baseTree, objectFormat: 'sha1' }
  };
}

function sourceState(binary: string, root: string): string { return [git(binary, root, ['symbolic-ref', 'HEAD']), git(binary, root, ['rev-parse', 'HEAD']), git(binary, root, ['rev-parse', 'HEAD^{tree}']), git(binary, root, ['status', '--porcelain=v2', '--untracked-files=all']), git(binary, root, ['config', '--local', '--list']), git(binary, root, ['for-each-ref', '--format=%(refname) %(objectname)'])].join('\n'); }
function git(binary: string, cwd: string, args: readonly string[]): string { return execFileSync(binary, ['-c', 'user.name=Kogg Test', '-c', 'user.email=kogg@example.invalid', ...args], { cwd, encoding: 'utf8', env: { PATH: path.dirname(binary), LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
