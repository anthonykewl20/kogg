export * from './kernel-evidence-protocol';

export type KoggPackageType =
  | 'vscode-extension'
  | 'kogg-integration'
  | 'workflow-template'
  | 'provider-adapter'
  | 'verification-adapter';

export interface KoggPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
  readonly type: KoggPackageType;
  readonly engines: {
    readonly kogg: string;
    readonly vscode?: string;
  };
  readonly artifact: {
    readonly url: string;
    readonly sha256: string;
    readonly size: number;
  };
  readonly permissions: readonly string[];
  readonly networkDomains: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly license: string;
  readonly sbomUrl: string;
  readonly provenanceUrl: string;
  readonly revoked: boolean;
  readonly signature: string;
}

export interface MarketplaceClient {
  search(query: string): Promise<readonly KoggPackageManifest[]>;
  details(id: string, version?: string): Promise<KoggPackageManifest>;
  install(manifest: KoggPackageManifest): Promise<void>;
  update(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  rollback(id: string): Promise<void>;
  refreshRevocations(): Promise<void>;
}

export const MarketplaceClientToken = Symbol('MarketplaceClient');

export interface CredentialMetadata {
  readonly provider: string;
  readonly account: string;
  readonly updatedAt: string;
}

export interface CredentialStore {
  set(provider: string, account: string, secret: string): Promise<void>;
  get(provider: string, account: string): Promise<string | undefined>;
  delete(provider: string, account: string): Promise<boolean>;
  listMetadata(): Promise<readonly CredentialMetadata[]>;
}

export const CredentialStoreToken = Symbol('CredentialStore');

export interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly configuration: 'api-key' | 'oauth' | 'oauth-account' | 'local';
  readonly capabilities: {
    readonly streaming: boolean;
    readonly toolCalls: boolean;
    readonly structuredOutput: boolean;
    readonly local: boolean;
  };
  readonly governedQualification: 'qualified' | 'blocked';
}

export interface ModelDescriptor {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

export interface ProviderRegistry {
  listProviders(): readonly ProviderDescriptor[];
  getProvider(id: string): ProviderDescriptor | undefined;
  discoverModels(provider: string, account: string, endpoint?: string): Promise<readonly ModelDescriptor[]>;
  credentialStatus(provider: string, account: string): Promise<'configured' | 'missing'>;
  testConnection(provider: string, account: string, endpoint?: string): Promise<{ readonly ok: boolean; readonly detail: string }>;
  importAccountCredential(provider: string, account: string): Promise<void>;
  assertGoverned(provider: string): void;
}

export const ProviderRegistryToken = Symbol('ProviderRegistry');

export type ProjectId = string;
export type ProjectRepositoryId = string;
export type ProjectOperationId = string;
export type ProjectRegistryRevision = number;

export type ProjectRepositoryAvailability = 'available' | 'missing' | 'invalid' | 'revalidation-required';
export type KoggProjectRole =
  | 'orchestrator' | 'architect' | 'planner' | 'worker' | 'researcher'
  | 'test-writer' | 'test-executor' | 'reviewer' | 'security-reviewer'
  | 'performance-reviewer' | 'documentation-agent' | 'migration-agent'
  | 'release-agent' | 'integrator' | 'verification-agent';

export interface ProjectRepositorySummary {
  readonly id: ProjectRepositoryId;
  readonly displayName: string;
  readonly rootUri: string;
  readonly availability: ProjectRepositoryAvailability;
  readonly revision: ProjectRegistryRevision;
}

export interface ProjectRoleAssignment {
  readonly providerConfigurationId: string;
  readonly modelId: string;
}

export interface ProjectTaskRepositoryBinding {
  readonly taskId: string;
  readonly repositoryId: ProjectRepositoryId;
}

export interface KoggProjectSummary {
  readonly id: ProjectId;
  readonly displayName: string;
  readonly lifecycle: 'available' | 'unavailable';
  readonly repositories: readonly ProjectRepositorySummary[];
  readonly executionProfileId?: string;
  readonly roleAssignments: Readonly<Partial<Record<KoggProjectRole, ProjectRoleAssignment>>>;
  readonly taskBindings: readonly ProjectTaskRepositoryBinding[];
  readonly revision: ProjectRegistryRevision;
}

export interface ProjectRegistrySnapshot {
  readonly schemaVersion: 1;
  readonly revision: ProjectRegistryRevision;
  readonly activeProjectId?: ProjectId;
  readonly pendingSwitch?: {
    readonly operationId: ProjectOperationId;
    readonly fromProjectId?: ProjectId;
    readonly toProjectId: ProjectId;
  };
  readonly projects: readonly KoggProjectSummary[];
}

export interface ProjectMutationExpectation {
  readonly expectedRegistryRevision: ProjectRegistryRevision;
  readonly requestId: ProjectOperationId;
}

export interface ProjectSwitchTicket {
  readonly operationId: ProjectOperationId;
  readonly projectId: ProjectId;
  readonly workspaceUri: string;
  readonly expectedRegistryRevision: ProjectRegistryRevision;
}

export interface ProjectWorkspaceReconciliation {
  readonly snapshot: ProjectRegistrySnapshot;
  readonly action: 'none' | 'open';
  readonly workspaceUri?: string;
}

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface KoggDiagnosticCheck {
  readonly id: string;
  readonly status: DiagnosticStatus;
  readonly summary: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface KoggDiagnosticReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly overall: DiagnosticStatus;
  readonly checks: readonly KoggDiagnosticCheck[];
}

export interface KoggSupportBundle {
  readonly uri: string;
  readonly report: KoggDiagnosticReport;
}

export interface KoggDiagnosticsService {
  run(): Promise<KoggDiagnosticReport>;
  createSupportBundle(): Promise<KoggSupportBundle>;
}

export interface KoggDiagnosticContributor {
  readonly id: string;
  diagnose(): Promise<readonly KoggDiagnosticCheck[]>;
}

export const KoggDiagnosticContribution = Symbol('KoggDiagnosticContribution');
export const KoggDiagnosticsServicePath = '/services/kogg-diagnostics';
export const KoggDiagnosticsServiceToken = Symbol('KoggDiagnosticsService');
