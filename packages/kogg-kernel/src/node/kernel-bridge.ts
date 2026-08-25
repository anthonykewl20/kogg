import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  KernelBridge,
  KernelCapabilities,
  KernelEvaluationRequest,
  KernelHealth,
  KOGG_RANEX_COMMIT,
  KOGG_RANEX_PROTOCOL,
  KOGG_RANEX_PROTOCOL_VERSION
} from '@kogg/contracts';
import { injectable } from '@theia/core/shared/inversify';

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
  private readonly root = process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd();

  async start(): Promise<KernelCapabilities> {
    if (this.state === 'ready' && this.cachedCapabilities) return this.cachedCapabilities;
    if (this.state === 'starting') throw new Error('Ranex kernel startup is already in progress');
    this.state = 'starting';

    const runtime = this.runtimePaths();
    const python = process.env.KOGG_PYTHON ?? runtime.python;
    const { adapter, ranexSource, provenance } = runtime;
    if (!existsSync(python) || !existsSync(adapter) || !existsSync(provenance)) {
      this.state = 'failed';
      throw new Error('Bundled Ranex runtime is incomplete; governed operations are unavailable');
    }
    mkdirSync(runtime.workingDirectory, { recursive: true, mode: 0o700 });

    this.child = spawn(python, ['-u', adapter], {
      cwd: runtime.workingDirectory,
      env: {
        PATH: process.env.PATH ?? '',
        PYTHONPATH: ranexSource,
        KOGG_RANEX_JOURNAL: process.env.KOGG_RANEX_JOURNAL ?? path.join(this.stateRoot(), 'ranex', 'journal.sqlite3'),
        KOGG_RANEX_PROVENANCE: provenance
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', line => this.receive(line));
    this.child.stderr.on('data', data => process.stderr.write(`[ranex] ${String(data)}`));
    this.child.once('exit', (code, signal) => this.onExit(code, signal));

    try {
      const capabilities = await this.handshake();
      this.assertCompatible(capabilities);
      this.cachedCapabilities = capabilities;
      this.state = 'ready';
      return capabilities;
    } catch (error) {
      this.state = 'failed';
      this.child.kill();
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

  verifyJournal(): Promise<{ readonly valid: boolean; readonly reason?: string }> {
    return this.request('journal.verify', {});
  }

  listVerdicts(): Promise<readonly Record<string, unknown>[]> {
    return this.request('verdict.list', {});
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request('shutdown', {}, true);
    } finally {
      this.child.kill();
      this.child = undefined;
      this.cachedCapabilities = undefined;
      this.state = 'stopped';
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
    if (response.error) pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
    else pending.resolve(response.result);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = this.state === 'stopped';
    this.child = undefined;
    this.cachedCapabilities = undefined;
    if (!expected) this.state = 'failed';
    this.failAll(new Error(`Ranex kernel exited (${signal ?? code ?? 'unknown'}); governed operations are blocked`));
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
}
