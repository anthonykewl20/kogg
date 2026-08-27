// observability-exempt: This file contains pure RPC declarations with no operational behavior.
// diagnostic-exempt: Pure RPC declarations have no independent runtime state.
import type { OperationLease } from '@kogg/operations/lib/common/operations-protocol';

export const KoggAgentsServicePath = '/services/kogg-agents';
export const KoggAgentsService = Symbol('KoggAgentsService');
export const KoggAdapterRegistry = Symbol('KoggAdapterRegistry');
export const CredentialLeaseAuthority = Symbol('CredentialLeaseAuthority');
export const KoggAgentBindingAuthorizer = Symbol('KoggAgentBindingAuthorizer');
export const KoggAgentWorkspaceAuthority = Symbol('KoggAgentWorkspaceAuthority');

export type Decimal = string;
export type AttemptState = 'requested' | 'admitted' | 'adapter_resolved' | 'registered' | 'starting' | 'ready' | 'active'
  | 'completed_observed' | 'failed_observed' | 'cancelling' | 'timed_out' | 'cleaning' | 'cleaned' | 'cleanup_failed'
  | 'recovery_required' | 'reconciling' | 'recovered_terminal' | 'unverified_residual';
export type AgentSafeCode = 'AGENT_OK' | 'ROLE_NOT_FOUND' | 'ROLE_REVISION_STALE' | 'ROLE_REVOKED' | 'TASK_AUTHORITY_STALE'
  | 'PROJECT_BINDING_CHANGED' | 'WORKSPACE_UNTRUSTED' | 'POLICY_REFUSED' | 'BUDGET_REFUSED' | 'ADAPTER_UNAVAILABLE'
  | 'ADAPTER_RESOLUTION_AMBIGUOUS' | 'ADAPTER_DISABLED' | 'PROTOCOL_UNSUPPORTED' | 'CAPABILITY_MISMATCH'
  | 'PROVIDER_MISMATCH' | 'MODEL_MISMATCH' | 'CREDENTIAL_LEASE_REFUSED' | 'CHILD_AUTHORITY_EXPANSION'
  | 'CHILD_LIMIT_EXCEEDED' | 'CHILD_CYCLE' | 'HANDSHAKE_TIMEOUT' | 'FIRST_ACTIVITY_TIMEOUT' | 'IDLE_TIMEOUT'
  | 'PROVIDER_REQUEST_TIMEOUT' | 'ABSOLUTE_TIMEOUT' | 'CANCELLED' | 'CANCEL_GRACE_EXPIRED' | 'PROVIDER_AUTH_REFUSED'
  | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_REFUSED' | 'TRANSPORT_LOST' | 'ADAPTER_HOST_EXITED' | 'ADAPTER_OBSERVATION_INVALID'
  | 'USAGE_INVALID' | 'USAGE_OVERFLOW' | 'RESOURCE_HIDDEN' | 'RESOURCE_IDENTITY_UNVERIFIED' | 'CLEANUP_FAILED'
  | 'RECOVERY_REQUIRED' | 'RECOVERY_FAILED' | 'REQUEST_ID_REUSED' | 'REGISTRY_REVISION_CONFLICT'
  | 'ATTEMPT_REVISION_CONFLICT' | 'AGENT_REGISTRY_UNAVAILABLE' | 'AGENT_REGISTRY_BUSY' | 'AGENT_REGISTRY_PERMISSION_FAILED'
  | 'AGENT_REGISTRY_SCHEMA_UNSUPPORTED' | 'AGENT_REGISTRY_INTEGRITY_FAILED' | 'AGENT_INTERNAL_FAILURE';

export interface RoleRevisionV1 {
  readonly schemaVersion: '1'; readonly roleId: string; readonly roleRevisionId: string; readonly roleRevision: Decimal;
  readonly roleKey: string; readonly displayName: string;
  readonly authority: { readonly capabilityIds: readonly string[]; readonly toolPolicyIds: readonly string[]; readonly mayCreateChildren: boolean; readonly permittedChildRoleKeys: readonly string[]; readonly maxChildDepth: Decimal; readonly maxDirectChildren: Decimal };
  readonly providerPolicy: { readonly permittedProviderIds: readonly string[]; readonly permittedModelIds: readonly string[]; readonly requiredAdapterCapabilities: readonly string[] };
  readonly budgetPolicyId: string; readonly createdAt: string;
}
export interface CreateRoleRevisionRequestV1 {
  readonly schemaVersion: '1'; readonly requestId: string; readonly expectedRegistryRevision: Decimal; readonly roleId?: string;
  readonly roleKey: string; readonly displayName: string; readonly authority: RoleRevisionV1['authority'];
  readonly providerPolicy: RoleRevisionV1['providerPolicy']; readonly budgetPolicyId: string;
}
export interface AdapterDescriptorV1 {
  readonly schemaVersion: '1'; readonly adapterKey: string; readonly adapterVersion: string; readonly protocolId: string; readonly protocolVersion: string;
  readonly providerIds: readonly string[]; readonly capabilityIds: readonly string[]; readonly executionKind: 'in-process' | 'supervised-host' | 'ranex-bridge';
  readonly cancellation: 'cooperative-and-owned-cleanup'; readonly usageModes: readonly ('provider-cumulative' | 'provider-delta' | 'kogg-derived')[]; readonly ownerKind: 'kogg' | 'ranex' | 'theia'; readonly enabled: boolean;
}
export interface UsageProjectionV1 {
  readonly status: 'unknown' | 'partial' | 'complete' | 'invalid';
  readonly source: 'none' | 'provider-cumulative' | 'provider-delta' | 'kogg-derived';
  readonly inputTokens?: Decimal; readonly outputTokens?: Decimal; readonly cachedInputTokens?: Decimal;
  readonly reasoningTokens?: Decimal; readonly totalTokens?: Decimal; readonly costMinorUnits?: Decimal; readonly currency?: string;
}
export interface AttemptProjectionV1 {
  readonly schemaVersion: '1'; readonly attemptId: string; readonly rootAttemptId: string; readonly parentAttemptId?: string;
  readonly attemptRevision: Decimal; readonly registryRevision: Decimal; readonly taskId: string; readonly projectId: string; readonly repositoryId: string;
  readonly specificationId: string; readonly approvalId: string; readonly runId?: string; readonly worktreeId?: string; readonly roleRevisionId: string;
  readonly adapterKey: string; readonly adapterVersion: string; readonly providerId: string; readonly requestedModelId: string; readonly observedModelId?: string;
  readonly state: AttemptState; readonly terminalCode?: AgentSafeCode; readonly activityCount: Decimal; readonly childCount: Decimal; readonly ownedResourceCount: Decimal;
  readonly usage: UsageProjectionV1; readonly requestedAt: string; readonly stateChangedAt: string;
}
export interface StartAttemptRequestV1 {
  readonly schemaVersion: '1'; readonly requestId: string; readonly expectedRegistryRevision: Decimal; readonly taskAdmissionId: string;
  readonly roleRevisionId: string; readonly providerId: string; readonly modelId: string; readonly adapterKey: string; readonly adapterVersion: string;
  readonly deadlinePolicyId: string; readonly parentAttemptId?: string; readonly workflowPlanDigest?: string;
}
export interface CancelAttemptRequestV1 { readonly schemaVersion: '1'; readonly requestId: string; readonly expectedRegistryRevision: Decimal; readonly expectedAttemptRevision: Decimal; readonly attemptId: string; readonly reason: 'user' | 'parent' | 'shutdown' | 'policy'; }
export interface AgentMutationResult { readonly kind: 'completed' | 'refused' | 'conflict' | 'failed'; readonly code: AgentSafeCode; readonly registryRevision: Decimal; readonly role?: RoleRevisionV1; readonly attempt?: AttemptProjectionV1; readonly replay?: boolean; }
export interface AgentRegistrySnapshot { readonly schemaVersion: '1'; readonly registryRevision: Decimal; readonly admission: 'enabled' | 'recovering' | 'blocked'; readonly roles: readonly RoleRevisionV1[]; readonly attempts: readonly AttemptProjectionV1[]; readonly adapters: readonly AdapterDescriptorV1[]; }
export interface AdapterObservationV1 { readonly sequence: Decimal; readonly kind: 'ready' | 'provider-request-started' | 'provider-request-settled' | 'activity' | 'usage' | 'completed' | 'failed'; readonly observedModelId?: string; readonly activityKind?: string; readonly usage?: UsageProjectionV1; readonly safeCode?: AgentSafeCode; }
export interface KoggAgentsClient { changed(snapshot: AgentRegistrySnapshot): void | Promise<void>; }
export interface AgentAdapterSession { readonly resourceId: string; readonly resourceKind: 'provider-host' | 'provider-request'; readonly ownerKind: AdapterDescriptorV1['ownerKind']; start(): Promise<void>; cancel(reason: CancelAttemptRequestV1['reason']): Promise<void>; cleanup(): Promise<{ readonly residualCount: number }>; }
export interface OpaqueCredentialLease { readonly leaseId: string; readonly expiresAt: string; consume(): void; dispose(): void; }
export interface CredentialLeaseAuthority { issue(input: { readonly attemptId: string; readonly providerId: string; readonly modelId: string; readonly adapterKey: string; readonly adapterVersion: string; readonly capabilityIds: readonly string[] }): Promise<OpaqueCredentialLease>; }
export interface AdapterAttemptBindingV1 {
  readonly schemaVersion: '1'; readonly attemptId: string; readonly taskId: string; readonly projectId: string; readonly repositoryId: string;
  readonly repositoryBindingRevision: Decimal; readonly specificationId: string; readonly approvalId: string; readonly runId: string;
  readonly roleRevisionId: string; readonly deadlinePolicyId: string; readonly providerId: string; readonly modelId: string; readonly worktreeId?: string;
}
export interface AgentWorkspaceAuthorizationRequestV1 {
  readonly schemaVersion: '1'; readonly requestId: string; readonly attemptId: string; readonly taskAdmissionId: string;
  readonly taskId: string; readonly projectId: string; readonly repositoryId: string; readonly repositoryBindingRevision: Decimal;
  readonly specificationId: string; readonly taskRevisionId: string; readonly taskRevisionDigest: string;
  readonly approvalId: string; readonly approvalDigest: string; readonly runId: string; readonly roleRevisionId: string; readonly workflowPlanDigest: string;
}
export interface AgentWorkspaceAuthorizationResultV1 { readonly allowed: boolean; readonly code: AgentSafeCode; readonly worktreeId?: string; readonly workspaceGrantDigest?: string; }
export interface AgentWorkspaceAuthority { prepareWorkspace(request: AgentWorkspaceAuthorizationRequestV1): Promise<AgentWorkspaceAuthorizationResultV1>; }
export interface AgentBindingAuthorizationRequestV1 { readonly roleRevisionId: string; readonly providerId: string; readonly modelId: string; readonly adapterKey: string; readonly adapterVersion: string; readonly deadlinePolicyId: string; }
export interface AgentBindingAuthorizationResultV1 { readonly allowed: boolean; readonly code: AgentSafeCode; readonly registryRevision: Decimal; }
export interface AgentBindingAuthorizer { authorizeBinding(request: AgentBindingAuthorizationRequestV1): Promise<AgentBindingAuthorizationResultV1>; }
export interface AgentAdapterFactory { readonly descriptor: AdapterDescriptorV1; create(input: { readonly binding: AdapterAttemptBindingV1; readonly operation: OperationLease; readonly credentialLease: OpaqueCredentialLease; readonly onObservation: (observation: AdapterObservationV1) => void }): AgentAdapterSession; }
export interface AdapterRegistryApi { register(factory: AgentAdapterFactory): void; descriptors(): readonly AdapterDescriptorV1[]; resolveExact(input: { adapterKey: string; adapterVersion: string; providerId: string; modelId: string; requiredCapabilities: readonly string[] }): AgentAdapterFactory; }
export interface KoggAgentsService { snapshot(): Promise<AgentRegistrySnapshot>; subscribe(): Promise<AgentRegistrySnapshot>; listAttempts(): Promise<readonly AttemptProjectionV1[]>; getAttempt(attemptId: string): Promise<AttemptProjectionV1>; listRoleRevisions(): Promise<readonly RoleRevisionV1[]>; createRoleRevision(request: CreateRoleRevisionRequestV1): Promise<AgentMutationResult>; startAttempt(request: StartAttemptRequestV1): Promise<AgentMutationResult>; cancelAttempt(request: CancelAttemptRequestV1): Promise<AgentMutationResult>; }
