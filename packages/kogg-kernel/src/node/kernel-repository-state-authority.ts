import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { canonicalKernelJson, type KernelJson, type RepositoryStateV1 } from '@kogg/contracts';
import type { ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { Process, ProcessType, type IProcessExitEvent } from '@theia/process/lib/node/process';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { PassThrough, type Readable, type Writable } from 'node:stream';

// diagnostic-coverage: kernel.bindings, kernel.evidence, kernel.cleanup

export interface RepositoryMeasurement { readonly state: RepositoryStateV1; readonly gitDirectory: string; }
type RegisterGit = (input: { kind: 'git'; owner: 'kogg-supervisor'; cancel: () => Promise<void> }) => ProcessLease;

@injectable()
export class KernelRepositoryStateAuthority {
  constructor(
    @inject(ProcessManager) private readonly processManager: ProcessManager,
    @inject(ILogger) @named('kogg:kernel:repository') private readonly logger: ILogger
  ) {}

  async stable(root: string, register: RegisterGit): Promise<RepositoryMeasurement> {
    const first = await this.measure(root, register); const second = await this.measure(root, register);
    if (first.gitDirectory !== second.gitDirectory || canonicalKernelJson(first.state as unknown as KernelJson) !== canonicalKernelJson(second.state as unknown as KernelJson)) {
      throw new RepositoryRefusal('KERNEL_SUBJECT_STALE');
    }
    return second;
  }

  private async measure(root: string, register: RegisterGit): Promise<RepositoryMeasurement> {
    const identity = await this.git(root, ['rev-parse', '--show-object-format', 'HEAD', 'HEAD^{tree}', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], register, 64 * 1024);
    const lines = identity.toString('utf8').trim().split(/\r?\n/gu);
    if (lines.length !== 6 || (lines[0] !== 'sha1' && lines[0] !== 'sha256')) throw new RepositoryRefusal('KERNEL_REPOSITORY_MISMATCH');
    const [objectFormat, commitObjectId, treeObjectId, rawGitDirectory, rawCommonDirectory, rawWorktree] = lines as [RepositoryStateV1['objectFormat'], string, string, string, string, string];
    const [gitDirectory, commonDirectory, worktree] = await Promise.all([realpath(rawGitDirectory), realpath(rawCommonDirectory), realpath(rawWorktree)]);
    if (worktree !== await realpath(root)) throw new RepositoryRefusal('KERNEL_REPOSITORY_MISMATCH');
    const [index, tracked, status] = await Promise.all([
      this.git(root, ['ls-files', '--stage', '-z'], register, 4 * 1024 * 1024),
      this.git(root, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], register, 4 * 1024 * 1024),
      this.git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=normal'], register, 1024 * 1024)
    ]);
    return { gitDirectory, state: {
      objectFormat, commitObjectId, treeObjectId,
      gitCommonDirectoryIdentity: opaqueIdentity('git-common-directory', pathToFileURL(commonDirectory).href),
      worktreeIdentity: opaqueIdentity('worktree', pathToFileURL(worktree).href), indexDigest: sha256(index),
      trackedContentDigest: sha256(tracked), untrackedPolicyDigest: sha256(Buffer.from('kogg:untracked-policy:v1\nrequire-none', 'utf8')),
      isClean: status.length === 0
    } };
  }

  private git(root: string, args: readonly string[], register: RegisterGit, limit: number): Promise<Buffer> {
    let managed: RepositoryGitProcess | undefined;
    const lease = register({ kind: 'git', owner: 'kogg-supervisor', cancel: async () => managed?.cancel() });
    managed = new RepositoryGitProcess(this.processManager, this.logger, lease, root, args, limit);
    return managed.result();
  }
}

class RepositoryGitProcess extends Process {
  private readonly child: ChildProcess; private readonly completion: Promise<Buffer>;
  private resolveCompletion: ((value: Buffer) => void) | undefined; private rejectCompletion: ((error: Error) => void) | undefined;
  private output = Buffer.alloc(0); private stderrBytes = 0; private terminal = false;
  readonly outputStream: Readable; readonly errorStream: Readable; readonly inputStream: Writable;
  constructor(processManager: ProcessManager, logger: ILogger, private readonly lease: ProcessLease, root: string, args: readonly string[], private readonly limit: number) {
    super(processManager, logger, ProcessType.Raw, { command: 'git', args: [], options: {} });
    this.completion = new Promise((resolve, reject) => { this.resolveCompletion = resolve; this.rejectCompletion = reject; }); this.lease.spawning();
    this.child = spawn('git', [...args], { cwd: root, detached: process.platform !== 'win32', env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.outputStream = this.child.stdout!; this.errorStream = this.child.stderr!; this.inputStream = new PassThrough();
    if (this.child.pid) this.lease.started(this.child.pid);
    this.child.stdout!.on('data', chunk => { this.lease.activity(); this.output = Buffer.concat([this.output, Buffer.from(chunk)]); if (this.output.length > this.limit) this.finish(new GitFailure(), 'nonzero'); });
    this.child.stderr!.on('data', chunk => { this.stderrBytes += chunk.length; if (this.stderrBytes > 64 * 1024) this.finish(new GitFailure(), 'nonzero'); });
    this.child.once('error', () => this.finish(new GitFailure(), 'nonzero'));
    this.child.once('close', (code, signal) => { if (!this.terminal) code === 0 ? this.succeed() : this.finish(new GitFailure(), signal ? 'signal' : 'nonzero'); });
  }
  result(): Promise<Buffer> { return this.completion; }
  async cancel(): Promise<void> { if (!this.terminal) this.finish(new GitFailure(), 'signal'); await this.completion.catch(() => undefined); }
  get pid(): number { if (!this.child.pid) throw new GitFailure(); return this.child.pid; }
  kill(signal: string = 'SIGKILL'): void { if (this._killed) return; try { if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal as NodeJS.Signals); else this.child.kill(signal as NodeJS.Signals); } catch { /* observability-exempt: ESRCH proves the owned Git process has already exited. */ } }
  protected override handleOnExit(_event: IProcessExitEvent): void { this._killed = true; }
  protected override handleOnError(_error: Error): void { this._killed = true; }
  private succeed(): void { this.terminal = true; this._killed = true; this.lease.exited('zero'); this.cleanup(); this.resolveCompletion?.(this.output); }
  private finish(error: Error, exitClass: 'nonzero' | 'signal'): void { if (this.terminal) return; this.terminal = true; this.kill(); this._killed = true; this.lease.exited(exitClass); this.cleanup(); this.rejectCompletion?.(error); }
  private cleanup(): void { this.processManager.unregister(this); this.lease.cleanup(); }
}

export class RepositoryRefusal extends Error { constructor(readonly safeCode: 'KERNEL_REPOSITORY_MISMATCH' | 'KERNEL_SUBJECT_STALE') { super(safeCode); } }
export class GitFailure extends Error {}
function sha256(value: Uint8Array): `sha256:${string}` { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function opaqueIdentity(domain: string, value: string): `sha256:${string}` { return sha256(Buffer.from(`kogg:${domain}:v1\n${value}`, 'utf8')); }
