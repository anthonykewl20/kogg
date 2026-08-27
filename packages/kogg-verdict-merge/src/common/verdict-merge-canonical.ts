import type { VerdictQueryV1 } from './verdict-merge-protocol';

// observability-exempt: Pure closed decoding performs no I/O and retains no query content.
// diagnostic-coverage: verdict.bindings, verdict.currentness
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u; const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const KEYS = ['queryId','requestId','taskId','taskRevisionId','approvalDigest','projectId','repositoryId','repositoryIdentityDigest','destinationRef','expectedBaseOid','subjectOid','subjectTreeOid','evidenceSetDigest','gateCatalogDigest','ranexArtifactDigest','ranexProtocolVersion','ranexJournalRoot','ranexJournalSeq'] as const;
export class VerdictMergeProtocolError extends Error { constructor() { super('PROTOCOL_INVALID'); } }
export function decodeVerdictQuery(input: unknown): VerdictQueryV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(); const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== [...KEYS].sort().join(',')) fail();
  for (const key of ['queryId','requestId','taskId','taskRevisionId','projectId','repositoryId'] as const) if (typeof value[key] !== 'string' || !UUID.test(value[key])) fail();
  for (const key of ['approvalDigest','repositoryIdentityDigest','evidenceSetDigest','gateCatalogDigest','ranexArtifactDigest','ranexJournalRoot'] as const) if (typeof value[key] !== 'string' || !DIGEST.test(value[key])) fail();
  for (const key of ['expectedBaseOid','subjectOid','subjectTreeOid'] as const) if (typeof value[key] !== 'string' || !OID.test(value[key])) fail();
  if (typeof value.destinationRef !== 'string' || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value.destinationRef) || value.destinationRef.includes('..') || value.destinationRef.endsWith('/') || value.ranexProtocolVersion !== '2' || typeof value.ranexJournalSeq !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value.ranexJournalSeq)) fail();
  return value as unknown as VerdictQueryV1;
}
function fail(): never { throw new VerdictMergeProtocolError(); }
