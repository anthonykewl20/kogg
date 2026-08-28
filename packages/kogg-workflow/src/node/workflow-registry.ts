import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, optional, unmanaged } from '@theia/core/shared/inversify';
import { WORKFLOW_SAFE_CODES, type EditableWorkflowGraphV1, type KoggWorkflowService, type WorkflowApprovalReviewResult, type WorkflowMutationResult, type WorkflowNodeConfigurationV1, type WorkflowPlanSummary, type WorkflowRunProjection, type WorkflowSafeCode, type WorkflowTemplateVersionProjection, type WorkflowValidationProjection } from '../common/workflow-protocol';
import { canonicalJson, WorkflowValidationError, workflowDigest } from '../common/workflow-canonical';
import { WorkflowCompiler } from './workflow-compiler';
import { workflowLog } from './workflow-logger';
import type { OperationsOwnerSink, OwnerEventV1, SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';
import { KoggModeOperationAuthorizer, type ModeOperationAuthorizer } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import { KoggAgentBindingAuthorizer, KoggAgentsService, type AgentBindingAuthorizer, type AgentBindingAuthorizationRequestV1, type AgentMutationResult, type AgentSafeCode, type AttemptProjectionV1, type KoggAgentsService as AgentAttemptDispatcher } from '@kogg/agents/lib/common/agents-protocol';
import { TaskAdmissionAuthority, type TaskAdmissionAuthority as TaskAdmissionResolver, type TaskAdmissionSnapshot } from '@kogg/tasks/lib/common/tasks-protocol';
import { workflowSourceMapDiagnostics } from './workflow-source-map-diagnostics';

// Logs through the closed workflowLog schemas.
// diagnostic-coverage: workflow.schema, workflow.catalog, workflow.graph, workflow.anchors, workflow.authority, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.recovery, workflow.source-maps

type Row = Record<string, SQLOutputValue>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEGACY_UNATTESTED_CATALOG = '0'.repeat(64);
export type WorkflowExternalAnchorKind = 'anchor.producer-separated' | 'anchor.evidence-admitted' | 'anchor.ranex-pass-current' | 'anchor.merge-preflight' | 'anchor.controlled-merge';
type WorkflowAnchorKind = 'anchor.spec-frozen' | 'anchor.spec-approved' | WorkflowExternalAnchorKind | 'anchor.checks-complete' | 'anchor.cleanup-complete';
export interface WorkflowTrustSpineContractV1 { readonly schemaVersion: '1'; readonly authorityId: 'kogg.workflow.trust-spine'; readonly authorityVersion: '1.0.0'; readonly supportedAnchors: readonly WorkflowExternalAnchorKind[]; readonly artifactDigest: string; }
export interface WorkflowTrustAnchorRequestV1 { readonly runId: string; readonly anchor: WorkflowExternalAnchorKind; readonly planDigest: string; readonly trustSpineDigest: string; readonly taskAdmissionId: string; readonly taskAdmissionDigest: string; readonly repositoryId: string; readonly subjectStateDigest: string; readonly priorFactDigest: string; }
export type WorkflowTrustAnchorResultV1 = { readonly kind: 'completed'; readonly code: 'WORKFLOW_OK'; readonly subjectStateDigest: string; readonly factDigest: string; readonly ownerSequence: string; readonly processCount: number; readonly residualProcessCount: 0 } | { readonly kind: 'refused'; readonly code: Exclude<WorkflowSafeCode, 'WORKFLOW_OK'>; readonly processCount: number; readonly residualProcessCount: number };
export const WorkflowTrustSpineAuthority = Symbol('WorkflowTrustSpineAuthority');
export interface WorkflowTrustSpineAuthority { readiness(): { readonly ready: boolean; readonly recoveryComplete: boolean; readonly residualProcessCount: number }; contract(): WorkflowTrustSpineContractV1; execute(request: WorkflowTrustAnchorRequestV1): Promise<WorkflowTrustAnchorResultV1>; cancel(request: WorkflowTrustAnchorRequestV1): Promise<{ readonly code: WorkflowSafeCode; readonly processCount: number; readonly residualProcessCount: number }>; }
const EXTERNAL_ANCHORS: readonly WorkflowExternalAnchorKind[] = ['anchor.producer-separated','anchor.evidence-admitted','anchor.ranex-pass-current','anchor.merge-preflight','anchor.controlled-merge'];
const ANCHORS: readonly WorkflowAnchorKind[] = ['anchor.spec-frozen','anchor.spec-approved','anchor.producer-separated','anchor.checks-complete','anchor.evidence-admitted','anchor.ranex-pass-current','anchor.merge-preflight','anchor.controlled-merge','anchor.cleanup-complete'];
const ANCHOR_IDS: Readonly<Record<WorkflowAnchorKind, string>> = Object.freeze(Object.fromEntries(ANCHORS.map((anchor, index) => [anchor, `71000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`])) as Record<WorkflowAnchorKind, string>);
const TRUST_ANCHOR_DEADLINE_MS = 1_000;

@injectable()
export class WorkflowRegistry implements KoggWorkflowService, BackendApplicationContribution {
  @inject(TaskAdmissionAuthority) @optional() private taskAdmissionAuthority: TaskAdmissionResolver | undefined;
  @inject(KoggAgentsService) @optional() private agentAttemptDispatcher: AgentAttemptDispatcher | undefined;
  @inject(WorkflowTrustSpineAuthority) @optional() private trustSpineAuthority: WorkflowTrustSpineAuthority | undefined;
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
  setTrustSpineAuthority(authority: WorkflowTrustSpineAuthority): void { this.trustSpineAuthority = authority; }

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

  async beginContinuationReview(input: { requestId: string; runId: string; nodeId: string; sessionId: string }): Promise<WorkflowApprovalReviewResult> {
    const ids = { requestId: safeId(input.requestId), runId: safeId(input.runId), nodeId: safeId(input.nodeId) }; workflowLog('approval.review.requested', ids);
    try {
      uuid(input.requestId); uuid(input.runId); uuid(input.nodeId); uuid(input.sessionId); const requestDigest = workflowDigest('run-snapshot', { schemaVersion: '1', operation: 'approval-review', ...input });
      const result = this.transaction(input.requestId, requestDigest, () => { const row = this.db().prepare("SELECT w.phase,r.state AS run_state,a.state AS attempt_state FROM workflow_approval_waits w JOIN workflow_runs r ON r.run_id=w.run_id JOIN workflow_node_attempts a ON a.run_id=w.run_id AND a.node_id=w.node_id WHERE w.run_id=? AND w.node_id=?").get(input.runId, input.nodeId) as Row | undefined; if (!row || !['waiting','reviewed'].includes(text(row, 'phase')) || text(row, 'run_state') !== 'stopping' || text(row, 'attempt_state') !== 'ready') return { kind: 'refused', code: 'WORKFLOW_APPROVAL_INVALID' } as const; const challenge = randomBytes(32).toString('base64url'); const expiresAt = new Date(Date.now() + 300_000).toISOString(); this.db().prepare("UPDATE workflow_approval_waits SET phase='reviewed',session_id=?,challenge_digest=?,expires_at=?,revision=revision+1,updated_at=? WHERE run_id=? AND node_id=?").run(input.sessionId, secretDigest(challenge), expiresAt, new Date().toISOString(), input.runId, input.nodeId); return { kind: 'completed', code: 'WORKFLOW_OK', challenge, expiresAt } as const; });
      if (result.kind === 'completed') workflowLog('approval.review.completed', ids); else workflowLog('approval.review.refused', { ...ids, safeCode: result.code }); return result;
    } catch (error) { // observability-exempt: approval.review.refused records only the closed code and opaque IDs; the challenge is deliberately excluded.
      const code = codeOf(error); workflowLog('approval.review.refused', { ...ids, safeCode: code }); return { kind: code === 'WORKFLOW_VERSION_CONFLICT' ? 'conflict' : 'refused', code }; }
  }

  async continueRun(input: { requestId: string; runId: string; nodeId: string; sessionId: string; challenge: string }): Promise<WorkflowMutationResult> {
    const ids = { requestId: safeId(input.requestId), runId: safeId(input.runId), nodeId: safeId(input.nodeId) }; workflowLog('approval.continue.requested', ids);
    try {
      uuid(input.requestId); uuid(input.runId); uuid(input.nodeId); uuid(input.sessionId); if (!/^[A-Za-z0-9_-]{43}$/u.test(input.challenge)) throw new WorkflowValidationError('WORKFLOW_APPROVAL_INVALID'); const challengeDigest = secretDigest(input.challenge); const requestDigest = workflowDigest('run-snapshot', { schemaVersion: '1', operation: 'approval-continue', requestId: input.requestId, runId: input.runId, nodeId: input.nodeId, sessionId: input.sessionId, challengeDigest });
      const authorized = this.transaction<WorkflowMutationResult>(input.requestId, requestDigest, () => { const row = this.db().prepare("SELECT w.*,r.state AS run_state,a.state AS attempt_state FROM workflow_approval_waits w JOIN workflow_runs r ON r.run_id=w.run_id JOIN workflow_node_attempts a ON a.run_id=w.run_id AND a.node_id=w.node_id WHERE w.run_id=? AND w.node_id=?").get(input.runId, input.nodeId) as Row | undefined; if (!row || text(row, 'phase') !== 'reviewed' || text(row, 'run_state') !== 'stopping' || text(row, 'attempt_state') !== 'ready' || text(row, 'session_id') !== input.sessionId || text(row, 'challenge_digest') !== challengeDigest || Date.parse(text(row, 'expires_at')) <= Date.now()) return { kind: 'refused', code: 'WORKFLOW_APPROVAL_INVALID' } as const; const approvedAt = new Date().toISOString(); const receiptDigest = workflowDigest('run-snapshot', { schemaVersion: '1', runId: input.runId, nodeId: input.nodeId, sessionId: input.sessionId, challengeDigest, approvedAt }); this.db().prepare("UPDATE workflow_approval_waits SET phase='approved',receipt_digest=?,revision=revision+1,updated_at=? WHERE run_id=? AND node_id=?").run(receiptDigest, approvedAt, input.runId, input.nodeId); this.db().prepare("UPDATE workflow_node_attempts SET state='pending',safe_code='WORKFLOW_OK',updated_at=? WHERE run_id=? AND node_id=? AND state='ready'").run(approvedAt, input.runId, input.nodeId); this.db().prepare("UPDATE workflow_runs SET state='running',safe_code='WORKFLOW_OK',revision=revision+1,updated_at=? WHERE run_id=? AND state='stopping'").run(approvedAt, input.runId); return { kind: 'completed', code: 'WORKFLOW_OK' } as const; });
      if (authorized.kind !== 'completed') { workflowLog('approval.continue.refused', { ...ids, safeCode: authorized.code }); return authorized; } if (authorized.run) return authorized;
      const stored = this.db().prepare('SELECT plan_id,task_admission_id FROM workflow_runs WHERE run_id=?').get(input.runId) as Row | undefined; if (!stored) throw new WorkflowValidationError('WORKFLOW_SCHEMA_INVALID'); const graph = this.graphForRun(input.runId); const result = await this.executeRun(input.runId, text(stored, 'plan_id'), graph, text(stored, 'task_admission_id')); this.db().prepare('UPDATE idempotency SET result_json=? WHERE request_id=?').run(JSON.stringify(result), input.requestId); this.publishOwnerEvents(); if (result.kind === 'completed') workflowLog('approval.continue.completed', ids); else workflowLog('approval.continue.refused', { ...ids, safeCode: result.code }); return result;
    } catch (error) { // observability-exempt: approval.continue.refused records only the closed code and opaque IDs; authorization material is deliberately excluded.
      const code = codeOf(error); workflowLog('approval.continue.refused', { ...ids, safeCode: code }); return { kind: 'refused', code }; }
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

  async listProjectPlans(projectId: string): Promise<readonly WorkflowPlanSummary[]> {
    workflowLog('plan.list.requested', { projectId: safeId(projectId) });
    try {
      uuid(projectId); const plans: WorkflowPlanSummary[] = [];
      for (const row of this.db().prepare(`SELECT p.plan_id,p.version_id,p.editable_node_count,p.injected_anchor_count,
        v.template_id,v.version_number,v.graph_json FROM compiled_plans p JOIN template_versions v ON v.version_id=p.version_id
        ORDER BY v.created_at,v.version_number`).all() as Row[]) {
        const graph = this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown);
        if (graph.projectId === projectId) plans.push({ planId: text(row, 'plan_id'), versionId: text(row, 'version_id'),
          templateId: text(row, 'template_id'), versionNumber: number(row, 'version_number'), editableNodeCount: number(row, 'editable_node_count'),
          injectedAnchorCount: number(row, 'injected_anchor_count') });
      }
      workflowLog('plan.list.completed', { projectId, planCount: plans.length }); return plans;
    } catch (error) {
      workflowLog('plan.list.refused', { projectId: safeId(projectId), safeCode: codeOf(error) }); throw error;
    }
  }

  async diagnostics(): Promise<{ integrity: boolean; foreignKeys: boolean; immutableTriggers: boolean; canonicalMismatchCount: number; catalogMismatchCount: number; catalogEntryCount: number; availableExecutorCount: number; unavailableExecutorCount: number; planMismatchCount: number; versionCount: number; planCount: number; schedulerIntegrity: boolean; ownerIntegrity: boolean; ownerEventCount: number; taskAdmissionAuthorityReady: boolean; agentAuthorityReady: boolean; trustSpineAuthorityReady: boolean; trustSpineAuthorityAnchorCount: number; materializedAnchorAttemptCount: number; completedTrustSpineRunCount: number; schedulerLeaseActive: boolean; schedulerAdmission: 'enabled' | 'blocked' | 'recovering'; pendingOutboxCount: number; quarantinedRunCount: number; activeProcessCount: number; residualProcessCount: number; recoveryBacklogCount: number; sourceMapsPresent: boolean; sourceMapExpectedCount: number; sourceMapPresentCount: number; sourceMapMissingCount: number }> {
    const db = this.db(); const integrity = text(db.prepare('PRAGMA quick_check').get() as Row, 'quick_check') === 'ok'; const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length === 0;
    const immutableTriggers = number(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'workflow_immutable_%'").get() as Row, 'count') === 8;
    let canonicalMismatchCount = 0; for (const row of db.prepare('SELECT graph_json,graph_digest FROM template_versions').all() as Row[]) { try { const graph = this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown); if (workflowDigest('template', graph) !== text(row, 'graph_digest')) canonicalMismatchCount++; } catch { /* observability-exempt: aggregate canonical mismatch count is the diagnostic signal; content is never logged. */ canonicalMismatchCount++; } }
    const catalog = this.compiler.catalogStatus();
    const catalogMismatchCount = number(db.prepare('SELECT count(*) AS count FROM template_versions WHERE catalog_digest<>?').get(catalog.digest) as Row, 'count') + number(db.prepare('SELECT count(*) AS count FROM compiled_plans WHERE catalog_digest<>?').get(catalog.digest) as Row, 'count') + (catalog.valid ? 0 : 1);
    let planMismatchCount = 0; for (const row of db.prepare('SELECT * FROM compiled_plans').all() as Row[]) { try { const version = this.version(text(row, 'version_id')); const graph = this.compiler.decodeAndValidate(JSON.parse(text(version, 'graph_json')) as unknown); if (text(row, 'graph_digest') !== text(version, 'graph_digest') || text(row, 'catalog_digest') !== text(version, 'catalog_digest')) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); this.compiler.assertPlanIntegrity(plan(row), graph); } catch { /* observability-exempt: aggregate plan mismatch count is the diagnostic signal; plan contents are never logged. */ planMismatchCount++; } }
    const sourceMaps = workflowSourceMapDiagnostics(); const sourceMapsPresent = sourceMaps.missingCount === 0;
    const lease = db.prepare('SELECT phase,admission FROM scheduler_lease WHERE singleton=1').get() as Row | undefined;
    const pendingOutboxCount = number(db.prepare("SELECT count(*) AS count FROM workflow_outbox WHERE phase IN ('requested','claimed')").get() as Row, 'count');
    const quarantinedRunCount = number(db.prepare("SELECT count(*) AS count FROM workflow_runs WHERE state='quarantined'").get() as Row, 'count');
    const residualProcessCount = number(db.prepare('SELECT coalesce(sum(residual_process_count),0) AS count FROM workflow_runs').get() as Row, 'count');
    const schedulerIntegrity = this.schedulerEventsValid() && this.schedulerRecordsValid(); const taskAdmissionAuthorityReady = !!this.taskAdmissionAuthority; let agentAuthorityReady = false; try { agentAuthorityReady = !!this.agentAttemptDispatcher && (await this.agentAttemptDispatcher.snapshot()).admission === 'enabled'; } catch { /* observability-exempt: workflow.authority reports the closed unavailable state; dispatcher payloads are never logged. */ }
    let trustSpineAuthorityReady = false; let trustSpineAuthorityAnchorCount = 0; try { if (this.trustSpineAuthority && validTrustAuthority(this.trustSpineAuthority)) { trustSpineAuthorityAnchorCount = this.trustSpineAuthority.contract().supportedAnchors.length; trustSpineAuthorityReady = trustSpineAuthorityAnchorCount === EXTERNAL_ANCHORS.length; } } catch { /* observability-exempt: workflow.authority reports the closed unavailable state; authority payloads are never logged. */ } const materializedAnchorAttemptCount = number(db.prepare('SELECT count(*) AS count FROM workflow_anchor_attempts').get() as Row, 'count'); const completedTrustSpineRunCount = number(db.prepare("SELECT count(*) AS count FROM (SELECT run_id FROM workflow_anchor_attempts WHERE sequence_version='2' AND state='succeeded' GROUP BY run_id HAVING count(*)=9)").get() as Row, 'count');
    const ownerIntegrity = this.ownerIdentityValid(); const ownerEventCount = number(db.prepare('SELECT count(*) AS count FROM workflow_scheduler_events').get() as Row, 'count');
    return { integrity: integrity && schedulerIntegrity && ownerIntegrity, foreignKeys, immutableTriggers, canonicalMismatchCount, catalogMismatchCount, catalogEntryCount: catalog.entryCount, availableExecutorCount: catalog.availableExecutorCount, unavailableExecutorCount: catalog.unavailableExecutorCount, planMismatchCount, versionCount: this.versionCount(), planCount: number(db.prepare('SELECT count(*) AS count FROM compiled_plans').get() as Row, 'count'), schedulerIntegrity, ownerIntegrity, ownerEventCount, taskAdmissionAuthorityReady, agentAuthorityReady, trustSpineAuthorityReady, trustSpineAuthorityAnchorCount, materializedAnchorAttemptCount, completedTrustSpineRunCount, schedulerLeaseActive: lease ? text(lease, 'phase') === 'active' : false, schedulerAdmission: lease ? text(lease, 'admission') as 'enabled' | 'blocked' | 'recovering' : 'recovering', pendingOutboxCount, quarantinedRunCount, activeProcessCount: 0, residualProcessCount, recoveryBacklogCount: pendingOutboxCount + quarantinedRunCount, sourceMapsPresent, sourceMapExpectedCount: sourceMaps.expectedCount, sourceMapPresentCount: sourceMaps.presentCount, sourceMapMissingCount: sourceMaps.missingCount };
  }

  private transaction<T>(requestId: string, requestDigest: string, action: () => T): T {
    const db = this.db(); db.exec('BEGIN IMMEDIATE');
    try { const prior = db.prepare('SELECT request_digest,result_json FROM idempotency WHERE request_id=?').get(requestId) as Row | undefined; if (prior) { if (text(prior, 'request_digest') !== requestDigest) throw new WorkflowValidationError('WORKFLOW_VERSION_CONFLICT'); db.exec('ROLLBACK'); return JSON.parse(text(prior, 'result_json')) as T; } const result = action(); db.prepare('INSERT INTO idempotency(request_id,request_digest,result_json) VALUES(?,?,?)').run(requestId, requestDigest, JSON.stringify(result)); db.exec('COMMIT'); return result; }
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
    const outputs = new Map<string, SchedulerOutcome>(); const attemptRows = this.db().prepare('SELECT node_id,state,routing_state,output FROM workflow_node_attempts WHERE run_id=?').all(runId) as Row[]; for (const row of attemptRows) { if (text(row, 'routing_state') === 'skipped') outputs.set(text(row, 'node_id'), 'skipped'); else if (['succeeded','failed'].includes(text(row, 'state'))) outputs.set(text(row, 'node_id'), schedulerOutput(text(row, 'output'))); } const pendingIds = new Set(attemptRows.filter(row => text(row, 'state') === 'pending').map(row => text(row, 'node_id'))); const pending = new Map(graph.nodes.filter(node => pendingIds.has(node.nodeId)).map(node => [node.nodeId, node])); let completedNodeCount = attemptRows.filter(row => text(row, 'state') === 'succeeded').length; let skippedNodeCount = attemptRows.filter(row => text(row, 'routing_state') === 'skipped').length; let failedNodeCount = attemptRows.filter(row => text(row, 'state') === 'failed').length;
    while (pending.size) {
      const candidate = [...pending.values()].map(node => ({ node, routing: route(node.nodeId, graph, outputs) })).find(item => item.routing !== 'waiting');
      if (!candidate) return this.finishControlRun(runId, planId, 'failed', 'WORKFLOW_CONDITION_INVALID', completedNodeCount, skippedNodeCount, pending.size);
      const { node, routing } = candidate;
      if (routing === 'skipped') { const now = new Date().toISOString(); this.schedulerTransaction(() => { this.db().prepare("UPDATE workflow_node_attempts SET state='cancelled',routing_state='skipped',safe_code='WORKFLOW_OK',updated_at=? WHERE run_id=? AND node_id=? AND attempt=1 AND state='pending'").run(now, runId, node.nodeId); }); outputs.set(node.nodeId, 'skipped'); pending.delete(node.nodeId); skippedNodeCount++; workflowLog('node.routing.skipped', { runId, nodeId: node.nodeId, nodeKind: node.kind, safeCode: 'WORKFLOW_OK', processCount: 0, residualProcessCount: 0 }); continue; }
      const predecessorOutcomes = graph.edges.filter(edge => edge.targetNodeId === node.nodeId).map(edge => predecessorOutcome(edge, outputs));
      if (node.kind === 'approval.continue' && !this.continuationReceipt(runId, node.nodeId)) return this.pauseForContinuation(runId, planId, node.nodeId, completedNodeCount, skippedNodeCount, failedNodeCount);
      const now = new Date().toISOString(); const outboxId = randomUUID(); const requestDigest = workflowDigest('run-snapshot', { schemaVersion: '1', runId, nodeId: node.nodeId, attempt: 1, configurationDigest: node.configurationDigest });
      this.schedulerTransaction(() => { this.db().prepare("UPDATE workflow_runs SET state='running',revision=revision+1,updated_at=? WHERE run_id=? AND state IN ('admitted','running')").run(now, runId); this.db().prepare("UPDATE workflow_node_attempts SET state='running',updated_at=? WHERE run_id=? AND node_id=? AND attempt=1 AND state='pending'").run(now, runId, node.nodeId); this.db().prepare("INSERT INTO workflow_outbox(outbox_id,run_id,node_id,operation_kind,request_digest,fencing_token,phase,safe_code,created_at,updated_at) VALUES(?,?,?,?,?,?,'claimed','WORKFLOW_OK',?,?)").run(outboxId, runId, node.nodeId, node.kind, requestDigest, this.schedulerFencingToken, now, now); });
      const result = node.kind.endsWith('.agent') ? await this.executeAgentNode(runId, taskAdmissionId, node, outboxId) : ['tool.git','tool.build','check.deterministic'].includes(node.kind) ? await this.executeExternalNode(runId, taskAdmissionId, node, predecessorOutcomes) : node.kind === 'approval.specification' ? await this.executeSpecificationApproval(runId, taskAdmissionId, node, predecessorOutcomes) : node.kind === 'approval.continue' ? this.executeContinuation(runId, node, predecessorOutcomes) : this.compiler.executeControl({ runId, node, attempt: 1, predecessorOutcomes }); const finishedAt = new Date().toISOString();
      const output = 'output' in result ? result.output : undefined; const handledFailure = result.kind !== 'completed' && result.residualProcessCount === 0 && graph.edges.some(edge => edge.sourceNodeId === node.nodeId && ['failure','finally'].includes(edge.sourcePort)); const durableOutput = handledFailure ? 'failure' : output; const facts = result as { readonly subjectStateDigest?: unknown; readonly factDigest?: unknown; readonly ownerSequence?: unknown }; const subjectStateDigest = typeof facts.subjectStateDigest === 'string' ? facts.subjectStateDigest : ''; const factDigest = typeof facts.factDigest === 'string' ? facts.factDigest : ''; const ownerSequence = typeof facts.ownerSequence === 'string' ? facts.ownerSequence : ''; this.schedulerTransaction(() => { this.db().prepare("UPDATE workflow_outbox SET phase='completed',safe_code=?,updated_at=? WHERE outbox_id=? AND phase='claimed'").run(result.code, finishedAt, outboxId); this.db().prepare("UPDATE workflow_node_attempts SET state=?,safe_code=?,output=?,subject_state_digest=?,fact_digest=?,owner_sequence=?,updated_at=? WHERE run_id=? AND node_id=? AND attempt=1 AND state='running'").run(result.kind === 'completed' ? 'succeeded' : 'failed', result.code, durableOutput ?? '', subjectStateDigest, factDigest, ownerSequence, finishedAt, runId, node.nodeId); });
      if (handledFailure) { outputs.set(node.nodeId, 'failure'); pending.delete(node.nodeId); failedNodeCount++; workflowLog('node.failure.routed', { runId, nodeId: node.nodeId, nodeKind: node.kind, safeCode: result.code, routeCount: graph.edges.filter(edge => edge.sourceNodeId === node.nodeId && ['failure','finally'].includes(edge.sourcePort)).length, processCount: 0, residualProcessCount: 0 }); continue; }
      if (result.kind !== 'completed' || !output) return this.finishControlRun(runId, planId, 'failed', result.code, completedNodeCount, skippedNodeCount, failedNodeCount + 1, result.residualProcessCount);
      outputs.set(node.nodeId, output); pending.delete(node.nodeId); completedNodeCount++;
    }
    if (graph.nodes.some(node => node.kind === 'check.deterministic')) return this.executeTrustSpine(runId, planId, completedNodeCount, skippedNodeCount, failedNodeCount);
    return this.finishControlRun(runId, planId, 'completed', 'WORKFLOW_OK', completedNodeCount, skippedNodeCount, failedNodeCount);
  }
  private async executeTrustSpine(runId: string, planId: string, completedNodeCount: number, skippedNodeCount: number, failedNodeCount: number): Promise<WorkflowMutationResult> {
    const authority = this.trustSpineAuthority; const run = this.db().prepare('SELECT r.plan_digest,r.task_admission_id,r.task_admission_digest,r.repository_id,p.trust_spine_digest FROM workflow_runs r JOIN compiled_plans p ON p.plan_id=r.plan_id WHERE r.run_id=?').get(runId) as Row | undefined;
    const checkNodeIds = new Set(this.graphForRun(runId).nodes.filter(node => node.kind === 'check.deterministic').map(node => node.nodeId));
    const checks = (this.db().prepare("SELECT node_id,subject_state_digest,fact_digest,owner_sequence FROM workflow_node_attempts WHERE run_id=? AND state='succeeded' AND subject_state_digest<>'' AND fact_digest<>'' ORDER BY node_id").all(runId) as Row[]).filter(row => checkNodeIds.has(text(row, 'node_id')));
    const checkSubjects = new Set(checks.map(row => text(row, 'subject_state_digest')));
    if (!authority || !run || checks.length !== checkNodeIds.size || checkSubjects.size !== 1 || !validTrustAuthority(authority)) return this.finishControlRun(runId, planId, 'failed', 'WORKFLOW_AUTHORITY_EXPANSION', completedNodeCount, skippedNodeCount, failedNodeCount + 1);
    let subjectStateDigest = [...checkSubjects][0]!; let priorFactDigest = text(run, 'task_admission_digest'); let lastOwnerSequence = 0;
    for (let index = 0; index < ANCHORS.length; index++) {
      const anchor = ANCHORS[index]!; const anchorId = ANCHOR_IDS[anchor]; const request = Object.freeze({ runId, anchor, planDigest: text(run, 'plan_digest'), trustSpineDigest: text(run, 'trust_spine_digest'), taskAdmissionId: text(run, 'task_admission_id'), taskAdmissionDigest: text(run, 'task_admission_digest'), repositoryId: text(run, 'repository_id'), subjectStateDigest, priorFactDigest }); const requestDigest = workflowDigest('trust-anchor', request); const ordinal = index + 1; const startedAt = new Date().toISOString();
      if (!isExternalAnchor(anchor)) {
        const resultFactDigest = anchor === 'anchor.checks-complete' ? workflowDigest('trust-anchor', { anchor, priorFactDigest, checks: checks.map(row => ({ nodeId: text(row, 'node_id'), factDigest: text(row, 'fact_digest'), ownerSequence: text(row, 'owner_sequence') })) }) : workflowDigest('trust-anchor', { anchor, priorFactDigest, subjectStateDigest });
        this.schedulerTransaction(() => { this.db().prepare("INSERT INTO workflow_anchor_attempts(run_id,anchor_id,anchor_kind,ordinal,sequence_version,owner_kind,state,request_digest,input_subject_digest,input_fact_digest,result_subject_digest,result_fact_digest,fencing_token,safe_code,updated_at) VALUES(?,?,?,?,'2','workflow','succeeded',?,?,?,?,?,?,'WORKFLOW_OK',?)").run(runId, anchorId, anchor, ordinal, requestDigest, subjectStateDigest, priorFactDigest, subjectStateDigest, resultFactDigest, this.schedulerFencingToken, startedAt); });
        workflowLog('anchor.execution.started', { runId, anchor, ordinal }); workflowLog('anchor.execution.completed', { runId, anchor, ordinal, safeCode: 'WORKFLOW_OK' }); priorFactDigest = resultFactDigest; continue;
      }
      const externalRequest = request as WorkflowTrustAnchorRequestV1; const outboxId = randomUUID();
      this.schedulerTransaction(() => { this.db().prepare("INSERT INTO workflow_anchor_attempts(run_id,anchor_id,anchor_kind,ordinal,sequence_version,owner_kind,state,request_digest,input_subject_digest,input_fact_digest,fencing_token,safe_code,updated_at) VALUES(?,?,?,?,'2','external','running',?,?,?,?,'WORKFLOW_OK',?)").run(runId, anchorId, anchor, ordinal, requestDigest, subjectStateDigest, priorFactDigest, this.schedulerFencingToken, startedAt); this.db().prepare("INSERT INTO workflow_outbox(outbox_id,run_id,node_id,operation_kind,request_digest,fencing_token,phase,safe_code,created_at,updated_at) VALUES(?,?,?,?,?,?,'claimed','WORKFLOW_OK',?,?)").run(outboxId, runId, anchorId, anchor, requestDigest, this.schedulerFencingToken, startedAt, startedAt); });
      workflowLog('anchor.execution.started', { runId, anchor, ordinal }); let result: WorkflowTrustAnchorResultV1;
      try { result = await executeTrustAnchor(authority, externalRequest); if (!validTrustResult(result, subjectStateDigest, anchor, lastOwnerSequence)) throw new Error('invalid trust anchor result'); }
      catch { /* observability-exempt: anchor.execution.refused below records the exact anchor and closed normalized failure without owner details. */ result = { kind: 'refused', code: 'WORKFLOW_EXTERNAL_FAILURE', processCount: 0, residualProcessCount: 0 }; }
      const finishedAt = new Date().toISOString(); const resultSubject = result.kind === 'completed' ? result.subjectStateDigest : ''; const resultFact = result.kind === 'completed' ? result.factDigest : ''; const ownerSequence = result.kind === 'completed' ? result.ownerSequence : '';
      this.schedulerTransaction(() => { this.db().prepare("UPDATE workflow_outbox SET phase='completed',safe_code=?,updated_at=? WHERE outbox_id=? AND phase='claimed'").run(result.code, finishedAt, outboxId); this.db().prepare("UPDATE workflow_anchor_attempts SET state=?,result_subject_digest=?,result_fact_digest=?,owner_sequence=?,safe_code=?,residual_process_count=?,updated_at=? WHERE run_id=? AND anchor_id=? AND state='running'").run(result.kind === 'completed' ? 'succeeded' : 'failed', resultSubject, resultFact, ownerSequence, result.code, result.residualProcessCount, finishedAt, runId, anchorId); });
      if (result.kind !== 'completed') { workflowLog('anchor.execution.refused', { runId, anchor, ordinal, safeCode: result.code, residualProcessCount: result.residualProcessCount }); return this.finishControlRun(runId, planId, 'failed', result.code, completedNodeCount, skippedNodeCount, failedNodeCount + 1, result.residualProcessCount); }
      workflowLog('anchor.execution.completed', { runId, anchor, ordinal, safeCode: 'WORKFLOW_OK' }); subjectStateDigest = result.subjectStateDigest; priorFactDigest = result.factDigest; lastOwnerSequence = Number(result.ownerSequence);
    }
    return this.finishControlRun(runId, planId, 'completed', 'WORKFLOW_OK', completedNodeCount, skippedNodeCount, failedNodeCount);
  }
  private executeContinuation(runId: string, node: EditableWorkflowGraphV1['nodes'][number], predecessorOutcomes: readonly ('success' | 'failure' | 'skipped')[]) { const receiptDigest = this.continuationReceipt(runId, node.nodeId); if (!receiptDigest) return agentRefused({ runId, nodeId: node.nodeId, nodeKind: node.kind, attempt: 1, executorId: 'kogg.workflow.continuation' }, 'WORKFLOW_APPROVAL_INVALID', 0); return this.compiler.executeContinuation({ runId, node, attempt: 1, predecessorOutcomes, receiptDigest }); }
  private async executeExternalNode(runId: string, taskAdmissionId: string, node: EditableWorkflowGraphV1['nodes'][number], predecessorOutcomes: readonly ('success' | 'failure' | 'skipped')[]) {
    const stored = this.db().prepare('SELECT plan_digest,repository_id FROM workflow_runs WHERE run_id=?').get(runId) as Row | undefined; const configuration = node.configuration;
    const bindingId = node.kind === 'check.deterministic' ? configuration?.checkId : configuration?.operationId;
    if (!stored || !configuration?.externalConfigurationDigest || !bindingId) return agentRefused({ runId, nodeId: node.nodeId, nodeKind: node.kind, attempt: 1, executorId: 'kogg.workflow.external' }, 'WORKFLOW_EXECUTOR_INCOMPATIBLE', 0);
    return this.compiler.executeExternal({ runId, node, attempt: 1, predecessorOutcomes, planDigest: text(stored, 'plan_digest'), taskAdmissionId, repositoryId: text(stored, 'repository_id'), bindingId, externalConfigurationDigest: configuration.externalConfigurationDigest });
  }
  private pauseForContinuation(runId: string, planId: string, nodeId: string, completedNodeCount: number, skippedNodeCount: number, failedNodeCount: number): WorkflowMutationResult { const now = new Date().toISOString(); this.schedulerTransaction(() => { this.db().prepare("UPDATE workflow_node_attempts SET state='ready',safe_code='WORKFLOW_APPROVAL_REQUIRED',updated_at=? WHERE run_id=? AND node_id=? AND state='pending'").run(now, runId, nodeId); this.db().prepare("UPDATE workflow_runs SET state='stopping',safe_code='WORKFLOW_APPROVAL_REQUIRED',revision=revision+1,updated_at=? WHERE run_id=?").run(now, runId); this.db().prepare("INSERT OR IGNORE INTO workflow_approval_waits(run_id,node_id,phase,created_at,updated_at) VALUES(?,?,'waiting',?,?)").run(runId, nodeId, now, now); }); workflowLog('approval.waiting', { runId, nodeId, safeCode: 'WORKFLOW_APPROVAL_REQUIRED' }); return { kind: 'waiting', code: 'WORKFLOW_APPROVAL_REQUIRED', run: { runId, planId, taskAdmissionId: text(this.db().prepare('SELECT task_admission_id FROM workflow_runs WHERE run_id=?').get(runId) as Row, 'task_admission_id'), state: 'waiting-approval', safeCode: 'WORKFLOW_APPROVAL_REQUIRED', completedNodeCount, skippedNodeCount, failedNodeCount } }; }
  private continuationReceipt(runId: string, nodeId: string): string | undefined { const row = this.db().prepare("SELECT receipt_digest FROM workflow_approval_waits WHERE run_id=? AND node_id=? AND phase='approved'").get(runId, nodeId) as Row | undefined; return row ? text(row, 'receipt_digest') : undefined; }
  private async executeAgentNode(runId: string, taskAdmissionId: string, node: EditableWorkflowGraphV1['nodes'][number], requestId: string): Promise<{ readonly kind: 'completed' | 'refused'; readonly code: WorkflowSafeCode; readonly output?: 'success'; readonly processCount: number; readonly residualProcessCount: number }> {
    const dispatcher = this.agentAttemptDispatcher; const configuration = node.configuration; const binding = configuration && agentBinding(configuration); const fields = { runId, nodeId: node.nodeId, nodeKind: node.kind, attempt: 1, executorId: 'kogg.agents.registry' };
    workflowLog('node.execution.started', fields);
    if (!dispatcher || !configuration || !binding) return agentRefused(fields, 'WORKFLOW_EXECUTOR_INCOMPATIBLE', 0);
    try {
      const snapshot = await dispatcher.snapshot();
      const run = this.db().prepare('SELECT plan_digest FROM workflow_runs WHERE run_id=?').get(runId) as Row | undefined;
      if (!run) return agentRefused(fields, 'WORKFLOW_OUTCOME_UNKNOWN', 0);
      const started = await dispatcher.startAttempt({ schemaVersion: '1', requestId, expectedRegistryRevision: snapshot.registryRevision, taskAdmissionId, workflowPlanDigest: text(run, 'plan_digest'), ...binding });
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
  private async executeSpecificationApproval(runId: string, taskAdmissionId: string, node: EditableWorkflowGraphV1['nodes'][number], predecessorOutcomes: readonly ('success' | 'failure' | 'skipped')[]) {
    const fields = { runId, nodeId: node.nodeId, nodeKind: node.kind, attempt: 1, executorId: 'kogg.tasks.admission' };
    try {
      const admission = await this.taskAdmissionAuthority?.resolveAdmission(taskAdmissionId); const stored = this.db().prepare('SELECT task_admission_digest,task_id,repository_id FROM workflow_runs WHERE run_id=?').get(runId) as Row | undefined;
      if (!admission || !stored || !validTaskAdmission(admission, taskAdmissionId) || admission.runId !== runId || admission.taskId !== text(stored, 'task_id') || admission.repositoryId !== text(stored, 'repository_id') || workflowDigest('run-snapshot', { schemaVersion: '1', taskAdmission: admission }) !== text(stored, 'task_admission_digest')) return authorityRefused(fields);
      return this.compiler.executeTaskApproval({ runId, node, attempt: 1, predecessorOutcomes, taskAdmission: admission, taskAdmissionDigest: text(stored, 'task_admission_digest') });
    } catch { // observability-exempt: the closed refusal excludes task and approval authority implementation details.
      return authorityRefused(fields);
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
    if (state === 'completed') { workflowLog('run.completed', { planId, runId, completedNodeCount, skippedNodeCount, failedNodeCount, safeCode: 'WORKFLOW_OK', processCount: 0, residualProcessCount: 0 }); return { kind: 'completed', code: 'WORKFLOW_OK', run }; }
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
    CREATE TABLE IF NOT EXISTS workflow_node_attempts(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),node_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>=1),state TEXT NOT NULL CHECK(state IN ('pending','ready','dispatched','running','succeeded','failed','cancelled','quarantined')),routing_state TEXT NOT NULL DEFAULT 'selected' CHECK(routing_state IN ('selected','skipped')),external_attempt_id TEXT NOT NULL DEFAULT '',output TEXT NOT NULL DEFAULT '',subject_state_digest TEXT NOT NULL DEFAULT '',fact_digest TEXT NOT NULL DEFAULT '',owner_sequence TEXT NOT NULL DEFAULT '',fencing_token TEXT NOT NULL,safe_code TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,node_id,attempt));
    CREATE TABLE IF NOT EXISTS workflow_approval_waits(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),node_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('waiting','reviewed','approved')),session_id TEXT NOT NULL DEFAULT '',challenge_digest TEXT NOT NULL DEFAULT '',receipt_digest TEXT NOT NULL DEFAULT '',expires_at TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,node_id));
    CREATE TABLE IF NOT EXISTS workflow_anchor_attempts(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),anchor_id TEXT NOT NULL,anchor_kind TEXT NOT NULL CHECK(anchor_kind IN ('anchor.spec-frozen','anchor.spec-approved','anchor.producer-separated','anchor.checks-complete','anchor.evidence-admitted','anchor.ranex-pass-current','anchor.merge-preflight','anchor.controlled-merge','anchor.cleanup-complete')),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 9),sequence_version TEXT NOT NULL CHECK(sequence_version IN ('1','2')),owner_kind TEXT NOT NULL CHECK(owner_kind IN ('workflow','external')),state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','quarantined')),request_digest TEXT NOT NULL,input_subject_digest TEXT NOT NULL,input_fact_digest TEXT NOT NULL,result_subject_digest TEXT NOT NULL DEFAULT '',result_fact_digest TEXT NOT NULL DEFAULT '',owner_sequence TEXT NOT NULL DEFAULT '',fencing_token TEXT NOT NULL,safe_code TEXT NOT NULL,residual_process_count INTEGER NOT NULL DEFAULT 0 CHECK(residual_process_count>=0),updated_at TEXT NOT NULL,PRIMARY KEY(run_id,anchor_id),UNIQUE(run_id,ordinal));
    CREATE TABLE IF NOT EXISTS workflow_outbox(outbox_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),node_id TEXT NOT NULL,operation_kind TEXT NOT NULL,request_digest TEXT NOT NULL,fencing_token TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('requested','claimed','completed','quarantined')),safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_scheduler_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),event_name TEXT NOT NULL,safe_code TEXT NOT NULL,previous_event_digest TEXT NOT NULL,event_digest TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_scheduler_events_update BEFORE UPDATE ON workflow_scheduler_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_scheduler_events_delete BEFORE DELETE ON workflow_scheduler_events BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    this.migrateAnchorAttempts();
    this.db().exec(`CREATE TABLE IF NOT EXISTS workflow_owner_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL,owner_epoch_id TEXT NOT NULL,identity_digest TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_owner_meta_update BEFORE UPDATE ON workflow_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_owner_meta_delete BEFORE DELETE ON workflow_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    if (!this.db().prepare('SELECT 1 FROM workflow_owner_meta WHERE singleton=1').get()) { const ownerId = randomUUID(); const ownerEpochId = randomUUID(); this.db().prepare('INSERT INTO workflow_owner_meta(singleton,owner_id,owner_epoch_id,identity_digest) VALUES(1,?,?,?)').run(ownerId, ownerEpochId, workflowDigest('owner-identity', { ownerId, ownerEpochId })); }
    this.db().prepare("INSERT OR IGNORE INTO scheduler_lease(singleton,owner_epoch_id,fencing_token,phase,admission,updated_at) VALUES(1,?,?,'released','recovering',?)").run(this.schedulerEpochId, this.schedulerFencingToken, new Date().toISOString());
    this.ensureColumn('template_versions', 'catalog_digest', LEGACY_UNATTESTED_CATALOG); this.ensureColumn('compiled_plans', 'catalog_digest', LEGACY_UNATTESTED_CATALOG); this.ensureColumn('workflow_node_attempts', 'routing_state', 'selected'); this.ensureColumn('workflow_node_attempts', 'external_attempt_id', ''); this.ensureColumn('workflow_node_attempts', 'output', ''); this.ensureColumn('workflow_node_attempts', 'subject_state_digest', ''); this.ensureColumn('workflow_node_attempts', 'fact_digest', ''); this.ensureColumn('workflow_node_attempts', 'owner_sequence', ''); this.ensureColumn('workflow_runs', 'task_admission_id', ''); this.ensureColumn('workflow_runs', 'task_admission_digest', ''); this.ensureColumn('workflow_runs', 'task_id', ''); this.ensureColumn('workflow_runs', 'repository_id', ''); this.ensureIntegerColumn('workflow_runs', 'residual_process_count'); }
  private migrateAnchorAttempts(): void {
    const columns = this.db().prepare('PRAGMA table_info(workflow_anchor_attempts)').all() as Row[]; if (columns.some(row => text(row, 'name') === 'sequence_version')) return;
    const db = this.db(); db.exec('BEGIN IMMEDIATE');
    try {
      db.exec("ALTER TABLE workflow_anchor_attempts RENAME TO workflow_anchor_attempts_v1; CREATE TABLE workflow_anchor_attempts(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),anchor_id TEXT NOT NULL,anchor_kind TEXT NOT NULL CHECK(anchor_kind IN ('anchor.spec-frozen','anchor.spec-approved','anchor.producer-separated','anchor.checks-complete','anchor.evidence-admitted','anchor.ranex-pass-current','anchor.merge-preflight','anchor.controlled-merge','anchor.cleanup-complete')),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 9),sequence_version TEXT NOT NULL CHECK(sequence_version IN ('1','2')),owner_kind TEXT NOT NULL CHECK(owner_kind IN ('workflow','external')),state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','quarantined')),request_digest TEXT NOT NULL,input_subject_digest TEXT NOT NULL,input_fact_digest TEXT NOT NULL,result_subject_digest TEXT NOT NULL DEFAULT '',result_fact_digest TEXT NOT NULL DEFAULT '',owner_sequence TEXT NOT NULL DEFAULT '',fencing_token TEXT NOT NULL,safe_code TEXT NOT NULL,residual_process_count INTEGER NOT NULL DEFAULT 0 CHECK(residual_process_count>=0),updated_at TEXT NOT NULL,PRIMARY KEY(run_id,anchor_id),UNIQUE(run_id,ordinal)); INSERT INTO workflow_anchor_attempts SELECT run_id,anchor_id,anchor_kind,ordinal,'1','external',state,request_digest,input_subject_digest,input_fact_digest,result_subject_digest,result_fact_digest,owner_sequence,fencing_token,safe_code,residual_process_count,updated_at FROM workflow_anchor_attempts_v1; DROP TABLE workflow_anchor_attempts_v1;"); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  private ensureColumn(table: 'template_versions' | 'compiled_plans' | 'workflow_node_attempts' | 'workflow_runs', column: 'catalog_digest' | 'routing_state' | 'external_attempt_id' | 'output' | 'subject_state_digest' | 'fact_digest' | 'owner_sequence' | 'task_admission_id' | 'task_admission_digest' | 'task_id' | 'repository_id', value: string): void { const present = (this.db().prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(row => text(row, 'name') === column); if (!present) this.db().exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${value}'`); }
  private ensureIntegerColumn(table: 'workflow_runs', column: 'residual_process_count'): void { const present = (this.db().prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(row => text(row, 'name') === column); if (!present) this.db().exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`); }
  private assertIntegrity(): void { const db = this.db(); if (text(db.prepare('PRAGMA quick_check').get() as Row, 'quick_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length || !this.schedulerEventsValid() || !this.ownerIdentityValid()) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); }
  private schedulerRecoveryCounts(): { activeRunCount: number; pendingOutboxCount: number } { return { activeRunCount: number(this.db().prepare("SELECT count(*) AS count FROM workflow_runs r WHERE r.state IN ('admitted','running') OR (r.state='stopping' AND NOT EXISTS (SELECT 1 FROM workflow_approval_waits w WHERE w.run_id=r.run_id AND w.phase IN ('waiting','reviewed')))").get() as Row, 'count'), pendingOutboxCount: number(this.db().prepare("SELECT count(*) AS count FROM workflow_outbox WHERE phase IN ('requested','claimed')").get() as Row, 'count') }; }
  private recoverScheduler(pending: { activeRunCount: number; pendingOutboxCount: number }): { activeRunCount: number; pendingOutboxCount: number; quarantinedRunCount: number } {
    const db = this.db(); const activeRuns = db.prepare("SELECT run_id FROM workflow_runs r WHERE r.state IN ('admitted','running') OR (r.state='stopping' AND NOT EXISTS (SELECT 1 FROM workflow_approval_waits w WHERE w.run_id=r.run_id AND w.phase IN ('waiting','reviewed'))) ORDER BY run_id").all() as Row[]; const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE scheduler_lease SET admission='recovering',updated_at=? WHERE singleton=1").run(now);
      for (const row of activeRuns) {
        const runId = text(row, 'run_id'); db.prepare("UPDATE workflow_runs SET state='quarantined',revision=revision+1,safe_code='WORKFLOW_OUTCOME_UNKNOWN',updated_at=? WHERE run_id=? AND state IN ('admitted','running','stopping')").run(now, runId);
        db.prepare("UPDATE workflow_node_attempts SET state='quarantined',safe_code='WORKFLOW_OUTCOME_UNKNOWN',updated_at=? WHERE run_id=? AND state IN ('pending','ready','dispatched','running')").run(now, runId); db.prepare("UPDATE workflow_anchor_attempts SET state='quarantined',safe_code='WORKFLOW_OUTCOME_UNKNOWN',updated_at=? WHERE run_id=? AND state='running'").run(now, runId);
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
    const mismatchedRuns = this.countInvalid('SELECT count(*) AS count FROM workflow_runs JOIN compiled_plans ON compiled_plans.plan_id=workflow_runs.plan_id WHERE workflow_runs.plan_digest<>compiled_plans.plan_digest');
    const malformedOutbox = this.countInvalid("SELECT count(*) AS count FROM workflow_outbox WHERE length(request_digest)<>64 OR request_digest GLOB '*[^0-9a-f]*'");
    const malformedAnchors = this.countInvalid("SELECT count(*) AS count FROM workflow_anchor_attempts WHERE NOT ((sequence_version='1' AND owner_kind='external' AND ((anchor_kind='anchor.evidence-admitted' AND anchor_id='71000000-0000-4000-8000-000000000001' AND ordinal=1) OR (anchor_kind='anchor.ranex-pass-current' AND anchor_id='71000000-0000-4000-8000-000000000002' AND ordinal=2) OR (anchor_kind='anchor.merge-preflight' AND anchor_id='71000000-0000-4000-8000-000000000003' AND ordinal=3) OR (anchor_kind='anchor.controlled-merge' AND anchor_id='71000000-0000-4000-8000-000000000004' AND ordinal=4))) OR (sequence_version='2' AND ((anchor_kind='anchor.spec-frozen' AND anchor_id='71000000-0000-4000-8000-000000000001' AND ordinal=1 AND owner_kind='workflow') OR (anchor_kind='anchor.spec-approved' AND anchor_id='71000000-0000-4000-8000-000000000002' AND ordinal=2 AND owner_kind='workflow') OR (anchor_kind='anchor.producer-separated' AND anchor_id='71000000-0000-4000-8000-000000000003' AND ordinal=3 AND owner_kind='external') OR (anchor_kind='anchor.checks-complete' AND anchor_id='71000000-0000-4000-8000-000000000004' AND ordinal=4 AND owner_kind='workflow') OR (anchor_kind='anchor.evidence-admitted' AND anchor_id='71000000-0000-4000-8000-000000000005' AND ordinal=5 AND owner_kind='external') OR (anchor_kind='anchor.ranex-pass-current' AND anchor_id='71000000-0000-4000-8000-000000000006' AND ordinal=6 AND owner_kind='external') OR (anchor_kind='anchor.merge-preflight' AND anchor_id='71000000-0000-4000-8000-000000000007' AND ordinal=7 AND owner_kind='external') OR (anchor_kind='anchor.controlled-merge' AND anchor_id='71000000-0000-4000-8000-000000000008' AND ordinal=8 AND owner_kind='external') OR (anchor_kind='anchor.cleanup-complete' AND anchor_id='71000000-0000-4000-8000-000000000009' AND ordinal=9 AND owner_kind='workflow')))) OR length(request_digest)<>64 OR request_digest GLOB '*[^0-9a-f]*' OR length(input_subject_digest)<>64 OR input_subject_digest GLOB '*[^0-9a-f]*' OR length(input_fact_digest)<>64 OR input_fact_digest GLOB '*[^0-9a-f]*' OR NOT ((state='succeeded' AND safe_code='WORKFLOW_OK' AND residual_process_count=0 AND length(result_subject_digest)=64 AND result_subject_digest NOT GLOB '*[^0-9a-f]*' AND length(result_fact_digest)=64 AND result_fact_digest NOT GLOB '*[^0-9a-f]*' AND ((owner_kind='workflow' AND owner_sequence='') OR (owner_kind='external' AND owner_sequence GLOB '[1-9]*' AND owner_sequence NOT GLOB '*[^0-9]*' AND length(owner_sequence)<=16))) OR (state<>'succeeded' AND result_subject_digest='' AND result_fact_digest='' AND owner_sequence=''))");
    const malformedRouting = this.countInvalid("SELECT count(*) AS count FROM workflow_node_attempts WHERE routing_state NOT IN ('selected','skipped') OR (routing_state='skipped' AND (state<>'cancelled' OR safe_code<>'WORKFLOW_OK'))");
    const malformedAttempts = this.countInvalid("SELECT count(*) AS count FROM workflow_node_attempts WHERE (external_attempt_id<>'' AND length(external_attempt_id)<>36) OR NOT ((subject_state_digest='' AND fact_digest='' AND owner_sequence='') OR (state='succeeded' AND length(subject_state_digest)=64 AND subject_state_digest NOT GLOB '*[^0-9a-f]*' AND length(fact_digest)=64 AND fact_digest NOT GLOB '*[^0-9a-f]*' AND owner_sequence GLOB '[1-9]*' AND owner_sequence NOT GLOB '*[^0-9]*' AND length(owner_sequence)<=20))");
    const malformedWaits = this.countInvalid("SELECT count(*) AS count FROM workflow_approval_waits w LEFT JOIN workflow_runs r ON r.run_id=w.run_id LEFT JOIN workflow_node_attempts a ON a.run_id=w.run_id AND a.node_id=w.node_id WHERE r.run_id IS NULL OR a.run_id IS NULL OR (w.phase IN ('waiting','reviewed') AND (r.state<>'stopping' OR a.state<>'ready')) OR (w.phase='waiting' AND (w.session_id<>'' OR w.challenge_digest<>'' OR w.receipt_digest<>'' OR w.expires_at<>'')) OR (w.phase='reviewed' AND (length(w.session_id)<>36 OR length(w.challenge_digest)<>64 OR w.challenge_digest GLOB '*[^0-9a-f]*' OR w.receipt_digest<>'' OR w.expires_at='')) OR (w.phase='approved' AND (length(w.session_id)<>36 OR length(w.challenge_digest)<>64 OR w.challenge_digest GLOB '*[^0-9a-f]*' OR length(w.receipt_digest)<>64 OR w.receipt_digest GLOB '*[^0-9a-f]*'))");
    const malformedAdmissions = this.countInvalid("SELECT count(*) AS count FROM workflow_runs WHERE residual_process_count<0 OR NOT ((task_admission_id='' AND task_admission_digest='' AND task_id='' AND repository_id='') OR (length(task_admission_id)=36 AND length(task_admission_digest)=64 AND length(task_id)=36 AND length(repository_id)=36))");
    return [mismatchedRuns, malformedOutbox, malformedAnchors, malformedRouting, malformedAttempts, malformedWaits, malformedAdmissions].every(count => count === 0) && this.anchorRecordsValid();
  }
  private countInvalid(sql: string): number { return number(this.db().prepare(sql).get() as Row, 'count'); }
  private anchorRecordsValid(): boolean {
    const grouped = new Map<string, Row[]>();
    for (const row of this.db().prepare('SELECT a.*,r.plan_digest,r.task_admission_id,r.task_admission_digest,r.repository_id,p.trust_spine_digest FROM workflow_anchor_attempts a JOIN workflow_runs r ON r.run_id=a.run_id JOIN compiled_plans p ON p.plan_id=r.plan_id ORDER BY a.run_id,a.ordinal').all() as Row[]) { const runId = text(row, 'run_id'); const rows = grouped.get(runId) ?? []; rows.push(row); grouped.set(runId, rows); }
    for (const rows of grouped.values()) {
      let prior: Row | undefined; let lastOwnerSequence = 0;
      for (const row of rows) {
        const request = { runId: text(row, 'run_id'), anchor: text(row, 'anchor_kind') as WorkflowAnchorKind, planDigest: text(row, 'plan_digest'), trustSpineDigest: text(row, 'trust_spine_digest'), taskAdmissionId: text(row, 'task_admission_id'), taskAdmissionDigest: text(row, 'task_admission_digest'), repositoryId: text(row, 'repository_id'), subjectStateDigest: text(row, 'input_subject_digest'), priorFactDigest: text(row, 'input_fact_digest') };
        if (text(row, 'request_digest') !== workflowDigest('trust-anchor', request) || (prior && (text(row, 'input_subject_digest') !== text(prior, 'result_subject_digest') || text(row, 'input_fact_digest') !== text(prior, 'result_fact_digest'))) || (prior && text(prior, 'state') !== 'succeeded')) return false;
        if (text(row, 'state') === 'succeeded') { if (text(row, 'owner_kind') === 'external') { const sequence = Number(text(row, 'owner_sequence')); if (!Number.isSafeInteger(sequence) || sequence <= lastOwnerSequence) return false; lastOwnerSequence = sequence; } if (text(row, 'anchor_kind') !== 'anchor.controlled-merge' && text(row, 'result_subject_digest') !== text(row, 'input_subject_digest')) return false; }
        prior = row;
      }
    }
    for (const row of this.db().prepare("SELECT r.run_id,v.graph_json FROM workflow_runs r JOIN compiled_plans p ON p.plan_id=r.plan_id JOIN template_versions v ON v.version_id=p.version_id WHERE r.state='completed'").all() as Row[]) { const graph = this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown); if (graph.nodes.some(node => node.kind === 'check.deterministic')) { const anchors = grouped.get(text(row, 'run_id')) ?? []; const expected = anchors[0] && text(anchors[0], 'sequence_version') === '1' ? 4 : ANCHORS.length; if (anchors.length !== expected || anchors.some(anchor => text(anchor, 'state') !== 'succeeded')) return false; } }
    return true;
  }
  private ownerIdentityValid(): boolean { const row = this.db().prepare('SELECT * FROM workflow_owner_meta WHERE singleton=1').get() as Row | undefined; if (!row) return false; const ownerId = text(row, 'owner_id'); const ownerEpochId = text(row, 'owner_epoch_id'); return UUID.test(ownerId) && UUID.test(ownerEpochId) && text(row, 'identity_digest') === workflowDigest('owner-identity', { ownerId, ownerEpochId }); }
  private currentVersion(templateId: string): number { const row = this.db().prepare('SELECT coalesce(max(version_number),0) AS count FROM template_versions WHERE template_id=?').get(templateId) as Row; return number(row, 'count'); }
  private version(versionId: string): Row { const row = this.db().prepare('SELECT * FROM template_versions WHERE version_id=?').get(versionId) as Row | undefined; if (!row) throw new WorkflowValidationError('WORKFLOW_SCHEMA_INVALID'); return row; }
  private compiledPlan(planId: string): Row { const row = this.db().prepare('SELECT * FROM compiled_plans WHERE plan_id=?').get(planId) as Row | undefined; if (!row) throw new WorkflowValidationError('WORKFLOW_SCHEMA_INVALID'); return row; }
  private graphForRun(runId: string): EditableWorkflowGraphV1 { const row = this.db().prepare('SELECT v.graph_json FROM workflow_runs r JOIN compiled_plans p ON p.plan_id=r.plan_id JOIN template_versions v ON v.version_id=p.version_id WHERE r.run_id=?').get(runId) as Row | undefined; if (!row) throw new WorkflowValidationError('WORKFLOW_SCHEMA_INVALID'); return this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown); }
  private versionCount(): number { return number(this.db().prepare('SELECT count(*) AS count FROM template_versions').get() as Row, 'count'); }
  private db(): DatabaseSync { if (!this.database) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); return this.database; }
}

function versionProjection(row: Row): WorkflowTemplateVersionProjection { return { templateId: text(row, 'template_id'), versionId: text(row, 'version_id'), versionNumber: number(row, 'version_number'), graphDigest: text(row, 'graph_digest'), catalogDigest: text(row, 'catalog_digest'), createdAt: text(row, 'created_at') }; }
function plan(row: Row) { return { planId: text(row, 'plan_id'), versionId: text(row, 'version_id'), planDigest: text(row, 'plan_digest'), graphDigest: text(row, 'graph_digest'), catalogDigest: text(row, 'catalog_digest'), trustSpineDigest: text(row, 'trust_spine_digest'), editableNodeCount: number(row, 'editable_node_count'), injectedAnchorCount: number(row, 'injected_anchor_count') }; }
function text(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); return value; }
function number(row: Row, key: string): number { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); return value; }
function uuid(value: string): void { if (!UUID.test(value)) throw new WorkflowValidationError('WORKFLOW_SCHEMA_INVALID'); }
function safeId(value: string): string { return UUID.test(value) ? value : 'invalid'; }
function isExternalAnchor(anchor: WorkflowAnchorKind): anchor is WorkflowExternalAnchorKind { return (EXTERNAL_ANCHORS as readonly string[]).includes(anchor); }
function validTrustAuthority(authority: WorkflowTrustSpineAuthority): boolean { try { const readiness = authority.readiness(); const contract = authority.contract(); const unsigned = { schemaVersion: contract.schemaVersion, authorityId: contract.authorityId, authorityVersion: contract.authorityVersion, supportedAnchors: contract.supportedAnchors }; return Object.keys(readiness).sort().join(',') === 'ready,recoveryComplete,residualProcessCount' && readiness.ready === true && readiness.recoveryComplete === true && readiness.residualProcessCount === 0 && Object.keys(contract).sort().join(',') === 'artifactDigest,authorityId,authorityVersion,schemaVersion,supportedAnchors' && contract.schemaVersion === '1' && contract.authorityId === 'kogg.workflow.trust-spine' && contract.authorityVersion === '1.0.0' && contract.supportedAnchors.join(',') === EXTERNAL_ANCHORS.join(',') && contract.artifactDigest === workflowDigest('executor-artifact', unsigned); } catch { /* observability-exempt: run.failed records WORKFLOW_AUTHORITY_EXPANSION; contract/readiness payloads are intentionally never logged. */ return false; } }
async function executeTrustAnchor(authority: WorkflowTrustSpineAuthority, request: WorkflowTrustAnchorRequestV1): Promise<WorkflowTrustAnchorResultV1> {
  let timer: NodeJS.Timeout | undefined; const timeout = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), TRUST_ANCHOR_DEADLINE_MS); });
  try {
    const result = await Promise.race([authority.execute(request), timeout]);
    if (result !== 'deadline') return result;
    try {
      const cancelled = await authority.cancel(request); const valid = !!cancelled && Object.keys(cancelled).sort().join(',') === 'code,processCount,residualProcessCount' && WORKFLOW_SAFE_CODES.includes(cancelled.code) && String(cancelled.code) !== 'WORKFLOW_OK' && Number.isSafeInteger(cancelled.processCount) && cancelled.processCount >= 0 && Number.isSafeInteger(cancelled.residualProcessCount) && cancelled.residualProcessCount >= 0;
      if (!valid) throw new Error('invalid trust anchor cancellation');
      return { kind: 'refused', code: cancelled.residualProcessCount ? 'WORKFLOW_RESIDUAL_PROCESS' : 'WORKFLOW_DEADLINE', processCount: cancelled.processCount, residualProcessCount: cancelled.residualProcessCount };
    } catch { /* observability-exempt: the caller records anchor.execution.refused with WORKFLOW_RESIDUAL_PROCESS and the conservative residual count. */ return { kind: 'refused', code: 'WORKFLOW_RESIDUAL_PROCESS', processCount: 0, residualProcessCount: 1 }; }
  } finally { if (timer) clearTimeout(timer); }
}
function validTrustResult(result: WorkflowTrustAnchorResultV1, inputSubject: string, anchor: WorkflowExternalAnchorKind, lastOwnerSequence: number): boolean { const common = !!result && Number.isSafeInteger(result.processCount) && result.processCount >= 0 && Number.isSafeInteger(result.residualProcessCount) && result.residualProcessCount >= 0; if (!common) return false; if (result.kind === 'refused') return Object.keys(result).sort().join(',') === 'code,kind,processCount,residualProcessCount' && WORKFLOW_SAFE_CODES.includes(result.code) && String(result.code) !== 'WORKFLOW_OK'; const sequence = Number(result.ownerSequence); return Object.keys(result).sort().join(',') === 'code,factDigest,kind,ownerSequence,processCount,residualProcessCount,subjectStateDigest' && result.code === 'WORKFLOW_OK' && /^[0-9a-f]{64}$/u.test(result.subjectStateDigest) && /^[0-9a-f]{64}$/u.test(result.factDigest) && /^[1-9][0-9]{0,15}$/u.test(result.ownerSequence) && Number.isSafeInteger(sequence) && sequence > lastOwnerSequence && result.residualProcessCount === 0 && (anchor === 'anchor.controlled-merge' || result.subjectStateDigest === inputSubject); }
function secretDigest(value: string): string { return createHash('sha256').update(`kogg-workflow-continuation-v1\0${value}`, 'utf8').digest('hex'); }
function schedulerOutput(value: string): SchedulerOutcome { if (!['success','failure','finally','true','false'].includes(value)) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); return value as SchedulerOutcome; }
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
function authorityRefused(fields: { runId: string; nodeId: string; nodeKind: string; attempt: number; executorId: string }) { workflowLog('node.execution.started', fields); return agentRefused(fields, 'WORKFLOW_AUTHORITY_EXPANSION', 0); }
function validTaskAdmission(admission: TaskAdmissionSnapshot, expectedId: string): boolean {
  const authorizedAt = Date.parse(admission.authorizedAt); const expiresAt = Date.parse(admission.expiresAt);
  return admission.taskAdmissionId === expectedId
    && [admission.taskAdmissionId, admission.taskId, admission.specificationId, admission.taskRevisionId, admission.approvalId, admission.projectId, admission.repositoryId, admission.runId].every(value => UUID.test(value))
    && admission.taskRevisionId === admission.specificationId
    && [admission.taskRevisionDigest, admission.approvalDigest].every(value => /^sha256:[0-9a-f]{64}$/u.test(value))
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
