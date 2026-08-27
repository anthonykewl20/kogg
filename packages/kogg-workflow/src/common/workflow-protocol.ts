// observability-exempt: Pure workflow RPC declarations have no operational behavior.
// diagnostic-exempt: Pure declarations are covered by the workflow runtime contributors.

export const KoggWorkflowServicePath = '/services/kogg-workflow';
export const KoggWorkflowService = Symbol('KoggWorkflowService');

export type WorkflowSafeCode = 'WORKFLOW_OK' | 'WORKFLOW_SCHEMA_INVALID' | 'WORKFLOW_VERSION_CONFLICT'
  | 'WORKFLOW_CATALOG_MISMATCH' | 'WORKFLOW_GRAPH_INVALID' | 'WORKFLOW_CYCLE' | 'WORKFLOW_PORT_INVALID'
  | 'WORKFLOW_UNREACHABLE' | 'WORKFLOW_JOIN_AMBIGUOUS' | 'WORKFLOW_BOUND_EXCEEDED'
  | 'WORKFLOW_CONDITION_INVALID' | 'WORKFLOW_ANCHOR_BYPASS' | 'WORKFLOW_AUTHORITY_EXPANSION'
  | 'WORKFLOW_ROLE_SEPARATION' | 'WORKFLOW_TARGET_MISMATCH' | 'WORKFLOW_EXECUTOR_INCOMPATIBLE'
  | 'WORKFLOW_APPROVAL_REQUIRED' | 'WORKFLOW_APPROVAL_INVALID' | 'WORKFLOW_DEADLINE'
  | 'WORKFLOW_RETRY_REFUSED' | 'WORKFLOW_OUTCOME_UNKNOWN' | 'WORKFLOW_EXTERNAL_FAILURE'
  | 'WORKFLOW_PROCESS_FAILED' | 'WORKFLOW_CLEANUP_FAILED' | 'WORKFLOW_RESIDUAL_PROCESS'
  | 'WORKFLOW_RECOVERY_FAILED' | 'WORKFLOW_STALE_EVIDENCE' | 'WORKFLOW_STALE_VERDICT'
  | 'WORKFLOW_MERGE_REFUSED' | 'WORKFLOW_STORE_INTEGRITY' | 'WORKFLOW_CANCELLED' | 'WORKFLOW_INTERNAL';
export type EditableNodeKind = 'research.agent' | 'pseudocode.agent' | 'probe.agent' | 'implementation.agent'
  | 'tool.git' | 'tool.build' | 'check.deterministic' | 'approval.specification' | 'approval.continue'
  | 'control.condition' | 'control.parallel' | 'control.join' | 'control.group' | 'control.finally';
export const EDITABLE_NODE_KINDS: readonly EditableNodeKind[] = ['research.agent','pseudocode.agent','probe.agent','implementation.agent','tool.git','tool.build','check.deterministic','approval.specification','approval.continue','control.condition','control.parallel','control.join','control.group','control.finally'];
export type WorkflowAuthorityEffect = 'read-repository' | 'mutate-private-repository' | 'run-tool'
  | 'invoke-provider' | 'record-approval' | 'record-check';
export type EdgeOutcome = 'success' | 'failure' | 'finally' | 'true' | 'false';

export interface WorkflowRetryPolicyV1 {
  readonly maxAttempts: number;
  readonly backoffMs: 0 | 1000 | 5000 | 15000;
  readonly sideEffectPolicy: 'none' | 'idempotent-exact-key' | 'fresh-authority';
}
export interface EditableWorkflowNodeV1 {
  readonly nodeId: string;
  readonly kind: EditableNodeKind;
  readonly kindVersion: '1';
  readonly configurationDigest: string;
  readonly requestedEffects: readonly WorkflowAuthorityEffect[];
  readonly retry: WorkflowRetryPolicyV1;
}
export interface EditableWorkflowEdgeV1 {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly sourcePort: EdgeOutcome;
  readonly targetNodeId: string;
  readonly targetPort: 'in';
}
export interface EditableWorkflowGraphV1 {
  readonly schemaVersion: '1';
  readonly projectId: string;
  readonly nodes: readonly EditableWorkflowNodeV1[];
  readonly edges: readonly EditableWorkflowEdgeV1[];
}
export interface WorkflowValidationProjection {
  readonly valid: boolean;
  readonly code: WorkflowSafeCode;
  readonly graphDigest?: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly rootCount: number;
}
export interface WorkflowTemplateVersionProjection {
  readonly templateId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly graphDigest: string;
  readonly catalogDigest: string;
  readonly createdAt: string;
}
export interface WorkflowCompiledPlanProjection {
  readonly planId: string;
  readonly versionId: string;
  readonly planDigest: string;
  readonly graphDigest: string;
  readonly trustSpineDigest: string;
  readonly catalogDigest: string;
  readonly editableNodeCount: number;
  readonly injectedAnchorCount: number;
}
export type WorkflowMutationResult =
  | { readonly kind: 'completed'; readonly code: 'WORKFLOW_OK'; readonly version?: WorkflowTemplateVersionProjection; readonly plan?: WorkflowCompiledPlanProjection }
  | { readonly kind: 'conflict' | 'refused' | 'failed'; readonly code: WorkflowSafeCode; readonly currentVersionNumber?: number };

export interface KoggWorkflowService {
  validate(graph: unknown): Promise<WorkflowValidationProjection>;
  saveVersion(input: { readonly requestId: string; readonly templateId: string; readonly expectedVersionNumber: number; readonly graph: unknown }): Promise<WorkflowMutationResult>;
  compile(input: { readonly requestId: string; readonly versionId: string }): Promise<WorkflowMutationResult>;
  admitRun(input: { readonly requestId: string; readonly planId: string }): Promise<WorkflowMutationResult>;
  listVersions(templateId: string): Promise<readonly WorkflowTemplateVersionProjection[]>;
  listProjectVersions(projectId: string): Promise<readonly WorkflowTemplateVersionProjection[]>;
}
