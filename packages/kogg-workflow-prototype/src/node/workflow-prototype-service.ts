import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggOperationRegistry, type OperationLease, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { PrototypeNode, PrototypeSnapshot, WorkflowPrototypeService } from '../common/workflow-prototype-protocol';

// diagnostic-exempt: Disposable issue #100 boundary probe; production workflow implementation belongs to #101.
const RUN_ID = '10000000-0000-4000-8000-000000000100';
const TEMPLATE_VERSION = 'workflow-prototype-v1';
const TEMPLATE_DIGEST = createHash('sha256').update('serial|parallel|condition|retry|anchors-v1').digest('hex');
const DEFAULT_NODES: readonly PrototypeNode[] = [
  { id: 'approval', kind: 'anchor.spec-approved', state: 'blocked', attempt: 0 },
  { id: 'serial', kind: 'implementation.agent', state: 'blocked', attempt: 0 },
  { id: 'parallel-a', kind: 'check.deterministic', state: 'blocked', attempt: 0 },
  { id: 'parallel-b', kind: 'control.condition', state: 'blocked', attempt: 0 },
  { id: 'evidence', kind: 'anchor.evidence-admitted', state: 'blocked', attempt: 0 },
  { id: 'verdict', kind: 'anchor.ranex-pass-current', state: 'blocked', attempt: 0 }
];

@injectable()
export class WorkflowPrototypeRegistry implements WorkflowPrototypeService, BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private child: ChildProcess | undefined;
  private lease: OperationLease | undefined;

  constructor(@inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi) {}

  onStart(): void {
    this.open();
    const row = this.db().prepare('SELECT state,child_pid FROM prototype_run WHERE singleton=1').get() as { state: string; child_pid?: number };
    if (row.state === 'active') {
      if (row.child_pid) {
        try {
          process.kill(row.child_pid, 'SIGKILL');
        } catch {
          console.info('[kogg:workflow:prototype] recovery.process.already-absent', { runId: RUN_ID, safeCode: 'WORKFLOW_PROCESS_ALREADY_ABSENT' });
        }
      }
      this.db().prepare('UPDATE prototype_run SET child_pid=NULL WHERE singleton=1').run();
      this.writeState('recovered', 'WORKFLOW_BACKEND_RESTARTED', DEFAULT_NODES.map(node => ({ ...node, state: 'cancelled' })), 0, true);
      console.warn('[kogg:workflow:prototype] recovery.completed', { runId: RUN_ID, safeCode: 'WORKFLOW_BACKEND_RESTARTED', processCount: 0 });
    }
    console.info('[kogg:workflow:prototype] registry.started', { runId: RUN_ID, templateVersion: TEMPLATE_VERSION });
  }

  async onStop(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    this.child = undefined;
    this.database?.close(); this.database = undefined;
  }

  async snapshot(): Promise<PrototypeSnapshot> { this.open(); return this.read(); }

  async refuseGraph(request: { readonly requestId: string; readonly mutation: 'cycle' | 'anchor-bypass' | 'authority-expansion' }): Promise<PrototypeSnapshot> {
    validateRequest(request.requestId);
    const code = request.mutation === 'cycle' ? 'WORKFLOW_CYCLE' : request.mutation === 'anchor-bypass' ? 'WORKFLOW_ANCHOR_BYPASS' : 'WORKFLOW_AUTHORITY_EXPANSION';
    console.warn('[kogg:workflow:prototype] compile.refused', { runId: RUN_ID, safeCode: code, mutation: request.mutation });
    this.writeState('refused', code, DEFAULT_NODES, 0, true);
    return this.read();
  }

  async runScenario(request: { readonly requestId: string; readonly scenario: 'success' | 'retry' | 'cancel' }): Promise<PrototypeSnapshot> {
    validateRequest(request.requestId);
    if (this.child) throw new Error('WORKFLOW_ACTIVE');
    console.info('[kogg:workflow:prototype] compile.completed', { runId: RUN_ID, templateVersion: TEMPLATE_VERSION });
    const nodes = DEFAULT_NODES.map(node => ({ ...node }));
    nodes[0] = { ...nodes[0]!, state: 'completed', attempt: 1 };
    nodes[1] = { ...nodes[1]!, state: 'active', attempt: 1 };
    this.writeState('active', 'WORKFLOW_OK', nodes, 1, true);
    await this.runWorker('serial', request.scenario === 'cancel' ? 'hang' : 'complete');
    if (request.scenario === 'cancel') {
      nodes[1] = { ...nodes[1]!, state: 'cancelled' };
      this.writeState('cancelled', 'WORKFLOW_CANCELLED', nodes, 5, true);
      return this.read();
    }
    nodes[1] = { ...nodes[1]!, state: 'completed' };
    nodes[2] = { ...nodes[2]!, state: 'active', attempt: 1 };
    nodes[3] = { ...nodes[3]!, state: 'active', attempt: 1 };
    this.writeState('active', 'WORKFLOW_OK', nodes, 4, true);
    await Promise.all([this.runWorker('parallel-a', 'complete'), this.runWorker('parallel-b', 'complete')]);
    nodes[2] = { ...nodes[2]!, state: 'completed' };
    if (request.scenario === 'retry') {
      nodes[3] = { ...nodes[3]!, state: 'retrying', attempt: 1 };
      this.writeState('active', 'WORKFLOW_RETRY_SCHEDULED', nodes, 8, true);
      await this.runWorker('parallel-b', 'complete');
      nodes[3] = { ...nodes[3]!, state: 'completed', attempt: 2 };
    } else nodes[3] = { ...nodes[3]!, state: 'completed' };
    nodes[4] = { ...nodes[4]!, state: 'completed', attempt: 1 };
    nodes[5] = { ...nodes[5]!, state: 'completed', attempt: 1 };
    this.writeState('completed', 'WORKFLOW_OK', nodes, request.scenario === 'retry' ? 14 : 11, true);
    console.info('[kogg:workflow:prototype] run.terminal', { runId: RUN_ID, safeCode: 'WORKFLOW_OK', processCount: 0 });
    return this.read();
  }

  async recover(request: { readonly requestId: string }): Promise<PrototypeSnapshot> {
    validateRequest(request.requestId);
    const current = this.read();
    if (current.state !== 'active') return current;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.lease?.cancel().catch(() => undefined); await this.lease?.cleanup().catch(() => undefined);
    this.child = undefined; this.lease = undefined;
    this.writeState('recovered', 'WORKFLOW_BACKEND_RESTARTED', current.nodes.map(node => node.state === 'active' ? { ...node, state: 'cancelled' } : node), current.eventCount + 3, true);
    console.warn('[kogg:workflow:prototype] recovery.completed', { runId: RUN_ID, safeCode: 'WORKFLOW_BACKEND_RESTARTED', processCount: 0 });
    return this.read();
  }

  private async runWorker(nodeId: string, mode: 'complete' | 'hang'): Promise<void> {
    const lease = await this.operations.startOperation({ kind: 'agent-dispatch', correlations: { runId: RUN_ID, attemptId: randomUUID() }, absoluteTimeoutMs: 5_000, idleTimeoutMs: 2_000 });
    this.lease = lease; lease.start();
    const processLease = lease.registerProcess({ kind: 'governed-command', owner: 'kogg-supervisor', cancel: async () => { if (this.child?.exitCode === null) this.child.kill('SIGKILL'); } });
    console.info('[kogg:workflow:prototype] node.process.registered', { runId: RUN_ID, nodeId, operationId: lease.id, processId: processLease.id });
    processLease.spawning();
    const child = spawn(process.execPath, [path.join(__dirname, 'worker.js')], { env: { PATH: process.env.PATH ?? '', KOGG_WORKFLOW_PROTOTYPE_WORKER: mode }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child; processLease.started(child.pid!); lease.active(); processLease.ready();
    this.db().prepare('UPDATE prototype_run SET child_pid=? WHERE singleton=1').run(child.pid!);
    const timer = mode === 'hang' ? setTimeout(() => child.kill('SIGTERM'), 10_000) : undefined;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    if (timer) clearTimeout(timer);
    processLease.exited(result.code === 0 ? 'zero' : 'signal'); processLease.cleanup();
    await lease.cleanup();
    if (mode === 'hang') { await lease.cancel(); }
    else lease.complete('OPERATIONS_OK');
    this.db().prepare('UPDATE prototype_run SET child_pid=NULL WHERE singleton=1').run();
    this.child = undefined; this.lease = undefined;
    console.info('[kogg:workflow:prototype] node.cleanup.completed', { runId: RUN_ID, nodeId, operationId: lease.id, processCount: 0 });
  }

  private open(): void {
    if (this.database) return;
    const root = process.env.KOGG_WORKFLOW_PROTOTYPE_DATA_DIR ?? path.join(process.cwd(), '.kogg-workflow-prototype'); mkdirSync(root, { recursive: true });
    const database = new DatabaseSync(path.join(root, 'workflow.sqlite3')); database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS prototype_run(singleton INTEGER PRIMARY KEY CHECK(singleton=1),run_id TEXT NOT NULL,template_version TEXT NOT NULL,template_digest TEXT NOT NULL,state TEXT NOT NULL,safe_code TEXT NOT NULL,nodes_json TEXT NOT NULL,event_count INTEGER NOT NULL,immutable INTEGER NOT NULL,child_pid INTEGER);');
    database.prepare('INSERT OR IGNORE INTO prototype_run VALUES(1,?,?,?,?,?,?,?,?,NULL)').run(RUN_ID, TEMPLATE_VERSION, TEMPLATE_DIGEST, 'idle', 'WORKFLOW_OK', JSON.stringify(DEFAULT_NODES), 0, 1);
    this.database = database;
  }
  private db(): DatabaseSync { if (!this.database) throw new Error('WORKFLOW_STORE_UNAVAILABLE'); return this.database; }
  private read(): PrototypeSnapshot {
    const row = this.db().prepare('SELECT * FROM prototype_run WHERE singleton=1').get() as Record<string, string | number>;
    return { runId: String(row.run_id), templateVersion: String(row.template_version), templateDigest: String(row.template_digest), state: String(row.state) as PrototypeSnapshot['state'], safeCode: String(row.safe_code), nodes: JSON.parse(String(row.nodes_json)), eventCount: Number(row.event_count), processCount: this.child ? 1 : 0, immutable: Boolean(row.immutable), debuggerReachable: true };
  }
  private writeState(state: PrototypeSnapshot['state'], safeCode: string, nodes: readonly PrototypeNode[], eventCount: number, immutable: boolean): void {
    this.db().prepare('UPDATE prototype_run SET state=?,safe_code=?,nodes_json=?,event_count=?,immutable=? WHERE singleton=1').run(state, safeCode, JSON.stringify(nodes), eventCount, immutable ? 1 : 0);
  }
}

function validateRequest(value: string): void { if (!/^[0-9a-f-]{36}$/u.test(value)) throw new Error('WORKFLOW_REQUEST_INVALID'); }
