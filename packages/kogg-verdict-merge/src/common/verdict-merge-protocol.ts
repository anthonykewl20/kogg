// observability-exempt: Pure verdict and merge RPC declarations have no operational behavior.
// diagnostic-exempt: Pure declarations are covered by the verdict and merge runtime contributors.
export const KoggVerdictMergeServicePath = '/services/kogg-verdict-merge';
export type VerdictMergeSafeCode = 'VERDICT_OK' | 'VERDICT_FAIL' | 'VERDICT_BLOCKED' | 'VERDICT_STALE' | 'VERDICT_UNKNOWN'
  | 'RANEX_PROVENANCE_INVALID' | 'JOURNAL_INVALID' | 'BINDING_MISMATCH' | 'IDENTITY_SEPARATION_INVALID'
  | 'AUTHORIZATION_REQUIRED' | 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_REPLAY' | 'REQUEST_CONFLICT'
  | 'STORE_INTEGRITY_FAILED' | 'PROTOCOL_INVALID' | 'INTERNAL_FAILURE';
export interface VerdictQueryV1 {
  readonly queryId: string; readonly requestId: string; readonly taskId: string; readonly taskRevisionId: string;
  readonly approvalDigest: string; readonly projectId: string; readonly repositoryId: string; readonly repositoryIdentityDigest: string;
  readonly destinationRef: string; readonly expectedBaseOid: string; readonly subjectOid: string; readonly subjectTreeOid: string;
  readonly evidenceSetDigest: string; readonly gateCatalogDigest: string; readonly ranexArtifactDigest: string;
  readonly ranexProtocolVersion: '2'; readonly ranexJournalRoot: string; readonly ranexJournalSeq: string;
}
export type VerdictExplanationResultV1 = { readonly kind: 'refused' | 'failed'; readonly safeCode: VerdictMergeSafeCode };
export interface KoggVerdictMergeService { explain(input: unknown): Promise<VerdictExplanationResultV1>; }
