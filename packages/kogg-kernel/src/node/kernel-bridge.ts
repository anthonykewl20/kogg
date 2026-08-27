import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalKernelJson,
  type CheckExecutionProjectionV1,
  type CheckExecutionV1,
  type EvidenceAdmissionProjectionV1,
  type EvidenceManifestV1,
  type GateEvaluationExpectationV1,
  type GateEvaluationProjectionV1,
  type FrozenSuiteProjectionV1,
  type FrozenSuiteV1,
  KERNEL_MAX_FRAME_BYTES,
  KERNEL_MAX_PENDING_REQUESTS,
  KERNEL_MAX_PENDING_RESPONSE_BYTES,
  KERNEL_OPERATIONS,
  KERNEL_SCHEMA_SET_DIGEST,
  KernelBridge,
  KernelCapabilities,
  type KernelExecutionQualification,
  type KernelJson,
  KernelHealth,
  type KernelOperationV2,
  type KernelResultV2,
  type ProducerBindingProjectionV1,
  type ProducerBindingV1,
  type OperationCancelProjectionV1,
  type OperationReconcileExpectationV1,
  type OperationReconcileProjectionV1,
  type RepositoryStateV1,
  type TaskBindingProjectionV1,
  type TaskExecutionBindingV1,
  type VerdictReadExpectationV1,
  type VerdictReadProjectionV1,
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
    if (operation === 'task.bind' || operation === 'producer.dispatch' || operation === 'suite.freeze' || operation === 'suite.execute' || operation === 'evidence.admit' || operation === 'gate.evaluate' || operation === 'verdict.read' || operation === 'operation.reconcile' || operation === 'operation.cancel') {
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

  dispatchProducer(binding: ProducerBindingV1): Promise<KernelResultV2<ProducerBindingProjectionV1>> {
    const bindingDigest = domainDigest('producer', binding as unknown as KernelJson);
    return this.requestResult<ProducerBindingProjectionV1>('producer.dispatch', { binding: binding as unknown as KernelJson, bindingDigest });
  }

  freezeSuite(suite: FrozenSuiteV1): Promise<KernelResultV2<FrozenSuiteProjectionV1>> {
    const suiteDigest = domainDigest('suite', suite as unknown as KernelJson);
    return this.requestResult<FrozenSuiteProjectionV1>('suite.freeze', { suite: suite as unknown as KernelJson, suiteDigest });
  }

  async executeCheck(execution: CheckExecutionV1): Promise<KernelResultV2<CheckExecutionProjectionV1>> {
    const authority = await this.operations.processExecutionAttestation(execution.processRegistrationId);
    if (!authority) {
      console.warn('[kogg:kernel:bridge] check.execution.refused', { executionId: execution.executionId, safeCode: 'KERNEL_AUTHORITY_INVALID' });
      return refusedCheckExecution();
    }
    const expectedOutcome: CheckExecutionV1['outcome'] = authority.operationState === 'timed-out' ? 'timeout'
      : authority.operationState === 'cancelled' ? 'cancelled'
      : authority.exitClass === 'zero' && authority.operationState === 'completed' ? 'pass'
      : authority.exitClass === 'nonzero' ? 'fail' : 'infrastructure';
    if (execution.startedAt !== authority.startedAt || execution.finishedAt !== authority.finishedAt
      || execution.exitClass !== authority.exitClass || execution.outcome !== expectedOutcome
      || execution.cleanupProofDigest !== authority.cleanupProofDigest || execution.suiteDigest !== authority.suiteDigest
      || execution.checkDefinitionDigest !== authority.checkDefinitionDigest
      || domainDigest('repository-state', execution.subjectState as unknown as KernelJson) !== authority.subjectStateDigest
      || execution.verifierId !== authority.verifierId || execution.verifierArtifactDigest !== authority.verifierArtifactDigest
      || execution.executionProfileDigest !== authority.executionProfileDigest || execution.resultArtifactDigest !== authority.resultArtifactDigest) {
      console.warn('[kogg:kernel:bridge] check.execution.refused', { executionId: execution.executionId, safeCode: 'KERNEL_AUTHORITY_INVALID' });
      return refusedCheckExecution();
    }
    const executionDigest = domainDigest('check-execution', execution as unknown as KernelJson);
    return this.requestResult<CheckExecutionProjectionV1>('suite.execute', {
      execution: execution as unknown as KernelJson, executionDigest, processAuthority: authority as unknown as KernelJson
    });
  }

  admitEvidence(evidence: EvidenceManifestV1, currentSubject: RepositoryStateV1): Promise<KernelResultV2<EvidenceAdmissionProjectionV1>> {
    const evidenceDigest = domainDigest('evidence', evidence as unknown as KernelJson);
    return this.requestResult<EvidenceAdmissionProjectionV1>('evidence.admit', {
      currentSubject: currentSubject as unknown as KernelJson, evidence: evidence as unknown as KernelJson, evidenceDigest
    });
  }

  evaluateGate(expectation: GateEvaluationExpectationV1, currentSubject: RepositoryStateV1): Promise<KernelResultV2<GateEvaluationProjectionV1>> {
    const expectationDigest = domainDigest('gate-evaluation', expectation as unknown as KernelJson);
    return this.requestResult<GateEvaluationProjectionV1>('gate.evaluate', {
      currentSubject: currentSubject as unknown as KernelJson, expectation: expectation as unknown as KernelJson, expectationDigest
    });
  }

  readVerdict(expectation: VerdictReadExpectationV1, currentSubject: RepositoryStateV1): Promise<KernelResultV2<VerdictReadProjectionV1>> {
    const expectationDigest = domainDigest('verdict-read', expectation as unknown as KernelJson);
    return this.requestResult<VerdictReadProjectionV1>('verdict.read', {
      currentSubject: currentSubject as unknown as KernelJson, expectation: expectation as unknown as KernelJson, expectationDigest
    });
  }

  reconcileOperation(expectation: OperationReconcileExpectationV1): Promise<KernelResultV2<OperationReconcileProjectionV1>> {
    console.info('[kogg:kernel:recovery] recovery.started', { targetOperation: expectation.targetOperation });
    const expectationDigest = domainDigest('operation-reconcile', expectation as unknown as KernelJson);
    return this.requestResult<OperationReconcileProjectionV1>('operation.reconcile', { expectation: expectation as unknown as KernelJson, expectationDigest }).then(result => {
      console.info('[kogg:kernel:recovery] recovery.reconciled', { targetOperation: expectation.targetOperation, safeCode: result.safeCode, outcome: result.projection?.outcome });
      return result;
    }, error => {
      console.warn('[kogg:kernel:recovery] recovery.failed', { targetOperation: expectation.targetOperation, errorType: error instanceof Error ? error.name : 'UnknownError' });
      throw error;
    });
  }

  async cancelOperation(cancellationRequestId: string, targetOperationId: string): Promise<KernelResultV2<OperationCancelProjectionV1>> {
    console.info('[kogg:kernel:cleanup] operation.cancel.started', { cancellationRequestId, targetOperationId });
    if (targetOperationId === this.operation?.id) return refusedCancellation(cancellationRequestId, targetOperationId);
    try {
      await this.operations.cancel({ requestId: cancellationRequestId, operationId: targetOperationId });
      const recovery = await this.operations.recoveryResult(targetOperationId);
      if (recovery.status !== 'cleaned') return refusedCancellation(cancellationRequestId, targetOperationId);
      const result = await this.requestResult<OperationCancelProjectionV1>('operation.cancel', { cancellationRequestId, cleanupStatus: 'cleaned', targetOperationId });
      console.info('[kogg:kernel:cleanup] operation.cancel.completed', { cancellationRequestId, targetOperationId, safeCode: result.safeCode });
      return result;
    } catch (error) {
      console.warn('[kogg:kernel:cleanup] operation.cancel.failed', { cancellationRequestId, targetOperationId, safeCode: 'KERNEL_CLEANUP_FAILED', errorType: error instanceof Error ? error.name : 'UnknownError' });
      return refusedCancellation(cancellationRequestId, targetOperationId);
    }
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
  if (operation === 'suite.execute') {
    return Object.keys(projection).sort().join(',') === 'checkExecutionDigest,executionId,outcome'
      && validDigest(projection.checkExecutionDigest) && validUuid(projection.executionId)
      && ['pass', 'fail', 'cancelled', 'timeout', 'infrastructure'].includes(String(projection.outcome));
  }
  if (operation === 'evidence.admit') {
    return Object.keys(projection).sort().join(',') === 'claimType,evidenceDigest,evidenceId'
      && validDigest(projection.evidenceDigest) && validUuid(projection.evidenceId)
      && typeof projection.claimType === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(projection.claimType);
  }
  if (operation === 'gate.evaluate') {
    return Object.keys(projection).sort().join(',') === 'decision,evidenceCount,verdictDigest,verdictId'
      && validDigest(projection.verdictDigest) && validUuid(projection.verdictId)
      && ['pass', 'fail', 'blocked'].includes(String(projection.decision))
      && Number.isSafeInteger(projection.evidenceCount) && Number(projection.evidenceCount) >= 0;
  }
  if (operation === 'verdict.read') {
    const rows = projection.gateRows;
    return Object.keys(projection).sort().join(',') === 'authorityDigest,currentDecision,currentness,evaluatedAt,evidenceSetDigest,gateCatalogDigest,gateRows,historicalDecision,journalRootDigest,journalSequence,ranexProvenanceDigest,subjectState,verdictDigest,verdictId'
      && validDigest(projection.verdictDigest) && validUuid(projection.verdictId)
      && validDigest(projection.evidenceSetDigest) && validDigest(projection.gateCatalogDigest) && validDigest(projection.authorityDigest)
      && validDigest(projection.ranexProvenanceDigest) && validDigest(projection.journalRootDigest)
      && Number.isSafeInteger(projection.journalSequence) && Number(projection.journalSequence) >= 0
      && typeof projection.evaluatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(projection.evaluatedAt)
      && Array.isArray(rows) && rows.length >= 1 && rows.length <= 64 && rows.every(validVerdictGateProjection)
      && validRepositoryState(projection.subjectState)
      && ['pass', 'fail', 'blocked'].includes(String(projection.historicalDecision))
      && projection.historicalDecision === verdictDecision(rows)
      && ['current', 'stale'].includes(String(projection.currentness))
      && (projection.currentDecision === null || ['pass', 'fail', 'blocked'].includes(String(projection.currentDecision)))
      && (projection.currentness === 'current') === (projection.currentDecision === projection.historicalDecision);
  }
  if (operation === 'operation.reconcile') {
    return Object.keys(projection).sort().join(',') === 'outcome,targetFactDigest'
      && ['acknowledged', 'absent'].includes(String(projection.outcome))
      && (projection.targetFactDigest === null || validDigest(projection.targetFactDigest))
      && (projection.outcome === 'acknowledged') === validDigest(projection.targetFactDigest);
  }
  if (operation === 'operation.cancel') {
    return Object.keys(projection).sort().join(',') === 'cancellationRequestId,outcome,targetOperationId'
      && validUuid(projection.cancellationRequestId) && validUuid(projection.targetOperationId)
      && projection.outcome === 'cancelled-clean';
  }
  return true;
}
function validRepositoryState(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const oidLength = state.objectFormat === 'sha1' ? 40 : state.objectFormat === 'sha256' ? 64 : 0;
  return Object.keys(state).sort().join(',') === 'commitObjectId,gitCommonDirectoryIdentity,indexDigest,isClean,objectFormat,trackedContentDigest,treeObjectId,untrackedPolicyDigest,worktreeIdentity'
    && oidLength > 0 && typeof state.commitObjectId === 'string' && new RegExp(`^[0-9a-f]{${oidLength}}$`, 'u').test(state.commitObjectId)
    && typeof state.treeObjectId === 'string' && new RegExp(`^[0-9a-f]{${oidLength}}$`, 'u').test(state.treeObjectId)
    && ['gitCommonDirectoryIdentity', 'indexDigest', 'trackedContentDigest', 'untrackedPolicyDigest', 'worktreeIdentity'].every(field => validDigest(state[field]))
    && typeof state.isClean === 'boolean';
}
function validVerdictGateProjection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'checkDefinitionDigest,claimType,evidenceDigest,producerBindingDigest,requiredOutcome,result'
    && typeof row.claimType === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(row.claimType)
    && validDigest(row.checkDefinitionDigest) && row.requiredOutcome === 'pass' && ['pass', 'fail', 'blocked'].includes(String(row.result))
    && (row.evidenceDigest === null || validDigest(row.evidenceDigest)) && (row.producerBindingDigest === null || validDigest(row.producerBindingDigest))
    && (row.result === 'blocked') === (row.evidenceDigest === null || row.producerBindingDigest === null);
}
function verdictDecision(rows: readonly unknown[]): 'pass' | 'fail' | 'blocked' {
  const results = rows.map(row => (row as Record<string, unknown>).result);
  return results.includes('fail') ? 'fail' : results.includes('blocked') ? 'blocked' : 'pass';
}
function validUuid(value: unknown): boolean { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function validDigest(value: unknown): boolean { return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value); }
function refusedCheckExecution(): KernelResultV2<CheckExecutionProjectionV1> {
  return {
    protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'refused',
    safeCode: 'KERNEL_AUTHORITY_INVALID', resultDigest: null, journal: null, projection: null
  };
}
function refusedCancellation(cancellationRequestId: string, targetOperationId: string): KernelResultV2<OperationCancelProjectionV1> {
  console.warn('[kogg:kernel:cleanup] operation.cancel.failed', { cancellationRequestId, targetOperationId, safeCode: 'KERNEL_CLEANUP_FAILED' });
  return {
    protocol: KOGG_RANEX_PROTOCOL, requestId: randomUUID(), operationId: randomUUID(), status: 'refused',
    safeCode: 'KERNEL_CLEANUP_FAILED', resultDigest: null, journal: null, projection: null
  };
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
