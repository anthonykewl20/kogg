import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalKernelJson,
  type FrozenSuiteProjectionV1,
  type FrozenSuiteV1,
  KERNEL_MAX_FRAME_BYTES,
  KERNEL_MAX_PENDING_REQUESTS,
  KERNEL_MAX_PENDING_RESPONSE_BYTES,
  KERNEL_OPERATIONS,
  KERNEL_SCHEMA_SET_DIGEST,
  KernelBridge,
  KernelCapabilities,
  KernelEvaluationRequest,
  KernelExecutionQualification,
  KernelHealth,
  type KernelOperationV2,
  type KernelResultV2,
  type ProducerBindingProjectionV1,
  type ProducerBindingV1,
  type TaskBindingProjectionV1,
  type TaskExecutionBindingV1,
  KOGG_RANEX_COMMIT,
  KOGG_RANEX_PROTOCOL,
  KOGG_RANEX_PROTOCOL_VERSION,
  KOGG_RANEX_TREE
} from '@kogg/contracts';
import { KoggOperationRegistry, type OperationLease, type OperationRegistryApi, type ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import { ILogger } from '@theia/core/lib/common/logger';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import { Process, ProcessType, type IProcessExitEvent } from '@theia/process/lib/node/process';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import { PassThrough, type Readable, type Writable } from 'node:stream';

// diagnostic-coverage: kernel.protocol, kernel.bridge, kernel.cleanup

interface PendingRequest {
  readonly operationId: string;
  readonly operation: KernelOperationV2;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

@injectable()
export class KernelBridgeImpl implements KernelBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private responseBuffer = Buffer.alloc(0);
  private adapterArtifactDigest = '';
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

    this.adapterArtifactDigest = sha256(readFileSync(adapter));
    this.child.stdout.on('data', data => this.receive(Buffer.from(data)));
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
    if (!this.processLease) return Promise.reject(new Error('Ranex process registration is unavailable'));
    return this.request<KernelCapabilities>('kernel.handshake', {
      adapterArtifactDigest: this.adapterArtifactDigest,
      processRegistrationId: this.processLease.id,
      schemaSetDigest: KERNEL_SCHEMA_SET_DIGEST
    }, true);
  }

  health(): Promise<KernelHealth> {
    return this.request<KernelHealth>('kernel.health', {});
  }

  async capabilities(): Promise<KernelCapabilities> {
    if (!this.cachedCapabilities) await this.start();
    if (!this.cachedCapabilities) throw new Error('Ranex capabilities are unavailable');
    return this.cachedCapabilities;
  }

  execute<TProjection extends KernelJson>(operation: KernelOperationV2, body: KernelJson): Promise<KernelResultV2<TProjection>> {
    if (operation === 'task.bind' || operation === 'producer.dispatch' || operation === 'suite.freeze') {
      console.warn('[kogg:kernel:bridge] request.refused', { operation, safeCode: 'KERNEL_AUTHORITY_INVALID' });
      return Promise.resolve({
        protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'refused',
        safeCode: 'KERNEL_AUTHORITY_INVALID', resultDigest: null, journal: null, projection: null
      });
    }
    return this.requestResult<TProjection>(operation, body);
  }

  bindTask(binding: TaskExecutionBindingV1): Promise<KernelResultV2<TaskBindingProjectionV1>> {
    const bindingDigest = domainDigest('task-binding', binding as unknown as KernelJson);
    return this.requestResult<TaskBindingProjectionV1>('task.bind', { binding: binding as unknown as KernelJson, bindingDigest });
  }

  qualifyExecution(targetId: string): Promise<KernelExecutionQualification> {
    return this.request<KernelExecutionQualification>('execution.qualify', { targetId });
  }

  verifyJournal(): Promise<{ readonly valid: boolean; readonly reason?: string }> {
    return this.request('journal.verify', {});
  }

  freezeSuite(suite: FrozenSuiteV1): Promise<KernelResultV2<FrozenSuiteProjectionV1>> {
    const suiteDigest = domainDigest('suite', suite as unknown as KernelJson);
    return this.requestResult<FrozenSuiteProjectionV1>('suite.freeze', { suite: suite as unknown as KernelJson, suiteDigest });
  }

  async verifyJournal(): Promise<{ readonly valid: boolean; readonly reason?: string }> {
    const health = await this.health();
    return health.journal === 'valid' ? { valid: true } : { valid: false, reason: health.journal };
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    this.expectedExit = true;
    try {
      this.child.stdin.end();
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

  private async request<T>(operation: KernelOperationV2, body: KernelJson, allowStarting = false): Promise<T> {
    const result = await this.requestResult<T>(operation, body, allowStarting);
    if (result.status !== 'succeeded' || result.projection === null) throw new Error(result.safeCode);
    return result.projection;
  }

  private requestResult<T>(operation: KernelOperationV2, body: KernelJson, allowStarting = false): Promise<KernelResultV2<T>> {
    if (!this.child || (!allowStarting && this.state !== 'ready')) {
      return Promise.reject(new Error('Ranex kernel is not ready; operation refused'));
    }
    if (this.pending.size >= KERNEL_MAX_PENDING_REQUESTS) return Promise.reject(new Error('KERNEL_PROTOCOL_OVERFLOW'));
    const requestId = randomUUID(); const operationId = randomUUID();
    const bodyDigest = sha256(Buffer.from(canonicalKernelJson(body), 'utf8'));
    const idempotencyKey = domainDigest('idempotency', { bodyDigest, operation, version: KERNEL_OPERATIONS[operation] });
    const envelope = { protocol: KOGG_RANEX_PROTOCOL, requestId, operationId, idempotencyKey, operation, operationVersion: KERNEL_OPERATIONS[operation], ranexCommit: KOGG_RANEX_COMMIT, schemaSetDigest: KERNEL_SCHEMA_SET_DIGEST, bodyDigest, body } as const;
    const payload = Buffer.from(canonicalKernelJson(envelope), 'utf8');
    if (payload.length > KERNEL_MAX_FRAME_BYTES) return Promise.reject(new Error('KERNEL_PROTOCOL_OVERFLOW'));
    const frame = Buffer.allocUnsafe(4 + payload.length); frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4);
    return new Promise<KernelResultV2<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        console.warn('[kogg:kernel:bridge] request.refused', { requestId, operationId, operation, safeCode: 'KERNEL_OUTCOME_UNKNOWN' });
        reject(new Error('KERNEL_OUTCOME_UNKNOWN'));
      }, 15_000);
      this.pending.set(requestId, { operationId, operation, resolve: value => resolve(value as KernelResultV2<T>), reject, timer });
      this.processLease?.activity();
      console.info('[kogg:kernel:bridge] request.validated', { requestId, operationId, operation, operationVersion: KERNEL_OPERATIONS[operation] });
      this.child?.stdin.write(frame);
    });
  }

  private receive(chunk: Buffer): void {
    this.responseBuffer = Buffer.concat([this.responseBuffer, chunk]);
    if (this.responseBuffer.length > KERNEL_MAX_PENDING_RESPONSE_BYTES) return this.protocolFailure('KERNEL_PROTOCOL_OVERFLOW');
    while (this.responseBuffer.length >= 4) {
      const length = this.responseBuffer.readUInt32BE(0);
      if (length === 0 || length > KERNEL_MAX_FRAME_BYTES) return this.protocolFailure('KERNEL_PROTOCOL_OVERFLOW');
      if (this.responseBuffer.length < length + 4) return;
      const payload = this.responseBuffer.subarray(4, length + 4); this.responseBuffer = this.responseBuffer.subarray(length + 4);
      try { this.acceptResult(payload); }
      catch { /* observability-exempt: the content-free safe code below is the complete protocol failure projection. */ return this.protocolFailure('KERNEL_PROTOCOL_INVALID'); }
    }
  }

  private acceptResult(payload: Buffer): void {
    const text = payload.toString('utf8'); const response = JSON.parse(text) as KernelResultV2;
    if (canonicalKernelJson(response as unknown as KernelJson) !== text) throw new Error('noncanonical');
    if (!response || Object.keys(response).sort().join(',') !== 'journal,operationId,projection,protocol,requestId,resultDigest,safeCode,status' || response.protocol !== KOGG_RANEX_PROTOCOL) throw new Error('schema');
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    if (response.operationId !== pending.operationId || !['succeeded', 'refused', 'unknown'].includes(response.status)) throw new Error('correlation');
    if ((response.status === 'succeeded') !== (response.safeCode === 'KERNEL_OK')) throw new Error('safe-code');
    if (!validJournal(response.journal) || (response.status === 'succeeded' && JOURNALED_OPERATIONS.has(pending.operation)) !== (response.journal !== null)) throw new Error('journal');
    if (response.projection !== null && !validOperationProjection(pending.operation, response.projection)) throw new Error('projection');
    if ((response.projection === null) !== (response.resultDigest === null) || (response.projection !== null && sha256(Buffer.from(canonicalKernelJson(response.projection as KernelJson), 'utf8')) !== response.resultDigest)) throw new Error('digest');
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    this.processLease?.activity();
    pending.resolve(response);
  }

  private protocolFailure(code: 'KERNEL_PROTOCOL_INVALID' | 'KERNEL_PROTOCOL_OVERFLOW'): void {
    console.error('[kogg:kernel:bridge] request.refused', { safeCode: code });
    this.failAll(new Error(code)); this.child?.kill();
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
      capabilities.ranexCommit !== KOGG_RANEX_COMMIT ||
      capabilities.ranexTree !== KOGG_RANEX_TREE ||
      capabilities.schemaSetDigest !== KERNEL_SCHEMA_SET_DIGEST ||
      capabilities.adapterArtifactDigest !== this.adapterArtifactDigest ||
      capabilities.operations.some(operation => KERNEL_OPERATIONS[operation.operation] !== operation.version)
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

function sha256(value: Uint8Array): `sha256:${string}` { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function domainDigest(domain: string, value: KernelJson): `sha256:${string}` {
  return sha256(Buffer.concat([Buffer.from(`kogg:${domain}:v1\n`, 'utf8'), Buffer.from(canonicalKernelJson(value), 'utf8')]));
}
const JOURNALED_OPERATIONS = new Set<KernelOperationV2>([
  'task.bind', 'producer.dispatch', 'suite.freeze', 'suite.execute', 'evidence.admit', 'gate.evaluate', 'operation.reconcile', 'operation.cancel'
]);
function validJournal(value: KernelResultV2['journal']): boolean {
  return value === null || (Object.keys(value).sort().join(',') === 'rootDigest,sequence'
    && /^(?:0|[1-9][0-9]*)$/u.test(value.sequence) && /^sha256:[0-9a-f]{64}$/u.test(value.rootDigest));
}
function validOperationProjection(operation: KernelOperationV2, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const projection = value as Record<string, unknown>;
  if (operation === 'task.bind') {
    return Object.keys(projection).sort().join(',') === 'taskBindingDigest,taskId,taskRevision'
      && validUuid(projection.taskId) && Number.isSafeInteger(projection.taskRevision) && Number(projection.taskRevision) > 0
      && validDigest(projection.taskBindingDigest);
  }
  if (operation === 'producer.dispatch') {
    return Object.keys(projection).sort().join(',') === 'attemptId,producerBindingDigest,producerId'
      && validUuid(projection.attemptId) && validUuid(projection.producerId) && validDigest(projection.producerBindingDigest);
  }
  if (operation === 'suite.freeze') {
    return Object.keys(projection).sort().join(',') === 'suiteDigest,suiteId,suiteRevision'
      && validUuid(projection.suiteId) && Number.isSafeInteger(projection.suiteRevision) && Number(projection.suiteRevision) > 0
      && validDigest(projection.suiteDigest);
  }
  return true;
}
function validUuid(value: unknown): boolean { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function validDigest(value: unknown): boolean { return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value); }

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
