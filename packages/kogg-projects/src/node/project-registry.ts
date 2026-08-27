import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type {
  KoggProjectRole,
  KoggProjectSummary,
  ProjectMutationExpectation,
  ProjectRegistrySnapshot,
  ProjectRepositorySummary,
  ProjectRoleAssignment,
  ProjectTaskRepositoryBinding,
  ProjectSwitchTicket,
  ProjectWorkspaceReconciliation,
  ProviderRegistry
} from '@kogg/contracts';
import { ProviderRegistryToken } from '@kogg/contracts';
import {
  KoggOperationRegistry,
  type OperationLease,
  type OperationRegistryApi,
  type OperationSafeCode
} from '@kogg/operations/lib/common/operations-protocol';
import { runOperation } from '@kogg/operations/lib/node/run-operation';
import type { OperationsOwnerSink, OwnerEventV1, SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { KoggProjectsService, ProjectBindingAuthority, ProjectBindingSnapshot } from '../common/projects-protocol';
import { ProjectError, errorType } from './project-errors';
import { ProjectRepositoryProbe, type RepositoryProbeResult } from './project-repository-probe';
import { ProjectWorkspaceProjection } from './project-workspace-projection';

// diagnostic-coverage: projects.registry, projects.repositories, projects.restoration, projects.processes, operations.registry, operations.cleanup

type SqlRow = Record<string, SQLOutputValue>;
type MutationRequest = ProjectMutationExpectation & object;

const ROLES: readonly KoggProjectRole[] = [
  'orchestrator', 'architect', 'planner', 'worker', 'researcher', 'test-writer',
  'test-executor', 'reviewer', 'security-reviewer', 'performance-reviewer',
  'documentation-agent', 'migration-agent', 'release-agent', 'integrator', 'verification-agent'
];
const EXECUTION_PROFILES = new Set(['default', 'restricted', 'trusted-local']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;

@injectable()
export class ProjectRegistry implements KoggProjectsService, ProjectBindingAuthority, BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private accepting = false;
  private readonly trackedOperations = new Map<string, OperationLease>();
  private readonly databasePath = path.join(stateRoot(), 'projects', 'registry.sqlite3');
  private ownerSink: OperationsOwnerSink | undefined;

  constructor(
    @inject(ProjectRepositoryProbe) private readonly repositories: ProjectRepositoryProbe,
    @inject(ProjectWorkspaceProjection) private readonly workspaces: ProjectWorkspaceProjection,
    @inject(ProviderRegistryToken) private readonly providers: ProviderRegistry,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi
  ) {}

  async onStart(): Promise<void> {
    console.info('[kogg:projects:registry] registry.start.requested');
    try {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, {
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false
      });
      this.database.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;');
      this.migrate();
      this.assertIntegrity();
      await fs.chmod(this.databasePath, 0o600).catch(error => {
        if (process.platform !== 'win32') throw error;
      });
      this.recoverExpiredSwitch();
      await this.refreshRepositoryAvailability();
      this.accepting = true;
      console.info('[kogg:projects:registry] registry.start.completed', { schemaVersion: 1 });
    } catch (error) {
      const terminal = error instanceof ProjectError
        ? error
        : new ProjectError('PROJECT_REGISTRY_INTEGRITY_FAILED', 'The Kogg project registry could not start.', { cause: error });
      console.error('[kogg:projects:registry] registry.start.failed', { errorType: errorType(error), safeCode: terminal.code });
      this.database?.close();
      this.database = undefined;
      throw terminal;
    }
  }

  async onStop(): Promise<void> {
    console.info('[kogg:projects:registry] registry.stop.started');
    this.accepting = false;
    try {
      await this.repositories.shutdown();
      this.database?.close();
      this.database = undefined;
      console.info('[kogg:projects:registry] registry.stop.completed');
    } catch (error) {
      console.error('[kogg:projects:registry] registry.stop.failed', { errorType: errorType(error) });
      throw error;
    }
  }
  setOwnerSink(sink?: OperationsOwnerSink): void { this.ownerSink = sink; if (sink && this.database) this.publishOwnerEvents(); }
  publishOwnerEvents(): void {
    if (!this.ownerSink || !this.database) return; const database = this.db(); const meta = database.prepare('SELECT owner_id,owner_epoch_id FROM registry_meta WHERE singleton=1').get() as SqlRow; let previous = '0'.repeat(64);
    for (const row of database.prepare('SELECT * FROM project_events ORDER BY event_sequence').all() as SqlRow[]) {
      const mapped = mapProjectOwnerEvent(row, stringValue(meta, 'owner_id'), stringValue(meta, 'owner_epoch_id'), previous); previous = mapped.eventDigest;
      try { this.ownerSink.ingest(mapped); }
      catch (error) { console.warn('[kogg:projects:registry] owner.publish.failed', { ownerKind: 'project', ownerSequence: mapped.sequence, safeCode: 'OWNER_PUBLISH_FAILED', errorType: errorType(error) }); break; }
    }
  }

  async snapshot(): Promise<ProjectRegistrySnapshot> {
    await this.refreshRepositoryAvailability();
    return this.readSnapshot();
  }

  async resolveBinding(projectId: string, repositoryId: string): Promise<ProjectBindingSnapshot | undefined> {
    await this.refreshRepositoryAvailability();
    const snapshot = this.readSnapshot();
    const project = snapshot.projects.find(item => item.id === projectId);
    const repository = project?.repositories.find(item => item.id === repositoryId);
    if (!project || !repository) return undefined;
    return {
      projectId,
      repositoryId,
      registryRevision: snapshot.revision,
      bindingRevision: repository.revision,
      available: project.lifecycle === 'available' && repository.availability === 'available',
      active: snapshot.activeProjectId === projectId,
      executionProfileId: project.executionProfileId ?? 'default'
    };
  }

  async createProject(request: ProjectMutationExpectation & { displayName: string; repositoryPath: string }): Promise<ProjectRegistrySnapshot> {
    await this.requested('project.create', request.requestId);
    const projectId = randomUUID();
    const repositoryId = randomUUID();
    try {
      validateExpectation(request); validateDisplayName(request.displayName);
      const probed = await this.probe(request.repositoryPath, request.requestId, repositoryId);
      await this.workspaces.write(projectId, [probed.rootUri]);
      const executed = this.mutate('project.create', request, database => {
        const now = new Date().toISOString();
        database.prepare('INSERT INTO projects(id, display_name, execution_profile_id, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, 1)')
          .run(projectId, request.displayName.trim(), 'default', now, now);
        this.insertRepository(database, projectId, repositoryId, request.displayName.trim(), probed, now);
      }, { projectId, subjectId: projectId });
      if (!executed) await this.workspaces.remove(projectId);
      await this.completed('project.create', request.requestId, { projectId, repositoryId });
      return this.readSnapshot();
    } catch (error) {
      await this.workspaces.remove(projectId).catch(() => undefined);
      await this.failed('project.create', request.requestId, error);
      throw error;
    }
  }

  async renameProject(request: ProjectMutationExpectation & { projectId: string; displayName: string }): Promise<ProjectRegistrySnapshot> {
    return this.simpleProjectMutation('project.update', request, database => {
      validateDisplayName(request.displayName);
      this.requireProject(database, request.projectId);
      database.prepare('UPDATE projects SET display_name = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
        .run(request.displayName.trim(), new Date().toISOString(), request.projectId);
    });
  }

  async removeProject(request: ProjectMutationExpectation & { projectId: string }): Promise<ProjectRegistrySnapshot> {
    await this.requested('project.remove', request.requestId, { projectId: request.projectId });
    try {
      validateExpectation(request); validateUuid(request.projectId, 'PROJECT_NOT_FOUND');
      const meta = this.meta();
      if (meta.active_project_id === request.projectId || meta.pending_to_project_id === request.projectId || meta.pending_from_project_id === request.projectId) {
        throw new ProjectError('PROJECT_ACTIVE_REMOVE_REFUSED', 'Switch away from this project before removing its registry entry.');
      }
      this.mutate('project.remove', request, database => {
        this.requireProject(database, request.projectId);
        const bindings = numberValue(database.prepare('SELECT count(*) AS count FROM task_repository_bindings b JOIN repositories r ON r.id = b.repository_id WHERE r.project_id = ?').get(request.projectId), 'count');
        if (bindings > 0) throw new ProjectError('PROJECT_IN_USE', 'The project is referenced by task records.');
        database.prepare('DELETE FROM role_assignments WHERE project_id = ?').run(request.projectId);
        database.prepare('DELETE FROM repositories WHERE project_id = ?').run(request.projectId);
        database.prepare('DELETE FROM projects WHERE id = ?').run(request.projectId);
      });
      await this.workspaces.remove(request.projectId);
      await this.completed('project.remove', request.requestId, { projectId: request.projectId });
      return this.readSnapshot();
    } catch (error) {
      await this.failed('project.remove', request.requestId, error, { projectId: request.projectId });
      throw error;
    }
  }

  async addRepository(request: ProjectMutationExpectation & { projectId: string; displayName: string; repositoryPath: string }): Promise<ProjectRegistrySnapshot> {
    await this.requested('repository.add', request.requestId, { projectId: request.projectId });
    const repositoryId = randomUUID();
    try {
      validateExpectation(request); validateUuid(request.projectId, 'PROJECT_NOT_FOUND'); validateDisplayName(request.displayName);
      const probed = await this.probe(request.repositoryPath, request.requestId, repositoryId);
      this.mutate('repository.add', request, database => {
        this.requireProject(database, request.projectId);
        this.assertUniqueRepository(database, probed.identityDigest);
        this.insertRepository(database, request.projectId, repositoryId, request.displayName.trim(), probed, new Date().toISOString());
        database.prepare('UPDATE projects SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(new Date().toISOString(), request.projectId);
      });
      await this.refreshProjection(request.projectId);
      await this.completed('repository.add', request.requestId, { projectId: request.projectId, repositoryId });
      return this.readSnapshot();
    } catch (error) {
      await this.failed('repository.add', request.requestId, error, { projectId: request.projectId, repositoryId });
      throw error;
    }
  }

  async relocateRepository(request: ProjectMutationExpectation & { projectId: string; repositoryId: string; repositoryPath: string }): Promise<ProjectRegistrySnapshot> {
    await this.requested('repository.relocate', request.requestId, { projectId: request.projectId, repositoryId: request.repositoryId });
    try {
      validateExpectation(request); validateUuid(request.projectId, 'PROJECT_NOT_FOUND'); validateUuid(request.repositoryId, 'PROJECT_REPOSITORY_NOT_FOUND');
      const probed = await this.probe(request.repositoryPath, request.requestId, request.repositoryId);
      this.mutate('repository.relocate', request, database => {
        const current = database.prepare('SELECT identity_digest FROM repositories WHERE id = ? AND project_id = ?').get(request.repositoryId, request.projectId) as SqlRow | undefined;
        if (!current) throw new ProjectError('PROJECT_REPOSITORY_NOT_FOUND', 'The repository registry entry does not exist.');
        if (stringValue(current, 'identity_digest') !== probed.identityDigest) throw new ProjectError('PROJECT_REPOSITORY_IDENTITY_CHANGED', 'The selected path is a different Git repository.');
        database.prepare("UPDATE repositories SET root_uri = ?, git_dir_uri = ?, availability = 'available', updated_at = ?, revision = revision + 1 WHERE id = ?")
          .run(probed.rootUri, probed.gitDirUri, new Date().toISOString(), request.repositoryId);
      });
      await this.refreshProjection(request.projectId);
      await this.completed('repository.relocate', request.requestId, { projectId: request.projectId, repositoryId: request.repositoryId });
      return this.readSnapshot();
    } catch (error) {
      await this.failed('repository.relocate', request.requestId, error, { projectId: request.projectId, repositoryId: request.repositoryId });
      throw error;
    }
  }

  async removeRepository(request: ProjectMutationExpectation & { projectId: string; repositoryId: string }): Promise<ProjectRegistrySnapshot> {
    await this.requested('repository.remove', request.requestId, { projectId: request.projectId, repositoryId: request.repositoryId });
    try {
      this.mutate('repository.remove', request, database => {
        this.requireProject(database, request.projectId);
        const count = numberValue(database.prepare('SELECT count(*) AS count FROM repositories WHERE project_id = ?').get(request.projectId), 'count');
        if (count <= 1) throw new ProjectError('PROJECT_LAST_REPOSITORY_REMOVE_REFUSED', 'A project must keep at least one repository.');
        const bindings = numberValue(database.prepare('SELECT count(*) AS count FROM task_repository_bindings WHERE repository_id = ?').get(request.repositoryId), 'count');
        if (bindings > 0) throw new ProjectError('PROJECT_IN_USE', 'The repository is referenced by task records.');
        const result = database.prepare('DELETE FROM repositories WHERE id = ? AND project_id = ?').run(request.repositoryId, request.projectId);
        if (result.changes !== 1) throw new ProjectError('PROJECT_REPOSITORY_NOT_FOUND', 'The repository registry entry does not exist.');
      });
      await this.refreshProjection(request.projectId);
      await this.completed('repository.remove', request.requestId, { projectId: request.projectId, repositoryId: request.repositoryId });
      return this.readSnapshot();
    } catch (error) {
      await this.failed('repository.remove', request.requestId, error, { projectId: request.projectId, repositoryId: request.repositoryId });
      throw error;
    }
  }

  async setExecutionProfile(request: ProjectMutationExpectation & { projectId: string; executionProfileId?: string }): Promise<ProjectRegistrySnapshot> {
    return this.simpleProjectMutation('execution-profile.update', request, database => {
      const profile = request.executionProfileId ?? 'default';
      if (!EXECUTION_PROFILES.has(profile)) throw new ProjectError('PROJECT_EXECUTION_PROFILE_INVALID', 'Select an approved execution profile.');
      this.requireProject(database, request.projectId);
      database.prepare('UPDATE projects SET execution_profile_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
        .run(profile, new Date().toISOString(), request.projectId);
    });
  }

  async bindTaskRepository(request: ProjectMutationExpectation & { projectId: string; taskId: string; repositoryId: string }): Promise<ProjectRegistrySnapshot> {
    return this.simpleProjectMutation('task-repository.bind', request, database => {
      validateTaskId(request.taskId); validateUuid(request.repositoryId, 'PROJECT_REPOSITORY_NOT_FOUND');
      this.requireProject(database, request.projectId);
      if (!database.prepare('SELECT 1 AS found FROM repositories WHERE id = ? AND project_id = ?').get(request.repositoryId, request.projectId)) {
        throw new ProjectError('PROJECT_REPOSITORY_NOT_FOUND', 'The task repository does not belong to this project.');
      }
      database.prepare(`INSERT INTO task_repository_bindings(task_id, repository_id) VALUES (?, ?)
        ON CONFLICT(task_id) DO UPDATE SET repository_id = excluded.repository_id`).run(request.taskId, request.repositoryId);
      database.prepare('UPDATE projects SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(new Date().toISOString(), request.projectId);
    });
  }

  async clearTaskRepository(request: ProjectMutationExpectation & { projectId: string; taskId: string }): Promise<ProjectRegistrySnapshot> {
    return this.simpleProjectMutation('task-repository.clear', request, database => {
      validateTaskId(request.taskId); this.requireProject(database, request.projectId);
      const result = database.prepare(`DELETE FROM task_repository_bindings WHERE task_id = ? AND repository_id IN
        (SELECT id FROM repositories WHERE project_id = ?)`).run(request.taskId, request.projectId);
      if (result.changes !== 1) throw new ProjectError('PROJECT_IN_USE', 'The project task binding does not exist.');
      database.prepare('UPDATE projects SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(new Date().toISOString(), request.projectId);
    });
  }

  async setRoleAssignment(request: ProjectMutationExpectation & {
    projectId: string; role: KoggProjectRole; assignment?: ProjectRoleAssignment;
  }): Promise<ProjectRegistrySnapshot> {
    await this.requested('role-assignment.update', request.requestId, { projectId: request.projectId });
    try {
      validateExpectation(request); validateUuid(request.projectId, 'PROJECT_NOT_FOUND');
      if (!ROLES.includes(request.role)) throw new ProjectError('PROJECT_ROLE_INVALID', 'Select a supported Kogg project role.');
      if (request.assignment) this.validateAssignment(request.assignment);
      this.mutate('role-assignment.update', request, database => {
        this.requireProject(database, request.projectId);
        if (!request.assignment) database.prepare('DELETE FROM role_assignments WHERE project_id = ? AND role_id = ?').run(request.projectId, request.role);
        else database.prepare(`INSERT INTO role_assignments(project_id, role_id, provider_configuration_id, model_id, updated_at, revision)
          VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(project_id, role_id) DO UPDATE SET provider_configuration_id = excluded.provider_configuration_id,
          model_id = excluded.model_id, updated_at = excluded.updated_at, revision = role_assignments.revision + 1`)
          .run(request.projectId, request.role, request.assignment.providerConfigurationId, request.assignment.modelId, new Date().toISOString());
      });
      await this.completed('role-assignment.update', request.requestId, { projectId: request.projectId });
      return this.readSnapshot();
    } catch (error) {
      await this.failed('role-assignment.update', request.requestId, error, { projectId: request.projectId });
      throw error;
    }
  }

  async requestSwitch(request: ProjectMutationExpectation & { projectId: string }): Promise<ProjectSwitchTicket> {
    await this.requested('project.switch', request.requestId, { projectId: request.projectId });
    try {
      validateExpectation(request); validateUuid(request.projectId, 'PROJECT_NOT_FOUND');
      await this.refreshRepositoryAvailability();
      const snapshot = this.readSnapshot();
      const target = snapshot.projects.find(project => project.id === request.projectId);
      if (!target) throw new ProjectError('PROJECT_NOT_FOUND', 'The project does not exist.');
      if (target.lifecycle !== 'available') throw new ProjectError('PROJECT_SWITCH_BLOCKED', 'The project has unavailable repositories.');
      await this.refreshProjection(request.projectId);
      this.mutate('project.switch', request, database => {
        const meta = this.meta(database);
        if (meta.pending_operation_id) throw new ProjectError('PROJECT_SWITCH_BLOCKED', 'Another project switch is already pending.');
        database.prepare(`UPDATE registry_meta SET pending_operation_id = ?, pending_from_project_id = active_project_id,
          pending_to_project_id = ?, pending_started_at = ? WHERE singleton = 1`)
          .run(request.requestId, request.projectId, new Date().toISOString());
      });
      console.info('[kogg:projects:switch] project.switch.started', { operationId: request.requestId, projectId: request.projectId });
      return {
        operationId: request.requestId, projectId: request.projectId,
        workspaceUri: this.workspaces.uri(request.projectId), expectedRegistryRevision: this.revision()
      };
    } catch (error) {
      await this.failed('project.switch', request.requestId, error, { projectId: request.projectId });
      throw error;
    }
  }

  async reconcileWorkspace(request: { requestId: string; currentWorkspaceUri?: string }): Promise<ProjectWorkspaceReconciliation> {
    return runOperation(this.operations, 'project-switch', async () => {
      validateUuid(request.requestId, 'PROJECT_REQUEST_INVALID');
      console.info('[kogg:projects:switch] project.restore.started', { operationId: request.requestId });
      await this.refreshRepositoryAvailability();
      const meta = this.meta();
    if (meta.pending_operation_id && meta.pending_to_project_id) {
      const pendingTarget = this.readSnapshot().projects.find(project => project.id === meta.pending_to_project_id);
      if (!pendingTarget || pendingTarget.lifecycle !== 'available') {
        this.clearPending(meta.pending_to_project_id, meta.pending_operation_id);
        console.warn('[kogg:projects:switch] project.restore.degraded', {
          operationId: request.requestId, projectId: meta.pending_to_project_id, safeCode: 'PROJECT_REPOSITORY_UNAVAILABLE'
        });
        return { snapshot: this.readSnapshot(), action: 'none' };
      }
      const targetUri = this.workspaces.uri(meta.pending_to_project_id);
      if (request.currentWorkspaceUri === targetUri) {
        this.transaction(database => {
          database.prepare(`UPDATE registry_meta SET active_project_id = pending_to_project_id, pending_operation_id = NULL,
            pending_from_project_id = NULL, pending_to_project_id = NULL, pending_started_at = NULL, revision = revision + 1 WHERE singleton = 1`).run();
          this.appendProjectEvent(database, 'project.switch-completed', meta.pending_to_project_id!, meta.pending_operation_id!);
        });
        console.info('[kogg:projects:switch] project.switch.completed', {
          operationId: meta.pending_operation_id, projectId: meta.pending_to_project_id
        });
        await this.completed('project.switch', meta.pending_operation_id, { projectId: meta.pending_to_project_id });
        console.info('[kogg:projects:switch] project.restore.completed', { operationId: request.requestId, projectId: meta.pending_to_project_id });
        return { snapshot: this.readSnapshot(), action: 'none' };
      }
      const priorUri = meta.pending_from_project_id ? this.workspaces.uri(meta.pending_from_project_id) : undefined;
      this.clearPending(meta.pending_to_project_id, meta.pending_operation_id);
      console.warn('[kogg:projects:switch] project.switch.failed', {
        operationId: meta.pending_operation_id, projectId: meta.pending_to_project_id, safeCode: 'PROJECT_RESTORE_FAILED'
      });
      await this.failed('project.switch', meta.pending_operation_id,
        new ProjectError('PROJECT_RESTORE_FAILED', 'The project switch could not be restored.'), { projectId: meta.pending_to_project_id });
      if (priorUri && request.currentWorkspaceUri !== priorUri) {
        console.warn('[kogg:projects:switch] project.restore.degraded', { operationId: request.requestId, safeCode: 'PROJECT_RESTORE_FAILED' });
        return { snapshot: this.readSnapshot(), action: 'open', workspaceUri: priorUri };
      }
      return { snapshot: this.readSnapshot(), action: 'none' };
    }
    if (meta.active_project_id) {
      const active = this.readSnapshot().projects.find(project => project.id === meta.active_project_id);
      if (!active || active.lifecycle !== 'available') {
        console.warn('[kogg:projects:switch] project.restore.degraded', {
          operationId: request.requestId, projectId: meta.active_project_id, safeCode: 'PROJECT_REPOSITORY_UNAVAILABLE'
        });
        return { snapshot: this.readSnapshot(), action: 'none' };
      }
      const activeUri = this.workspaces.uri(meta.active_project_id);
      if (request.currentWorkspaceUri !== activeUri) {
        console.warn('[kogg:projects:switch] project.restore.degraded', { operationId: request.requestId, projectId: meta.active_project_id });
        return { snapshot: this.readSnapshot(), action: 'open', workspaceUri: activeUri };
      }
      console.info('[kogg:projects:switch] project.restore.completed', { operationId: request.requestId, projectId: meta.active_project_id });
    } else {
      console.info('[kogg:projects:switch] project.restore.completed', { operationId: request.requestId });
    }
      return { snapshot: this.readSnapshot(), action: 'none' };
    });
  }

  async cancelSwitch(request: { requestId: string; operationId: string }): Promise<ProjectRegistrySnapshot> {
    return runOperation(this.operations, 'project-switch', async () => {
      validateUuid(request.requestId, 'PROJECT_REQUEST_INVALID'); validateUuid(request.operationId, 'PROJECT_SWITCH_STALE');
      console.info('[kogg:projects:switch] project.switch.cancelled', { operationId: request.operationId });
      const meta = this.meta();
      if (meta.pending_operation_id !== request.operationId) throw new ProjectError('PROJECT_SWITCH_STALE', 'The project switch is no longer pending.');
      this.clearPending(meta.pending_to_project_id!, meta.pending_operation_id);
      await this.cancelled(request.operationId);
      console.info('[kogg:projects:switch] project.switch.cleanup.completed', { operationId: request.operationId });
      return this.readSnapshot();
    });
  }

  diagnostics(): { integrity: boolean; foreignKeys: boolean; repositoryCount: number; unavailableCount: number; activeConsistent: boolean; pendingConsistent: boolean; activeProcesses: number } {
    const database = this.db();
    const integrity = stringValue(database.prepare('PRAGMA quick_check').get() as SqlRow, 'quick_check') === 'ok' && this.projectEventChainIsValid(database);
    const foreignKeys = numberValue(database.prepare('PRAGMA foreign_keys').get(), 'foreign_keys') === 1;
    const repositoryCount = numberValue(database.prepare('SELECT count(*) AS count FROM repositories').get(), 'count');
    const unavailableCount = numberValue(database.prepare("SELECT count(*) AS count FROM repositories WHERE availability != 'available'").get(), 'count');
    const meta = this.meta(database);
    const activeConsistent = !meta.active_project_id || !!database.prepare('SELECT 1 AS found FROM projects WHERE id = ?').get(meta.active_project_id);
    const pendingConsistent = !meta.pending_operation_id || (!!meta.pending_to_project_id && !!database.prepare('SELECT 1 AS found FROM projects WHERE id = ?').get(meta.pending_to_project_id));
    return { integrity, foreignKeys, repositoryCount, unavailableCount, activeConsistent, pendingConsistent, activeProcesses: this.repositories.activeCount() };
  }

  private migrate(): void {
    const database = this.db();
    const version = numberValue(database.prepare('PRAGMA user_version').get(), 'user_version');
    if (version > 1) throw new ProjectError('PROJECT_REGISTRY_SCHEMA_UNSUPPORTED', 'The project registry was created by a newer Kogg version.');
    if (version === 1) { this.ensureOperationsOwnerSchema(); return; }
    console.info('[kogg:projects:registry] registry.migration.started', { fromVersion: version, toVersion: 1 });
    this.transaction(db => db.exec(SCHEMA));
    this.ensureOperationsOwnerSchema();
    console.info('[kogg:projects:registry] registry.migration.completed', { schemaVersion: 1 });
  }

  private ensureOperationsOwnerSchema(): void {
    const db = this.db(); const columns = new Set((db.prepare('PRAGMA table_info(registry_meta)').all() as SqlRow[]).map(row => stringValue(row, 'name')));
    if (!columns.has('owner_id')) db.exec('ALTER TABLE registry_meta ADD COLUMN owner_id TEXT');
    if (!columns.has('owner_epoch_id')) db.exec('ALTER TABLE registry_meta ADD COLUMN owner_epoch_id TEXT');
    db.prepare("UPDATE registry_meta SET owner_id=COALESCE(owner_id,?),owner_epoch_id=COALESCE(owner_epoch_id,?) WHERE singleton=1").run(randomUUID(), randomUUID());
    db.exec(`CREATE TABLE IF NOT EXISTS project_events(event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,event_kind TEXT NOT NULL,project_id TEXT NOT NULL,subject_id TEXT NOT NULL,registry_revision INTEGER NOT NULL,observed_at TEXT NOT NULL,previous_fact_digest TEXT NOT NULL,fact_digest TEXT NOT NULL UNIQUE);
      CREATE TRIGGER IF NOT EXISTS project_events_immutable_update BEFORE UPDATE ON project_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
      CREATE TRIGGER IF NOT EXISTS project_events_immutable_delete BEFORE DELETE ON project_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;`);
  }

  private assertIntegrity(): void {
    console.info('[kogg:projects:registry] registry.integrity.started');
    const database = this.db();
    const result = stringValue(database.prepare('PRAGMA integrity_check').get() as SqlRow, 'integrity_check');
    const foreignKeyRows = database.prepare('PRAGMA foreign_key_check').all();
    const enabled = numberValue(database.prepare('PRAGMA foreign_keys').get(), 'foreign_keys') === 1;
    const ownerChainValid = this.projectEventChainIsValid(database);
    const immutableTriggerCount = numberValue(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('project_events_immutable_update','project_events_immutable_delete')").get(), 'count');
    if (result !== 'ok' || foreignKeyRows.length || !enabled || !ownerChainValid || immutableTriggerCount !== 2) {
      console.error('[kogg:projects:registry] registry.integrity.failed', { foreignKeyFailureCount: foreignKeyRows.length, ownerChainValid, immutableTriggerCount });
      throw new ProjectError('PROJECT_REGISTRY_INTEGRITY_FAILED', 'The project registry failed its integrity check.');
    }
    console.info('[kogg:projects:registry] registry.integrity.completed');
  }

  private recoverExpiredSwitch(): void {
    const meta = this.meta();
    if (!meta.pending_operation_id || !meta.pending_started_at) return;
    if (Date.now() - Date.parse(meta.pending_started_at) <= 30_000) return;
    console.warn('[kogg:projects:switch] registry.recovery.started', { operationId: meta.pending_operation_id, safeCode: 'PROJECT_SWITCH_TIMEOUT' });
    this.clearPending(meta.pending_to_project_id ?? undefined, meta.pending_operation_id);
    console.info('[kogg:projects:switch] registry.recovery.completed', { operationId: meta.pending_operation_id, safeCode: 'PROJECT_SWITCH_TIMEOUT' });
  }

  private mutate(kind: string, request: MutationRequest, operation: (database: DatabaseSync) => void, event?: { projectId: string; subjectId: string }): boolean {
    try {
      return this.mutateChecked(kind, request, operation, event);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  private mutateChecked(kind: string, request: MutationRequest, operation: (database: DatabaseSync) => void, event?: { projectId: string; subjectId: string }): boolean {
    this.ensureAccepting();
    validateExpectation(request);
    const digest = requestDigest(kind, request);
    const database = this.db();
    const replay = database.prepare('SELECT request_digest FROM request_results WHERE request_id = ?').get(request.requestId) as SqlRow | undefined;
    if (replay) {
      if (stringValue(replay, 'request_digest') !== digest) throw new ProjectError('PROJECT_REQUEST_REPLAY_MISMATCH', 'The request ID was already used for different input.');
      return false;
    }
    this.transaction(db => {
      if (this.revision(db) !== request.expectedRegistryRevision) throw new ProjectError('PROJECT_REVISION_CONFLICT', 'The project registry changed. Refresh and try again.');
      operation(db);
      db.prepare('UPDATE registry_meta SET revision = revision + 1 WHERE singleton = 1').run();
      this.appendProjectEvent(db, projectEventKind(kind), event?.projectId ?? projectIdFrom(request), event?.subjectId ?? subjectIdFrom(request));
      db.prepare(`INSERT INTO request_results(request_id, operation_kind, request_digest, terminal_state, resulting_revision, safe_code, created_at)
        VALUES (?, ?, ?, 'completed', (SELECT revision FROM registry_meta WHERE singleton = 1), 'OK', ?)`)
        .run(request.requestId, kind, digest, new Date().toISOString());
      db.prepare(`DELETE FROM request_results WHERE request_id IN (
        SELECT request_id FROM request_results ORDER BY created_at DESC LIMIT -1 OFFSET 1000
      )`).run();
    });
    return true;
  }

  private async simpleProjectMutation(kind: string, request: MutationRequest & { projectId: string }, operation: (database: DatabaseSync) => void): Promise<ProjectRegistrySnapshot> {
    await this.requested(kind, request.requestId, { projectId: request.projectId });
    try {
      validateExpectation(request); validateUuid(request.projectId, 'PROJECT_NOT_FOUND');
      this.mutate(kind, request, operation);
      await this.completed(kind, request.requestId, { projectId: request.projectId });
      return this.readSnapshot();
    } catch (error) {
      await this.failed(kind, request.requestId, error, { projectId: request.projectId });
      throw error;
    }
  }

  private transaction(operation: (database: DatabaseSync) => void): void {
    const database = this.db();
    let began = false;
    try {
      database.exec('BEGIN IMMEDIATE'); began = true;
      operation(database); database.exec('COMMIT'); this.publishOwnerEvents();
    } catch (error) {
      if (began) database.exec('ROLLBACK');
      throw normalizeSqliteError(error);
    }
  }

  private appendProjectEvent(database: DatabaseSync, eventKind: string, projectId: string, subjectId: string): void {
    const prior = database.prepare('SELECT fact_digest FROM project_events ORDER BY event_sequence DESC LIMIT 1').get() as SqlRow | undefined; const previous = prior ? stringValue(prior, 'fact_digest') : '';
    const eventId = randomUUID(); const observedAt = new Date().toISOString(); const revision = this.revision(database);
    const factDigest = projectFactDigest({ event_id: eventId, event_kind: eventKind, project_id: projectId, subject_id: subjectId, registry_revision: revision, observed_at: observedAt, previous_fact_digest: previous });
    database.prepare('INSERT INTO project_events(event_id,event_kind,project_id,subject_id,registry_revision,observed_at,previous_fact_digest,fact_digest) VALUES(?,?,?,?,?,?,?,?)').run(eventId, eventKind, projectId, subjectId, revision, observedAt, previous, factDigest);
  }

  private readSnapshot(): ProjectRegistrySnapshot {
    const database = this.db();
    const meta = this.meta(database);
    const repositories = database.prepare('SELECT * FROM repositories ORDER BY project_id, id').all() as SqlRow[];
    const roles = database.prepare('SELECT * FROM role_assignments ORDER BY project_id, role_id').all() as SqlRow[];
    const taskBindings = database.prepare(`SELECT b.task_id, b.repository_id, r.project_id FROM task_repository_bindings b
      JOIN repositories r ON r.id = b.repository_id ORDER BY b.task_id`).all() as SqlRow[];
    const projects = (database.prepare('SELECT * FROM projects ORDER BY display_name COLLATE NOCASE, id').all() as SqlRow[]).map(row => {
      const projectId = stringValue(row, 'id');
      const projectRepositories: ProjectRepositorySummary[] = repositories.filter(item => stringValue(item, 'project_id') === projectId).map(item => ({
        id: stringValue(item, 'id'), displayName: stringValue(item, 'display_name'), rootUri: stringValue(item, 'root_uri'),
        availability: stringValue(item, 'availability') as ProjectRepositorySummary['availability'], revision: numberValue(item, 'revision')
      }));
      const roleAssignments: Partial<Record<KoggProjectRole, ProjectRoleAssignment>> = {};
      const projectTaskBindings: ProjectTaskRepositoryBinding[] = taskBindings
        .filter(item => stringValue(item, 'project_id') === projectId)
        .map(item => ({ taskId: stringValue(item, 'task_id'), repositoryId: stringValue(item, 'repository_id') }));
      for (const role of roles.filter(item => stringValue(item, 'project_id') === projectId)) {
        roleAssignments[stringValue(role, 'role_id') as KoggProjectRole] = {
          providerConfigurationId: stringValue(role, 'provider_configuration_id'), modelId: stringValue(role, 'model_id')
        };
      }
      return {
        id: projectId, displayName: stringValue(row, 'display_name'),
        lifecycle: projectRepositories.length > 0 && projectRepositories.every(repository => repository.availability === 'available') ? 'available' : 'unavailable',
        repositories: projectRepositories, executionProfileId: optionalString(row, 'execution_profile_id'),
        roleAssignments, taskBindings: projectTaskBindings, revision: numberValue(row, 'revision')
      } satisfies KoggProjectSummary;
    });
    return {
      schemaVersion: 1, revision: numberValue(meta, 'revision'), activeProjectId: optionalString(meta, 'active_project_id'),
      pendingSwitch: meta.pending_operation_id && meta.pending_to_project_id ? {
        operationId: meta.pending_operation_id, fromProjectId: meta.pending_from_project_id ?? undefined, toProjectId: meta.pending_to_project_id
      } : undefined,
      projects
    };
  }

  private async probe(repositoryPath: string, operationId: string, repositoryId: string): Promise<RepositoryProbeResult> {
    if (typeof repositoryPath !== 'string' || !repositoryPath || repositoryPath.length > 4096) throw new ProjectError('PROJECT_REQUEST_INVALID', 'Select a local repository directory.');
    let localPath = repositoryPath;
    try {
      if (repositoryPath.startsWith('file:')) localPath = fileURLToPath(repositoryPath);
    } catch (error) {
      throw new ProjectError('PROJECT_REQUEST_INVALID', 'Select a valid local repository directory.', { cause: error });
    }
    try {
      const selected = await fs.stat(localPath);
      const directGitMetadataPresent = await fs.access(path.join(localPath, '.git')).then(() => true, () => false);
      console.info('[kogg:projects:registry] repository.selection.resolved', {
        operationId, repositoryId, selectionKind: repositoryPath.startsWith('file:') ? 'file-uri' : 'local-path',
        isDirectory: selected.isDirectory(), directGitMetadataPresent
      });
    } catch (error) {
      console.warn('[kogg:projects:registry] repository.selection.failed', { operationId, repositoryId, errorType: errorType(error) });
    }
    return this.repositories.probe(localPath, operationId, repositoryId);
  }

  private insertRepository(database: DatabaseSync, projectId: string, repositoryId: string, displayName: string, repository: RepositoryProbeResult, now: string): void {
    this.assertUniqueRepository(database, repository.identityDigest);
    database.prepare(`INSERT INTO repositories(id, project_id, display_name, root_uri, git_dir_uri, identity_digest, availability, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?, 1)`)
      .run(repositoryId, projectId, displayName, repository.rootUri, repository.gitDirUri, repository.identityDigest, now, now);
  }

  private assertUniqueRepository(database: DatabaseSync, identityDigest: string): void {
    if (database.prepare('SELECT 1 AS found FROM repositories WHERE identity_digest = ?').get(identityDigest)) {
      throw new ProjectError('PROJECT_REPOSITORY_ALREADY_REGISTERED', 'This Git repository is already registered.');
    }
  }

  private requireProject(database: DatabaseSync, projectId: string): void {
    validateUuid(projectId, 'PROJECT_NOT_FOUND');
    if (!database.prepare('SELECT 1 AS found FROM projects WHERE id = ?').get(projectId)) throw new ProjectError('PROJECT_NOT_FOUND', 'The project does not exist.');
  }

  private validateAssignment(assignment: ProjectRoleAssignment): void {
    if (!SAFE_ID.test(assignment.providerConfigurationId) || !SAFE_ID.test(assignment.modelId)) {
      throw new ProjectError('PROJECT_PROVIDER_REFERENCE_INVALID', 'Select a valid provider and model reference.');
    }
    const providerId = assignment.providerConfigurationId.split(':', 1)[0]!;
    if (!this.providers.getProvider(providerId)) throw new ProjectError('PROJECT_PROVIDER_REFERENCE_INVALID', 'Select a configured Kogg provider.');
  }

  private async refreshProjection(projectId: string): Promise<void> {
    const rows = this.db().prepare('SELECT root_uri FROM repositories WHERE project_id = ? ORDER BY id').all(projectId) as SqlRow[];
    await this.workspaces.write(projectId, rows.map(row => stringValue(row, 'root_uri')));
  }

  private async refreshRepositoryAvailability(): Promise<void> {
    const database = this.db();
    const rows = database.prepare('SELECT id, project_id, root_uri, availability FROM repositories ORDER BY id').all() as SqlRow[];
    const changes: Array<{ id: string; projectId: string; availability: ProjectRepositorySummary['availability'] }> = [];
    console.info('[kogg:projects:registry] repository.revalidation.started', { repositoryCount: rows.length });
    for (const row of rows) {
      let availability: ProjectRepositorySummary['availability'] = 'available';
      try {
        const rootUri = stringValue(row, 'root_uri');
        if (!rootUri.startsWith('file:')) availability = 'invalid';
        else await fs.access(fileURLToPath(rootUri));
      } catch (error) {
        availability = error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing' : 'revalidation-required';
        console.warn('[kogg:projects:registry] repository.revalidation.degraded', {
          repositoryId: stringValue(row, 'id'), availability, errorType: errorType(error)
        });
      }
      if (availability !== stringValue(row, 'availability')) {
        changes.push({ id: stringValue(row, 'id'), projectId: stringValue(row, 'project_id'), availability });
      }
    }
    if (changes.length) {
      this.transaction(db => {
        const now = new Date().toISOString();
        const updateRepository = db.prepare('UPDATE repositories SET availability = ?, updated_at = ?, revision = revision + 1 WHERE id = ?');
        const updateProject = db.prepare('UPDATE projects SET updated_at = ?, revision = revision + 1 WHERE id = ?');
        for (const change of changes) updateRepository.run(change.availability, now, change.id);
        for (const projectId of new Set(changes.map(change => change.projectId))) updateProject.run(now, projectId);
        db.prepare('UPDATE registry_meta SET revision = revision + 1 WHERE singleton = 1').run();
        for (const projectId of new Set(changes.map(change => change.projectId))) {
          const unavailable = numberValue(db.prepare("SELECT count(*) AS count FROM repositories WHERE project_id = ? AND availability != 'available'").get(projectId), 'count');
          this.appendProjectEvent(db, unavailable === 0 ? 'project.available' : 'project.unavailable', projectId, projectId);
        }
      });
    }
    const unavailableCount = numberValue(database.prepare("SELECT count(*) AS count FROM repositories WHERE availability != 'available'").get(), 'count');
    console.info('[kogg:projects:registry] repository.revalidation.completed', { changedCount: changes.length, unavailableCount });
  }

  private clearPending(projectId?: string, subjectId?: string): void {
    this.transaction(database => {
      database.prepare(`UPDATE registry_meta SET pending_operation_id = NULL, pending_from_project_id = NULL,
        pending_to_project_id = NULL, pending_started_at = NULL, revision = revision + 1 WHERE singleton = 1`).run();
      if (projectId && subjectId) this.appendProjectEvent(database, 'project.switch-cancelled', projectId, subjectId);
    });
  }

  private projectEventChainIsValid(database: DatabaseSync): boolean {
    let previous = '';
    for (const row of database.prepare('SELECT * FROM project_events ORDER BY event_sequence').all() as SqlRow[]) {
      if (stringValue(row, 'previous_fact_digest') !== previous) return false;
      const digest = projectFactDigest(row);
      if (digest !== stringValue(row, 'fact_digest')) return false;
      previous = digest;
    }
    return true;
  }

  private meta(database = this.db()): {
    revision: number; active_project_id: string | null; pending_operation_id: string | null;
    pending_from_project_id: string | null; pending_to_project_id: string | null; pending_started_at: string | null;
  } {
    const row = database.prepare('SELECT * FROM registry_meta WHERE singleton = 1').get() as SqlRow | undefined;
    if (!row) throw new ProjectError('PROJECT_REGISTRY_INTEGRITY_FAILED', 'The project registry metadata is missing.');
    return {
      revision: numberValue(row, 'revision'), active_project_id: nullableString(row, 'active_project_id'),
      pending_operation_id: nullableString(row, 'pending_operation_id'), pending_from_project_id: nullableString(row, 'pending_from_project_id'),
      pending_to_project_id: nullableString(row, 'pending_to_project_id'), pending_started_at: nullableString(row, 'pending_started_at')
    };
  }

  private revision(database = this.db()): number { return this.meta(database).revision; }
  private db(): DatabaseSync {
    if (!this.database) throw new ProjectError('PROJECTS_UNAVAILABLE', 'The Kogg project registry is unavailable.');
    return this.database;
  }
  private ensureAccepting(): void {
    if (!this.accepting) throw new ProjectError('PROJECTS_SHUTTING_DOWN', 'The Kogg project registry is not accepting changes.');
  }

  private async requested(event: string, operationId: string, fields: Record<string, string> = {}): Promise<void> {
    const operation = await this.operations.startOperation({
      kind: event === 'project.switch' ? 'project-switch' : 'project-mutation',
      correlations: fields.projectId ? { projectId: fields.projectId } : undefined,
      cancellable: false
    });
    operation.start(); operation.active(); this.trackedOperations.set(operationId, operation);
    console.info('[kogg:projects:registry] operation.requested', { operationKind: event, operationId, ...fields });
  }
  private async completed(event: string, operationId: string, fields: Record<string, string> = {}): Promise<void> {
    const operation = this.trackedOperations.get(operationId);
    if (operation) {
      operation.activity(); await operation.cleanup(); operation.complete('OPERATIONS_OK'); this.trackedOperations.delete(operationId);
    }
    console.info('[kogg:projects:registry] operation.completed', { operationKind: event, operationId, ...fields });
  }
  private async refused(event: string, operationId: string, safeCode: string, fields: Record<string, string> = {}): Promise<void> {
    await this.finishFailed(operationId, 'OPERATIONS_REFUSED', 'ProjectError');
    console.warn('[kogg:projects:registry] operation.refused', { operationKind: event, operationId, safeCode, ...fields });
  }
  private async failed(event: string, operationId: string, error: unknown, fields: Record<string, string> = {}): Promise<void> {
    const safeCode = error instanceof ProjectError ? error.code : 'PROJECTS_UNAVAILABLE';
    if (error instanceof ProjectError && /REFUSED|CONFLICT|NOT_FOUND|ALREADY|INVALID|IN_USE/gu.test(error.code)) {
      await this.refused(event, operationId, safeCode, fields);
    } else {
      await this.finishFailed(operationId, 'OWNER_UNAVAILABLE', errorType(error));
      console.error('[kogg:projects:registry] operation.failed', { operationKind: event, operationId, safeCode, errorType: errorType(error), ...fields });
    }
  }
  private async finishFailed(operationId: string, code: OperationSafeCode, failureType: string): Promise<void> {
    const operation = this.trackedOperations.get(operationId);
    if (!operation) return;
    try { await operation.cleanup(); }
    catch {
      // observability-exempt: The registry emitted and persisted cleanup failure before this terminal classification.
      code = 'CLEANUP_FAILED';
    }
    operation.fail(code, failureType); this.trackedOperations.delete(operationId);
  }
  private async cancelled(operationId: string): Promise<void> {
    const operation = this.trackedOperations.get(operationId);
    if (!operation) return;
    await operation.cancel(); this.trackedOperations.delete(operationId);
  }
}

function projectEventKind(kind: string): string { return ({ 'project.create': 'project.created', 'project.update': 'project.renamed', 'project.remove': 'project.removed', 'repository.add': 'repository.changed', 'repository.relocate': 'repository.changed', 'repository.remove': 'repository.changed', 'execution-profile.update': 'project.profile-changed', 'task-repository.bind': 'project.binding-changed', 'task-repository.clear': 'project.binding-changed', 'role-assignment.update': 'project.role-changed', 'project.switch': 'project.switch-requested' } as Record<string, string>)[kind] ?? 'project.unavailable'; }
function projectFactDigest(row: SqlRow): string {
  return createHash('sha256').update(JSON.stringify([
    stringValue(row, 'event_id'), stringValue(row, 'event_kind'), stringValue(row, 'project_id'), stringValue(row, 'subject_id'),
    numberValue(row, 'registry_revision'), stringValue(row, 'observed_at'), stringValue(row, 'previous_fact_digest')
  ])).digest('hex');
}
function projectIdFrom(request: MutationRequest): string { const value = (request as Record<string, unknown>).projectId; if (typeof value === 'string' && SAFE_ID.test(value)) return value; throw new ProjectError('PROJECT_REQUEST_INVALID', 'The project owner event is missing its project identity.'); }
function subjectIdFrom(request: MutationRequest): string { const row = request as Record<string, unknown>; for (const key of ['repositoryId', 'taskId', 'role', 'operationId', 'requestId']) { const value = row[key]; if (typeof value === 'string' && SAFE_ID.test(value)) return value; } throw new ProjectError('PROJECT_REQUEST_INVALID', 'The project owner event is missing its subject identity.'); }
function mapProjectOwnerEvent(row: SqlRow, ownerInstanceId: string, epochId: string, previousEventDigest: string): OwnerEventV1 {
  const eventKind = stringValue(row, 'event_kind'); const lifecycle = eventKind === 'project.created' || eventKind === 'project.available' ? 'available' : eventKind === 'project.removed' || eventKind === 'project.unavailable' ? 'unavailable' : eventKind === 'project.switch-requested' ? 'requested' : eventKind === 'project.switch-completed' ? 'completed' : eventKind === 'project.switch-cancelled' ? 'cancelled' : undefined;
  const safePayload: SafeOwnerPayloadV1 = lifecycle ? { lifecycle } : { resultClass: 'passed' };
  const unsigned: Omit<OwnerEventV1, 'eventDigest'> = { ownerKind: 'project', ownerInstanceId, ownerSchemaVersion: 1, epochId, sequence: String(numberValue(row, 'event_sequence')), eventId: stringValue(row, 'event_id'), eventKind, factId: stringValue(row, 'subject_id'), factDigest: stringValue(row, 'fact_digest'), previousEventDigest, causalParents: [], correlations: { projectId: stringValue(row, 'project_id') }, observedAt: stringValue(row, 'observed_at'), safePayload };
  return { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) };
}

const SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, execution_profile_id TEXT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1)
);
CREATE TABLE repositories (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL, root_uri TEXT NOT NULL, git_dir_uri TEXT NOT NULL UNIQUE,
  identity_digest TEXT NOT NULL UNIQUE, availability TEXT NOT NULL CHECK(availability IN ('available','missing','invalid','revalidation-required')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), UNIQUE(project_id, root_uri)
);
CREATE TABLE role_assignments (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, role_id TEXT NOT NULL,
  provider_configuration_id TEXT NOT NULL, model_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1), PRIMARY KEY(project_id, role_id)
);
CREATE TABLE task_repository_bindings (
  task_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT
);
CREATE TABLE request_results (
  request_id TEXT PRIMARY KEY, operation_kind TEXT NOT NULL, request_digest TEXT NOT NULL,
  terminal_state TEXT NOT NULL CHECK(terminal_state IN ('completed','failed','refused','timeout','cancelled')),
  resulting_revision INTEGER NULL, safe_code TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE registry_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  revision INTEGER NOT NULL CHECK(revision >= 1), active_project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  pending_operation_id TEXT NULL, pending_from_project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  pending_to_project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT, pending_started_at TEXT NULL,
  CHECK((pending_operation_id IS NULL AND pending_to_project_id IS NULL AND pending_started_at IS NULL)
     OR (pending_operation_id IS NOT NULL AND pending_to_project_id IS NOT NULL AND pending_started_at IS NOT NULL))
);
INSERT INTO registry_meta(singleton, schema_version, revision) VALUES (1, 1, 1);
PRAGMA user_version = 1;
`;

function validateExpectation(request: ProjectMutationExpectation): void {
  validateUuid(request.requestId, 'PROJECT_REQUEST_INVALID');
  if (!Number.isSafeInteger(request.expectedRegistryRevision) || request.expectedRegistryRevision < 1) throw new ProjectError('PROJECT_REQUEST_INVALID', 'The registry revision is invalid.');
}
function validateUuid(value: string, code: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProjectError(code, 'The supplied identifier is invalid.');
}
function validateDisplayName(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProjectError('PROJECT_REQUEST_INVALID', 'Project and repository names must contain 1 to 80 printable characters.');
  }
}
function validateTaskId(value: string): void {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new ProjectError('PROJECT_REQUEST_INVALID', 'Task IDs must use 1 to 128 safe identifier characters.');
}
function requestDigest(kind: string, request: MutationRequest): string {
  return createHash('sha256').update(JSON.stringify([kind, sortObject(request)]), 'utf8').digest('hex');
}
function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortObject(child)]));
  return value;
}
function normalizeSqliteError(error: unknown): unknown {
  if (error instanceof ProjectError) return error;
  if (error instanceof Error && /\b(?:busy|locked)\b/iu.test(error.message)) {
    return new ProjectError('PROJECT_REGISTRY_BUSY', 'The project registry is busy. Try again.', { cause: error });
  }
  return error;
}
function stringValue(row: SqlRow | undefined, key: string): string {
  const value = row?.[key]; if (typeof value !== 'string') throw new ProjectError('PROJECT_REGISTRY_INTEGRITY_FAILED', 'The registry contains invalid data.'); return value;
}
function optionalString(row: SqlRow, key: string): string | undefined { return nullableString(row, key) ?? undefined; }
function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key]; if (value === null) return null; if (typeof value === 'string') return value;
  throw new ProjectError('PROJECT_REGISTRY_INTEGRITY_FAILED', 'The registry contains invalid data.');
}
function numberValue(row: SqlRow | undefined, key: string): number {
  const value = row?.[key]; if (typeof value !== 'number') throw new ProjectError('PROJECT_REGISTRY_INTEGRITY_FAILED', 'The registry contains invalid data.'); return value;
}
function stateRoot(): string {
  const root = process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd();
  return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(root, '.kogg', 'state'));
}
