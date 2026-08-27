import type {
  KoggProjectRole,
  ProjectMutationExpectation,
  ProjectRegistrySnapshot,
  ProjectSwitchTicket,
  ProjectWorkspaceReconciliation
} from '@kogg/contracts';

// observability-exempt: This file contains pure RPC declarations with no operational behavior.
// diagnostic-exempt: Pure RPC declarations have no independent runtime state.

export const KoggProjectsServicePath = '/services/kogg-projects';
export const KoggProjectsService = Symbol('KoggProjectsService');
export const ProjectBindingAuthority = Symbol('ProjectBindingAuthority');

export interface ProjectBindingSnapshot {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly registryRevision: number;
  readonly bindingRevision: number;
  readonly available: boolean;
  readonly active: boolean;
  readonly executionProfileId: string;
  readonly rootUri: string;
  readonly repositoryIdentityDigest: string;
}

export interface ProjectBindingAuthority {
  resolveBinding(projectId: string, repositoryId: string): Promise<ProjectBindingSnapshot | undefined>;
}

export interface KoggProjectsService {
  snapshot(): Promise<ProjectRegistrySnapshot>;
  createProject(request: ProjectMutationExpectation & { readonly displayName: string; readonly repositoryPath: string }): Promise<ProjectRegistrySnapshot>;
  renameProject(request: ProjectMutationExpectation & { readonly projectId: string; readonly displayName: string }): Promise<ProjectRegistrySnapshot>;
  removeProject(request: ProjectMutationExpectation & { readonly projectId: string }): Promise<ProjectRegistrySnapshot>;
  addRepository(request: ProjectMutationExpectation & { readonly projectId: string; readonly displayName: string; readonly repositoryPath: string }): Promise<ProjectRegistrySnapshot>;
  relocateRepository(request: ProjectMutationExpectation & { readonly projectId: string; readonly repositoryId: string; readonly repositoryPath: string }): Promise<ProjectRegistrySnapshot>;
  removeRepository(request: ProjectMutationExpectation & { readonly projectId: string; readonly repositoryId: string }): Promise<ProjectRegistrySnapshot>;
  setExecutionProfile(request: ProjectMutationExpectation & { readonly projectId: string; readonly executionProfileId?: string }): Promise<ProjectRegistrySnapshot>;
  bindTaskRepository(request: ProjectMutationExpectation & { readonly projectId: string; readonly taskId: string; readonly repositoryId: string }): Promise<ProjectRegistrySnapshot>;
  clearTaskRepository(request: ProjectMutationExpectation & { readonly projectId: string; readonly taskId: string }): Promise<ProjectRegistrySnapshot>;
  setRoleAssignment(request: ProjectMutationExpectation & {
    readonly projectId: string;
    readonly role: KoggProjectRole;
    readonly assignment?: { readonly providerConfigurationId: string; readonly modelId: string };
  }): Promise<ProjectRegistrySnapshot>;
  requestSwitch(request: ProjectMutationExpectation & { readonly projectId: string }): Promise<ProjectSwitchTicket>;
  reconcileWorkspace(request: { readonly requestId: string; readonly currentWorkspaceUri?: string }): Promise<ProjectWorkspaceReconciliation>;
  cancelSwitch(request: { readonly requestId: string; readonly operationId: string }): Promise<ProjectRegistrySnapshot>;
}
