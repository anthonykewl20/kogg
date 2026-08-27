import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, optional, unmanaged } from '@theia/core/shared/inversify';
import type { EditableWorkflowGraphV1, KoggWorkflowService, WorkflowMutationResult, WorkflowNodeConfigurationV1, WorkflowRunProjection, WorkflowSafeCode, WorkflowTemplateVersionProjection, WorkflowValidationProjection } from '../common/workflow-protocol';
import { canonicalJson, WorkflowValidationError, workflowDigest } from '../common/workflow-canonical';
import { WorkflowCompiler } from './workflow-compiler';
import { workflowLog } from './workflow-logger';
import type { OperationsOwnerSink, OwnerEventV1, SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';
import { KoggModeOperationAuthorizer, type ModeOperationAuthorizer } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import { KoggAgentBindingAuthorizer, KoggAgentsService, type AgentBindingAuthorizer, type AgentBindingAuthorizationRequestV1, type AgentMutationResult, type AgentSafeCode, type AttemptProjectionV1, type KoggAgentsService as AgentAttemptDispatcher } from '@kogg/agents/lib/common/agents-protocol';
import { TaskAdmissionAuthority, type TaskAdmissionAuthority as TaskAdmissionResolver, type TaskAdmissionSnapshot } from '@kogg/tasks/lib/common/tasks-protocol';

// Logs through the closed workflowLog schemas.
// diagnostic-coverage: workflow.schema, workflow.catalog, workflow.graph, workflow.anchors, workflow.authority, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.recovery, workflow.source-maps

type Row = Record<string, SQLOutputValue>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEGACY_UNATTESTED_CATALOG = '0'.repeat(64);

@injectable()
export class WorkflowRegistry implements KoggWorkflowService, BackendApplicationContribution {
  @inject(TaskAdmissionAuthority) @optional() private taskAdmissionAuthority: TaskAdmissionResolver | undefined;
  @inject(KoggAgentsService) @optional() private agentAttemptDispatcher: AgentAttemptDispatcher | undefined;
  private database: DatabaseSync | undefined;
  private readonly schedulerEpochId = randomUUID();
  private readonly schedulerFencingToken = randomUUID();
  private ownerSink: OperationsOwnerSink | undefined;
  constructor(@inject(WorkflowCompiler) private readonly compiler: WorkflowCompiler,
    @inject(KoggModeOperationAuthorizer) private readonly modeAuthority: ModeOperationAuthorizer,
    @inject(KoggAgentBindingAuthorizer) private readonly agentBindingAuthority: AgentBindingAuthorizer,
    @unmanaged() private readonly databasePath = path.join(stateRoot(), 'workflow', 'registry.sqlite3')) {}

  async onStart(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      this.migrate(); this.assertIntegrity(); const stored = await this.diagnostics(); if (!stored.integrity || !stored.foreignKeys || !stored.immutableTriggers || !stored.schedulerIntegrity || !stored.ownerIntegrity || stored.canonicalMismatchCount || stored.catalogMismatchCount || stored.planMismatchCount) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY');
      const versionCount = this.versionCount(); const pending = this.schedulerRecoveryCounts(); workflowLog('recovery.started', { versionCount, activeRunCount: pending.activeRunCount, pendingOutboxCount: pending.pendingOutboxCount });
      const recovery = this.recoverScheduler(pending);
      this.publishOwnerEvents();
      await fs.chmod(this.databasePath, 0o600).catch(error => { if (process.platform !== 'win32') throw error; });
      workflowLog('recovery.completed', { versionCount, activeProcessCount: 0, quarantinedRunCount: recovery.quarantinedRunCount });
    } catch (error) {
      // observability-exempt: diagnostics.failed records the sanitized startup failure without raw database text.
      this.database?.close(); this.database = undefined; workflowLog('diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); throw error;
    }
  }

  async onStop(): Promise<void> { workflowLog('registry.stop.started', {}); try { this.ownerSink = undefined; this.database?.prepare("UPDATE scheduler_lease SET phase='released',updated_at=? WHERE singleton=1 AND owner_epoch_id=? AND phase='active'").run(new Date().toISOString(), this.schedulerEpochId); this.database?.close(); this.database = undefined; workflowLog('registry.stop.completed', {}); } catch (error) { /* observability-exempt: registry.stop.failed emits only a normalized error type. */ workflowLog('registry.stop.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); throw error; } }

  setOwnerSink(sink?: OperationsOwnerSink): void { this.ownerSink = sink; if (sink && this.database) this.publishOwnerEvents(); }
  setTaskAdmissionAuthority(authority: TaskAdmissionResolver): void { this.taskAdmissionAuthority = authority; }
  setAgentAttemptDispatcher(dispatcher: AgentAttemptDispatcher): void { this.agentAttemptDispatcher = dispatcher; }

  publishOwnerEvents(): void {
    if (!this.ownerSink || !this.database) return;
    const meta = this.database.prepare('SELECT owner_id,owner_epoch_id FROM workflow_owner_meta WHERE singleton=1').get() as Row;
    let previous = '0'.repeat(64);
    for (const row of this.database.prepare(`SELECT e.*,r.plan_id,r.task_id,v.graph_json FROM workflow_scheduler_events e JOIN workflow_runs r ON r.run_id=e.run_id JOIN compiled_plans p ON p.plan_id=r.plan_id JOIN template_versions v ON v.version_id=p.version_id ORDER BY e.sequence`).all() as Row[]) {
      if (text(row, 'previous_event_digest') !== sourcePreviousDigest(this.database, number(row, 'sequence')) || schedulerEventDigest(row) !== text(row, 'event_digest')) {
        workflowLog('owner.publish.failed', { safeCode: 'WORKFLOW_STORE_INTEGRITY', errorType: 'OwnerEventIntegrityError' }); break;
      }
      let projectId: string;
      try { projectId = this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown).projectId; }
      catch { // observability-exempt: the closed owner publication event reports a fixed correlation-integrity class without graph content.
        workflowLog('owner.publish.failed', { safeCode: 'WORKFLOW_STORE_INTEGRITY', errorType: 'OwnerCorrelationIntegrityError' }); break;
      }
      const mapped = mapOwnerEvent(row, text(meta, 'owner_id'), text(meta, 'owner_epoch_id'), projectId, previous); previous = mapped.eventDigest;
      try { this.ownerSink.ingest(mapped); }
      catch (error) { // observability-exempt: the closed owner publication event records only a normalized failure type.
        workflowLog('owner.publish.failed', { safeCode: 'WORKFLOW_STORE_INTEGRITY', errorType: error instanceof Error ? error.name : 'UnknownError' }); break;
      }
    }
  }
  async validate(graph: unknown): Promise<WorkflowValidationProjection> { workflowLog('draft.command.requested', { operation: 'validate' }); const result = this.compiler.validate(graph); if (result.valid) workflowLog('draft.command.completed', { operation: 'validate', nodeCount: result.nodeCount, edgeCount: result.edgeCount }); else workflowLog('draft.command.refused', { operation: 'validate', safeCode: result.code }); return result; }

  async saveVersion(input: { requestId: string; templateId: string; expectedVersionNumber: number; graph: unknown }): Promise<WorkflowMutationResult> {
    workflowLog('template.version.requested', { requestId: safeId(input.requestId), templateId: safeId(input.templateId) });
    try {
      uuid(input.requestId); uuid(input.templateId); if (!Number.isSafeInteger(input.expectedVersionNumber) || input.expectedVersionNumber < 0) throw new WorkflowValidationError('WORKFLOW_SCHEMA_INVALID');
      const graph = this.compiler.decodeAndValidate(input.graph); const requestDigest = workflowDigest('template', { ...input, graph });
      const result = this.transaction(input.requestId, requestDigest, () => {
        const current = this.currentVersion(input.templateId); if (current !== input.expectedVersionNumber) return { kind: 'conflict', code: 'WORKFLOW_VERSION_CONFLICT', currentVersionNumber: current } as const;
        const versionId = randomUUID(); const versionNumber = current + 1; const graphDigest = workflowDigest('template', graph); const createdAt = new Date().toISOString();
        const catalogDigest = this.compiler.catalogStatus().digest;
        this.db().prepare('INSERT INTO template_versions(version_id,template_id,version_number,graph_digest,catalog_digest,graph_json,created_at) VALUES(?,?,?,?,?,?,?)').run(versionId, input.templateId, versionNumber, graphDigest, catalogDigest, canonicalJson(graph), createdAt);
        return { kind: 'completed', code: 'WORKFLOW_OK', version: { templateId: input.templateId, versionId, versionNumber, graphDigest, catalogDigest, createdAt } } as const;
      });
      if (result.kind === 'completed' && result.version) workflowLog('template.version.created', { requestId: input.requestId, templateId: input.templateId, versionId: result.version.versionId, versionNumber: result.version.versionNumber });
      else workflowLog('template.version.refused', { requestId: input.requestId, templateId: input.templateId, safeCode: result.code });
      return result;
    } catch (error) {
      // observability-exempt: template.version.refused is the sanitized terminal event for every validation/storage refusal.
      const code = codeOf(error); workflowLog('template.version.refused', { requestId: safeId(input.requestId), templateId: safeId(input.templateId), safeCode: code }); return { kind: code === 'WORKFLOW_VERSION_CONFLICT' ? 'conflict' : 'refused', code };
    }
  }

  async compile(input: { requestId: string; versionId: string }): Promise<WorkflowMutationResult> {
    workflowLog('compile.started', { requestId: safeId(input.requestId), versionId: safeId(input.versionId) });
    try {
      uuid(input.requestId); uuid(input.versionId); const row = this.version(input.versionId); const graph = this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown);
      if (text(row, 'catalog_digest') !== this.compiler.catalogStatus().digest) throw new WorkflowValidationError('WORKFLOW_CATALOG_MISMATCH');
      const requestDigest = workflowDigest('compiled-plan', input);
      const result = this.transaction(input.requestId, requestDigest, () => {
        const prior = this.db().prepare('SELECT * FROM compiled_plans WHERE version_id=?').get(input.versionId) as Row | undefined;
        if (prior) return { kind: 'completed', code: 'WORKFLOW_OK', plan: plan(prior) } as const;
        const projection = this.compiler.compile(input.versionId, graph);
        this.db().prepare('INSERT INTO compiled_plans(plan_id,version_id,plan_digest,graph_digest,catalog_digest,trust_spine_digest,editable_node_count,injected_anchor_count) VALUES(?,?,?,?,?,?,?,?)').run(projection.planId, projection.versionId, projection.planDigest, projection.graphDigest, projection.catalogDigest, projection.trustSpineDigest, projection.editableNodeCount, projection.injectedAnchorCount);
        return { kind: 'completed', code: 'WORKFLOW_OK', plan: projection } as const;
      });
      if (result.kind === 'completed' && result.plan) workflowLog('compile.completed', { requestId: input.requestId, versionId: input.versionId, planId: result.plan.planId });
      return result;
    } catch (error) {
      // observability-exempt: compile.refused is the sanitized terminal event for missing or invalid versions.
      const code = codeOf(error); workflowLog('compile.refused', { requestId: safeId(input.requestId), versionId: safeId(input.versionId), safeCode: code }); return { kind: 'refused', code };
    }
  }

  async admitRun(input: { requestId: string; planId: string; taskAdmissionId: string }): Promise<WorkflowMutationResult> {
    workflowLog('run.admission.requested', { requestId: safeId(input.requestId), planId: safeId(input.planId), taskAdmissionId: safeId(input.taskAdmissionId) });
    let unavailableExecutorCount = 0;
    try {
      uuid(input.requestId); uuid(input.planId); uuid(input.taskAdmissionId);
      const storedPlan = this.compiledPlan(input.planId); const storedVersion = this.version(text(storedPlan, 'version_id'));
      const graph = this.compiler.decodeAndValidate(JSON.parse(text(storedVersion, 'graph_json')) as unknown);
      const catalog = this.compiler.catalogStatus();
      if (text(storedPlan, 'catalog_digest') !== catalog.digest || text(storedVersion, 'catalog_digest') !== catalog.digest) throw new WorkflowValidationError('WORKFLOW_CATALOG_MISMATCH');
      this.compiler.assertPlanIntegrity(plan(storedPlan), graph);
      let taskAdmission: TaskAdmissionSnapshot | undefined;
      try { taskAdmission = await this.taskAdmissionAuthority?.resolveAdmission(input.taskAdmissionId); }
      catch { // observability-exempt: the closed authority refusal excludes task-admission implementation details.
        taskAdmission = undefined;
      }
      const taskAdmissionDigest = taskAdmission ? workflowDigest('run-snapshot', { schemaVersion: '1', taskAdmission }) : LEGACY_UNATTESTED_CATALOG;
      const requestDigest = workflowDigest('run-snapshot', { schemaVersion: '1', planId: input.planId, planDigest: text(storedPlan, 'plan_digest'), taskAdmissionId: input.taskAdmissionId, taskAdmissionDigest });
      const refuseAuthority = (): WorkflowMutationResult => {
        const result = this.transaction(input.requestId, requestDigest, () => ({ kind: 'refused', code: 'WORKFLOW_AUTHORITY_EXPANSION' } as const));
        workflowLog('run.admission.refused', { requestId: input.requestId, planId: input.planId, taskAdmissionId: input.taskAdmissionId, safeCode: result.code, unavailableExecutorCount: 0 }); return result;
      };
      if (!taskAdmission || !validTaskAdmission(taskAdmission, input.taskAdmissionId) || taskAdmission.projectId !== graph.projectId) return refuseAuthority();
      let authority: Awaited<ReturnType<ModeOperationAuthorizer['authorizeOperation']>>;
      try { authority = await this.modeAuthority.authorizeOperation({ requestId: input.requestId, taskId: taskAdmission.taskId, operation: 'governed-entry' }); }
      catch { // observability-exempt: the closed admission refusal records only the fixed authority safe code and no upstream error content.
        return refuseAuthority();
      }
      if (!authority.allowed || authority.projection.state !== 'ready' || authority.projection.taskId !== taskAdmission.taskId || authority.projection.projectId !== graph.projectId || authority.projection.repositoryId !== taskAdmission.repositoryId) {
        return refuseAuthority();
      }
      for (const node of graph.nodes.filter(candidate => candidate.kind.endsWith('.agent'))) {
        const binding = agentBinding(node.configuration);
        if (!binding) return refuseAuthority();
        let resolved: Awaited<ReturnType<AgentBindingAuthorizer['authorizeBinding']>>;
        try { resolved = await this.agentBindingAuthority.authorizeBinding(binding); }
        catch { // observability-exempt: the closed workflow authority refusal excludes upstream errors and immutable configuration content.
          return refuseAuthority();
        }
        if (!resolved.allowed) return refuseAuthority();
      }
      const agentNodeCount = graph.nodes.filter(node => node.kind.endsWith('.agent')).length;
      unavailableExecutorCount = graph.nodes.filter(node => this.compiler.catalogEntry(node.kind).executor.status === 'unavailable').length;
      if (agentNodeCount) {
        try { if (!this.agentAttemptDispatcher || (await this.agentAttemptDispatcher.snapshot()).admission !== 'enabled') unavailableExecutorCount += agentNodeCount; }
        catch { // observability-exempt: executor health refusal excludes agent-registry implementation details.
          unavailableExecutorCount += agentNodeCount;
        }
      }
      if (unavailableExecutorCount > 0) {
        const result = this.transaction(input.requestId, requestDigest, () => ({ kind: 'refused', code: 'WORKFLOW_EXECUTOR_INCOMPATIBLE' } as const));
        workflowLog('run.admission.refused', { requestId: input.requestId, planId: input.planId, taskAdmissionId: input.taskAdmissionId, safeCode: result.code, unavailableExecutorCount }); return result;
      }
      const admitted = this.transaction(input.requestId, requestDigest, () => this.createControlRun(input.planId, text(storedPlan, 'plan_digest'), graph, taskAdmission, taskAdmissionDigest));
      if (admitted.kind !== 'completed' || !admitted.run || admitted.run.state !== 'admitted') return admitted;
      workflowLog('run.admitted', { requestId: input.requestId, planId: input.planId, taskAdmissionId: input.taskAdmissionId, runId: admitted.run.runId, nodeCount: graph.nodes.length });
      const completed = await this.executeRun(admitted.run.runId, input.planId, graph, taskAdmission.taskAdmissionId); this.db().prepare('UPDATE idempotency SET result_json=? WHERE request_id=?').run(JSON.stringify(completed), input.requestId); this.publishOwnerEvents(); return completed;
    } catch (error) {
      // observability-exempt: run.admission.refused is the sanitized terminal event and excludes graph, configuration, and executor details.
      const code = codeOf(error); workflowLog('run.admission.refused', { requestId: safeId(input.requestId), planId: safeId(input.planId), taskAdmissionId: safeId(input.taskAdmissionId), safeCode: code, unavailableExecutorCount }); return { kind: 'refused', code };
    }
  }

  async listVersions(templateId: string): Promise<readonly WorkflowTemplateVersionProjection[]> { uuid(templateId); return (this.db().prepare('SELECT * FROM template_versions WHERE template_id=? ORDER BY version_number').all(templateId) as Row[]).map(versionProjection); }

  async listProjectVersions(projectId: string): Promise<readonly WorkflowTemplateVersionProjection[]> {
    workflowLog('template.list.requested', { projectId: safeId(projectId) });
    try {
      uuid(projectId); const versions: WorkflowTemplateVersionProjection[] = [];
      for (const row of this.db().prepare('SELECT * FROM template_versions ORDER BY created_at,version_number').all() as Row[]) {
        const graph = this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown);
        if (graph.projectId === projectId) versions.push(versionProjection(row));
      }
      workflowLog('template.list.completed', { projectId, versionCount: versions.length }); return versions;
    } catch (error) {
      const code = codeOf(error); workflowLog('template.list.refused', { projectId: safeId(projectId), safeCode: code }); throw error;
    }
  }

  async diagnostics(): Promise<{ integrity: boolean; foreignKeys: boolean; immutableTriggers: boolean; canonicalMismatchCount: number; catalogMismatchCount: number; catalogEntryCount: number; availableExecutorCount: number; unavailableExecutorCount: number; planMismatchCount: number; versionCount: number; planCount: number; schedulerIntegrity: boolean; ownerIntegrity: boolean; ownerEventCount: number; schedulerLeaseActive: boolean; schedulerAdmission: 'enabled' | 'blocked' | 'recovering'; pendingOutboxCount: number; quarantinedRunCount: number; activeProcessCount: number; residualProcessCount: number; recoveryBacklogCount: number; sourceMapsPresent: boolean }> {
    const db = this.db(); const integrity = text(db.prepare('PRAGMA quick_check').get() as Row, 'quick_check') === 'ok'; const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length === 0;
    const immutableTriggers = number(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'workflow_immutable_%'").get() as Row, 'count') === 8;
    let canonicalMismatchCount = 0; for (const row of db.prepare('SELECT graph_json,graph_digest FROM template_versions').all() as Row[]) { try { const graph = this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown); if (workflowDigest('template', graph) !== text(row, 'graph_digest')) canonicalMismatchCount++; } catch { /* observability-exempt: aggregate canonical mismatch count is the diagnostic signal; content is never logged. */ canonicalMismatchCount++; } }
    const catalog = this.compiler.catalogStatus();
    const catalogMismatchCount = number(db.prepare('SELECT count(*) AS count FROM template_versions WHERE catalog_digest<>?').get(catalog.digest) as Row, 'count') + number(db.prepare('SELECT count(*) AS count FROM compiled_plans WHERE catalog_digest<>?').get(catalog.digest) as Row, 'count') + (catalog.valid ? 0 : 1);
    let planMismatchCount = 0; for (const row of db.prepare('SELECT * FROM compiled_plans').all() as Row[]) { try { const version = this.version(text(row, 'version_id')); const graph = this.compiler.decodeAndValidate(JSON.parse(text(version, 'graph_json')) as unknown); if (text(row, 'graph_digest') !== text(version, 'graph_digest') || text(row, 'catalog_digest') !== text(version, 'catalog_digest')) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); this.compiler.assertPlanIntegrity(plan(row), graph); } catch { /* observability-exempt: aggregate plan mismatch count is the diagnostic signal; plan contents are never logged. */ planMismatchCount++; } }
    const packageRuntime = path.basename(__filename) === 'workflow-registry.js'; const sourceMapsPresent = existsSync(`${__filename}.map`) && (!packageRuntime || (existsSync(path.join(__dirname, 'workflow-compiler.js.map')) && existsSync(path.join(__dirname, 'workflow-node-catalog.js.map')) && existsSync(path.join(__dirname, 'workflow-executor-registry.js.map')) && existsSync(path.join(__dirname, '..', 'browser', 'workflow-editor-widget.js.map'))));
    const lease = db.prepare('SELECT phase,admission FROM scheduler_lease WHERE singleton=1').get() as Row | undefined;
    const pendingOutboxCount = number(db.prepare("SELECT count(*) AS count FROM workflow_outbox WHERE phase IN ('requested','claimed')").get() as Row, 'count');
    const quarantinedRunCount = number(db.prepare("SELECT count(*) AS count FROM workflow_runs WHERE state='quarantined'").get() as Row, 'count');
    const residualProcessCount = number(db.prepare('SELECT coalesce(sum(residual_process_count),0) AS count FROM workflow_runs').get() as Row, 'count');
    const schedulerIntegrity = this.schedulerEventsValid() && this.schedulerRecordsValid();
    const ownerIntegrity = this.ownerIdentityValid(); const ownerEventCount = number(db.prepare('SELECT count(*) AS count FROM workflow_scheduler_events').get() as Row, 'count');
    return { integrity: integrity && schedulerIntegrity && ownerIntegrity, foreignKeys, immutableTriggers, canonicalMismatchCount, catalogMismatchCount, catalogEntryCount: catalog.entryCount, availableExecutorCount: catalog.availableExecutorCount, unavailableExecutorCount: catalog.unavailableExecutorCount, planMismatchCount, versionCount: this.versionCount(), planCount: number(db.prepare('SELECT count(*) AS count FROM compiled_plans').get() as Row, 'count'), schedulerIntegrity, ownerIntegrity, ownerEventCount, schedulerLeaseActive: lease ? text(lease, 'phase') === 'active' : false, schedulerAdmission: lease ? text(lease, 'admission') as 'enabled' | 'blocked' | 'recovering' : 'recovering', pendingOutboxCount, quarantinedRunCount, activeProcessCount: 0, residualProcessCount, recoveryBacklogCount: pendingOutboxCount + quarantinedRunCount, sourceMapsPresent };
  }

  private transaction(requestId: string, requestDigest: string, action: () => WorkflowMutationResult): WorkflowMutationResult {
    const db = this.db(); db.exec('BEGIN IMMEDIATE');
    try { const prior = db.prepare('SELECT request_digest,result_json FROM idempotency WHERE request_id=?').get(requestId) as Row | undefined; if (prior) { if (text(prior, 'request_digest') !== requestDigest) throw new WorkflowValidationError('WORKFLOW_VERSION_CONFLICT'); db.exec('ROLLBACK'); return JSON.parse(text(prior, 'result_json')) as WorkflowMutationResult; } const result = action(); db.prepare('INSERT INTO idempotency(request_id,request_digest,result_json) VALUES(?,?,?)').run(requestId, requestDigest, JSON.stringify(result)); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* observability-exempt: the original sanitized operation refusal remains authoritative. */ } throw error; }
  }
  private createControlRun(planId: string, planDigest: string, graph: EditableWorkflowGraphV1, taskAdmission: TaskAdmissionSnapshot, taskAdmissionDigest: string): WorkflowMutationResult {
    const runId = taskAdmission.runId; const now = new Date().toISOString();
    if (this.db().prepare('SELECT 1 FROM workflow_runs WHERE run_id=?').get(runId)) throw new WorkflowValidationError('WORKFLOW_VERSION_CONFLICT');
    this.db().prepare("INSERT INTO workflow_runs(run_id,plan_id,plan_digest,task_admission_id,task_admission_digest,task_id,repository_id,state,revision,owner_epoch_id,safe_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'admitted',1,?,'WORKFLOW_OK',?,?)").run(runId, planId, planDigest, taskAdmission.taskAdmissionId, taskAdmissionDigest, taskAdmission.taskId, taskAdmission.repositoryId, this.schedulerEpochId, now, now);
    const insert = this.db().prepare("INSERT INTO workflow_node_attempts(run_id,node_id,attempt,state,fencing_token,safe_code,updated_at) VALUES(?,?,1,'pending',?,'WORKFLOW_OK',?)"); for (const node of graph.nodes) insert.run(runId, node.nodeId, this.schedulerFencingToken, now);
    this.schedulerEvent(runId, 'run.admitted', 'WORKFLOW_OK', now); return { kind: 'completed', code: 'WORKFLOW_OK', run: { runId, planId, taskAdmissionId: taskAdmission.taskAdmissionId, state: 'admitted', safeCode: 'WORKFLOW_OK', completedNodeCount: 0, skippedNodeCount: 0, failedNodeCount: 0 } };
  }
  private async executeRun(runId: string, planId: string, graph: EditableWorkflowGraphV1, taskAdmissionId: string): Promise<WorkflowMutationResult> {
    const outputs = new Map<string, SchedulerOutcome>(); const pending = new Map(graph.nodes.map(node => [node.nodeId, node])); let completedNodeCount = 0; let skippedNodeCount = 0;
    while (pending.size) {
      const candidate = [...pending.values()].map(node => ({ node, routing: route(node.nodeId, graph, outputs) })).find(item => item.routing !== 'waiting');
      if (!candidate) return this.finishControlRun(runId, planId, 'failed', 'WORKFLOW_CONDITION_INVALID', completedNodeCount, skippedNodeCount, pending.size);
      const { node, routing } = candidate;
      if (routing === 'skipped') { const now = new Date().toISOString(); this.schedulerTransaction(() => { this.db().prepare("UPDATE workflow_node_attempts SET state='cancelled',routing_state='skipped',safe_code='WORKFLOW_OK',updated_at=? WHERE run_id=? AND node_id=? AND attempt=1 AND state='pending'").run(now, runId, node.nodeId); }); outputs.set(node.nodeId, 'skipped'); pending.delete(node.nodeId); skippedNodeCount++; workflowLog('node.routing.skipped', { runId, nodeId: node.nodeId, nodeKind: node.kind, safeCode: 'WORKFLOW_OK', processCount: 0, residualProcessCount: 0 }); continue; }
      const predecessorOutcomes = graph.edges.filter(edge => edge.targetNodeId === node.nodeId).map(edge => predecessorOutcome(edge, outputs));
      const now = new Date().toISOString(); const outboxId = randomUUID(); const requestDigest = workflowDigest('run-snapshot', { schemaVersion: '1', runId, nodeId: node.nodeId, attempt: 1, configurationDigest: node.configurationDigest });
      this.schedulerTransaction(() => { this.db().prepare("UPDATE workflow_runs SET state='running',revision=revision+1,updated_at=? WHERE run_id=? AND state IN ('admitted','running')").run(now, runId); this.db().prepare("UPDATE workflow_node_attempts SET state='running',updated_at=? WHERE run_id=? AND node_id=? AND attempt=1 AND state='pending'").run(now, runId, node.nodeId); this.db().prepare("INSERT INTO workflow_outbox(outbox_id,run_id,node_id,operation_kind,request_digest,fencing_token,phase,safe_code,created_at,updated_at) VALUES(?,?,?,?,?,?,'claimed','WORKFLOW_OK',?,?)").run(outboxId, runId, node.nodeId, node.kind, requestDigest, this.schedulerFencingToken, now, now); });
      const result = node.kind.endsWith('.agent') ? await this.executeAgentNode(runId, taskAdmissionId, node, outboxId) : this.compiler.executeControl({ runId, node, attempt: 1, predecessorOutcomes }); const finishedAt = new Date().toISOString();
      this.schedulerTransaction(() => { this.db().prepare("UPDATE workflow_outbox SET phase='completed',safe_code=?,updated_at=? WHERE outbox_id=? AND phase='claimed'").run(result.code, finishedAt, outboxId); this.db().prepare("UPDATE workflow_node_attempts SET state=?,safe_code=?,updated_at=? WHERE run_id=? AND node_id=? AND attempt=1 AND state='running'").run(result.kind === 'completed' ? 'succeeded' : 'failed', result.code, finishedAt, runId, node.nodeId); });
      if (result.kind !== 'completed' || !result.output) return this.finishControlRun(runId, planId, 'failed', result.code, completedNodeCount, skippedNodeCount, 1, result.residualProcessCount);
      outputs.set(node.nodeId, result.output); pending.delete(node.nodeId); completedNodeCount++;
    }
    return this.finishControlRun(runId, planId, 'completed', 'WORKFLOW_OK', completedNodeCount, skippedNodeCount, 0);
  }
  private async executeAgentNode(runId: string, taskAdmissionId: string, node: EditableWorkflowGraphV1['nodes'][number], requestId: string): Promise<{ readonly kind: 'completed' | 'refused'; readonly code: WorkflowSafeCode; readonly output?: 'success'; readonly processCount: number; readonly residualProcessCount: number }> {
    const dispatcher = this.agentAttemptDispatcher; const configuration = node.configuration; const binding = configuration && agentBinding(configuration); const fields = { runId, nodeId: node.nodeId, nodeKind: node.kind, attempt: 1, executorId: 'kogg.agents.registry' };
    workflowLog('node.execution.started', fields);
    if (!dispatcher || !configuration || !binding) return agentRefused(fields, 'WORKFLOW_EXECUTOR_INCOMPATIBLE', 0);
    try {
      const snapshot = await dispatcher.snapshot();
      const started = await dispatcher.startAttempt({ schemaVersion: '1', requestId, expectedRegistryRevision: snapshot.registryRevision, taskAdmissionId, ...binding });
      if (started.attempt) this.db().prepare('UPDATE workflow_node_attempts SET external_attempt_id=? WHERE run_id=? AND node_id=? AND attempt=1').run(started.attempt.attemptId, runId, node.nodeId);
      if (started.kind !== 'completed' || !started.attempt) return agentRefused(fields, agentWorkflowCode(started.code), residualFor(started));
      const terminal = await this.waitForAgentAttempt(dispatcher, started.attempt, configuration.absoluteDeadlineMs); const terminalAttempt = terminal.attempt;
      const residualProcessCount = terminalAttempt.state === 'cleanup_failed' || terminalAttempt.state === 'unverified_residual' ? 1 : 0;
      if (terminal.timedOut) return agentRefused(fields, residualProcessCount ? 'WORKFLOW_RESIDUAL_PROCESS' : 'WORKFLOW_DEADLINE', residualProcessCount);
      if (terminalAttempt.state === 'cleaned' && terminalAttempt.terminalCode === 'AGENT_OK') { workflowLog('node.execution.completed', { ...fields, output: 'success', safeCode: 'WORKFLOW_OK', processCount: 0, residualProcessCount: 0 }); return { kind: 'completed', code: 'WORKFLOW_OK', output: 'success', processCount: 0, residualProcessCount: 0 }; }
      return agentRefused(fields, agentWorkflowCode(terminalAttempt.terminalCode), residualProcessCount);
    } catch (error) { // observability-exempt: node.execution.refused emits only the closed workflow failure code and opaque correlations.
      const code = codeOf(error); return agentRefused(fields, code, code === 'WORKFLOW_RESIDUAL_PROCESS' ? 1 : 0);
    }
  }
  private async waitForAgentAttempt(dispatcher: AgentAttemptDispatcher, initial: AttemptProjectionV1, deadlineMs: number): Promise<{ attempt: AttemptProjectionV1; timedOut: boolean }> {
    let current = initial; const deadline = Date.now() + deadlineMs;
    while (!terminalAgentAttempt(current) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); current = await dispatcher.getAttempt(current.attemptId); }
    if (terminalAgentAttempt(current)) return { attempt: current, timedOut: false };
    for (let retry = 0; retry < 2; retry++) {
      current = await dispatcher.getAttempt(current.attemptId); if (terminalAgentAttempt(current)) return { attempt: current, timedOut: true };
      const snapshot = await dispatcher.snapshot(); const cancelled = await dispatcher.cancelAttempt({ schemaVersion: '1', requestId: randomUUID(), expectedRegistryRevision: snapshot.registryRevision, expectedAttemptRevision: current.attemptRevision, attemptId: current.attemptId, reason: 'policy' });
      if (cancelled.attempt) current = cancelled.attempt; if (terminalAgentAttempt(current)) return { attempt: current, timedOut: true };
    }
    throw new WorkflowValidationError('WORKFLOW_RESIDUAL_PROCESS');
  }
  private finishControlRun(runId: string, planId: string, state: 'completed' | 'failed', safeCode: WorkflowSafeCode, completedNodeCount: number, skippedNodeCount: number, failedNodeCount: number, residualProcessCount = 0): WorkflowMutationResult {
    const now = new Date().toISOString(); this.schedulerTransaction(() => { if (state === 'failed') this.db().prepare("UPDATE workflow_node_attempts SET state='cancelled',safe_code=?,updated_at=? WHERE run_id=? AND state='pending'").run(safeCode, now, runId); this.db().prepare('UPDATE workflow_runs SET state=?,revision=revision+1,safe_code=?,residual_process_count=?,updated_at=? WHERE run_id=?').run(state, safeCode, residualProcessCount, now, runId); this.schedulerEvent(runId, state === 'completed' ? 'run.completed' : 'run.failed', safeCode, now); });
    const taskAdmissionId = text(this.db().prepare('SELECT task_admission_id FROM workflow_runs WHERE run_id=?').get(runId) as Row, 'task_admission_id'); const run: WorkflowRunProjection = { runId, planId, taskAdmissionId, state, safeCode, completedNodeCount, skippedNodeCount, failedNodeCount };
    if (state === 'completed') { workflowLog('run.completed', { planId, runId, completedNodeCount, skippedNodeCount, safeCode: 'WORKFLOW_OK', processCount: 0, residualProcessCount: 0 }); return { kind: 'completed', code: 'WORKFLOW_OK', run }; }
    workflowLog('run.failed', { planId, runId, completedNodeCount, skippedNodeCount, failedNodeCount, safeCode, processCount: 0, residualProcessCount }); return { kind: 'failed', code: safeCode, run };
  }
  private schedulerTransaction(action: () => void): void { const db = this.db(); db.exec('BEGIN IMMEDIATE'); try { action(); db.exec('COMMIT'); } catch (error) { try { db.exec('ROLLBACK'); } catch { /* observability-exempt: the originating scheduler failure remains authoritative. */ } throw error; } }
  private migrate(): void { this.db().exec(`CREATE TABLE IF NOT EXISTS template_versions(version_id TEXT PRIMARY KEY,template_id TEXT NOT NULL,version_number INTEGER NOT NULL CHECK(version_number>0),graph_digest TEXT NOT NULL,catalog_digest TEXT NOT NULL,graph_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(template_id,version_number));
    CREATE TABLE IF NOT EXISTS compiled_plans(plan_id TEXT PRIMARY KEY,version_id TEXT NOT NULL UNIQUE REFERENCES template_versions(version_id),plan_digest TEXT NOT NULL UNIQUE,graph_digest TEXT NOT NULL,catalog_digest TEXT NOT NULL,trust_spine_digest TEXT NOT NULL,editable_node_count INTEGER NOT NULL,injected_anchor_count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,result_json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_versions_update BEFORE UPDATE ON template_versions BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_versions_delete BEFORE DELETE ON template_versions BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_plans_update BEFORE UPDATE ON compiled_plans BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_plans_delete BEFORE DELETE ON compiled_plans BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TABLE IF NOT EXISTS scheduler_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_epoch_id TEXT NOT NULL,fencing_token TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('active','released')),admission TEXT NOT NULL CHECK(admission IN ('enabled','blocked','recovering')),updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_runs(run_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES compiled_plans(plan_id),plan_digest TEXT NOT NULL,task_admission_id TEXT NOT NULL DEFAULT '',task_admission_digest TEXT NOT NULL DEFAULT '',task_id TEXT NOT NULL DEFAULT '',repository_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL CHECK(state IN ('admitted','running','stopping','completed','failed','cancelled','quarantined')),revision INTEGER NOT NULL CHECK(revision>=1),owner_epoch_id TEXT NOT NULL,safe_code TEXT NOT NULL,residual_process_count INTEGER NOT NULL DEFAULT 0 CHECK(residual_process_count>=0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_node_attempts(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),node_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>=1),state TEXT NOT NULL CHECK(state IN ('pending','ready','dispatched','running','succeeded','failed','cancelled','quarantined')),routing_state TEXT NOT NULL DEFAULT 'selected' CHECK(routing_state IN ('selected','skipped')),external_attempt_id TEXT NOT NULL DEFAULT '',fencing_token TEXT NOT NULL,safe_code TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,node_id,attempt));
    CREATE TABLE IF NOT EXISTS workflow_outbox(outbox_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),node_id TEXT NOT NULL,operation_kind TEXT NOT NULL,request_digest TEXT NOT NULL,fencing_token TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('requested','claimed','completed','quarantined')),safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_scheduler_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),event_name TEXT NOT NULL,safe_code TEXT NOT NULL,previous_event_digest TEXT NOT NULL,event_digest TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_scheduler_events_update BEFORE UPDATE ON workflow_scheduler_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_scheduler_events_delete BEFORE DELETE ON workflow_scheduler_events BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    this.db().exec(`CREATE TABLE IF NOT EXISTS workflow_owner_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL,owner_epoch_id TEXT NOT NULL,identity_digest TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_owner_meta_update BEFORE UPDATE ON workflow_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_owner_meta_delete BEFORE DELETE ON workflow_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    if (!this.db().prepare('SELECT 1 FROM workflow_owner_meta WHERE singleton=1').get()) { const ownerId = randomUUID(); const ownerEpochId = randomUUID(); this.db().prepare('INSERT INTO workflow_owner_meta(singleton,owner_id,owner_epoch_id,identity_digest) VALUES(1,?,?,?)').run(ownerId, ownerEpochId, workflowDigest('owner-identity', { ownerId, ownerEpochId })); }
    this.db().prepare("INSERT OR IGNORE INTO scheduler_lease(singleton,owner_epoch_id,fencing_token,phase,admission,updated_at) VALUES(1,?,?,'released','recovering',?)").run(this.schedulerEpochId, this.schedulerFencingToken, new Date().toISOString());
    this.ensureColumn('template_versions', 'catalog_digest', LEGACY_UNATTESTED_CATALOG); this.ensureColumn('compiled_plans', 'catalog_digest', LEGACY_UNATTESTED_CATALOG); this.ensureColumn('workflow_node_attempts', 'routing_state', 'selected'); this.ensureColumn('workflow_node_attempts', 'external_attempt_id', ''); this.ensureColumn('workflow_runs', 'task_admission_id', ''); this.ensureColumn('workflow_runs', 'task_admission_digest', ''); this.ensureColumn('workflow_runs', 'task_id', ''); this.ensureColumn('workflow_runs', 'repository_id', ''); this.ensureIntegerColumn('workflow_runs', 'residual_process_count'); }
  private ensureColumn(table: 'template_versions' | 'compiled_plans' | 'workflow_node_attempts' | 'workflow_runs', column: 'catalog_digest' | 'routing_state' | 'external_attempt_id' | 'task_admission_id' | 'task_admission_digest' | 'task_id' | 'repository_id', value: string): void { const present = (this.db().prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(row => text(row, 'name') === column); if (!present) this.db().exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${value}'`); }
  private ensureIntegerColumn(table: 'workflow_runs', column: 'residual_process_count'): void { const present = (this.db().prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(row => text(row, 'name') === column); if (!present) this.db().exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`); }
  private assertIntegrity(): void { const db = this.db(); if (text(db.prepare('PRAGMA quick_check').get() as Row, 'quick_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length || !this.schedulerEventsValid() || !this.ownerIdentityValid()) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); }
  private schedulerRecoveryCounts(): { activeRunCount: number; pendingOutboxCount: number } { return { activeRunCount: number(this.db().prepare("SELECT count(*) AS count FROM workflow_runs WHERE state IN ('admitted','running','stopping')").get() as Row, 'count'), pendingOutboxCount: number(this.db().prepare("SELECT count(*) AS count FROM workflow_outbox WHERE phase IN ('requested','claimed')").get() as Row, 'count') }; }
  private recoverScheduler(pending: { activeRunCount: number; pendingOutboxCount: number }): { activeRunCount: number; pendingOutboxCount: number; quarantinedRunCount: number } {
    const db = this.db(); const activeRuns = db.prepare("SELECT run_id FROM workflow_runs WHERE state IN ('admitted','running','stopping') ORDER BY run_id").all() as Row[]; const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE scheduler_lease SET admission='recovering',updated_at=? WHERE singleton=1").run(now);
      for (const row of activeRuns) {
        const runId = text(row, 'run_id'); db.prepare("UPDATE workflow_runs SET state='quarantined',revision=revision+1,safe_code='WORKFLOW_OUTCOME_UNKNOWN',updated_at=? WHERE run_id=? AND state IN ('admitted','running','stopping')").run(now, runId);
        db.prepare("UPDATE workflow_node_attempts SET state='quarantined',safe_code='WORKFLOW_OUTCOME_UNKNOWN',updated_at=? WHERE run_id=? AND state IN ('pending','ready','dispatched','running')").run(now, runId);
        db.prepare("UPDATE workflow_outbox SET phase='quarantined',safe_code='WORKFLOW_OUTCOME_UNKNOWN',updated_at=? WHERE run_id=? AND phase IN ('requested','claimed')").run(now, runId); this.schedulerEvent(runId, 'run.recovery.quarantined', 'WORKFLOW_OUTCOME_UNKNOWN', now); workflowLog('run.recovery.quarantined', { runId, safeCode: 'WORKFLOW_OUTCOME_UNKNOWN' });
      }
      const quarantinedRunCount = number(db.prepare("SELECT count(*) AS count FROM workflow_runs WHERE state='quarantined'").get() as Row, 'count');
      db.prepare("UPDATE scheduler_lease SET owner_epoch_id=?,fencing_token=?,phase='active',admission=?,updated_at=? WHERE singleton=1").run(this.schedulerEpochId, this.schedulerFencingToken, quarantinedRunCount ? 'blocked' : 'enabled', now); db.exec('COMMIT');
      return { activeRunCount: pending.activeRunCount, pendingOutboxCount: pending.pendingOutboxCount, quarantinedRunCount };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  private schedulerEvent(runId: string, eventName: string, safeCode: WorkflowSafeCode, createdAt: string): void {
    const prior = this.db().prepare('SELECT event_digest FROM workflow_scheduler_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousEventDigest = prior ? text(prior, 'event_digest') : '0'.repeat(64); const eventId = randomUUID();
    const eventDigest = workflowDigest('scheduler-event', { eventId, runId, eventName, safeCode, previousEventDigest, createdAt }); this.db().prepare('INSERT INTO workflow_scheduler_events(event_id,run_id,event_name,safe_code,previous_event_digest,event_digest,created_at) VALUES(?,?,?,?,?,?,?)').run(eventId, runId, eventName, safeCode, previousEventDigest, eventDigest, createdAt);
  }
  private schedulerEventsValid(): boolean {
    let previousEventDigest = '0'.repeat(64); for (const row of this.db().prepare('SELECT * FROM workflow_scheduler_events ORDER BY sequence').all() as Row[]) { const expected = workflowDigest('scheduler-event', { eventId: text(row, 'event_id'), runId: text(row, 'run_id'), eventName: text(row, 'event_name'), safeCode: text(row, 'safe_code'), previousEventDigest, createdAt: text(row, 'created_at') }); if (text(row, 'previous_event_digest') !== previousEventDigest || text(row, 'event_digest') !== expected) return false; previousEventDigest = expected; } return true;
  }
  private schedulerRecordsValid(): boolean {
    const mismatchedRuns = number(this.db().prepare('SELECT count(*) AS count FROM workflow_runs JOIN compiled_plans ON compiled_plans.plan_id=workflow_runs.plan_id WHERE workflow_runs.plan_digest<>compiled_plans.plan_digest').get() as Row, 'count');
    const malformedOutbox = number(this.db().prepare("SELECT count(*) AS count FROM workflow_outbox WHERE length(request_digest)<>64 OR request_digest GLOB '*[^0-9a-f]*'").get() as Row, 'count'); const malformedRouting = number(this.db().prepare("SELECT count(*) AS count FROM workflow_node_attempts WHERE routing_state NOT IN ('selected','skipped') OR (routing_state='skipped' AND (state<>'cancelled' OR safe_code<>'WORKFLOW_OK'))").get() as Row, 'count'); const malformedAttempts = number(this.db().prepare("SELECT count(*) AS count FROM workflow_node_attempts WHERE external_attempt_id<>'' AND length(external_attempt_id)<>36").get() as Row, 'count'); const malformedAdmissions = number(this.db().prepare("SELECT count(*) AS count FROM workflow_runs WHERE residual_process_count<0 OR NOT ((task_admission_id='' AND task_admission_digest='' AND task_id='' AND repository_id='') OR (length(task_admission_id)=36 AND length(task_admission_digest)=64 AND length(task_id)=36 AND length(repository_id)=36))").get() as Row, 'count'); return mismatchedRuns === 0 && malformedOutbox === 0 && malformedRouting === 0 && malformedAttempts === 0 && malformedAdmissions === 0;
  }
  private ownerIdentityValid(): boolean { const row = this.db().prepare('SELECT * FROM workflow_owner_meta WHERE singleton=1').get() as Row | undefined; if (!row) return false; const ownerId = text(row, 'owner_id'); const ownerEpochId = text(row, 'owner_epoch_id'); return UUID.test(ownerId) && UUID.test(ownerEpochId) && text(row, 'identity_digest') === workflowDigest('owner-identity', { ownerId, ownerEpochId }); }
  private currentVersion(templateId: string): number { const row = this.db().prepare('SELECT coalesce(max(version_number),0) AS count FROM template_versions WHERE template_id=?').get(templateId) as Row; return number(row, 'count'); }
  private version(versionId: string): Row { const row = this.db().prepare('SELECT * FROM template_versions WHERE version_id=?').get(versionId) as Row | undefined; if (!row) throw new WorkflowValidationError('WORKFLOW_SCHEMA_INVALID'); return row; }
  private compiledPlan(planId: string): Row { const row = this.db().prepare('SELECT * FROM compiled_plans WHERE plan_id=?').get(planId) as Row | undefined; if (!row) throw new WorkflowValidationError('WORKFLOW_SCHEMA_INVALID'); return row; }
  private versionCount(): number { return number(this.db().prepare('SELECT count(*) AS count FROM template_versions').get() as Row, 'count'); }
  private db(): DatabaseSync { if (!this.database) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); return this.database; }
}

function versionProjection(row: Row): WorkflowTemplateVersionProjection { return { templateId: text(row, 'template_id'), versionId: text(row, 'version_id'), versionNumber: number(row, 'version_number'), graphDigest: text(row, 'graph_digest'), catalogDigest: text(row, 'catalog_digest'), createdAt: text(row, 'created_at') }; }
function plan(row: Row) { return { planId: text(row, 'plan_id'), versionId: text(row, 'version_id'), planDigest: text(row, 'plan_digest'), graphDigest: text(row, 'graph_digest'), catalogDigest: text(row, 'catalog_digest'), trustSpineDigest: text(row, 'trust_spine_digest'), editableNodeCount: number(row, 'editable_node_count'), injectedAnchorCount: number(row, 'injected_anchor_count') }; }
function text(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); return value; }
function number(row: Row, key: string): number { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); return value; }
function uuid(value: string): void { if (!UUID.test(value)) throw new WorkflowValidationError('WORKFLOW_SCHEMA_INVALID'); }
function safeId(value: string): string { return UUID.test(value) ? value : 'invalid'; }
function terminalAgentAttempt(attempt: AttemptProjectionV1): boolean { return ['cleaned','cleanup_failed','recovered_terminal','unverified_residual'].includes(attempt.state); }
function residualFor(result: AgentMutationResult): number { return result.attempt && ['cleanup_failed','unverified_residual'].includes(result.attempt.state) ? 1 : 0; }
function agentWorkflowCode(code: AgentSafeCode | undefined): WorkflowSafeCode {
  if (code === 'AGENT_OK') return 'WORKFLOW_OK';
  if (code === 'CANCELLED' || code === 'CANCEL_GRACE_EXPIRED') return 'WORKFLOW_CANCELLED';
  if (code === 'HANDSHAKE_TIMEOUT' || code === 'FIRST_ACTIVITY_TIMEOUT' || code === 'IDLE_TIMEOUT' || code === 'PROVIDER_REQUEST_TIMEOUT' || code === 'ABSOLUTE_TIMEOUT') return 'WORKFLOW_DEADLINE';
  if (code === 'CLEANUP_FAILED' || code === 'RESOURCE_IDENTITY_UNVERIFIED' || code === 'RECOVERY_FAILED') return 'WORKFLOW_CLEANUP_FAILED';
  if (code === 'TASK_AUTHORITY_STALE' || code === 'PROJECT_BINDING_CHANGED' || code === 'POLICY_REFUSED' || code === 'ROLE_NOT_FOUND' || code === 'ROLE_REVISION_STALE' || code === 'ROLE_REVOKED' || code === 'PROVIDER_MISMATCH' || code === 'MODEL_MISMATCH' || code === 'CAPABILITY_MISMATCH') return 'WORKFLOW_AUTHORITY_EXPANSION';
  return 'WORKFLOW_EXTERNAL_FAILURE';
}
function agentRefused(fields: { runId: string; nodeId: string; nodeKind: string; attempt: number; executorId: string }, code: WorkflowSafeCode, residualProcessCount: number) { workflowLog('node.execution.refused', { ...fields, safeCode: code, processCount: 0, residualProcessCount }); return { kind: 'refused', code, processCount: 0, residualProcessCount } as const; }
function validTaskAdmission(admission: TaskAdmissionSnapshot, expectedId: string): boolean {
  const authorizedAt = Date.parse(admission.authorizedAt); const expiresAt = Date.parse(admission.expiresAt);
  return admission.taskAdmissionId === expectedId
    && [admission.taskAdmissionId, admission.taskId, admission.specificationId, admission.approvalId, admission.projectId, admission.repositoryId, admission.runId].every(value => UUID.test(value))
    && [admission.bindingRevision, admission.registryRevision, admission.taskRevision].every(value => /^(?:0|[1-9][0-9]*)$/u.test(value))
    && Number.isFinite(authorizedAt) && Number.isFinite(expiresAt) && authorizedAt <= expiresAt && expiresAt > Date.now();
}
function agentBinding(configuration: WorkflowNodeConfigurationV1 | undefined): AgentBindingAuthorizationRequestV1 | undefined {
  if (!configuration?.roleRevisionId || !configuration.providerId || !configuration.modelId || !configuration.adapterKey || !configuration.adapterVersion || !configuration.deadlinePolicyId) return undefined;
  return { roleRevisionId: configuration.roleRevisionId, providerId: configuration.providerId, modelId: configuration.modelId, adapterKey: configuration.adapterKey, adapterVersion: configuration.adapterVersion, deadlinePolicyId: configuration.deadlinePolicyId };
}
type SchedulerOutcome = 'success' | 'failure' | 'finally' | 'true' | 'false' | 'skipped';
function route(nodeId: string, graph: EditableWorkflowGraphV1, outputs: ReadonlyMap<string, SchedulerOutcome>): 'waiting' | 'ready' | 'skipped' { const incoming = graph.edges.filter(edge => edge.targetNodeId === nodeId); if (incoming.length === 0) return 'ready'; if (incoming.some(edge => !outputs.has(edge.sourceNodeId))) return 'waiting'; return incoming.some(edge => { const output = outputs.get(edge.sourceNodeId); return output !== 'skipped' && (edge.sourcePort === 'finally' || output === edge.sourcePort); }) ? 'ready' : 'skipped'; }
function predecessorOutcome(edge: EditableWorkflowGraphV1['edges'][number], outputs: ReadonlyMap<string, SchedulerOutcome>): 'success' | 'failure' | 'skipped' { const output = outputs.get(edge.sourceNodeId); if (!output || output === 'skipped' || (edge.sourcePort !== 'finally' && output !== edge.sourcePort)) return 'skipped'; return output === 'failure' ? 'failure' : 'success'; }
function codeOf(error: unknown): WorkflowSafeCode { return error instanceof WorkflowValidationError ? error.code : 'WORKFLOW_INTERNAL'; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state')); }

function sourcePreviousDigest(database: DatabaseSync, sequence: number): string { const row = database.prepare('SELECT event_digest FROM workflow_scheduler_events WHERE sequence<? ORDER BY sequence DESC LIMIT 1').get(sequence) as Row | undefined; return row ? text(row, 'event_digest') : '0'.repeat(64); }
function schedulerEventDigest(row: Row): string { return workflowDigest('scheduler-event', { eventId: text(row, 'event_id'), runId: text(row, 'run_id'), eventName: text(row, 'event_name'), safeCode: text(row, 'safe_code'), previousEventDigest: text(row, 'previous_event_digest'), createdAt: text(row, 'created_at') }); }
function mapOwnerEvent(row: Row, ownerInstanceId: string, epochId: string, projectId: string, previousEventDigest: string): OwnerEventV1 {
  const eventName = text(row, 'event_name'); const eventKind = eventName === 'run.admitted' ? 'run.started' : eventName === 'run.completed' ? 'run.completed' : 'run.failed';
  const lifecycle = eventKind === 'run.started' ? 'active' : eventKind === 'run.completed' ? 'completed' : 'failed'; const safePayload: SafeOwnerPayloadV1 = { lifecycle, ...(eventKind === 'run.started' ? {} : { terminalClass: lifecycle }), safeCode: text(row, 'safe_code'), freshness: 'current' };
  const taskId = text(row, 'task_id'); const unsigned: Omit<OwnerEventV1, 'eventDigest'> = { ownerKind: 'workflow', ownerInstanceId, ownerSchemaVersion: 1, epochId, sequence: String(number(row, 'sequence')), eventId: text(row, 'event_id'), eventKind, factId: text(row, 'run_id'), factDigest: text(row, 'event_digest'), previousEventDigest, causalParents: [], correlations: { projectId, ...(taskId ? { taskId } : {}), runId: text(row, 'run_id') }, observedAt: text(row, 'created_at'), safePayload };
  return { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) };
}
