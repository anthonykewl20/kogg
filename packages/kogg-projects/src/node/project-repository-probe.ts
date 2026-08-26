import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { ILogger } from '@theia/core/lib/common/logger';
import { KoggOperationRegistry, type OperationRegistryApi, type ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import { inject, injectable, named, unmanaged } from '@theia/core/shared/inversify';
import { Process, ProcessType, type IProcessExitEvent } from '@theia/process/lib/node/process';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { ProjectError } from './project-errors';

// diagnostic-coverage: projects.repositories, projects.processes

export interface RepositoryProbeResult {
  readonly rootUri: string;
  readonly gitDirUri: string;
  readonly identityDigest: string;
}

@injectable()
export class ProjectRepositoryProbe {
  private readonly active = new Map<string, KoggGitProcess>();

  constructor(
    @inject(ProcessManager) private readonly processManager: ProcessManager,
    @inject(ILogger) @named('kogg:projects:git') private readonly logger: ILogger,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @unmanaged() private readonly timeoutMs = 10_000
  ) {}

  async probe(repositoryPath: string, operationId: string, repositoryId: string = randomUUID()): Promise<RepositoryProbeResult> {
    console.info('[kogg:projects:git] repository.validate.requested', { operationId, repositoryId });
    let managed: KoggGitProcess | undefined;
    const operation = await this.operations.startOperation({ id: operationId, kind: 'repository-probe' });
    operation.start();
    const processLease = operation.registerProcess({ kind: 'git', owner: 'kogg-supervisor', cancel: async () => managed?.cancel() });
    try {
      const canonicalRepositoryPath = await realpath(repositoryPath);
      managed = new KoggGitProcess(this.processManager, this.logger, processLease, canonicalRepositoryPath, operationId, repositoryId, this.timeoutMs);
      this.active.set(operationId, managed);
      const output = await managed.result();
      operation.active();
      const lines = output.trim().split(/\r?\n/gu);
      if (lines.length !== 4 || lines[2] !== 'false' || lines[3] !== 'true') {
        throw new ProjectError(
          lines[2] === 'true' ? 'PROJECT_REPOSITORY_BARE_UNSUPPORTED' : 'PROJECT_REPOSITORY_OUTPUT_INVALID',
          'Select a supported non-bare Git worktree.'
        );
      }
      const [rawRoot, rawGitDir] = lines;
      if (!rawRoot || !rawGitDir) throw new ProjectError('PROJECT_REPOSITORY_OUTPUT_INVALID', 'Git returned incomplete repository identity.');
      const [root, gitDir] = await Promise.all([realpath(rawRoot), realpath(rawGitDir)]);
      const rootUri = pathToFileURL(root).href;
      const gitDirUri = pathToFileURL(gitDir).href;
      const identityDigest = createHash('sha256').update(`kogg-git-dir-v1\0${gitDirUri}`, 'utf8').digest('hex');
      await operation.cleanup(); operation.complete();
      return { rootUri, gitDirUri, identityDigest };
    } catch (error) {
      await operation.cleanup().catch(() => undefined);
      operation.fail(error instanceof ProjectError && error.code === 'PROJECT_REPOSITORY_PROBE_TIMEOUT'
        ? 'OPERATION_ABSOLUTE_TIMEOUT' : 'PROCESS_EXIT_NONZERO', error instanceof Error ? error.name : 'UnknownError');
      if (error instanceof ProjectError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ProjectError('PROJECT_REPOSITORY_PATH_MISSING', 'The selected repository is unavailable.', { cause: error });
      throw new ProjectError('PROJECT_REPOSITORY_PROBE_FAILED', 'Kogg could not validate the selected Git repository.', { cause: error });
    } finally {
      this.active.delete(operationId);
    }
  }

  activeCount(): number { return this.active.size; }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.values()].map(process => process.cancel()));
  }
}

class KoggGitProcess extends Process {
  private readonly child: ChildProcess | undefined;
  private stdout = '';
  private stderrBytes = 0;
  private readonly completion: Promise<string>;
  private settle: ((output: string) => void) | undefined;
  private fail: ((error: Error) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private terminal = false;

  readonly outputStream: Readable;
  readonly errorStream: Readable;
  readonly inputStream: Writable;

  constructor(
    processManager: ProcessManager,
    logger: ILogger,
    private readonly processLease: ProcessLease,
    repositoryPath: string,
    private readonly operationId: string,
    private readonly repositoryId: string,
    private readonly timeoutMs: number
  ) {
    super(processManager, logger, ProcessType.Raw, { command: 'git', args: [], options: {} });
    console.info('[kogg:projects:git] repository.process.registered', { operationId, repositoryId, processRegistrationId: this.id });
    this.completion = new Promise<string>((resolve, reject) => { this.settle = resolve; this.fail = reject; });
    try {
      this.processLease.spawning();
      this.child = spawn('git', [
        'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir',
        '--is-bare-repository', '--is-inside-work-tree'
      ], {
        cwd: path.resolve(repositoryPath),
        detached: process.platform !== 'win32',
        env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.outputStream = this.child.stdout!;
      this.errorStream = this.child.stderr!;
      this.inputStream = new PassThrough();
      if (this.child.pid) this.processLease.started(this.child.pid);
      this.attach();
    } catch (error) {
      // observability-exempt: The asynchronously scheduled terminal handler emits the spawn failure after listeners can attach.
      const empty = new PassThrough();
      this.outputStream = empty; this.errorStream = empty; this.inputStream = empty;
      process.nextTick(() => {
        this.processLease.failed('PROCESS_SPAWN_FAILED', error instanceof Error ? error.name : 'UnknownError');
        this.finalizeFailure(new ProjectError('PROJECT_REPOSITORY_PROBE_FAILED', 'Git could not start.', { cause: error }));
      });
    }
  }

  get pid(): number {
    if (!this.child?.pid) throw new ProjectError('PROJECT_REPOSITORY_PROBE_FAILED', 'Git did not start.');
    return this.child.pid;
  }

  result(): Promise<string> { return this.completion; }

  async cancel(): Promise<void> {
    if (!this.terminal) {
      this.finishFailure(new ProjectError('PROJECT_REPOSITORY_PROBE_CANCELLED', 'Git validation was cancelled.'), 'cancelled');
      await this.completion.catch(() => undefined);
    }
  }

  kill(signal: string = 'SIGKILL'): void {
    if (!this.child || this._killed) return;
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal as NodeJS.Signals);
      else this.child.kill(signal as NodeJS.Signals);
    } catch {
      // observability-exempt: ESRCH means the process already exited; close/exit handlers provide the terminal evidence.
    }
  }

  protected override handleOnExit(_event: IProcessExitEvent): void { this._killed = true; }
  protected override handleOnError(_error: Error): void { this._killed = true; }

  private attach(): void {
    console.info('[kogg:projects:git] repository.validate.started', {
      operationId: this.operationId,
      repositoryId: this.repositoryId,
      processRegistrationId: this.id
    });
    this.outputStream.on('data', chunk => {
      this.processLease.activity();
      this.stdout += String(chunk);
      if (Buffer.byteLength(this.stdout) > 16 * 1024) this.finishFailure(new ProjectError('PROJECT_REPOSITORY_OUTPUT_INVALID', 'Git output exceeded its bound.'));
    });
    this.errorStream.on('data', chunk => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 16 * 1024) this.finishFailure(new ProjectError('PROJECT_REPOSITORY_OUTPUT_INVALID', 'Git output exceeded its bound.'));
    });
    this.child!.once('error', error => {
      this.processLease.failed('PROCESS_SPAWN_FAILED', error.name);
      this.finishFailure(new ProjectError('PROJECT_REPOSITORY_PROBE_FAILED', 'Git failed to start.', { cause: error }));
    });
    this.child!.once('close', (code, signal) => {
      if (this.terminal) return;
      if (code === 0) {
        this.terminal = true;
        this._killed = true;
        console.info('[kogg:projects:git] repository.validate.completed', {
          operationId: this.operationId, repositoryId: this.repositoryId, processRegistrationId: this.id, exitClass: 'zero'
        });
        this.settle?.(this.stdout);
        this.processLease.exited('zero');
        this.cleanup();
      } else {
        this.finishFailure(new ProjectError('PROJECT_REPOSITORY_NOT_GIT', 'Select a valid Git worktree.'), signal ? 'signal' : 'nonzero');
      }
    });
    this.timer = setTimeout(() => {
      if (this.terminal) return;
      this.finishFailure(new ProjectError('PROJECT_REPOSITORY_PROBE_TIMEOUT', 'Git validation timed out.'), 'timeout');
    }, this.timeoutMs);
  }

  private finishFailure(error: Error, exitClass = 'failure'): void {
    if (this.terminal) return;
    this.terminal = true;
    this.kill();
    const finalize = () => this.finalizeFailure(error, exitClass);
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) finalize();
    else this.child.once('close', finalize);
  }

  private finalizeFailure(error: Error, exitClass = 'failure'): void {
    this.terminal = true;
    this._killed = true;
    const fields = {
      operationId: this.operationId, repositoryId: this.repositoryId,
      processRegistrationId: this.id, exitClass, errorType: error.name
    };
    if (error instanceof ProjectError && error.code === 'PROJECT_REPOSITORY_PROBE_TIMEOUT') {
      console.warn('[kogg:projects:git] repository.validate.timeout', fields);
    } else if (error instanceof ProjectError && error.code === 'PROJECT_REPOSITORY_PROBE_CANCELLED') {
      console.warn('[kogg:projects:git] repository.validate.cancelled', fields);
    } else {
      console.error('[kogg:projects:git] repository.validate.failed', fields);
    }
    this.fail?.(error);
    this.processLease.exited(exitClass === 'signal' || exitClass === 'timeout' || exitClass === 'cancelled' ? 'signal' : 'nonzero');
    this.cleanup();
  }

  private cleanup(): void {
    if (this.timer) clearTimeout(this.timer);
    console.info('[kogg:projects:git] repository.process.cleanup.started', {
      operationId: this.operationId, repositoryId: this.repositoryId, processRegistrationId: this.id
    });
    this.processManager.unregister(this);
    this.processLease.cleanup();
    console.info('[kogg:projects:git] repository.process.cleanup.completed', {
      operationId: this.operationId, repositoryId: this.repositoryId, processRegistrationId: this.id
    });
  }
}
