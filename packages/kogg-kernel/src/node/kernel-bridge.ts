import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  KernelBridge,
  KernelCapabilities,
  KernelEvaluationRequest,
  KernelExecutionQualification,
  KernelHealth,
  KOGG_RANEX_COMMIT,
  KOGG_RANEX_PROTOCOL,
  KOGG_RANEX_PROTOCOL_VERSION
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationLease, type OperationRegistryApi, type ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { Process, ProcessType, type IProcessExitEvent } from '@theia/process/lib/node/process';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { PassThrough, type Readable, type Writable } from 'node:stream';

// diagnostic-coverage: kernel.health, kernel.journal

interface RpcResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

@injectable()
export class KernelBridgeImpl implements KernelBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private state: 'stopped' | 'starting' | 'ready' | 'failed' = 'stopped';
  private cachedCapabilities: KernelCapabilities | undefined;
  private operation: OperationLease | undefined;
  private processLease: ProcessLease | undefined;
  private managed: KoggKernelProcess | undefined;
  private expectedExit = false;
  private externallyCancelling = false;
  private exitHandled: Promise<void> = Promise.resolve();
  private resolveExit: (() => void) | undefined;
  private readonly root = process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd();

  constructor(
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @inject(ProcessManager) private readonly processManager: ProcessManager,
    @inject(ILogger) @named('kogg:kernel:bridge') private readonly logger: ILogger
  ) {}

  async start(): Promise<KernelCapabilities> {
    if (this.state === 'ready' && this.cachedCapabilities) return this.cachedCapabilities;
    if (this.state === 'starting') throw new Error('Ranex kernel startup is already in progress');
    this.state = 'starting';
    this.operation = await this.operations.startOperation({ kind: 'ranex-bridge', cancellable: false });
    this.operation.start();

    const runtime = this.runtimePaths();
    const python = process.env.KOGG_PYTHON ?? runtime.python;
    const { adapter, ranexSource, provenance } = runtime;
    if (!existsSync(python) || !existsSync(adapter) || !existsSync(provenance)) {
      this.state = 'failed';
      await this.operation.cleanup();
      this.operation.fail('OWNER_UNAVAILABLE', 'Error');
      throw new Error('Bundled Ranex runtime is incomplete; governed operations are unavailable');
    }
    mkdirSync(runtime.workingDirectory, { recursive: true, mode: 0o700 });

    this.processLease = this.operation.registerProcess({
      kind: 'ranex-kernel', owner: 'ranex',
      cancel: async () => { this.externallyCancelling = true; await this.terminateChild(); await this.exitHandled; }
    });
    this.processLease.spawning();
    this.managed = new KoggKernelProcess(this.processManager, this.logger, python, ['-u', adapter], {
      cwd: runtime.workingDirectory,
      env: {
        PATH: process.env.PATH ?? '',
        PYTHONPATH: ranexSource,
        KOGG_RANEX_JOURNAL: process.env.KOGG_RANEX_JOURNAL ?? path.join(this.stateRoot(), 'ranex', 'journal.sqlite3'),
        KOGG_RANEX_PROVENANCE: provenance
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = this.managed.child;
    if (!this.child.pid) throw new Error('Ranex kernel did not return a process identity');
    this.processLease.started(this.child.pid);
    this.exitHandled = new Promise(resolve => { this.resolveExit = resolve; });

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', line => this.receive(line));
    let stderrBytes = 0;
    this.child.stderr.on('data', data => {
      stderrBytes += data.length;
      this.processLease?.activity();
      if (stderrBytes > 64 * 1024) void this.terminateChild();
    });
    this.child.once('exit', (code, signal) => this.onExit(code, signal));

    try {
      const capabilities = await this.handshake();
      this.assertCompatible(capabilities);
      this.cachedCapabilities = capabilities;
      this.state = 'ready';
      this.processLease.ready();
      this.operation.active();
      return capabilities;
    } catch (error) {
      this.state = 'failed';
      this.processLease.failed('PROCESS_READINESS_FAILED', error instanceof Error ? error.name : 'UnknownError');
      if (this.managed) {
        await this.terminateChild();
        await this.exitHandled;
      } else {
        this.processLease.cleanup();
        await this.operation.cleanup();
        this.operation.fail('PROCESS_READINESS_FAILED', error instanceof Error ? error.name : 'UnknownError');
        this.operation = undefined; this.processLease = undefined;
      }
      throw error;
    }
  }

  handshake(): Promise<KernelCapabilities> {
    return this.request<KernelCapabilities>('handshake', {
      protocol: KOGG_RANEX_PROTOCOL,
      protocolVersion: KOGG_RANEX_PROTOCOL_VERSION,
      ranexCommit: KOGG_RANEX_COMMIT
    }, true);
  }

  health(): Promise<KernelHealth> {
    return this.request<KernelHealth>('health', {});
  }

  async capabilities(): Promise<KernelCapabilities> {
    if (!this.cachedCapabilities) await this.start();
    if (!this.cachedCapabilities) throw new Error('Ranex capabilities are unavailable');
    return this.cachedCapabilities;
  }

  evaluate(evaluation: KernelEvaluationRequest): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('evaluate', evaluation);
  }

  qualifyExecution(targetId: string): Promise<KernelExecutionQualification> {
    return this.request<KernelExecutionQualification>('execution.qualify', { targetId });
  }

  verifyJournal(): Promise<{ readonly valid: boolean; readonly reason?: string }> {
    return this.request('journal.verify', {});
  }

  listVerdicts(): Promise<readonly Record<string, unknown>[]> {
    return this.request('verdict.list', {});
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    this.expectedExit = true;
    try {
      await this.request('shutdown', {}, true);
    } finally {
      await this.terminateChild();
      await this.exitHandled;
    }
  }

  private runtimePaths(): { python: string; adapter: string; ranexSource: string; provenance: string; workingDirectory: string } {
    const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const packagedRoot = process.env.KOGG_PACKAGED_RUNTIME
      ?? (electronResources ? path.join(electronResources, 'kogg-runtime') : undefined);
    if (packagedRoot && existsSync(packagedRoot)) {
      return {
        python: process.platform === 'win32'
          ? path.join(packagedRoot, 'python', 'python.exe')
          : path.join(packagedRoot, 'python', 'bin', 'python3.12'),
        adapter: path.join(packagedRoot, 'adapter', 'kogg_ranex_adapter.py'),
        ranexSource: path.join(packagedRoot, 'ranex', 'src'),
        provenance: path.join(packagedRoot, 'ranex', 'PROVENANCE.json'),
        workingDirectory: this.stateRoot()
      };
    }
    return {
      python: process.platform === 'win32'
        ? path.join(this.root, '.venv', 'Scripts', 'python.exe')
        : path.join(this.root, '.venv', 'bin', 'python'),
      adapter: path.join(this.root, 'packages', 'kogg-kernel', 'python', 'kogg_ranex_adapter.py'),
      ranexSource: path.join(this.root, 'vendor', 'ranex', 'src'),
      provenance: path.join(this.root, 'vendor', 'ranex', 'PROVENANCE.json'),
      workingDirectory: this.root
    };
  }

  private stateRoot(): string {
    return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(this.root, '.kogg', 'state'));
  }

  private request<T>(method: string, params: unknown, allowStarting = false): Promise<T> {
    if (!this.child || (!allowStarting && this.state !== 'ready')) {
      return Promise.reject(new Error('Ranex kernel is not ready; operation refused'));
    }
    const id = `kogg-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Ranex request ${method} exceeded its 15 second bound`));
      }, 15_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.processLease?.activity();
      this.child?.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private receive(line: string): void {
    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch (error) {
      console.error('[kogg:kernel:bridge] protocol-response.invalid', {
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
      this.failAll(new Error('Ranex emitted malformed protocol output'));
      this.child?.kill();
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    this.processLease?.activity();
    if (response.error) pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
    else pending.resolve(response.result);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = this.expectedExit;
    const externallyCancelling = this.externallyCancelling;
    this.processLease?.exited(signal ? 'signal' : code === 0 ? 'zero' : 'nonzero');
    this.processLease?.cleanup();
    this.child = undefined;
    this.managed = undefined;
    this.cachedCapabilities = undefined;
    this.state = expected ? 'stopped' : 'failed';
    this.failAll(new Error(`Ranex kernel exited (${signal ?? code ?? 'unknown'}); governed operations are blocked`));
    const operation = this.operation;
    this.operation = undefined; this.processLease = undefined; this.expectedExit = false; this.externallyCancelling = false;
    if (externallyCancelling) {
      this.resolveExit?.();
    } else {
      void operation?.cleanup().then(() => {
        if (expected) operation.complete(); else operation.fail(signal ? 'PROCESS_SIGNALLED' : 'PROCESS_EXIT_NONZERO', 'Error');
      }).catch(error => console.error('[kogg:kernel:bridge] cleanup.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' })).finally(() => this.resolveExit?.());
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private assertCompatible(capabilities: KernelCapabilities): void {
    if (
      capabilities.protocol !== KOGG_RANEX_PROTOCOL ||
      capabilities.protocolVersion !== KOGG_RANEX_PROTOCOL_VERSION ||
      capabilities.ranexCommit !== KOGG_RANEX_COMMIT
    ) {
      throw new Error('Ranex protocol or revision mismatch; governed operations are blocked');
    }
  }

  private async terminateChild(): Promise<void> {
    const managed = this.managed;
    if (!managed || managed.killed) return;
    managed.kill('SIGTERM');
    const deadline = Date.now() + 2_000;
    while (!managed.killed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!managed.killed) managed.kill('SIGKILL');
  }
}

class KoggKernelProcess extends Process {
  readonly child: ChildProcessWithoutNullStreams;
  readonly outputStream: Readable;
  readonly errorStream: Readable;
  readonly inputStream: Writable;
  constructor(processManager: ProcessManager, logger: ILogger, command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) {
    super(processManager, logger, ProcessType.Raw, { command: 'ranex-kernel', args: [], options: {} });
    try {
      this.child = spawn(command, [...args], options) as ChildProcessWithoutNullStreams;
      this.outputStream = this.child.stdout; this.errorStream = this.child.stderr; this.inputStream = this.child.stdin;
      this.child.once('error', error => { this._killed = true; this.processManager.unregister(this); console.error('[kogg:kernel:bridge] process.failed', { errorType: error.name }); });
      this.child.once('exit', () => { this._killed = true; this.processManager.unregister(this); });
    } catch (error) {
      const empty = new PassThrough(); this.outputStream = empty; this.errorStream = empty; this.inputStream = empty;
      this.child = undefined as unknown as ChildProcessWithoutNullStreams;
      this._killed = true; this.processManager.unregister(this);
      throw error;
    }
  }
  get pid(): number { if (!this.child.pid) throw new Error('Ranex kernel did not start'); return this.child.pid; }
  kill(signal: string = 'SIGKILL'): void {
    if (this._killed) return;
    try { if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal as NodeJS.Signals); else this.child.kill(signal as NodeJS.Signals); }
    catch { /* observability-exempt: ESRCH means the owned child already exited and the exit listener records cleanup. */ }
  }
  protected override handleOnExit(_event: IProcessExitEvent): void { this._killed = true; }
  protected override handleOnError(_error: Error): void { this._killed = true; }
}
