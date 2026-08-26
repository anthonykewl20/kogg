import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { ProcessLease } from '@kogg/operations/lib/common/operations-protocol';
import type { AdapterObservationV1, AgentAdapterFactory, AgentAdapterSession, AdapterDescriptorV1, CancelAttemptRequestV1 } from '../common/agents-protocol';
import { AdapterRegistry } from './adapter-registry';

// diagnostic-coverage: agents.adapters, agents.processes, agents.logging, agents.source-maps

@injectable()
export class FixtureAdapter implements AgentAdapterFactory, BackendApplicationContribution {
  readonly descriptor: AdapterDescriptorV1 = { schemaVersion: '1', adapterKey: 'kogg.fixture', adapterVersion: '1.0.0', protocolId: 'kogg.fixture-peer', protocolVersion: '1.0.0', providerIds: ['kogg.fixture'], capabilityIds: ['provider-turn'], executionKind: 'supervised-host', cancellation: 'cooperative-and-owned-cleanup', usageModes: ['provider-cumulative'], ownerKind: 'kogg', enabled: true };
  constructor(@inject(AdapterRegistry) private readonly registry: AdapterRegistry) {}
  onStart(): void { this.registry.register(this); }
  create(input: Parameters<AgentAdapterFactory['create']>[0]): AgentAdapterSession { return new FixtureSession(input); }
}

class FixtureSession implements AgentAdapterSession {
  readonly resourceId = crypto.randomUUID(); readonly resourceKind = 'provider-host' as const; readonly ownerKind = 'kogg' as const;
  private child: ChildProcessWithoutNullStreams | undefined; private process: ProcessLease | undefined; private settled: Promise<void> | undefined;
  constructor(private readonly input: Parameters<AgentAdapterFactory['create']>[0]) {}
  async start(): Promise<void> {
    this.input.credentialLease.consume();
    this.process = this.input.operation.registerProcess({ kind: 'provider-cli', owner: 'kogg-supervisor', cancel: () => this.cancel('policy') });
    this.process.spawning(); console.debug('[kogg:agents:adapter] fixture-host.start.requested', { attemptId: this.input.attemptId, resourceId: this.resourceId });
    const script = createRequire(__filename).resolve('@kogg/agents/lib/node/fixture-host.js');
    const child = spawn(process.execPath, [script, this.input.modelId], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    this.child = child; if (!child.pid) { this.process.failed('PROCESS_SPAWN_FAILED', 'MissingPid'); throw new FixtureAdapterError('ADAPTER_HOST_EXITED'); }
    this.process.started(child.pid);
    this.settled = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', line => { try { const observation = parseObservation(line); if (observation.kind === 'ready') this.process?.ready(); else this.process?.activity(); this.input.onObservation(observation); } catch (error) { console.warn('[kogg:agents:adapter] fixture-host.observation.refused', { attemptId: this.input.attemptId, resourceId: this.resourceId, safeCode: 'ADAPTER_OBSERVATION_INVALID', errorType: error instanceof Error ? error.name : 'UnknownError' }); reject(error); } });
      child.stderr.resume();
      child.once('error', error => { this.process?.failed('PROCESS_SPAWN_FAILED', error.name); reject(new FixtureAdapterError('ADAPTER_HOST_EXITED')); });
      child.once('exit', (code, signal) => { this.process?.exited(signal ? 'signal' : code === 0 ? 'zero' : 'nonzero'); console.info('[kogg:agents:adapter] fixture-host.exited', { attemptId: this.input.attemptId, resourceId: this.resourceId, exitClass: signal ? 'signal' : code === 0 ? 'zero' : 'nonzero' }); if (code === 0 || signal) resolve(); else reject(new FixtureAdapterError('ADAPTER_HOST_EXITED')); });
    });
    return this.settled;
  }
  async cancel(reason: CancelAttemptRequestV1['reason']): Promise<void> { const child = this.child; if (!child || child.exitCode !== null || child.signalCode !== null) return; child.stdin.write(`${JSON.stringify({ kind: 'cancel', reason })}\n`); await Promise.race([this.settled?.catch(() => undefined) ?? Promise.resolve(), delay(1_000)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  async cleanup(): Promise<{ readonly residualCount: number }> { const child = this.child; if (child && child.exitCode === null && child.signalCode === null) { if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { // observability-exempt: ESRCH is an expected absence proof and the residual inventory below remains authoritative.
          /* already absent */ } } else child.kill('SIGTERM'); await waitForExit(child, 2_000); } const residualCount = child && child.exitCode === null && child.signalCode === null ? 1 : 0; if (!residualCount) this.process?.cleanup(); return { residualCount }; }
}

class FixtureAdapterError extends Error { constructor(readonly code: 'ADAPTER_HOST_EXITED' | 'ADAPTER_OBSERVATION_INVALID') { super(code); } }
function parseObservation(line: string): AdapterObservationV1 { if (Buffer.byteLength(line) > 4096) throw new FixtureAdapterError('ADAPTER_OBSERVATION_INVALID'); const value = JSON.parse(line) as Partial<AdapterObservationV1>; if (!value.sequence || !['ready', 'activity', 'usage', 'completed', 'failed'].includes(value.kind ?? '')) throw new FixtureAdapterError('ADAPTER_OBSERVATION_INVALID'); return value as AdapterObservationV1; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(); return Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), delay(timeoutMs)]); }
