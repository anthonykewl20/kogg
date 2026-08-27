// observability-exempt: This file contains pure RPC declarations with no operational behavior.
// diagnostic-exempt: Pure RPC declarations have no independent runtime state.

export const KoggTasksServicePath = '/services/kogg-tasks';
export const KoggTasksService = Symbol('KoggTasksService');
export const TaskAdmissionAuthority = Symbol('TaskAdmissionAuthority');

export type TaskResultKind = 'completed' | 'refused' | 'conflict' | 'failed';
export type TaskLifecycle = 'active' | 'archived';
export type SpecificationLifecycle = 'draft' | 'frozen';
export type ApprovalLifecycle = 'current' | 'revoked' | 'invalidated' | 'superseded';
export type TaskSafeCode = 'TASK_OK' | 'TASK_NOT_AVAILABLE' | 'TASK_ARCHIVED' | 'TASK_NOT_DRAFT'
  | 'TASK_ALREADY_ARCHIVED' | 'SPEC_EMPTY' | 'SPEC_TOO_LARGE' | 'SPEC_INVALID_UNICODE'
  | 'BINDING_MISSING' | 'BINDING_CHANGED' | 'PROJECT_UNTRUSTED' | 'REVIEW_REQUIRED'
  | 'REVIEW_EXPIRED' | 'REVIEW_SESSION_CHANGED' | 'APPROVAL_NOT_CURRENT'
  | 'ADMISSION_NOT_AUTHORIZED' | 'REGISTRY_REVISION_CONFLICT' | 'TASK_REVISION_CONFLICT'
  | 'REQUEST_ID_REUSED' | 'CURRENT_REVISION_CHANGED' | 'REGISTRY_UNAVAILABLE'
  | 'SCHEMA_UNSUPPORTED' | 'INTEGRITY_FAILED' | 'STORAGE_PERMISSION_FAILED'
  | 'TRANSACTION_BUSY' | 'INTERNAL_FAILURE';

export interface SpecificationProjection {
  readonly specificationId: string; readonly sequence: string; readonly lifecycle: SpecificationLifecycle;
  readonly content: string; readonly byteLength: number; readonly lineEnding: 'none' | 'lf' | 'crlf' | 'mixed'; readonly createdAt: string;
}
export interface ApprovalProjection {
  readonly approvalId: string; readonly specificationId: string; readonly lifecycle: ApprovalLifecycle; readonly createdAt: string;
}
export interface TaskProjection {
  readonly taskId: string; readonly projectId: string; readonly repositoryId: string; readonly bindingRevision: string;
  readonly taskRevision: string; readonly registryRevision: string; readonly lifecycle: TaskLifecycle;
  readonly currentSpecification: SpecificationProjection; readonly currentApproval?: ApprovalProjection;
}
export interface TaskSummary {
  readonly taskId: string; readonly projectId: string; readonly repositoryId: string; readonly taskRevision: string;
  readonly lifecycle: TaskLifecycle; readonly specificationLifecycle: SpecificationLifecycle; readonly approvalLifecycle?: ApprovalLifecycle;
}
export interface MutationPrecondition { readonly requestId: string; readonly expectedRegistryRevision: string; readonly expectedTaskRevision: string; }
export interface TaskMutationResult {
  readonly kind: TaskResultKind; readonly code: TaskSafeCode; readonly projection?: TaskProjection;
  readonly currentRegistryRevision?: string; readonly currentTaskRevision?: string; readonly replay?: boolean;
}
export interface ReviewProjection {
  readonly kind: TaskResultKind; readonly code: TaskSafeCode; readonly challenge?: string; readonly expiresAt?: string; readonly projection?: TaskProjection;
}
export interface TaskAdmissionSnapshot {
  readonly taskAdmissionId: string; readonly taskId: string; readonly specificationId: string; readonly approvalId: string; readonly projectId: string;
  readonly repositoryId: string; readonly bindingRevision: string; readonly registryRevision: string; readonly taskRevision: string; readonly runId: string;
  readonly authorizedAt: string; readonly expiresAt: string;
}

export interface TaskKernelAuthoritySnapshot {
  readonly taskId: string; readonly taskRevision: number; readonly specificationDigest: string;
  readonly approvalId: string; readonly approvalDigest: string; readonly approvalCreatedAt: string;
  readonly projectId: string; readonly repositoryId: string; readonly bindingRevision: number;
  readonly runId: string; readonly authorizedAt: string; readonly expiresAt: string; readonly executionProfileId: string; readonly rootUri: string;
  readonly repositoryIdentityDigest: string;
}

export const TaskKernelBindingAuthority = Symbol('TaskKernelBindingAuthority');
export interface TaskKernelBindingAuthority {
  resolveAdmission(admission: TaskAdmissionSnapshot): Promise<TaskKernelAuthoritySnapshot>;
}
export interface TaskAdmissionAuthority { resolveAdmission(taskAdmissionId: string): Promise<TaskAdmissionSnapshot | undefined>; }

export interface KoggTasksService {
  list(projectId?: string): Promise<readonly TaskSummary[]>;
  get(taskId: string): Promise<TaskProjection>;
  create(input: { readonly requestId: string; readonly projectId: string; readonly repositoryId: string; readonly content: string }): Promise<TaskMutationResult>;
  edit(input: MutationPrecondition & { readonly taskId: string; readonly content: string }): Promise<TaskMutationResult>;
  createSuccessorDraft(input: MutationPrecondition & { readonly taskId: string }): Promise<TaskMutationResult>;
  freeze(input: MutationPrecondition & { readonly taskId: string }): Promise<TaskMutationResult>;
  beginApprovalReview(input: { readonly requestId: string; readonly taskId: string; readonly sessionId: string }): Promise<ReviewProjection>;
  approve(input: MutationPrecondition & { readonly taskId: string; readonly sessionId: string; readonly challenge: string }): Promise<TaskMutationResult>;
  revoke(input: MutationPrecondition & { readonly taskId: string }): Promise<TaskMutationResult>;
  archive(input: MutationPrecondition & { readonly taskId: string }): Promise<TaskMutationResult>;
  authorizeAdmission(input: MutationPrecondition & { readonly taskId: string; readonly runId: string }): Promise<TaskMutationResult & { readonly admission?: TaskAdmissionSnapshot }>;
}
