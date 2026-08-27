// observability-exempt: Pure verdict and merge RPC declarations have no operational behavior.
// diagnostic-exempt: Pure declarations are covered by the verdict and merge runtime contributors.
export const KoggVerdictMergeServicePath = '/services/kogg-verdict-merge';
export const KoggVerdictMergeServiceToken = Symbol('KoggVerdictMergeService');
export type VerdictMergeSafeCode = 'VERDICT_OK' | 'VERDICT_FAIL' | 'VERDICT_BLOCKED' | 'VERDICT_STALE' | 'VERDICT_UNKNOWN'
  | 'RANEX_PROVENANCE_INVALID' | 'JOURNAL_INVALID' | 'BINDING_MISMATCH' | 'IDENTITY_SEPARATION_INVALID'
  | 'AUTHORIZATION_OK' | 'AUTHORIZATION_REQUIRED' | 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_REPLAY' | 'REQUEST_CONFLICT'
  | 'MERGE_PREFLIGHT_PENDING' | 'MERGE_ALREADY_REQUESTED'
  | 'STORE_INTEGRITY_FAILED' | 'PROTOCOL_INVALID' | 'INTERNAL_FAILURE';
export interface VerdictQueryV1 {
  readonly queryId: string; readonly requestId: string; readonly taskId: string; readonly taskRevisionId: string; readonly taskAdmissionId: string;
  readonly approvalDigest: string; readonly projectId: string; readonly repositoryId: string; readonly repositoryIdentityDigest: string;
  readonly destinationRef: string; readonly expectedBaseOid: string; readonly subjectOid: string; readonly subjectTreeOid: string;
  readonly evidenceSetDigest: string; readonly gateCatalogDigest: string; readonly ranexArtifactDigest: string;
  readonly verdictId: string; readonly verdictDigest: string; readonly taskBindingDigest: string; readonly subjectStateDigest: string;
  readonly verifierAuthorityDigest: string; readonly ranexProvenanceDigest: string;
  readonly ranexProtocolVersion: '2'; readonly ranexJournalRoot: string; readonly ranexJournalSeq: string;
}
export interface GateExplanationV1 { readonly gateId: string; readonly gateVersion: string; readonly required: boolean; readonly result: 'pass' | 'fail' | 'blocked'; readonly safeReasonCode: string; readonly producerRoleDigest: string | null; readonly verifierRoleDigest: string; readonly evidenceDigest: string | null; readonly subjectDigest: string; readonly journalSeq: string; }
export interface VerdictExplanationV1 { readonly explanationId: string; readonly queryDigest: string; readonly ranexDecision: 'pass' | 'fail' | 'blocked'; readonly currentness: 'current' | 'stale' | 'unknown'; readonly currentnessCode: VerdictMergeSafeCode; readonly gateRows: readonly GateExplanationV1[]; readonly requiredCount: number; readonly passCount: number; readonly failCount: number; readonly blockedCount: number; readonly verifiedAt: string; readonly expiresAt: string; readonly ranexProvenanceDigest: string; readonly journalRoot: string; readonly journalSeq: string; readonly explanationDigest: string; }
export type VerdictExplanationResultV1 = { readonly kind: 'completed'; readonly safeCode: 'VERDICT_OK' | 'VERDICT_FAIL' | 'VERDICT_BLOCKED' | 'VERDICT_STALE' | 'VERDICT_UNKNOWN'; readonly explanation: VerdictExplanationV1; readonly replay: boolean } | { readonly kind: 'refused' | 'failed'; readonly safeCode: VerdictMergeSafeCode };
export interface MergeChallengeRequestV1 { readonly requestId: string; readonly explanationId: string; }
export interface MergeAuthorizeRequestV1 { readonly requestId: string; readonly challengeId: string; readonly displayedChallengeDigest: string; readonly explicitHumanGesture: true; }
export interface MergeChallengeProjectionV1 { readonly challengeId: string; readonly explanationDigest: string; readonly taskRevisionId: string; readonly repositoryIdentityDigest: string; readonly destinationRef: string; readonly expectedBaseOid: string; readonly subjectOid: string; readonly subjectTreeOid: string; readonly mergePolicyId: 'local-two-parent-no-ff-v1'; readonly issuedAt: string; readonly expiresAt: string; readonly challengeDigest: string; }
export interface MergeAuthorizationProjectionV1 { readonly authorizationId: string; readonly challengeId: string; readonly explanationDigest: string; readonly exactBindingsDigest: string; readonly state: 'authorized'; readonly recordedAt: string; readonly expiresAt: string; }
export type MergeChallengeResultV1 = { readonly kind: 'created'; readonly safeCode: 'AUTHORIZATION_REQUIRED'; readonly challenge: MergeChallengeProjectionV1; readonly replay: boolean } | { readonly kind: 'refused'; readonly safeCode: VerdictMergeSafeCode };
export type MergeAuthorizationResultV1 = { readonly kind: 'authorized'; readonly safeCode: 'AUTHORIZATION_OK'; readonly authorization: MergeAuthorizationProjectionV1; readonly replay: boolean } | { readonly kind: 'refused'; readonly safeCode: VerdictMergeSafeCode };
export interface MergeExecuteRequestV1 { readonly requestId: string; readonly authorizationId: string; }
export interface MergeIntentProjectionV1 { readonly mergeId: string; readonly authorizationId: string; readonly destinationRef: string; readonly expectedOldOid: string; readonly subjectOid: string; readonly expectedTreeOid: string; readonly mergePolicyId: 'local-two-parent-no-ff-v1'; readonly state: 'preflight-pending'; readonly createdAt: string; }
export type MergeExecuteResultV1 = { readonly kind: 'accepted'; readonly safeCode: 'MERGE_PREFLIGHT_PENDING'; readonly intent: MergeIntentProjectionV1; readonly replay: boolean } | { readonly kind: 'refused'; readonly safeCode: VerdictMergeSafeCode };
export interface MergeCandidateProjectionV1 { readonly explanationId: string; readonly ranexDecision: 'pass' | 'fail' | 'blocked'; readonly currentness: 'current' | 'stale' | 'unknown'; readonly destinationRef: string; readonly expectedBaseOid: string; readonly subjectOid: string; readonly subjectTreeOid: string; readonly mergePolicyId: 'local-two-parent-no-ff-v1'; readonly requiredCount: number; readonly passCount: number; readonly failCount: number; readonly blockedCount: number; readonly expiresAt: string; }
export interface KoggVerdictMergeService { explain(input: unknown): Promise<VerdictExplanationResultV1>; mergeCandidates(): Promise<readonly MergeCandidateProjectionV1[]>; }
