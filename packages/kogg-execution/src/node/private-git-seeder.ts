import { createHash } from 'node:crypto';
import { lstat, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { OperationLease, OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { ExecutionGitCode } from '../common/execution-protocol';
import { ControllerGitRunner, GitRunError } from './controller-git-runner';

// The seeder transfers only the exact approved source HEAD through a controller bundle and proves the private store has no shared Git authority.
// diagnostic-coverage: execution.git-independence, execution.source-integrity, execution.process-cleanup
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface PrivateGitSeedRequest {
  readonly projectId: string; readonly repositoryId: string; readonly runId: string; readonly worktreeId: string;
  readonly sourceRoot: string; readonly sourceGitDirectory: string; readonly privateRoot: string; readonly bundlePath: string;
  readonly baseCommit: string; readonly baseTree: string; readonly objectFormat: 'sha1' | 'sha256';
}
export interface PrivateGitSeedResult { readonly baseCommit: string; readonly baseTree: string; readonly branchRefDigest: string; readonly alternateCount: 0; }
export interface PrivateGitSeedAuthority { seed(request: PrivateGitSeedRequest): Promise<PrivateGitSeedResult>; }

export class PrivateGitSeeder implements PrivateGitSeedAuthority {
  constructor(private readonly operations: OperationRegistryApi, private readonly git: ControllerGitRunner) {}

  async seed(request: PrivateGitSeedRequest): Promise<PrivateGitSeedResult> {
    validate(request);
    const operation = await this.operations.startOperation({
      kind: 'worktree', correlations: { projectId: request.projectId, runId: request.runId, worktreeId: request.worktreeId }
    });
    operation.start(); operation.active();
    console.info('[kogg:execution:git] seed.started', {
      operationId: operation.id, projectId: request.projectId, runId: request.runId, worktreeId: request.worktreeId
    });
    try {
      await absent(request.bundlePath); await absent(request.privateRoot);
      const sourceHead = text(await this.git.run(operation, 'source-head', request.sourceRoot, git(this.git, ['rev-parse', '--verify', 'HEAD'])));
      if (sourceHead !== request.baseCommit) throw new SeedError('GIT_BASE_CHANGED');
      const sourceTree = text(await this.git.run(operation, 'source-tree', request.sourceRoot, git(this.git, ['rev-parse', '--verify', 'HEAD^{tree}'])));
      if (sourceTree !== request.baseTree) throw new SeedError('GIT_SOURCE_INTEGRITY_FAILED');
      await this.git.run(operation, 'bundle-create', request.sourceRoot, git(this.git, ['bundle', 'create', request.bundlePath, 'HEAD']));
      await this.git.run(operation, 'private-init', path.dirname(request.privateRoot), git(this.git, ['init', `--template=${this.git.templateDirectory()}`, request.privateRoot]));
      await this.git.run(operation, 'private-fetch', request.privateRoot, git(this.git, ['fetch', '--no-tags', request.bundlePath, 'HEAD']));
      const ref = runRef(request.runId); const zero = '0'.repeat(request.objectFormat === 'sha1' ? 40 : 64);
      await this.git.run(operation, 'private-ref', request.privateRoot, git(this.git, ['update-ref', ref, request.baseCommit, zero]));
      await this.git.run(operation, 'private-ref', request.privateRoot, git(this.git, ['symbolic-ref', 'HEAD', ref]));
      await this.git.run(operation, 'private-checkout', request.privateRoot, git(this.git, ['reset', '--hard', request.baseCommit]));
      await unlink(path.join(request.privateRoot, '.git', 'FETCH_HEAD')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      await this.verify(operation, request, ref);
      await unlink(request.bundlePath);
      await operation.cleanup(); operation.complete();
      console.info('[kogg:execution:git] seed.completed', {
        operationId: operation.id, projectId: request.projectId, runId: request.runId, worktreeId: request.worktreeId, alternateCount: 0
      });
      return { baseCommit: request.baseCommit, baseTree: request.baseTree, branchRefDigest: digestRef(ref), alternateCount: 0 };
    } catch (error) {
      await unlink(request.bundlePath).catch(() => { // observability-exempt: Failure cleanup intentionally suppresses only deletion errors for an opaque temporary bundle.
        /* recovery handles any residual bundle in its private allocation */
      });
      await operation.cleanup().catch(() => { // observability-exempt: OperationRegistry already logs and blocks admission on cleanup failure.
        /* preserve the original closed Git failure */
      });
      operation.fail('PROCESS_EXIT_NONZERO', error instanceof Error ? error.name : 'UnknownError');
      const code = error instanceof SeedError || error instanceof GitRunError ? error.code : 'GIT_SEED_FAILED';
      console.error('[kogg:execution:git] seed.failed', {
        operationId: operation.id, projectId: request.projectId, runId: request.runId, worktreeId: request.worktreeId,
        safeCode: code, errorType: error instanceof Error ? error.name : 'UnknownError'
      });
      throw new SeedError(code);
    }
  }

  private async verify(operation: OperationLease, request: PrivateGitSeedRequest, ref: string): Promise<void> {
    const [head, tree, format, remotes, heads, configNames] = await Promise.all([
      this.git.run(operation, 'private-verify', request.privateRoot, git(this.git, ['rev-parse', '--verify', 'HEAD'])),
      this.git.run(operation, 'private-verify', request.privateRoot, git(this.git, ['rev-parse', '--verify', 'HEAD^{tree}'])),
      this.git.run(operation, 'private-verify', request.privateRoot, git(this.git, ['rev-parse', '--show-object-format'])),
      this.git.run(operation, 'private-verify', request.privateRoot, git(this.git, ['remote'])),
      this.git.run(operation, 'private-verify', request.privateRoot, git(this.git, ['for-each-ref', '--format=%(refname)', 'refs/heads'])),
      this.git.run(operation, 'private-verify', request.privateRoot, git(this.git, ['config', '--local', '--null', '--name-only', '--list']))
    ]);
    const requiredConfigNames = ['core.bare', 'core.filemode', 'core.logallrefupdates', 'core.repositoryformatversion',
      ...(request.objectFormat === 'sha256' ? ['extensions.objectformat'] : [])];
    const allowedConfigNames = new Set([...requiredConfigNames, 'core.ignorecase', 'core.precomposeunicode']);
    const actualConfigNames = configNames.toString('utf8').split('\0').filter(Boolean).sort();
    if (text(head) !== request.baseCommit || text(tree) !== request.baseTree || text(format) !== request.objectFormat
      || text(remotes) || text(heads) !== ref || actualConfigNames.some(name => !allowedConfigNames.has(name))
      || requiredConfigNames.some(name => !actualConfigNames.includes(name))) throw new SeedError('GIT_INDEPENDENCE_FAILED');
    await this.git.run(operation, 'private-verify', request.privateRoot, git(this.git, ['fsck', '--strict', '--full', '--no-reflogs']));
    try { await lstat(path.join(request.privateRoot, '.git', 'objects', 'info', 'alternates')); throw new SeedError('GIT_INDEPENDENCE_FAILED'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const [sourceObjects, privateObjects] = await Promise.all([
      stat(path.join(request.sourceGitDirectory, 'objects')), stat(path.join(request.privateRoot, '.git', 'objects'))
    ]);
    if (sourceObjects.dev === privateObjects.dev && sourceObjects.ino === privateObjects.ino) throw new SeedError('GIT_INDEPENDENCE_FAILED');
  }
}

export class SeedError extends Error { constructor(readonly code: ExecutionGitCode) { super(code); this.name = 'SeedError'; } }

function validate(value: PrivateGitSeedRequest): void {
  const object = value.objectFormat === 'sha1' ? SHA1 : SHA256;
  if (![value.projectId, value.repositoryId, value.runId, value.worktreeId].every(id => UUID.test(id))
    || !object.test(value.baseCommit) || !object.test(value.baseTree)
    || ![value.sourceRoot, value.sourceGitDirectory, value.privateRoot, value.bundlePath].every(item => path.isAbsolute(item))
    || value.sourceRoot === value.privateRoot || within(value.sourceRoot, value.privateRoot) || within(value.sourceRoot, value.bundlePath)
    || within(value.sourceGitDirectory, value.bundlePath) || path.dirname(value.privateRoot) !== path.dirname(value.bundlePath)) throw new SeedError('GIT_SEED_FAILED');
}
function git(runner: ControllerGitRunner, args: readonly string[]): readonly string[] { return runner.protectedArguments(args); }
function text(value: Buffer): string { return value.toString('utf8').trim(); }
function runRef(runId: string): string { return `refs/heads/kogg-run/${runId.replaceAll('-', '')}`; }
function digestRef(ref: string): string { return `sha256:${createHash('sha256').update(`kogg-execution-ref-v1\0${ref}`).digest('hex')}`; }
async function absent(value: string): Promise<void> {
  try { await lstat(value); throw new SeedError('GIT_SEED_FAILED'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function within(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
