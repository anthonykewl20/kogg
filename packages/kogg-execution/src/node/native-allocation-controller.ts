import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { KoggOperationRegistry, type OperationLease, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { ExecutionAllocationSummaryV1, ReserveExecutionAllocationV1 } from '../common/execution-protocol';
import { ExecutionAllocationRegistry, type PhysicalAllocationIntentV1 } from './execution-allocation-registry';
import { ExecutionTargetRegistry } from './execution-target-registry';

// The allocation controller verifies the qualified native artifact, registers it before spawn, and commits only closed identity output.
// diagnostic-coverage: execution.target-qualification, execution.worktree-registry, execution.capacity, execution.recovery, execution.process-cleanup
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OUTPUT_LIMIT = 4096;
type HelperChild = ChildProcess;

export interface NativeAllocationControllerConfiguration {
  readonly platform: NodeJS.Platform; readonly arch: string; readonly allocationRoot: string;
  readonly binary: string; readonly manifest: string; readonly timeoutMs: number;
}

@injectable()
export class NativeAllocationController implements BackendApplicationContribution {
  private rootFd: number | undefined;

  constructor(
    @inject(ExecutionAllocationRegistry) private readonly allocations: ExecutionAllocationRegistry,
    @inject(ExecutionTargetRegistry) private readonly targets: Pick<ExecutionTargetRegistry, 'physicalAllocationAuthority'>,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @unmanaged() private readonly configuration: NativeAllocationControllerConfiguration = defaultConfiguration()
  ) {}

  onStart(): void { if (this.supported()) this.openRoot(); }
  onStop(): void { if (this.rootFd !== undefined) closeSync(this.rootFd); this.rootFd = undefined; }

  async allocate(request: ReserveExecutionAllocationV1): Promise<ExecutionAllocationSummaryV1> {
    const artifactDigest = this.artifactDigest();
    const authority = await this.targets.physicalAllocationAuthority(request.binding, artifactDigest);
    if (!authority) throw new NativeAllocationError('ALLOCATION_QUALIFICATION_INVALID');
    const allocation = await this.allocations.reserve(request);
    const intent = await this.allocations.preparePhysicalAllocation({ requestId: randomUUID(), worktreeId: allocation.worktreeId,
      expectedRevision: allocation.revision, bindingDigest: allocation.bindingDigest, helperDigest: authority.helperDigest, mountQuotaDigest: authority.mountQuotaDigest });
    let operation: OperationLease | undefined; let committed = false;
    try {
      operation = await this.operations.startOperation({ kind: 'worktree', correlations: {
        projectId: request.binding.projectId, runId: request.binding.runId, attemptId: request.binding.attemptId, worktreeId: allocation.worktreeId
      } });
      operation.start(); operation.active();
      console.info('[kogg:execution:allocation-helper] allocation.started', { operationId: operation.id, worktreeId: allocation.worktreeId });
      const result = await this.invoke(operation, intent);
      if (!result.ok) throw new NativeAllocationError(result.safeCode === 'ALLOCATION_QUALIFICATION_INVALID' ? result.safeCode : 'ALLOCATION_INTEGRITY_FAILED');
      const completed = await this.allocations.recordPhysicalAllocation({ requestId: randomUUID(), intentId: intent.intentId,
        worktreeId: intent.worktreeId, expectedRevision: intent.expectedRevision, bindingDigest: allocation.bindingDigest,
        fencingToken: intent.fencingToken, allocationName: intent.allocationName, allocationNonceDigest: allocation.allocationNonceDigest,
        filesystemDevice: result.filesystemDevice, filesystemInode: result.filesystemInode, ownerUid: result.ownerUid, mode: '0700',
        mountId: result.mountId, quotaProjectId: result.quotaProjectId, quotaBytes: intent.quotaBytes, quotaInodes: intent.quotaInodes,
        helperDigest: intent.helperDigest, mountQuotaDigest: intent.mountQuotaDigest });
      committed = true; await operation.cleanup(); operation.complete();
      console.info('[kogg:execution:allocation-helper] allocation.completed', { operationId: operation.id, worktreeId: allocation.worktreeId });
      return completed;
    } catch (error) {
      let safeCode = error instanceof NativeAllocationError ? error.code : 'ALLOCATION_INTEGRITY_FAILED';
      if (!committed) {
        try {
          await this.allocations.failPhysicalAllocation({ requestId: randomUUID(), intentId: intent.intentId, worktreeId: intent.worktreeId,
            expectedRevision: intent.expectedRevision, bindingDigest: allocation.bindingDigest, fencingToken: intent.fencingToken, safeCode });
        } catch (failureError) { // observability-exempt: The closed allocation.failed event records failure-commit loss without exposing either raw error.
          safeCode = 'ALLOCATION_INTEGRITY_FAILED';
          console.error('[kogg:execution:allocation-helper] failure.commit.failed', { operationId: operation?.id, worktreeId: allocation.worktreeId, safeCode, errorType: failureError instanceof Error ? failureError.name : 'UnknownError' });
        }
      }
      await operation?.cleanup().catch(() => undefined); operation?.fail('PROCESS_EXIT_NONZERO', error instanceof Error ? error.name : 'UnknownError');
      console.error('[kogg:execution:allocation-helper] allocation.failed', { operationId: operation?.id, worktreeId: allocation.worktreeId, safeCode, errorType: error instanceof Error ? error.name : 'UnknownError' });
      throw new NativeAllocationError(safeCode);
    }
  }

  private artifactDigest(): string {
    if (!this.supported()) throw new NativeAllocationError('ALLOCATION_QUALIFICATION_INVALID');
    this.openRoot();
    try {
      const [binaryStat, manifestStat] = [statSync(this.configuration.binary), statSync(this.configuration.manifest)];
      const effectiveUid = process.geteuid?.();
      if (!binaryStat.isFile() || !manifestStat.isFile() || (binaryStat.mode & 0o777) !== 0o500 || (manifestStat.mode & 0o777) !== 0o400
        || effectiveUid === undefined || binaryStat.uid !== effectiveUid || manifestStat.uid !== effectiveUid) throw new Error('permissions');
      const manifest = JSON.parse(readFileSync(this.configuration.manifest, 'utf8')) as Record<string, unknown>;
      if (Object.keys(manifest).sort().join(',') !== 'architecture,artifactDigest,platform,schemaVersion,sourceDigest'
        || manifest.schemaVersion !== 1 || manifest.platform !== 'linux' || manifest.architecture !== 'x64'
        || typeof manifest.artifactDigest !== 'string' || !DIGEST.test(manifest.artifactDigest)
        || typeof manifest.sourceDigest !== 'string' || !DIGEST.test(manifest.sourceDigest)) throw new Error('manifest');
      const observed = `sha256:${createHash('sha256').update(readFileSync(this.configuration.binary)).digest('hex')}`;
      if (observed !== manifest.artifactDigest) throw new Error('artifact');
      return observed;
    } catch { throw new NativeAllocationError('ALLOCATION_QUALIFICATION_INVALID'); }
  }

  private async invoke(operation: OperationLease, intent: PhysicalAllocationIntentV1): Promise<HelperResult> {
    const rootFd = this.rootFd; if (rootFd === undefined) throw new NativeAllocationError('ALLOCATION_QUALIFICATION_INVALID');
    if (this.artifactDigest() !== intent.helperDigest) throw new NativeAllocationError('ALLOCATION_QUALIFICATION_INVALID');
    let child: HelperChild | undefined; let terminal: { code: number | null; signal: NodeJS.Signals | null } | undefined; let spawnFailed = false;
    let output = Buffer.alloc(0); let bytes = 0; let limited = false; let timedOut = false; let timeout: NodeJS.Timeout | undefined;
    let settled: Promise<void> | undefined;
    const processLease = operation.registerProcess({ kind: 'governed-command', owner: 'kogg-supervisor', cancel: async () => { kill(child); await settled?.catch(() => undefined); } });
    console.info('[kogg:execution:allocation-helper] process.registered', { operationId: operation.id, processId: processLease.id });
    processLease.spawning();
    try {
      const spawned = spawn(this.configuration.binary, [], { detached: true, env: {}, stdio: ['pipe', 'pipe', 'pipe', rootFd] }); child = spawned;
      settled = new Promise(resolve => { spawned.once('error', () => { spawnFailed = true; }); spawned.once('close', (code, signal) => { terminal = { code, signal }; resolve(); }); });
      if (!spawned.pid) { await settled; throw new NativeAllocationError('ALLOCATION_INTEGRITY_FAILED'); }
      processLease.started(spawned.pid); processLease.ready(); timeout = setTimeout(() => { timedOut = true; kill(spawned); }, this.configuration.timeoutMs);
      spawned.stdout?.on('data', chunk => { const value = Buffer.from(chunk); bytes += value.length; if (bytes > OUTPUT_LIMIT) { limited = true; kill(spawned); } else output = Buffer.concat([output, value]); processLease.activity(); });
      spawned.stderr?.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > OUTPUT_LIMIT) { limited = true; kill(spawned); } processLease.activity(); });
      spawned.stdin?.end(`${JSON.stringify(helperRequest(intent))}\n`); await settled;
      if (spawnFailed || limited || timedOut || terminal?.signal || (terminal?.code !== 0 && output.length === 0)) throw new NativeAllocationError('ALLOCATION_INTEGRITY_FAILED');
      return parseHelperResult(output, intent.quotaProjectId);
    } finally {
      if (timeout) clearTimeout(timeout); kill(child); await settled?.catch(() => undefined);
      if (child?.pid) processLease.exited(terminal?.signal ? 'signal' : terminal?.code === 0 ? 'zero' : 'nonzero'); else processLease.failed('PROCESS_SPAWN_FAILED', 'Error');
      processLease.cleanup();
      console.info('[kogg:execution:allocation-helper] process.exited', { operationId: operation.id, processId: processLease.id, exitClass: terminal?.signal ? 'signal' : terminal?.code === 0 ? 'zero' : child?.pid ? 'nonzero' : 'spawn-failed' });
    }
  }

  private supported(): boolean { return this.configuration.platform === 'linux' && this.configuration.arch === 'x64'; }
  private openRoot(): void {
    if (this.rootFd !== undefined) return;
    mkdirSync(this.configuration.allocationRoot, { recursive: true, mode: 0o700 });
    const stat = statSync(this.configuration.allocationRoot);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.geteuid?.()) throw new NativeAllocationError('ALLOCATION_QUALIFICATION_INVALID');
    this.rootFd = openSync(this.configuration.allocationRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }
}

export class NativeAllocationError extends Error {
  constructor(readonly code: 'ALLOCATION_INTEGRITY_FAILED' | 'ALLOCATION_QUALIFICATION_INVALID') { super(code); this.name = 'NativeAllocationError'; }
}

type HelperResult = { readonly ok: false; readonly safeCode: string } | { readonly ok: true; readonly filesystemDevice: string; readonly filesystemInode: string; readonly ownerUid: string; readonly mountId: string; readonly quotaProjectId: string };
function parseHelperResult(output: Buffer, expectedProjectId: string): HelperResult {
  if (output.length === 0 || output.length > OUTPUT_LIMIT) throw new NativeAllocationError('ALLOCATION_INTEGRITY_FAILED');
  let value: Record<string, unknown>; try { value = JSON.parse(output.toString('utf8').trim()) as Record<string, unknown>; } catch { throw new NativeAllocationError('ALLOCATION_INTEGRITY_FAILED'); }
  if (value.schemaVersion !== 1 || typeof value.ok !== 'boolean' || typeof value.safeCode !== 'string') throw new NativeAllocationError('ALLOCATION_INTEGRITY_FAILED');
  if (!value.ok) {
    if (Object.keys(value).sort().join(',') !== 'ok,safeCode,schemaVersion') throw new NativeAllocationError('ALLOCATION_INTEGRITY_FAILED');
    return { ok: false, safeCode: value.safeCode };
  }
  if (Object.keys(value).sort().join(',') !== 'filesystemDevice,filesystemInode,mode,mountId,ok,ownerUid,quotaProjectId,safeCode,schemaVersion'
    || value.safeCode !== 'ALLOCATION_OK' || value.mode !== '0700'
    || ![value.filesystemDevice, value.filesystemInode, value.ownerUid, value.mountId, value.quotaProjectId].every(item => typeof item === 'string' && DECIMAL.test(item))
    || value.filesystemInode === '0' || value.mountId === '0' || value.quotaProjectId !== expectedProjectId) throw new NativeAllocationError('ALLOCATION_INTEGRITY_FAILED');
  return { ok: true, filesystemDevice: String(value.filesystemDevice), filesystemInode: String(value.filesystemInode), ownerUid: String(value.ownerUid), mountId: String(value.mountId), quotaProjectId: String(value.quotaProjectId) };
}
function helperRequest(intent: PhysicalAllocationIntentV1): Record<string, string | number> {
  if (![intent.intentId, intent.worktreeId, intent.ownerInstanceId].every(value => UUID.test(value))) throw new NativeAllocationError('ALLOCATION_INTEGRITY_FAILED');
  return { schemaVersion: 1, operation: 'allocate', allocationName: intent.allocationName, allocationNonce: intent.allocationNonce,
    worktreeId: intent.worktreeId, ownerInstanceId: intent.ownerInstanceId, createdAt: intent.createdAt, quotaProjectId: intent.quotaProjectId,
    quotaBytes: intent.quotaBytes, quotaInodes: intent.quotaInodes };
}
function kill(child: HelperChild | undefined): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { // observability-exempt: Direct-child termination is the required fallback; the governed process lifecycle records the final exit class.
    child.kill('SIGKILL');
  }
}
function defaultConfiguration(): NativeAllocationControllerConfiguration {
  const native = path.resolve(__dirname, '..', '..', 'native', 'bin', 'linux-x64');
  return { platform: process.platform, arch: process.arch, allocationRoot: path.join(stateRoot(), 'execution', 'allocations'), binary: path.join(native, 'kogg-execution-helper'), manifest: path.join(native, 'manifest.json'), timeoutMs: 10_000 };
}
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state')); }
