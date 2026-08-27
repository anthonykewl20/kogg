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

// Logs through the closed workflowLog schemas.
// diagnostic-coverage: workflow.schema, workflow.catalog, workflow.graph, workflow.anchors, workflow.authority, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.recovery, workflow.source-maps

type Row = Record<string, SQLOutputValue>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEGACY_UNATTESTED_CATALOG = '0'.repeat(64);

@injectable()
export class WorkflowRegistry implements KoggWorkflowService, BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  constructor(@inject(WorkflowCompiler) private readonly compiler: WorkflowCompiler, @unmanaged() private readonly databasePath = path.join(stateRoot(), 'workflow', 'registry.sqlite3')) {}

  async onStart(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      this.migrate(); this.assertIntegrity(); const stored = await this.diagnostics(); if (stored.canonicalMismatchCount || stored.catalogMismatchCount || stored.planMismatchCount) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); await fs.chmod(this.databasePath, 0o600).catch(error => { if (process.platform !== 'win32') throw error; });
      const versionCount = this.versionCount(); workflowLog('recovery.started', { versionCount });
      workflowLog('recovery.completed', { versionCount, activeProcessCount: 0 });
    } catch (error) {
      // observability-exempt: diagnostics.failed records the sanitized startup failure without raw database text.
      this.database?.close(); this.database = undefined; workflowLog('diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); throw error;
    }
  }

  async onStop(): Promise<void> { workflowLog('registry.stop.started', {}); try { this.database?.close(); this.database = undefined; workflowLog('registry.stop.completed', {}); } catch (error) { /* observability-exempt: registry.stop.failed emits only a normalized error type. */ workflowLog('registry.stop.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); throw error; } }
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

  async diagnostics(): Promise<{ integrity: boolean; foreignKeys: boolean; immutableTriggers: boolean; canonicalMismatchCount: number; catalogMismatchCount: number; catalogEntryCount: number; unavailableExecutorCount: number; planMismatchCount: number; versionCount: number; planCount: number; activeProcessCount: number; residualProcessCount: number; recoveryBacklogCount: number; sourceMapsPresent: boolean }> {
    const db = this.db(); const integrity = text(db.prepare('PRAGMA quick_check').get() as Row, 'quick_check') === 'ok'; const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length === 0;
    const immutableTriggers = number(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'workflow_immutable_%'").get() as Row, 'count') === 4;
    let canonicalMismatchCount = 0; for (const row of db.prepare('SELECT graph_json,graph_digest FROM template_versions').all() as Row[]) { try { const graph = this.compiler.decodeAndValidate(JSON.parse(text(row, 'graph_json')) as unknown); if (workflowDigest('template', graph) !== text(row, 'graph_digest')) canonicalMismatchCount++; } catch { /* observability-exempt: aggregate canonical mismatch count is the diagnostic signal; content is never logged. */ canonicalMismatchCount++; } }
    const catalog = this.compiler.catalogStatus();
    const catalogMismatchCount = number(db.prepare('SELECT count(*) AS count FROM template_versions WHERE catalog_digest<>?').get(catalog.digest) as Row, 'count') + number(db.prepare('SELECT count(*) AS count FROM compiled_plans WHERE catalog_digest<>?').get(catalog.digest) as Row, 'count') + (catalog.valid ? 0 : 1);
    let planMismatchCount = 0; for (const row of db.prepare('SELECT * FROM compiled_plans').all() as Row[]) { const version = this.version(text(row, 'version_id')); const graph = this.compiler.decodeAndValidate(JSON.parse(text(version, 'graph_json')) as unknown); const trustSpineDigest = workflowDigest('trust-spine', { schemaVersion: '1', anchors: ['anchor.spec-frozen','anchor.spec-approved','anchor.producer-separated','anchor.checks-complete','anchor.evidence-admitted','anchor.ranex-pass-current','anchor.merge-preflight','anchor.controlled-merge','anchor.cleanup-complete'] }); const catalogDigest = text(row, 'catalog_digest'); const expectedPlanDigest = workflowDigest('compiled-plan', { schemaVersion: '1', versionId: text(row, 'version_id'), graphDigest: text(version, 'graph_digest'), catalogDigest, trustSpineDigest, editableNodeIds: graph.nodes.map(node => node.nodeId), anchors: ['anchor.spec-frozen','anchor.spec-approved','anchor.producer-separated','anchor.checks-complete','anchor.evidence-admitted','anchor.ranex-pass-current','anchor.merge-preflight','anchor.controlled-merge','anchor.cleanup-complete'] }); if (text(row, 'graph_digest') !== text(version, 'graph_digest') || catalogDigest !== text(version, 'catalog_digest') || catalogDigest !== catalog.digest || text(row, 'trust_spine_digest') !== trustSpineDigest || text(row, 'plan_digest') !== expectedPlanDigest) planMismatchCount++; }
    const packageRuntime = path.basename(__filename) === 'workflow-registry.js'; const sourceMapsPresent = existsSync(`${__filename}.map`) && (!packageRuntime || (existsSync(path.join(__dirname, 'workflow-compiler.js.map')) && existsSync(path.join(__dirname, 'workflow-node-catalog.js.map'))));
    return { integrity, foreignKeys, immutableTriggers, canonicalMismatchCount, catalogMismatchCount, catalogEntryCount: catalog.entryCount, unavailableExecutorCount: catalog.unavailableExecutorCount, planMismatchCount, versionCount: this.versionCount(), planCount: number(db.prepare('SELECT count(*) AS count FROM compiled_plans').get() as Row, 'count'), activeProcessCount: 0, residualProcessCount: 0, recoveryBacklogCount: 0, sourceMapsPresent };
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
    CREATE TRIGGER IF NOT EXISTS workflow_immutable_plans_delete BEFORE DELETE ON compiled_plans BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    this.ensureColumn('template_versions', 'catalog_digest', LEGACY_UNATTESTED_CATALOG); this.ensureColumn('compiled_plans', 'catalog_digest', LEGACY_UNATTESTED_CATALOG); }
  private ensureColumn(table: 'template_versions' | 'compiled_plans', column: 'catalog_digest', value: string): void { const present = (this.db().prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(row => text(row, 'name') === column); if (!present) this.db().exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${value}'`); }
  private assertIntegrity(): void { const db = this.db(); if (text(db.prepare('PRAGMA quick_check').get() as Row, 'quick_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new WorkflowValidationError('WORKFLOW_STORE_INTEGRITY'); }
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
