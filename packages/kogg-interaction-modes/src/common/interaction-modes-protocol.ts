// observability-exempt: This file contains pure closed RPC declarations with no operational behavior.
// diagnostic-exempt: Pure RPC declarations have no independent runtime state.
export const KoggInteractionModesServicePath = '/services/kogg-interaction-modes';
export const KoggInteractionModesService = Symbol('KoggInteractionModesService');
export const KoggModeOperationAuthorizer = Symbol('KoggModeOperationAuthorizer');
export const KoggModeTransitionOwner = Symbol('KoggModeTransitionOwner');

export type InteractionModeV1 = 'plan' | 'build' | 'kogg';
export type ModeCapabilityV1 = 'research.read' | 'plan.write' | 'plan.approval-request' | 'worktree.create'
  | 'repository.mutate-private' | 'tool.execute-build' | 'provider.invoke-advisory' | 'provider.invoke-mutating'
  | 'check.run-untrusted' | 'workflow.compile-governed' | 'workflow.run-governed' | 'approval.consume'
  | 'check.run-independent' | 'evidence.request' | 'verdict.observe' | 'merge.request-controlled';
export type ModeOperationV1 = 'research' | 'plan-save' | 'plan-approval-request' | 'worktree-create' | 'private-mutate'
  | 'build-tool' | 'governed-entry' | 'evidence-request' | 'verdict-observe-current' | 'merge-controlled';
export type ModeSafeCodeV1 = 'MODE_OK' | 'MODE_PROTOCOL_INVALID' | 'MODE_TASK_STALE' | 'MODE_TASK_UNAVAILABLE'
  | 'MODE_REQUEST_CONFLICT' | 'MODE_AUTHORITY_REFUSED' | 'PLAN_MUTATION_REFUSED' | 'BUILD_EVIDENCE_REFUSED'
  | 'BUILD_VERDICT_REFUSED' | 'BUILD_MERGE_REFUSED' | 'MODE_RESTORE_DEGRADED' | 'MODE_REGISTRY_UNAVAILABLE'
  | 'MODE_REGISTRY_INTEGRITY_FAILED' | 'MODE_EXPANSION_CONFIRMATION_REQUIRED' | 'MODE_TRANSITION_CONFLICT'
  | 'MODE_ACTIVE_OPERATION' | 'MODE_TRANSITION_EXPIRED' | 'MODE_CLEANUP_FAILED' | 'MODE_PROCESS_RESIDUAL'
  | 'MODE_WORKTREE_INVALID' | 'MODE_PROVIDER_UNQUALIFIED' | 'MODE_HOST_UNQUALIFIED' | 'MODE_WORKFLOW_UNAVAILABLE'
  | 'MODE_QUARANTINED';
export interface ModeProjectionV1 {
  readonly schemaVersion: 1; readonly taskId: string; readonly projectId: string; readonly repositoryId: string;
  readonly taskRevision: string; readonly selectedMode: InteractionModeV1; readonly effectiveCapabilities: readonly ModeCapabilityV1[];
  readonly sequence: string; readonly state: 'ready' | 'transition-pending' | 'restore-degraded' | 'quarantined'; readonly activeStage: string;
  readonly safeCode: ModeSafeCodeV1;
}
export interface ModeReadRequestV1 { readonly requestId: string; readonly taskId: string; }
export interface ModeOperationRequestV1 { readonly requestId: string; readonly taskId: string; readonly operation: ModeOperationV1; }
export interface ModeOperationResultV1 { readonly schemaVersion: 1; readonly allowed: boolean; readonly safeCode: ModeSafeCodeV1; readonly projection: ModeProjectionV1; }
export interface ModeOperationAuthorizer { authorizeOperation(request: ModeOperationRequestV1): Promise<ModeOperationResultV1>; }
export type ModeTransitionStateV1 = 'committed' | 'awaiting-confirmation' | 'cleanup-pending' | 'cancelled' | 'expired' | 'refused' | 'quarantined';
export interface ModeTransitionRequestV1 {
  readonly transitionId: string; readonly requestId: string; readonly taskId: string; readonly expectedSequence: string;
  readonly fromMode: InteractionModeV1; readonly toMode: InteractionModeV1; readonly requestedConfigurationDigest: string;
}
export interface ModeTransitionCancelRequestV1 { readonly requestId: string; readonly transitionId: string; readonly taskId: string; }
export type ModeTransitionConfigurationV1 =
  | { readonly schemaVersion: 1; readonly kind: 'plan' }
  | { readonly schemaVersion: 1; readonly kind: 'build'; readonly roleRevisionId: string; readonly providerId: string; readonly modelId: string; readonly adapterKey: string; readonly adapterVersion: string; readonly deadlinePolicyId: string; readonly targetId: string }
  | { readonly schemaVersion: 1; readonly kind: 'kogg'; readonly workflowVersionId: string };
export interface ModeTransitionConfirmRequestV1 {
  readonly requestId: string; readonly transitionId: string; readonly taskId: string; readonly challengeDigest?: string;
  readonly explicitGesture: true; readonly configuration: ModeTransitionConfigurationV1;
}
export type ModeTransitionOwnerIdV1 = 'operations' | 'agent-binding' | 'execution-target' | 'workflow-anchors';
export interface ModeTransitionConfigurationContextV1 { readonly taskId: string; readonly projectId: string; readonly repositoryId: string; readonly taskRevision: string; }
export type ModeTransitionConfigurationCandidateV1 =
  | { readonly owner: 'agent-binding'; readonly roleRevisionId: string; readonly providerId: string; readonly modelId: string; readonly adapterKey: string; readonly adapterVersion: string; readonly deadlinePolicyId: string }
  | { readonly owner: 'execution-target'; readonly targetId: string }
  | { readonly owner: 'workflow-anchors'; readonly workflowVersionId: string };
export interface ModeTransitionConfigurationOptionsRequestV1 { readonly requestId: string; readonly taskId: string; readonly toMode: InteractionModeV1; }
export interface ModeTransitionConfigurationOptionsV1 { readonly schemaVersion: 1; readonly options: readonly ModeTransitionConfigurationV1[]; }
export interface ModeTransitionOwnerRequestV1 {
  readonly transitionId: string; readonly taskId: string; readonly projectId: string; readonly repositoryId: string;
  readonly taskRevision: string; readonly fromMode: InteractionModeV1; readonly toMode: InteractionModeV1;
  readonly direction: 'preserve' | 'reduce' | 'expand'; readonly configuration: ModeTransitionConfigurationV1;
}
export interface ModeTransitionOwnerResultV1 {
  readonly owner: ModeTransitionOwnerIdV1; readonly qualified: boolean; readonly safeCode: ModeSafeCodeV1; readonly proofDigest?: string;
}
export interface ModeTransitionOwnerContribution {
  readonly owner: ModeTransitionOwnerIdV1;
  qualifyTransition(request: ModeTransitionOwnerRequestV1): Promise<ModeTransitionOwnerResultV1>;
  configurationCandidates?(context: ModeTransitionConfigurationContextV1): Promise<readonly ModeTransitionConfigurationCandidateV1[]>;
}
export interface ModeTransitionProjectionV1 {
  readonly schemaVersion: 1; readonly transitionId: string; readonly taskId: string; readonly fromMode: InteractionModeV1;
  readonly toMode: InteractionModeV1; readonly direction: 'preserve' | 'reduce' | 'expand'; readonly state: ModeTransitionStateV1;
  readonly safeCode: ModeSafeCodeV1; readonly configurationDigest: string; readonly challengeDigest?: string; readonly expiresAt?: string; readonly mode: ModeProjectionV1;
}
export interface KoggInteractionModesService {
  get(request: ModeReadRequestV1): Promise<ModeProjectionV1>;
  getPendingTransition(request: ModeReadRequestV1): Promise<ModeTransitionProjectionV1 | undefined>;
  authorizeOperation(request: ModeOperationRequestV1): Promise<ModeOperationResultV1>;
  transitionConfigurations(request: ModeTransitionConfigurationOptionsRequestV1): Promise<ModeTransitionConfigurationOptionsV1>;
  requestDesktopTransition(request: ModeTransitionRequestV1): Promise<ModeTransitionProjectionV1>;
  confirmDesktopTransition(request: ModeTransitionConfirmRequestV1): Promise<ModeTransitionProjectionV1>;
  cancelDesktopTransition(request: ModeTransitionCancelRequestV1): Promise<ModeTransitionProjectionV1>;
}
