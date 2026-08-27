import assert from 'node:assert/strict';
import test from 'node:test';
import { VerdictMergeDiagnosticContributor, VERDICT_MERGE_CHECKS } from './verdict-merge-diagnostic-contributor';
import { VerdictMergeService } from './verdict-merge-service';

// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation, merge.authorization, merge.preflight, merge.processes, merge.atomicity, merge.recovery, merge.source-maps
test('refuses a valid exact query when the Ranex provenance and currentness owner is unavailable', async () => {
  const service = new VerdictMergeService(); const result = await service.explain(query());
  assert.deepEqual(result, { kind: 'refused', safeCode: 'VERDICT_UNKNOWN' }); const diagnostics = await new VerdictMergeDiagnosticContributor(service).diagnose();
  assert.deepEqual(diagnostics.map(check => check.id), [...VERDICT_MERGE_CHECKS]); assert.equal(diagnostics.find(check => check.id === 'verdict.provenance')?.status, 'fail'); assert.equal(diagnostics.find(check => check.id === 'merge.processes')?.status, 'pass');
});
test('rejects unknown fields, unsafe refs, malformed object ids, and open protocol versions before authority access', async () => {
  const service = new VerdictMergeService();
  assert.equal((await service.explain({ ...query(), extra: true })).safeCode, 'PROTOCOL_INVALID');
  assert.equal((await service.explain({ ...query(), destinationRef: 'refs/heads/../main' })).safeCode, 'PROTOCOL_INVALID');
  assert.equal((await service.explain({ ...query(), subjectOid: 'a'.repeat(39) })).safeCode, 'PROTOCOL_INVALID');
  assert.equal((await service.explain({ ...query(), ranexProtocolVersion: '3' })).safeCode, 'PROTOCOL_INVALID');
});
function query() { return { queryId:'10000000-0000-4000-8000-000000000001',requestId:'10000000-0000-4000-8000-000000000002',taskId:'10000000-0000-4000-8000-000000000003',taskRevisionId:'10000000-0000-4000-8000-000000000004',approvalDigest:'a'.repeat(64),projectId:'10000000-0000-4000-8000-000000000005',repositoryId:'10000000-0000-4000-8000-000000000006',repositoryIdentityDigest:'b'.repeat(64),destinationRef:'refs/heads/main',expectedBaseOid:'c'.repeat(40),subjectOid:'d'.repeat(40),subjectTreeOid:'e'.repeat(40),evidenceSetDigest:'f'.repeat(64),gateCatalogDigest:'1'.repeat(64),ranexArtifactDigest:'2'.repeat(64),ranexProtocolVersion:'2',ranexJournalRoot:'3'.repeat(64),ranexJournalSeq:'1' }; }
