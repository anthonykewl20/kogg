import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalKernelJson,
  type KernelBridge,
  KernelBridgeToken,
  type KernelJson,
  type KernelResultV2,
  KOGG_RANEX_PROTOCOL,
  type RepositoryStateV1,
  type TaskBindingProjectionV1,
  type TaskExecutionBindingV1
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationRegistryApi, type ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import { TaskKernelBindingAuthority, type TaskAdmissionSnapshot, type TaskKernelBindingAuthority as TaskAuthority } from '@kogg/tasks/lib/common/tasks-protocol';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { Process, ProcessType, type IProcessExitEvent } from '@theia/process/lib/node/process';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { PassThrough, type Readable, type Writable } from 'node:stream';

// diagnostic-coverage: kernel.bindings, kernel.cleanup

@injectable()
export class KernelTaskBindingService {
  constructor(
    @inject(TaskKernelBindingAuthority) private readonly tasks: TaskAuthority,
    @inject(KernelBridgeToken) private readonly kernel: KernelBridge,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @inject(ProcessManager) private readonly processManager: ProcessManager,
    @inject(ILogger) @named('kogg:kernel:binding') private readonly logger: ILogger
  ) {}

  async bind(admission: TaskAdmissionSnapshot): Promise<KernelResultV2<TaskBindingProjectionV1>> {
    const operation = await this.operations.startOperation({
      kind: 'task', cancellable: true, absoluteTimeoutMs: 30_000,
      correlations: { taskId: admission.taskId, runId: admission.runId }
    });
    operation.start();
    this.logger.info('binding.started', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId });
    try {
      const authority = await this.tasks.resolveAdmission(admission);
      const root = fileURLToPath(authority.rootUri);
      const first = await this.measure(root, operation.registerProcess.bind(operation));
      const facts = await this.measure(root, operation.registerProcess.bind(operation));
      if (first.gitDirectory !== facts.gitDirectory || canonicalKernelJson(first.state as unknown as KernelJson) !== canonicalKernelJson(facts.state as unknown as KernelJson)) {
        throw new BindingRefusal('KERNEL_SUBJECT_STALE');
      }
      const expectedRepositoryIdentity = createHash('sha256')
        .update(`kogg-git-dir-v1\0${pathToFileURL(facts.gitDirectory).href}`, 'utf8').digest('hex');
      if (expectedRepositoryIdentity !== authority.repositoryIdentityDigest || !facts.state.isClean) {
        throw new BindingRefusal('KERNEL_REPOSITORY_MISMATCH');
      }
      const authorityDigest = domainDigest('authority', {
        approvalCreatedAt: authority.approvalCreatedAt, approvalDigest: authority.approvalDigest,
        approvalId: authority.approvalId, bindingRevision: authority.bindingRevision,
        projectId: authority.projectId, repositoryId: authority.repositoryId, runId: authority.runId,
        specificationDigest: authority.specificationDigest, taskId: authority.taskId, taskRevision: authority.taskRevision,
        authorizedAt: authority.authorizedAt, expiresAt: authority.expiresAt
      });
      if (Date.parse(authority.expiresAt) <= Date.now()) throw new BindingRefusal('KERNEL_AUTHORITY_INVALID');
      const binding: TaskExecutionBindingV1 = {
        taskId: authority.taskId, taskRevision: authority.taskRevision,
        specificationDigest: digest(authority.specificationDigest), approvalId: authority.approvalId,
        approvalDigest: digest(authority.approvalDigest), authorityDigest,
        projectId: authority.projectId, repositoryId: authority.repositoryId,
        repositoryIdentityDigest: digest(authority.repositoryIdentityDigest), protectedSource: facts.state,
        worktreeId: uuidFromDigest(facts.state.worktreeIdentity), worktreeIdentityDigest: facts.state.worktreeIdentity,
        baseState: facts.state, executionProfileDigest: sha256(Buffer.from(canonicalKernelJson(authority.executionProfileId), 'utf8')),
        expiresAt: authority.expiresAt
      };
      operation.active();
      const result = await this.kernel.bindTask(binding);
      await operation.cleanup();
      if (result.status === 'succeeded') {
        operation.complete();
        this.logger.info('binding.completed', { operationId: operation.id, taskId: authority.taskId, runId: authority.runId, safeCode: result.safeCode });
      } else {
        operation.fail('OPERATIONS_REFUSED', 'BindingRefusal');
        this.logger.warn('binding.failed', { operationId: operation.id, taskId: authority.taskId, runId: authority.runId, safeCode: result.safeCode });
      }
      return result;
    } catch (error) {
      await operation.cleanup().catch(() => undefined);
      operation.fail(error instanceof GitFailure ? 'PROCESS_EXIT_NONZERO' : 'OPERATIONS_REFUSED', errorName(error));
      const safeCode = error instanceof BindingRefusal ? error.safeCode : 'KERNEL_AUTHORITY_INVALID';
      this.logger.warn('binding.failed', { operationId: operation.id, taskId: admission.taskId, runId: admission.runId, safeCode, errorType: errorName(error) });
      return refused(safeCode);
    }
  }

  private async measure(root: string, register: (input: { kind: 'git'; owner: 'kogg-supervisor'; cancel: () => Promise<void> }) => ProcessLease): Promise<{ state: RepositoryStateV1; gitDirectory: string }> {
    const identity = await this.git(root, ['rev-parse', '--show-object-format', 'HEAD', 'HEAD^{tree}', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], register, 64 * 1024);
    const lines = identity.toString('utf8').trim().split(/\r?\n/gu);
    if (lines.length !== 6 || (lines[0] !== 'sha1' && lines[0] !== 'sha256')) throw new BindingRefusal('KERNEL_REPOSITORY_MISMATCH');
    const [objectFormat, commitObjectId, treeObjectId, rawGitDirectory, rawCommonDirectory, rawWorktree] = lines as [RepositoryStateV1['objectFormat'], string, string, string, string, string];
    const [gitDirectory, commonDirectory, worktree] = await Promise.all([realpath(rawGitDirectory), realpath(rawCommonDirectory), realpath(rawWorktree)]);
    if (worktree !== await realpath(root)) throw new BindingRefusal('KERNEL_REPOSITORY_MISMATCH');
    const [index, tracked, status] = await Promise.all([
      this.git(root, ['ls-files', '--stage', '-z'], register, 4 * 1024 * 1024),
      this.git(root, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], register, 4 * 1024 * 1024),
      this.git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=normal'], register, 1024 * 1024)
    ]);
    return {
      gitDirectory,
      state: {
        objectFormat, commitObjectId, treeObjectId,
        gitCommonDirectoryIdentity: opaqueIdentity('git-common-directory', pathToFileURL(commonDirectory).href),
        worktreeIdentity: opaqueIdentity('worktree', pathToFileURL(worktree).href),
        indexDigest: sha256(index), trackedContentDigest: sha256(tracked),
        untrackedPolicyDigest: sha256(Buffer.from('kogg:untracked-policy:v1\nrequire-none', 'utf8')),
        isClean: status.length === 0
      }
    };
  }

  private git(root: string, args: readonly string[], register: (input: { kind: 'git'; owner: 'kogg-supervisor'; cancel: () => Promise<void> }) => ProcessLease, limit: number): Promise<Buffer> {
    let managed: BindingGitProcess | undefined;
    const lease = register({ kind: 'git', owner: 'kogg-supervisor', cancel: async () => managed?.cancel() });
    managed = new BindingGitProcess(this.processManager, this.logger, lease, root, args, limit);
    return managed.result();
  }
}

class BindingGitProcess extends Process {
  private readonly child: ChildProcess;
  private readonly completion: Promise<Buffer>;
  private resolveCompletion: ((value: Buffer) => void) | undefined;
  private rejectCompletion: ((error: Error) => void) | undefined;
  private output = Buffer.alloc(0);
  private stderrBytes = 0;
  private terminal = false;
  readonly outputStream: Readable;
  readonly errorStream: Readable;
  readonly inputStream: Writable;

  constructor(processManager: ProcessManager, logger: ILogger, private readonly lease: ProcessLease, root: string, args: readonly string[], private readonly limit: number) {
    super(processManager, logger, ProcessType.Raw, { command: 'git', args: [], options: {} });
    this.completion = new Promise((resolve, reject) => { this.resolveCompletion = resolve; this.rejectCompletion = reject; });
    this.lease.spawning();
    this.child = spawn('git', [...args], {
      cwd: root, detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.outputStream = this.child.stdout!; this.errorStream = this.child.stderr!; this.inputStream = new PassThrough();
    if (this.child.pid) this.lease.started(this.child.pid);
    this.child.stdout!.on('data', chunk => {
      this.lease.activity(); this.output = Buffer.concat([this.output, Buffer.from(chunk)]);
      if (this.output.length > this.limit) this.finish(new GitFailure(), 'nonzero');
    });
    this.child.stderr!.on('data', chunk => { this.stderrBytes += chunk.length; if (this.stderrBytes > 64 * 1024) this.finish(new GitFailure(), 'nonzero'); });
    this.child.once('error', () => this.finish(new GitFailure(), 'nonzero'));
    this.child.once('close', (code, signal) => {
      if (this.terminal) return;
      if (code === 0) this.succeed(); else this.finish(new GitFailure(), signal ? 'signal' : 'nonzero');
    });
  }

  result(): Promise<Buffer> { return this.completion; }
  async cancel(): Promise<void> { if (!this.terminal) this.finish(new GitFailure(), 'signal'); await this.completion.catch(() => undefined); }
  get pid(): number { if (!this.child.pid) throw new GitFailure(); return this.child.pid; }
  kill(signal: string = 'SIGKILL'): void {
    if (this._killed) return;
    try { if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal as NodeJS.Signals); else this.child.kill(signal as NodeJS.Signals); }
    catch { /* observability-exempt: ESRCH is an already-exited owned Git process; cleanup remains deterministic. */ }
  }
  protected override handleOnExit(_event: IProcessExitEvent): void { this._killed = true; }
  protected override handleOnError(_error: Error): void { this._killed = true; }
  private succeed(): void { this.terminal = true; this._killed = true; this.lease.exited('zero'); this.cleanup(); this.resolveCompletion?.(this.output); }
  private finish(error: Error, exitClass: 'nonzero' | 'signal'): void {
    if (this.terminal) return; this.terminal = true; this.kill(); this._killed = true;
    this.lease.exited(exitClass); this.cleanup(); this.rejectCompletion?.(error);
  }
  private cleanup(): void { this.processManager.unregister(this); this.lease.cleanup(); }
}

class BindingRefusal extends Error { constructor(readonly safeCode: 'KERNEL_REPOSITORY_MISMATCH' | 'KERNEL_SUBJECT_STALE' | 'KERNEL_AUTHORITY_INVALID') { super(safeCode); } }
class GitFailure extends Error {}
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function sha256(value: Uint8Array): `sha256:${string}` { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function domainDigest(domain: string, value: KernelJson): `sha256:${string}` { return sha256(Buffer.concat([Buffer.from(`kogg:${domain}:v1\n`, 'utf8'), Buffer.from(canonicalKernelJson(value), 'utf8')])); }
function opaqueIdentity(domain: string, value: string): `sha256:${string}` { return sha256(Buffer.from(`kogg:${domain}:v1\n${value}`, 'utf8')); }
function digest(value: string): `sha256:${string}` { return value.startsWith('sha256:') ? value as `sha256:${string}` : `sha256:${value}`; }
function uuidFromDigest(value: `sha256:${string}`): string {
  const hex = value.slice(7, 39).split(''); hex[12] = '5'; hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}
function refused(safeCode: 'KERNEL_REPOSITORY_MISMATCH' | 'KERNEL_SUBJECT_STALE' | 'KERNEL_AUTHORITY_INVALID'): KernelResultV2<TaskBindingProjectionV1> {
  return { protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'refused', safeCode, resultDigest: null, journal: null, projection: null };
}
