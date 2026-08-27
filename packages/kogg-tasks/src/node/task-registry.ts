import { randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ProjectBindingAuthority, type ProjectBindingAuthority as BindingAuthority, type ProjectBindingSnapshot } from '@kogg/projects/lib/common/projects-protocol';
import type { ApprovalProjection, KoggTasksService, MutationPrecondition, ReviewProjection, TaskAdmissionSnapshot, TaskKernelAuthoritySnapshot, TaskMutationResult, TaskProjection, TaskSafeCode, TaskSummary } from '../common/tasks-protocol';
import { canonicalRequestDigest, canonicalSpecification, SpecificationValidationError } from '../common/canonical-specification';

// diagnostic-coverage: tasks.registry, tasks.revisions, tasks.bindings, tasks.approvals

type Row = Record<string, SQLOutputValue>;
type Challenge = { taskId: string; specificationId: string; sessionId: string; expiresAt: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

@injectable()
export class TaskRegistry implements KoggTasksService, BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private readonly challenges = new Map<string, Challenge>();
  private readonly databasePath = path.join(stateRoot(), 'tasks', 'registry.sqlite3');

  constructor(@inject(ProjectBindingAuthority) private readonly projects: BindingAuthority) {}

  async onStart(): Promise<void> {
    console.info('[kogg:tasks:registry] registry.start.requested');
    try {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      this.migrate(); this.assertIntegrity();
      await fs.chmod(this.databasePath, 0o600).catch(error => { if (process.platform !== 'win32') throw error; });
      console.info('[kogg:tasks:registry] registry.recovery.started', { taskCount: this.taskCount() });
      console.info('[kogg:tasks:registry] registry.recovery.completed', { taskCount: this.taskCount() });
      console.info('[kogg:tasks:registry] registry.start.completed', { schemaVersion: 1 });
    } catch (error) {
      this.database?.close(); this.database = undefined;
      console.error('[kogg:tasks:registry] registry.start.failed', { errorType: errorName(error), safeCode: codeOf(error) });
      throw error;
    }
  }

  async onStop(): Promise<void> {
    console.info('[kogg:tasks:registry] registry.stop.started');
    this.challenges.clear();
    try { this.database?.close(); this.database = undefined; console.info('[kogg:tasks:registry] registry.stop.completed'); }
    catch (error) { console.error('[kogg:tasks:registry] registry.stop.failed', { errorType: errorName(error) }); throw error; }
  }

  async list(projectId?: string): Promise<readonly TaskSummary[]> {
    if (projectId) uuid(projectId);
    const rows = (projectId ? this.db().prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId)
      : this.db().prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100').all()) as Row[];
    return rows.map(task => {
      const spec = this.spec(str(task, 'current_specification_id'));
      return { taskId: str(task, 'task_id'), projectId: str(task, 'project_id'), repositoryId: str(task, 'repository_id'),
        taskRevision: dec(task, 'task_revision'), lifecycle: str(task, 'lifecycle') as TaskSummary['lifecycle'],
        specificationLifecycle: str(spec, 'lifecycle') as TaskSummary['specificationLifecycle'],
        approvalLifecycle: optional(task, 'current_approval_id') ? 'current' : undefined };
    });
  }
  async get(taskId: string): Promise<TaskProjection> { uuid(taskId); return this.projection(taskId); }

  async create(input: { requestId: string; projectId: string; repositoryId: string; content: string }): Promise<TaskMutationResult> {
    const op = 'task.create'; this.requested(op, input.requestId, { projectId: safe(input.projectId), repositoryId: safe(input.repositoryId) });
    try {
      uuid(input.requestId); uuid(input.projectId); uuid(input.repositoryId);
      const binding = await this.projects.resolveBinding(input.projectId, input.repositoryId);
      if (!binding) return this.refused(op, input.requestId, 'BINDING_MISSING');
      if (!binding.available || !binding.active) return this.refused(op, input.requestId, 'PROJECT_UNTRUSTED');
      const taskId = randomUUID();
      const canonical = canonicalSpecification({ content: input.content, taskId, projectId: input.projectId, repositoryId: input.repositoryId, bindingRevision: String(binding.bindingRevision) });
      const digest = canonicalRequestDigest({ ...input, content: canonical.bytes.toString('base64') });
      const result = this.write(op, input.requestId, digest, db => {
        const specId = randomUUID(); const now = new Date().toISOString(); const registryRevision = this.bumpRegistry(db);
        db.prepare(`INSERT INTO tasks(task_id,project_id,repository_id,binding_revision,task_revision,lifecycle,current_specification_id,current_approval_id,created_at)
          VALUES(?,?,?,?,1,'active',?,NULL,?)`).run(taskId, input.projectId, input.repositoryId, binding.bindingRevision, specId, now);
        this.insertSpec(db, specId, taskId, 1, undefined, 'draft', canonical, now);
        this.event(db, taskId, 1, registryRevision, 'task.created', specId);
        return done(this.projection(taskId, db));
      });
      this.terminal(op, input.requestId, result, { taskId: result.projection?.taskId ?? taskId }); return result;
    } catch (error) {
      // observability-exempt: failed emits the sanitized terminal failure for this mutation.
      return this.failed(op, input.requestId, error);
    }
  }

  async edit(input: MutationPrecondition & { taskId: string; content: string }): Promise<TaskMutationResult> {
    const binding = await this.binding(input.taskId);
    return this.mutate('specification.edit', input, binding, (db, task, current, revision) => {
      this.requireActiveDraft(task, current);
      const next = num(task, 'task_revision') + 1; const specId = randomUUID();
      const canonical = canonicalSpecification({ content: input.content, taskId: input.taskId, projectId: str(task, 'project_id'), repositoryId: str(task, 'repository_id'), bindingRevision: dec(task, 'binding_revision') });
      this.insertSpec(db, specId, input.taskId, next, str(current, 'specification_id'), 'draft', canonical, new Date().toISOString());
      db.prepare('UPDATE tasks SET current_specification_id=?,current_approval_id=NULL,task_revision=? WHERE task_id=?').run(specId, next, input.taskId);
      this.event(db, input.taskId, next, revision, 'specification.edited', specId);
    });
  }

  async freeze(input: MutationPrecondition & { taskId: string }): Promise<TaskMutationResult> {
    const binding = await this.binding(input.taskId);
    return this.mutate('specification.freeze', input, binding, (db, task, current, revision) => {
      this.requireActiveDraft(task, current);
      this.copySpec(db, task, current, input.taskId, 'frozen', 'specification.frozen', revision);
    });
  }

  async createSuccessorDraft(input: MutationPrecondition & { taskId: string }): Promise<TaskMutationResult> {
    const binding = await this.binding(input.taskId);
    return this.mutate('specification.successor', input, binding, (db, task, current, revision) => {
      if (str(task, 'lifecycle') !== 'active') throw new Refusal('TASK_ARCHIVED');
      if (str(current, 'lifecycle') !== 'frozen') throw new Refusal('TASK_NOT_DRAFT');
      this.copySpec(db, task, current, input.taskId, 'draft', 'specification.successor-created', revision);
    });
  }

  async beginApprovalReview(input: { requestId: string; taskId: string; sessionId: string }): Promise<ReviewProjection> {
    this.requested('review', input.requestId, { taskId: safe(input.taskId), sessionId: safe(input.sessionId) });
    try {
      uuid(input.requestId); uuid(input.taskId); uuid(input.sessionId);
      const task = this.task(input.taskId); const current = this.spec(str(task, 'current_specification_id'));
      const binding = await this.projects.resolveBinding(str(task, 'project_id'), str(task, 'repository_id'));
      if (str(task, 'lifecycle') !== 'active' || str(current, 'lifecycle') !== 'frozen') return this.reviewRefused(input, 'REVIEW_REQUIRED');
      if (!matches(task, binding)) return this.reviewRefused(input, 'BINDING_CHANGED');
      const challenge = randomUUID(); const expiresAt = Date.now() + 600_000;
      this.challenges.set(challenge, { taskId: input.taskId, specificationId: str(current, 'specification_id'), sessionId: input.sessionId, expiresAt });
      console.info('[kogg:tasks:approval] review.completed', { requestId: input.requestId, taskId: input.taskId, sessionId: input.sessionId });
      return { kind: 'completed', code: 'TASK_OK', challenge, expiresAt: new Date(expiresAt).toISOString(), projection: this.projection(input.taskId) };
    } catch (error) {
      console.error('[kogg:tasks:approval] review.failed', { requestId: safe(input.requestId), taskId: safe(input.taskId), errorType: errorName(error) });
      return { kind: 'failed', code: codeOf(error) };
    }
  }

  async approve(input: MutationPrecondition & { taskId: string; sessionId: string; challenge: string }): Promise<TaskMutationResult> {
    this.requested('approval', input.requestId, { taskId: safe(input.taskId) });
    const review = this.challenges.get(input.challenge);
    if (!review) return this.refused('approval', input.requestId, 'REVIEW_REQUIRED', { taskId: safe(input.taskId) });
    if (review.sessionId !== input.sessionId) return this.refused('approval', input.requestId, 'REVIEW_SESSION_CHANGED', { taskId: safe(input.taskId) });
    if (review.expiresAt < Date.now()) { this.challenges.delete(input.challenge); return this.refused('approval', input.requestId, 'REVIEW_EXPIRED', { taskId: safe(input.taskId) }); }
    const binding = await this.binding(input.taskId);
    const result = await this.mutate('approval', input, binding, (db, task, current, revision) => {
      if (str(current, 'lifecycle') !== 'frozen' || str(current, 'specification_id') !== review.specificationId) throw new Refusal('CURRENT_REVISION_CHANGED');
      const approvalId = randomUUID(); const next = num(task, 'task_revision') + 1;
      const approvalDigest = canonicalRequestDigest({ version: 'kogg.task-approval.v1', approvalId, taskId: input.taskId,
        specificationId: str(current, 'specification_id'), specificationDigest: str(current, 'specification_digest'),
        projectId: str(task, 'project_id'), repositoryId: str(task, 'repository_id'), bindingRevision: dec(task, 'binding_revision') });
      db.prepare('INSERT INTO approvals(approval_id,task_id,specification_id,approval_digest,created_at) VALUES(?,?,?,?,?)')
        .run(approvalId, input.taskId, str(current, 'specification_id'), approvalDigest, new Date().toISOString());
      db.prepare('UPDATE tasks SET current_approval_id=?,task_revision=? WHERE task_id=?').run(approvalId, next, input.taskId);
      this.event(db, input.taskId, next, revision, 'approval.recorded', approvalId);
    }, true);
    if (result.kind === 'completed') this.challenges.delete(input.challenge);
    return result;
  }

  async revoke(input: MutationPrecondition & { taskId: string }): Promise<TaskMutationResult> {
    return this.mutate('approval.revoke', input, await this.binding(input.taskId), (db, task, _current, revision) => {
      const approval = optional(task, 'current_approval_id'); if (!approval) throw new Refusal('APPROVAL_NOT_CURRENT');
      const next = num(task, 'task_revision') + 1;
      db.prepare('UPDATE tasks SET current_approval_id=NULL,task_revision=? WHERE task_id=?').run(next, input.taskId);
      this.event(db, input.taskId, next, revision, 'approval.revoked', approval);
    });
  }

  async archive(input: MutationPrecondition & { taskId: string }): Promise<TaskMutationResult> {
    return this.mutate('task.archive', input, await this.binding(input.taskId), (db, task, _current, revision) => {
      if (str(task, 'lifecycle') === 'archived') throw new Refusal('TASK_ALREADY_ARCHIVED');
      const next = num(task, 'task_revision') + 1;
      db.prepare("UPDATE tasks SET lifecycle='archived',current_approval_id=NULL,task_revision=? WHERE task_id=?").run(next, input.taskId);
      this.event(db, input.taskId, next, revision, 'task.archived', input.taskId);
    });
  }

  async authorizeAdmission(input: MutationPrecondition & { taskId: string; runId: string }): Promise<TaskMutationResult & { admission?: TaskAdmissionSnapshot }> {
    uuid(input.runId);
    const result = await this.mutate('admission', input, await this.binding(input.taskId), (db, task, current, revision) => {
      const approval = optional(task, 'current_approval_id');
      if (!approval || str(current, 'lifecycle') !== 'frozen') throw new Refusal('ADMISSION_NOT_AUTHORIZED');
      const next = num(task, 'task_revision') + 1; db.prepare('UPDATE tasks SET task_revision=? WHERE task_id=?').run(next, input.taskId);
      this.event(db, input.taskId, next, revision, 'admission.authorized', approval);
      const authorizedAt = new Date().toISOString();
      const admission: TaskAdmissionSnapshot = { taskId: input.taskId, specificationId: str(current, 'specification_id'), approvalId: approval,
        projectId: str(task, 'project_id'), repositoryId: str(task, 'repository_id'), bindingRevision: dec(task, 'binding_revision'),
        registryRevision: String(revision), taskRevision: String(next), runId: input.runId, authorizedAt,
        expiresAt: new Date(Date.parse(authorizedAt) + 15 * 60_000).toISOString() };
      db.prepare(`INSERT INTO admissions(run_id,task_id,task_revision,specification_id,approval_id,project_id,repository_id,binding_revision,
        registry_revision,authorized_at,expires_at,admission_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        admission.runId, admission.taskId, Number(admission.taskRevision), admission.specificationId, admission.approvalId,
        admission.projectId, admission.repositoryId, Number(admission.bindingRevision), Number(admission.registryRevision),
        admission.authorizedAt, admission.expiresAt, canonicalRequestDigest(admission));
    });
    const row = result.kind === 'completed' ? this.db().prepare('SELECT * FROM admissions WHERE run_id = ?').get(input.runId) as Row | undefined : undefined;
    return { ...result, admission: row ? this.admission(row) : undefined };
  }

  async resolveAdmission(admission: TaskAdmissionSnapshot): Promise<TaskKernelAuthoritySnapshot> {
    console.debug('[kogg:tasks:registry] kernel-binding.validation.started', { taskId: safe(admission.taskId), runId: safe(admission.runId) });
    try {
      uuid(admission.taskId); uuid(admission.runId); uuid(admission.specificationId); uuid(admission.approvalId);
      const task = this.task(admission.taskId); const specification = this.spec(str(task, 'current_specification_id'));
      const approval = this.db().prepare('SELECT * FROM approvals WHERE approval_id = ?').get(admission.approvalId) as Row | undefined;
      const storedAdmission = this.db().prepare('SELECT * FROM admissions WHERE run_id = ?').get(admission.runId) as Row | undefined;
      const binding = await this.projects.resolveBinding(str(task, 'project_id'), str(task, 'repository_id'));
      if (!approval || !storedAdmission || !equal(canonicalRequestDigest(admission), str(storedAdmission, 'admission_digest'))
        || Date.parse(admission.expiresAt) <= Date.now() || !binding || !matches(task, binding) || str(task, 'lifecycle') !== 'active' || str(specification, 'lifecycle') !== 'frozen'
        || str(task, 'current_specification_id') !== admission.specificationId || optional(task, 'current_approval_id') !== admission.approvalId
        || str(approval, 'specification_id') !== admission.specificationId || dec(task, 'task_revision') !== admission.taskRevision
        || str(task, 'project_id') !== admission.projectId || str(task, 'repository_id') !== admission.repositoryId
        || dec(task, 'binding_revision') !== admission.bindingRevision) throw new Refusal('ADMISSION_NOT_AUTHORIZED');
      const result = {
        taskId: admission.taskId, taskRevision: num(task, 'task_revision'), specificationDigest: str(specification, 'specification_digest'),
        approvalId: admission.approvalId, approvalDigest: `sha256:${str(approval, 'approval_digest')}`, approvalCreatedAt: str(approval, 'created_at'),
        projectId: admission.projectId, repositoryId: admission.repositoryId, bindingRevision: num(task, 'binding_revision'),
        runId: admission.runId, authorizedAt: admission.authorizedAt, expiresAt: admission.expiresAt,
        executionProfileId: binding.executionProfileId, rootUri: binding.rootUri,
        repositoryIdentityDigest: binding.repositoryIdentityDigest
      } satisfies TaskKernelAuthoritySnapshot;
      console.info('[kogg:tasks:registry] kernel-binding.validation.completed', { taskId: admission.taskId, runId: admission.runId });
      return result;
    } catch (error) {
      console.warn('[kogg:tasks:registry] kernel-binding.validation.refused', { taskId: safe(admission.taskId), runId: safe(admission.runId), safeCode: 'ADMISSION_NOT_AUTHORIZED', errorType: errorName(error) });
      throw new Refusal('ADMISSION_NOT_AUTHORIZED');
    }
  }

  async diagnostics(): Promise<{ integrity: boolean; foreignKeys: boolean; immutableTriggers: boolean; revisionMismatchCount: number; bindingMismatchCount: number; approvalMismatchCount: number; taskCount: number; openTransactionCount: number }> {
    const db = this.db(); const integrity = str(db.prepare('PRAGMA quick_check').get() as Row, 'quick_check') === 'ok';
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length === 0;
    const immutableTriggers = num(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'tasks_immutable_%'").get() as Row, 'count') === 8;
    let revisionMismatchCount = 0; let bindingMismatchCount = 0;
    for (const spec of db.prepare('SELECT * FROM specifications ORDER BY task_id,sequence').all() as Row[]) {
      try { const task = this.task(str(spec, 'task_id')); const canonical = canonicalSpecification({ content: bytes(spec, 'content').toString('utf8'), taskId: str(spec, 'task_id'), projectId: str(task, 'project_id'), repositoryId: str(task, 'repository_id'), bindingRevision: dec(task, 'binding_revision') }); if (canonical.digest !== str(spec, 'specification_digest')) revisionMismatchCount++; }
      catch (error) { revisionMismatchCount++; console.error('[kogg:tasks:specification] diagnostics.revision.failed', { errorType: errorName(error) }); }
    }
    for (const task of db.prepare('SELECT * FROM tasks').all() as Row[]) {
      const binding = await this.projects.resolveBinding(str(task, 'project_id'), str(task, 'repository_id')).catch(error => { console.error('[kogg:tasks:registry] diagnostics.binding.failed', { errorType: errorName(error) }); return undefined; });
      if (!matches(task, binding)) bindingMismatchCount++;
    }
    const approvalMismatchCount = num(db.prepare(`SELECT count(*) AS count FROM tasks t LEFT JOIN approvals a ON a.approval_id=t.current_approval_id
      WHERE t.current_approval_id IS NOT NULL AND (a.approval_id IS NULL OR a.specification_id!=t.current_specification_id)`).get() as Row, 'count');
    return { integrity, foreignKeys, immutableTriggers, revisionMismatchCount, bindingMismatchCount, approvalMismatchCount, taskCount: this.taskCount(), openTransactionCount: 0 };
  }

  private async mutate(operation: string, input: MutationPrecondition & { taskId: string }, binding: ProjectBindingSnapshot | undefined,
    action: (db: DatabaseSync, task: Row, current: Row, registryRevision: number) => void, alreadyRequested = false): Promise<TaskMutationResult> {
    if (!alreadyRequested) this.requested(operation, input.requestId, { taskId: safe(input.taskId) });
    try {
      uuid(input.requestId); uuid(input.taskId); decimal(input.expectedRegistryRevision); decimal(input.expectedTaskRevision);
      const result = this.write(operation, input.requestId, canonicalRequestDigest(input), db => {
        const task = this.task(input.taskId, db); const registry = this.registryRevision(db); const taskRevision = num(task, 'task_revision');
        if (registry !== Number(input.expectedRegistryRevision)) throw new Conflict('REGISTRY_REVISION_CONFLICT', registry, taskRevision);
        if (taskRevision !== Number(input.expectedTaskRevision)) throw new Conflict('TASK_REVISION_CONFLICT', registry, taskRevision);
        if (!matches(task, binding)) throw new Refusal(binding ? 'BINDING_CHANGED' : 'BINDING_MISSING');
        const revision = registry + 1; action(db, task, this.spec(str(task, 'current_specification_id'), db), revision);
        db.prepare('UPDATE registry_meta SET registry_revision=? WHERE singleton=1').run(revision);
        return done(this.projection(input.taskId, db));
      });
      this.terminal(operation, input.requestId, result, { taskId: input.taskId }); return result;
    } catch (error) {
      // observability-exempt: refused, terminal, and failed emit the sanitized outcome for every classified path below.
      if (error instanceof Refusal) return this.refused(operation, input.requestId, error.code, { taskId: safe(input.taskId) });
      if (error instanceof Conflict) { const result: TaskMutationResult = { kind: 'conflict', code: error.code, currentRegistryRevision: String(error.registry), currentTaskRevision: String(error.task) }; this.terminal(operation, input.requestId, result, { taskId: safe(input.taskId) }); return result; }
      return this.failed(operation, input.requestId, error, { taskId: safe(input.taskId) });
    }
  }

  private write(operation: string, requestId: string, digest: string, action: (db: DatabaseSync) => TaskMutationResult): TaskMutationResult {
    const db = this.db(); db.exec('BEGIN IMMEDIATE');
    try {
      console.debug('[kogg:tasks:registry] mutation.started', { requestId, operation });
      const prior = db.prepare('SELECT request_digest,result_projection FROM idempotency WHERE request_id=?').get(requestId) as Row | undefined;
      if (prior) {
        if (!equal(str(prior, 'request_digest'), digest)) throw new Conflict('REQUEST_ID_REUSED', this.registryRevision(db), 0);
        db.exec('ROLLBACK'); return { ...(JSON.parse(str(prior, 'result_projection')) as TaskMutationResult), replay: true };
      }
      const result = action(db);
      db.prepare('INSERT INTO idempotency(request_id,request_digest,operation_type,result_projection) VALUES(?,?,?,?)').run(requestId, digest, operation, JSON.stringify(result));
      db.exec('COMMIT'); return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (rollbackError) { console.error('[kogg:tasks:registry] mutation.rollback.failed', { requestId, operation, errorType: errorName(rollbackError) }); }
      throw normalize(error);
    }
  }

  private migrate(): void {
    const db = this.db();
    db.exec(`CREATE TABLE IF NOT EXISTS registry_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,registry_revision INTEGER NOT NULL,installation_principal_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,repository_id TEXT NOT NULL,binding_revision INTEGER NOT NULL,task_revision INTEGER NOT NULL,lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived')),current_specification_id TEXT NOT NULL,current_approval_id TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS specifications(specification_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(task_id),sequence INTEGER NOT NULL,parent_specification_id TEXT,lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','frozen')),encoding_version TEXT NOT NULL,content BLOB NOT NULL,byte_length INTEGER NOT NULL,specification_digest TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,sequence));
      CREATE TABLE IF NOT EXISTS approvals(approval_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(task_id),specification_id TEXT NOT NULL REFERENCES specifications(specification_id),approval_digest TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admissions(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(task_id),task_revision INTEGER NOT NULL,
        specification_id TEXT NOT NULL REFERENCES specifications(specification_id),approval_id TEXT NOT NULL REFERENCES approvals(approval_id),project_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,binding_revision INTEGER NOT NULL,registry_revision INTEGER NOT NULL,authorized_at TEXT NOT NULL,expires_at TEXT NOT NULL,admission_digest TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS task_events(event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL REFERENCES tasks(task_id),task_revision INTEGER NOT NULL,registry_revision INTEGER NOT NULL UNIQUE,event_type TEXT NOT NULL,subject_id TEXT NOT NULL,previous_event_digest TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS idempotency(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,operation_type TEXT NOT NULL,result_projection TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS tasks_immutable_specifications_update BEFORE UPDATE ON specifications BEGIN SELECT RAISE(ABORT,'immutable specification'); END;
      CREATE TRIGGER IF NOT EXISTS tasks_immutable_specifications_delete BEFORE DELETE ON specifications BEGIN SELECT RAISE(ABORT,'immutable specification'); END;
      CREATE TRIGGER IF NOT EXISTS tasks_immutable_approvals_update BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT,'immutable approval'); END;
      CREATE TRIGGER IF NOT EXISTS tasks_immutable_approvals_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT,'immutable approval'); END;
      CREATE TRIGGER IF NOT EXISTS tasks_immutable_admissions_update BEFORE UPDATE ON admissions BEGIN SELECT RAISE(ABORT,'immutable admission'); END;
      CREATE TRIGGER IF NOT EXISTS tasks_immutable_admissions_delete BEFORE DELETE ON admissions BEGIN SELECT RAISE(ABORT,'immutable admission'); END;
      CREATE TRIGGER IF NOT EXISTS tasks_immutable_events_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
      CREATE TRIGGER IF NOT EXISTS tasks_immutable_events_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;`);
    if (!db.prepare('SELECT 1 FROM registry_meta WHERE singleton=1').get()) db.prepare('INSERT INTO registry_meta VALUES(1,1,0,?)').run(randomUUID());
    if (num(db.prepare('SELECT schema_version FROM registry_meta WHERE singleton=1').get() as Row, 'schema_version') !== 1) throw new Failure('SCHEMA_UNSUPPORTED');
  }

  private assertIntegrity(): void {
    const db = this.db(); if (str(db.prepare('PRAGMA quick_check').get() as Row, 'quick_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Failure('INTEGRITY_FAILED');
    for (const spec of db.prepare('SELECT * FROM specifications ORDER BY task_id,sequence').all() as Row[]) {
      const task = this.task(str(spec, 'task_id'), db);
      const canonical = canonicalSpecification({
        content: bytes(spec, 'content').toString('utf8'),
        taskId: str(spec, 'task_id'),
        projectId: str(task, 'project_id'),
        repositoryId: str(task, 'repository_id'),
        bindingRevision: dec(task, 'binding_revision')
      });
      if (canonical.digest !== str(spec, 'specification_digest') || canonical.bytes.length !== num(spec, 'byte_length')) throw new Failure('INTEGRITY_FAILED');
    }
    for (const row of db.prepare('SELECT * FROM admissions ORDER BY run_id').all() as Row[]) {
      if (!equal(canonicalRequestDigest(this.admission(row)), str(row, 'admission_digest'))) throw new Failure('INTEGRITY_FAILED');
    }
    const approvalMismatchCount = num(db.prepare(`SELECT count(*) AS count FROM tasks t LEFT JOIN approvals a ON a.approval_id=t.current_approval_id
      WHERE t.current_approval_id IS NOT NULL AND (a.approval_id IS NULL OR a.specification_id!=t.current_specification_id)`).get() as Row, 'count');
    if (approvalMismatchCount) throw new Failure('INTEGRITY_FAILED');
    let previous = '';
    for (const row of db.prepare('SELECT * FROM task_events ORDER BY event_sequence').all() as Row[]) {
      if (str(row, 'previous_event_digest') !== previous || eventDigest(row) !== str(row, 'event_digest')) throw new Failure('INTEGRITY_FAILED');
      previous = str(row, 'event_digest');
    }
  }

  private copySpec(db: DatabaseSync, task: Row, current: Row, taskId: string, lifecycle: 'draft' | 'frozen', event: string, revision: number): void {
    const next = num(task, 'task_revision') + 1; const specId = randomUUID();
    const canonical = canonicalSpecification({ content: bytes(current, 'content').toString('utf8'), taskId, projectId: str(task, 'project_id'), repositoryId: str(task, 'repository_id'), bindingRevision: dec(task, 'binding_revision') });
    this.insertSpec(db, specId, taskId, next, str(current, 'specification_id'), lifecycle, canonical, new Date().toISOString());
    db.prepare('UPDATE tasks SET current_specification_id=?,current_approval_id=NULL,task_revision=? WHERE task_id=?').run(specId, next, taskId);
    this.event(db, taskId, next, revision, event, specId);
  }
  private insertSpec(db: DatabaseSync, id: string, taskId: string, sequence: number, parent: string | undefined, lifecycle: 'draft' | 'frozen', canonical: ReturnType<typeof canonicalSpecification>, createdAt: string): void {
    db.prepare(`INSERT INTO specifications(specification_id,task_id,sequence,parent_specification_id,lifecycle,encoding_version,content,byte_length,specification_digest,created_at)
      VALUES(?,?,?,?,?,'utf-8-exact-v1',?,?,?,?)`).run(id, taskId, sequence, parent ?? null, lifecycle, canonical.bytes, canonical.bytes.length, canonical.digest, createdAt);
  }
  private event(db: DatabaseSync, taskId: string, taskRevision: number, registryRevision: number, type: string, subject: string): void {
    const last = db.prepare('SELECT event_digest FROM task_events ORDER BY event_sequence DESC LIMIT 1').get() as Row | undefined;
    const previous = last ? str(last, 'event_digest') : ''; const eventId = randomUUID();
    const digest = canonicalRequestDigest({ eventId, taskId, taskRevision: String(taskRevision), registryRevision: String(registryRevision), eventType: type, subjectId: subject, previousDigest: previous });
    db.prepare('INSERT INTO task_events(event_id,task_id,task_revision,registry_revision,event_type,subject_id,previous_event_digest,event_digest) VALUES(?,?,?,?,?,?,?,?)')
      .run(eventId, taskId, taskRevision, registryRevision, type, subject, previous, digest);
  }
  private requireActiveDraft(task: Row, current: Row): void {
    if (str(task, 'lifecycle') !== 'active') throw new Refusal('TASK_ARCHIVED');
    if (str(current, 'lifecycle') !== 'draft') throw new Refusal('TASK_NOT_DRAFT');
  }
  private bumpRegistry(db: DatabaseSync): number { const next = this.registryRevision(db) + 1; db.prepare('UPDATE registry_meta SET registry_revision=? WHERE singleton=1').run(next); return next; }
  private projection(taskId: string, db = this.db()): TaskProjection {
    const task = this.task(taskId, db); const spec = this.spec(str(task, 'current_specification_id'), db); const approvalId = optional(task, 'current_approval_id');
    let approval: ApprovalProjection | undefined;
    if (approvalId) { const row = db.prepare('SELECT * FROM approvals WHERE approval_id=?').get(approvalId) as Row; approval = { approvalId, specificationId: str(row, 'specification_id'), lifecycle: 'current', createdAt: str(row, 'created_at') }; }
    const content = bytes(spec, 'content').toString('utf8');
    return { taskId, projectId: str(task, 'project_id'), repositoryId: str(task, 'repository_id'), bindingRevision: dec(task, 'binding_revision'),
      taskRevision: dec(task, 'task_revision'), registryRevision: String(this.registryRevision(db)), lifecycle: str(task, 'lifecycle') as TaskProjection['lifecycle'],
      currentSpecification: { specificationId: str(spec, 'specification_id'), sequence: dec(spec, 'sequence'), lifecycle: str(spec, 'lifecycle') as 'draft' | 'frozen',
        content, byteLength: num(spec, 'byte_length'), lineEnding: eol(content), createdAt: str(spec, 'created_at') }, currentApproval: approval };
  }
  private task(id: string, db = this.db()): Row { const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id) as Row | undefined; if (!row) throw new Failure('TASK_NOT_AVAILABLE'); return row; }
  private spec(id: string, db = this.db()): Row { const row = db.prepare('SELECT * FROM specifications WHERE specification_id=?').get(id) as Row | undefined; if (!row) throw new Failure('INTEGRITY_FAILED'); return row; }
  private admission(row: Row): TaskAdmissionSnapshot {
    return {
      taskId: str(row, 'task_id'), taskRevision: dec(row, 'task_revision'), specificationId: str(row, 'specification_id'),
      approvalId: str(row, 'approval_id'), projectId: str(row, 'project_id'), repositoryId: str(row, 'repository_id'),
      bindingRevision: dec(row, 'binding_revision'), registryRevision: dec(row, 'registry_revision'), runId: str(row, 'run_id'),
      authorizedAt: str(row, 'authorized_at'), expiresAt: str(row, 'expires_at')
    };
  }
  private async binding(taskId: string): Promise<ProjectBindingSnapshot | undefined> {
    try { uuid(taskId); const task = this.task(taskId); return this.projects.resolveBinding(str(task, 'project_id'), str(task, 'repository_id')); }
    catch (error) { console.warn('[kogg:tasks:registry] binding.resolve.failed', { taskId: safe(taskId), errorType: errorName(error) }); return undefined; }
  }
  private registryRevision(db = this.db()): number { return num(db.prepare('SELECT registry_revision FROM registry_meta WHERE singleton=1').get() as Row, 'registry_revision'); }
  private taskCount(): number { return num(this.db().prepare('SELECT count(*) AS count FROM tasks').get() as Row, 'count'); }
  private db(): DatabaseSync { if (!this.database) throw new Failure('REGISTRY_UNAVAILABLE'); return this.database; }
  private requested(operation: string, requestId: string, fields: Record<string, string> = {}): void { console.debug('[kogg:tasks:registry] mutation.requested', { requestId: safe(requestId), operation, ...fields }); }
  private terminal(operation: string, requestId: string, result: TaskMutationResult, fields: Record<string, string> = {}): void {
    const data = { requestId: safe(requestId), operation, safeCode: result.code, replay: result.replay === true, ...fields };
    if (result.kind === 'completed') console.info('[kogg:tasks:registry] mutation.completed', data);
    else if (result.kind === 'conflict') console.warn('[kogg:tasks:registry] mutation.conflict', data);
    else console.warn('[kogg:tasks:registry] mutation.refused', data);
  }
  private refused(operation: string, requestId: string, code: TaskSafeCode, fields: Record<string, string> = {}): TaskMutationResult { const result: TaskMutationResult = { kind: 'refused', code }; this.terminal(operation, requestId, result, fields); return result; }
  private failed(operation: string, requestId: string, error: unknown, fields: Record<string, string> = {}): TaskMutationResult { const code = codeOf(error); console.error('[kogg:tasks:registry] mutation.failed', { requestId: safe(requestId), operation, safeCode: code, errorType: errorName(error), ...fields }); return { kind: 'failed', code }; }
  private reviewRefused(input: { requestId: string; taskId: string }, code: TaskSafeCode): ReviewProjection { console.warn('[kogg:tasks:approval] review.refused', { requestId: safe(input.requestId), taskId: safe(input.taskId), safeCode: code }); return { kind: 'refused', code }; }
}

class Refusal extends Error { constructor(readonly code: TaskSafeCode) { super(code); } }
class Failure extends Error { constructor(readonly code: TaskSafeCode) { super(code); } }
class Conflict extends Error { constructor(readonly code: TaskSafeCode, readonly registry: number, readonly task: number) { super(code); } }
function done(projection: TaskProjection): TaskMutationResult { return { kind: 'completed', code: 'TASK_OK', projection }; }
function matches(task: Row, binding: ProjectBindingSnapshot | undefined): boolean { return Boolean(binding?.available && binding.active && binding.projectId === str(task, 'project_id') && binding.repositoryId === str(task, 'repository_id') && binding.bindingRevision === num(task, 'binding_revision')); }
function uuid(value: string): void { if (!UUID.test(value)) throw new Failure('TASK_NOT_AVAILABLE'); }
function decimal(value: string): void { if (!DECIMAL.test(value) || Number(value) > Number.MAX_SAFE_INTEGER) throw new Failure('INTERNAL_FAILURE'); }
function safe(value: string): string { return UUID.test(value) ? value : 'invalid'; }
function str(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new Failure('INTEGRITY_FAILED'); return value; }
function optional(row: Row, key: string): string | undefined { const value = row[key]; if (value == null) return undefined; if (typeof value !== 'string') throw new Failure('INTEGRITY_FAILED'); return value; }
function num(row: Row, key: string): number { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Failure('INTEGRITY_FAILED'); return value; }
function dec(row: Row, key: string): string { return String(num(row, key)); }
function bytes(row: Row, key: string): Buffer { const value = row[key]; if (!(value instanceof Uint8Array)) throw new Failure('INTEGRITY_FAILED'); return Buffer.from(value); }
function equal(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function codeOf(error: unknown): TaskSafeCode {
  if (error instanceof Refusal || error instanceof Failure || error instanceof Conflict || error instanceof SpecificationValidationError) return error.code;
  if (error instanceof Error && /locked|busy/iu.test(error.message)) return 'TRANSACTION_BUSY';
  if (typeof error === 'object' && error !== null && 'code' in error && ['EACCES', 'EPERM', 'EROFS'].includes(String(error.code))) return 'STORAGE_PERMISSION_FAILED';
  return 'INTERNAL_FAILURE';
}
function normalize(error: unknown): unknown { return error instanceof Error && /locked|busy/iu.test(error.message) ? new Failure('TRANSACTION_BUSY') : error; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function stateRoot(): string { const root = process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(); return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(root, '.kogg', 'state')); }
function eol(content: string): 'none' | 'lf' | 'crlf' | 'mixed' { const crlf = /\r\n/u.test(content); const rest = content.replace(/\r\n/gu, ''); const lf = /\n/u.test(rest); const cr = /\r/u.test(rest); if (!crlf && !lf && !cr) return 'none'; if (crlf && !lf && !cr) return 'crlf'; if (!crlf && lf && !cr) return 'lf'; return 'mixed'; }
function eventDigest(row: Row): string { return canonicalRequestDigest({ eventId: str(row, 'event_id'), taskId: str(row, 'task_id'), taskRevision: dec(row, 'task_revision'), registryRevision: dec(row, 'registry_revision'), eventType: str(row, 'event_type'), subjectId: str(row, 'subject_id'), previousDigest: str(row, 'previous_event_digest') }); }
