import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import type { KoggWorkflowService, WorkflowMutationResult, WorkflowSafeCode, WorkflowTemplateVersionProjection, WorkflowValidationProjection } from '../common/workflow-protocol';
import { canonicalJson, WorkflowValidationError, workflowDigest } from '../common/workflow-canonical';
import { WorkflowCompiler } from './workflow-compiler';
import { workflowLog } from './workflow-logger';
import type { OperationsOwnerSink, OwnerEventV1, SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';

// Logs through the closed workflowLog schemas.
// diagnostic-coverage: workflow.schema, workflow.catalog, workflow.graph, workflow.anchors, workflow.authority, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.recovery, workflow.source-maps

type Row = Record<string, SQLOutputValue>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEGACY_UNATTESTED_CATALOG = '0'.repeat(64);

@injectable()
export class WorkflowRegistry implements KoggWorkflowService, BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private readonly schedulerEpochId = randomUUID();
  private readonly schedulerFencingToken = randomUUID();
  private ownerSink: OperationsOwnerSink | undefined;
  constructor(@inject(WorkflowCompiler) private readonly compiler: WorkflowCompiler, @unmanaged() private readonly databasePath = path.join(stateRoot(), 'workflow', 'registry.sqlite3')) {}

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

  publishOwnerEvents(): void {
    if (!this.ownerSink || !this.database) return;
    const meta = this.database.prepare('SELECT owner_id,owner_epoch_id FROM workflow_owner_meta WHERE singleton=1').get() as Row;
    let previous = '0'.repeat(64);
    for (const row of this.database.prepare(`SELECT e.*,r.plan_id,v.graph_json FROM workflow_scheduler_events e JOIN workflow_runs r ON r.run_id=e.run_id JOIN compiled_plans p ON p.plan_id=r.plan_id JOIN template_versions v ON v.version_id=p.version_id ORDER BY e.sequence`).all() as Row[]) {
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

  async admitRun(input: { requestId: string; planId: string }): Promise<WorkflowMutationResult> {
    workflowLog('run.admission.requested', { requestId: safeId(input.requestId), planId: safeId(input.planId) });
    let unavailableExecutorCount = 0;
    try {
      uuid(input.requestId); uuid(input.planId);
      const storedPlan = this.compiledPlan(input.planId); const storedVersion = this.version(text(storedPlan, 'version_id'));
      const graph = this.compiler.decodeAndValidate(JSON.parse(text(storedVersion, 'graph_json')) as unknown);
      const catalog = this.compiler.catalogStatus();
      if (text(storedPlan, 'catalog_digest') !== catalog.digest || text(storedVersion, 'catalog_digest') !== catalog.digest) throw new WorkflowValidationError('WORKFLOW_CATALOG_MISMATCH');
      this.compiler.assertPlanIntegrity(plan(storedPlan), graph);
      unavailableExecutorCount = graph.nodes.filter(node => this.compiler.catalogEntry(node.kind).executor.status === 'unavailable').length;
      const requestDigest = workflowDigest('run-snapshot', { schemaVersion: '1', planId: input.planId, planDigest: text(storedPlan, 'plan_digest') });
      const result = this.transaction(input.requestId, requestDigest, () => ({ kind: 'refused', code: unavailableExecutorCount > 0 ? 'WORKFLOW_EXECUTOR_INCOMPATIBLE' : 'WORKFLOW_AUTHORITY_EXPANSION' } as const));
      workflowLog('run.admission.refused', { requestId: input.requestId, planId: input.planId, safeCode: result.code, unavailableExecutorCount });
      return result;
    } catch (error) {
      // observability-exempt: run.admission.refused is the sanitized terminal event and excludes graph, configuration, and executor details.
      const code = codeOf(error); workflowLog('run.admission.refused', { requestId: safeId(input.requestId), planId: safeId(input.planId), safeCode: code, unavailableExecutorCount }); return { kind: 'refused', code };
    }
  }

  async listVersions(templateId: string): Promise<readonly WorkflowTemplateVersionProjection[]> { uuid(templateId); return (this.db().prepare('SELECT * FROM template_versions WHERE template_id=? ORDER BY version_number').all(templateId) as Row[]).map(versionProjection); }

  async diagnostics(): Promise<{ integrity: boolean; foreignKeys: boolean; immutableTriggers: boolean; canonicalMismatchCount: number; catalogMismatchCount: number; catalogEntryCount: number; unavailableExecutorCount: number; planMismatchCount: number; versionCount: number; planCount: number; schedulerIntegrity: boolean; ownerIntegrity: boolean; ownerEventCount: number; schedulerLeaseActive: boolean; schedulerAdmission: 'enabled' | 'blocked' | 'recovering'; pendingOutboxCount: number; quarantinedRunCount: number; activeProcessCount: number; residualProcessCount: number; recoveryBacklogCount: number; sourceMapsPresent: boolean }> {
    const db = this.db(); const integrity = text(db.prepare('PRAGMA quick_check').get() as Row, 'quick_check') === 'ok'; const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length === 0;
    const immutableTriggers = number(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'workflow_immutable_%'").get() as Row, 'count') === 8;
    let canonicalMismatchCount = 0; for (const row of db.prepare('SELECT graph_json,graph_digest FROM template_versions').all() as Row[]) { try { const graph = this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown); if (workflowDigest('template', graph) !== text(row, 'graph_digest')) canonicalMismatchCount++; } catch { /* observability-exempt: aggregate canonical mismatch count is the diagnostic signal; content is never logged. */ canonicalMismatchCount++; } }
    const catalog = this.compiler.catalogStatus();
    const catalogMismatchCount = number(db.prepare('SELECT count(*) AS count FROM template_versions WHERE catalog_digest<>?').get(catalog.digest) as Row, 'count') + number(db.prepare('SELECT count(*) AS count FROM compiled_plans WHERE catalog_digest<>?').get(catalog.digest) as Row, 'count') + (catalog.valid ? 0 : 1);
    let planMismatchCount = 0; for (const row of db.prepare('SELECT * FROM compiled_plans').all() as Row[]) { try { const version = this.version(text(row, 'version_id')); const graph = this.compiler.decodeAndValidate(JSON.parse(text(version, 'graph_json')) as unknown); if (text(row, 'graph_digest') !== text(version, 'graph_digest') || text(row, 'catalog_digest') !== text(version, 'catalog_digest')) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); this.compiler.assertPlanIntegrity(plan(row), graph); } catch { /* observability-exempt: aggregate plan mismatch count is the diagnostic signal; plan contents are never logged. */ planMismatchCount++; } }
    const packageRuntime = path.basename(__filename) === 'workflow-registry.js'; const sourceMapsPresent = existsSync(`${__filename}.map`) && (!packageRuntime || (existsSync(path.join(__dirname, 'workflow-compiler.js.map')) && existsSync(path.join(__dirname, 'workflow-node-catalog.js.map'))));
    const lease = db.prepare('SELECT phase,admission FROM scheduler_lease WHERE singleton=1').get() as Row | undefined;
    const pendingOutboxCount = number(db.prepare("SELECT count(*) AS count FROM workflow_outbox WHERE phase IN ('requested','claimed')").get() as Row, 'count');
    const quarantinedRunCount = number(db.prepare("SELECT count(*) AS count FROM workflow_runs WHERE state='quarantined'").get() as Row, 'count');
    const schedulerIntegrity = this.schedulerEventsValid() && this.schedulerRecordsValid();
    const ownerIntegrity = this.ownerIdentityValid(); const ownerEventCount = number(db.prepare('SELECT count(*) AS count FROM workflow_scheduler_events').get() as Row, 'count');
    return { integrity: integrity && schedulerIntegrity && ownerIntegrity, foreignKeys, immutableTriggers, canonicalMismatchCount, catalogMismatchCount, catalogEntryCount: catalog.entryCount, unavailableExecutorCount: catalog.unavailableExecutorCount, planMismatchCount, versionCount: this.versionCount(), planCount: number(db.prepare('SELECT count(*) AS count FROM compiled_plans').get() as Row, 'count'), schedulerIntegrity, ownerIntegrity, ownerEventCount, schedulerLeaseActive: lease ? text(lease, 'phase') === 'active' : false, schedulerAdmission: lease ? text(lease, 'admission') as 'enabled' | 'blocked' | 'recovering' : 'recovering', pendingOutboxCount, quarantinedRunCount, activeProcessCount: 0, residualProcessCount: 0, recoveryBacklogCount: pendingOutboxCount + quarantinedRunCount, sourceMapsPresent };
  }

  private transaction(requestId: string, requestDigest: string, action: () => WorkflowMutationResult): WorkflowMutationResult {
    const db = this.db(); db.exec('BEGIN IMMEDIATE');
    try { const prior = db.prepare('SELECT request_digest,result_json FROM idempotency WHERE request_id=?').get(requestId) as Row | undefined; if (prior) { if (text(prior, 'request_digest') !== requestDigest) throw new WorkflowValidationError('WORKFLOW_VERSION_CONFLICT'); db.exec('ROLLBACK'); return JSON.parse(text(prior, 'result_json')) as WorkflowMutationResult; } const result = action(); db.prepare('INSERT INTO idempotency(request_id,request_digest,result_json) VALUES(?,?,?)').run(requestId, requestDigest, JSON.stringify(result)); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* observability-exempt: the original sanitized operation refusal remains authoritative. */ } throw error; }
  }
  private migrate(): void { this.db().exec(`CREATE TABLE IF NOT EXISTS template_versions(version_id TEXT PRIMARY KEY,template_id TEXT NOT NULL,version_number INTEGER NOT NULL CHECK(version_number>0),graph_digest TEXT NOT NULL,catalog_digest TEXT NOT NULL,graph_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(template_id,version_number));
    CREATE TABLE IF NOT EXISTS compiled_plans(plan_id TEXT PRIMARY KEY,version_id TEXT NOT NULL UNIQUE REFERENCES template_versions(version_id),plan_digest TEXT NOT NULL UNIQUE,graph_digest TEXT NOT NULL,catalog_digest TEXT NOT NULL,trust_spine_digest TEXT NOT NULL,editable_node_count INTEGER NOT NULL,injected_anchor_count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,result_json TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_versions_update BEFORE UPDATE ON template_versions BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_versions_delete BEFORE DELETE ON template_versions BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_plans_update BEFORE UPDATE ON compiled_plans BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_plans_delete BEFORE DELETE ON compiled_plans BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TABLE IF NOT EXISTS scheduler_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_epoch_id TEXT NOT NULL,fencing_token TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('active','released')),admission TEXT NOT NULL CHECK(admission IN ('enabled','blocked','recovering')),updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_runs(run_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES compiled_plans(plan_id),plan_digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('admitted','running','stopping','completed','failed','cancelled','quarantined')),revision INTEGER NOT NULL CHECK(revision>=1),owner_epoch_id TEXT NOT NULL,safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_node_attempts(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),node_id TEXT NOT NULL,attempt INTEGER NOT NULL CHECK(attempt>=1),state TEXT NOT NULL CHECK(state IN ('pending','ready','dispatched','running','succeeded','failed','cancelled','quarantined')),fencing_token TEXT NOT NULL,safe_code TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,node_id,attempt));
    CREATE TABLE IF NOT EXISTS workflow_outbox(outbox_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),node_id TEXT NOT NULL,operation_kind TEXT NOT NULL,request_digest TEXT NOT NULL,fencing_token TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('requested','claimed','completed','quarantined')),safe_code TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_scheduler_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),event_name TEXT NOT NULL,safe_code TEXT NOT NULL,previous_event_digest TEXT NOT NULL,event_digest TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_scheduler_events_update BEFORE UPDATE ON workflow_scheduler_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_scheduler_events_delete BEFORE DELETE ON workflow_scheduler_events BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    this.db().exec(`CREATE TABLE IF NOT EXISTS workflow_owner_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL,owner_epoch_id TEXT NOT NULL,identity_digest TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_owner_meta_update BEFORE UPDATE ON workflow_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_owner_meta_delete BEFORE DELETE ON workflow_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    if (!this.db().prepare('SELECT 1 FROM workflow_owner_meta WHERE singleton=1').get()) { const ownerId = randomUUID(); const ownerEpochId = randomUUID(); this.db().prepare('INSERT INTO workflow_owner_meta(singleton,owner_id,owner_epoch_id,identity_digest) VALUES(1,?,?,?)').run(ownerId, ownerEpochId, workflowDigest('owner-identity', { ownerId, ownerEpochId })); }
    this.db().prepare("INSERT OR IGNORE INTO scheduler_lease(singleton,owner_epoch_id,fencing_token,phase,admission,updated_at) VALUES(1,?,?,'released','recovering',?)").run(this.schedulerEpochId, this.schedulerFencingToken, new Date().toISOString());
    this.ensureColumn('template_versions', 'catalog_digest', LEGACY_UNATTESTED_CATALOG); this.ensureColumn('compiled_plans', 'catalog_digest', LEGACY_UNATTESTED_CATALOG); }
  private ensureColumn(table: 'template_versions' | 'compiled_plans', column: 'catalog_digest', value: string): void { const present = (this.db().prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(row => text(row, 'name') === column); if (!present) this.db().exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${value}'`); }
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
    const malformedOutbox = number(this.db().prepare("SELECT count(*) AS count FROM workflow_outbox WHERE length(request_digest)<>64 OR request_digest GLOB '*[^0-9a-f]*'").get() as Row, 'count'); return mismatchedRuns === 0 && malformedOutbox === 0;
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
function codeOf(error: unknown): WorkflowSafeCode { return error instanceof WorkflowValidationError ? error.code : 'WORKFLOW_INTERNAL'; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state')); }

function sourcePreviousDigest(database: DatabaseSync, sequence: number): string { const row = database.prepare('SELECT event_digest FROM workflow_scheduler_events WHERE sequence<? ORDER BY sequence DESC LIMIT 1').get(sequence) as Row | undefined; return row ? text(row, 'event_digest') : '0'.repeat(64); }
function schedulerEventDigest(row: Row): string { return workflowDigest('scheduler-event', { eventId: text(row, 'event_id'), runId: text(row, 'run_id'), eventName: text(row, 'event_name'), safeCode: text(row, 'safe_code'), previousEventDigest: text(row, 'previous_event_digest'), createdAt: text(row, 'created_at') }); }
function mapOwnerEvent(row: Row, ownerInstanceId: string, epochId: string, projectId: string, previousEventDigest: string): OwnerEventV1 {
  const safePayload: SafeOwnerPayloadV1 = { lifecycle: 'failed', terminalClass: 'failed', safeCode: text(row, 'safe_code'), freshness: 'current' };
  const unsigned: Omit<OwnerEventV1, 'eventDigest'> = { ownerKind: 'workflow', ownerInstanceId, ownerSchemaVersion: 1, epochId, sequence: String(number(row, 'sequence')), eventId: text(row, 'event_id'), eventKind: 'run.failed', factId: text(row, 'run_id'), factDigest: text(row, 'event_digest'), previousEventDigest, causalParents: [], correlations: { projectId, runId: text(row, 'run_id') }, observedAt: text(row, 'created_at'), safePayload };
  return { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) };
}
