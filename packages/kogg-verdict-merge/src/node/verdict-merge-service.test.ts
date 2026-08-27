import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { VerdictQueryV1 } from '../common/verdict-merge-protocol';
import { verdictMergeDigest } from '../common/verdict-merge-canonical';
import { VerdictMergeDiagnosticContributor, VERDICT_MERGE_CHECKS } from './verdict-merge-diagnostic-contributor';
import { VerdictMergeService } from './verdict-merge-service';
import { KernelVerdictProjectionAuthority, VerdictProjectionAuthority, type UnsealedVerdictExplanationV1 } from './verdict-projection-authority';
import type { KernelBridge, KernelResultV2, VerdictReadProjectionV1 } from '@kogg/contracts';
import type { KernelVerdictReadService } from '@kogg/kernel/lib/node/kernel-verdict-read-service';
import type { TaskAdmissionAuthority, TaskAdmissionSnapshot, TaskKernelBindingAuthority } from '@kogg/tasks/lib/common/tasks-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';
import type { ModeOperationAuthorizer } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';

const MODE_AUTHORITY = { authorizeOperation: async () => ({ allowed: true, safeCode: 'MODE_OK' }) } as unknown as ModeOperationAuthorizer;

// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation, merge.authorization, merge.preflight, merge.processes, merge.atomicity, merge.recovery, merge.source-maps
test('refuses and durably replays a valid exact query when the Ranex projection owner is unavailable', async () => {
  await withService(new VerdictProjectionAuthority(), async service => { const result = await service.explain(query()); assert.deepEqual(result, { kind: 'refused', safeCode: 'VERDICT_UNKNOWN' }); assert.deepEqual(await service.explain(query()), result); const conflict = await service.explain({ ...query(), subjectOid: '9'.repeat(40) }); assert.equal(conflict.safeCode, 'REQUEST_CONFLICT'); const diagnostics = await new VerdictMergeDiagnosticContributor(service).diagnose(); assert.deepEqual(diagnostics.map(check => check.id), [...VERDICT_MERGE_CHECKS]); assert.equal(diagnostics.find(check => check.id === 'verdict.provenance')?.status, 'fail'); assert.equal(diagnostics.find(check => check.id === 'merge.processes')?.status, 'pass'); });
});
test('stores one immutable closed explanation, replays it exactly, and verifies it across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-verdict-store-')); const database = path.join(root, 'registry.sqlite3');
  try { const service = new VerdictMergeService(new PassingAuthority(), MODE_AUTHORITY, database); await service.onStart(); const first = await service.explain(query()); assert.equal(first.kind, 'completed'); if (first.kind !== 'completed') throw new Error('Expected completed explanation'); assert.equal(first.safeCode, 'VERDICT_OK'); assert.equal(first.replay, false); assert.match(first.explanation.explanationDigest, /^[0-9a-f]{64}$/u); const replay = await service.explain(query()); assert.equal(replay.kind, 'completed'); if (replay.kind === 'completed') assert.equal(replay.replay, true); const candidates = await service.mergeCandidates(); assert.equal(candidates.length, 1); assert.equal(candidates[0]?.destinationRef, 'refs/heads/main'); assert.equal(candidates[0]?.ranexDecision, 'pass'); assert.equal(service.diagnostics().explanationCount, 1); service.onStop(); const restarted = new VerdictMergeService(new VerdictProjectionAuthority(), MODE_AUTHORITY, database); await restarted.onStart(); assert.equal(restarted.diagnostics().integrity, true); assert.equal(restarted.diagnostics().explanationCount, 1); restarted.onStop(); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('publishes an honest unknown verdict through a stable owner and replays it exactly across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-verdict-owner-')); const database = path.join(root, 'registry.sqlite3'); const projection = new OperationsReadModel(path.join(root, 'operations.sqlite3'));
  try {
    projection.start(); projection.registerOwner('verdict'); const service = new VerdictMergeService(new VerdictProjectionAuthority(), MODE_AUTHORITY, database); service.setOwnerSink(projection); await service.onStart();
    assert.deepEqual(await service.explain(query()), { kind: 'refused', safeCode: 'VERDICT_UNKNOWN' }); assert.equal(projection.diagnostics().acceptedEventCount, 1); assert.equal(projection.diagnostics().ownerCount, 1);
    const source = new DatabaseSync(database); const identityBefore = source.prepare('SELECT owner_id,owner_epoch_id FROM verdict_owner_meta').get(); const event = source.prepare('SELECT event_kind,safe_code,task_id,project_id FROM verdict_owner_events').get() as Record<string, unknown>; assert.deepEqual({ ...event }, { event_kind: 'verdict.unknown', safe_code: 'VERDICT_UNKNOWN', task_id: query().taskId, project_id: query().projectId }); assert.equal(JSON.stringify(event).includes(query().destinationRef), false); assert.equal(JSON.stringify(event).includes(query().subjectOid), false); source.close(); service.onStop();
    const restarted = new VerdictMergeService(new VerdictProjectionAuthority(), MODE_AUTHORITY, database); restarted.setOwnerSink(projection); await restarted.onStart(); assert.equal(projection.diagnostics().acceptedEventCount, 1); const reopened = new DatabaseSync(database); assert.deepEqual(reopened.prepare('SELECT owner_id,owner_epoch_id FROM verdict_owner_meta').get(), identityBefore); reopened.close(); restarted.onStop(); projection.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('refuses startup after an immutable verdict owner source fact is altered', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-verdict-owner-corrupt-')); const database = path.join(root, 'registry.sqlite3');
  try { const service = new VerdictMergeService(new VerdictProjectionAuthority(), MODE_AUTHORITY, database); await service.onStart(); await service.explain(query()); service.onStop(); const corrupt = new DatabaseSync(database); corrupt.exec('DROP TRIGGER verdict_owner_events_update'); corrupt.prepare("UPDATE verdict_owner_events SET safe_code='VERDICT_OK'").run(); corrupt.close(); await assert.rejects(new VerdictMergeService(new VerdictProjectionAuthority(), MODE_AUTHORITY, database).onStart(), /STORE_INTEGRITY_FAILED/u); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('refuses startup after immutable explanation corruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-verdict-corrupt-')); const database = path.join(root, 'registry.sqlite3');
  try { const service = new VerdictMergeService(new PassingAuthority(), MODE_AUTHORITY, database); await service.onStart(); await service.explain(query()); service.onStop(); const corrupt = new DatabaseSync(database); corrupt.exec('DROP TRIGGER verdict_explanations_update'); corrupt.prepare('UPDATE explanations SET explanation_digest=?').run('f'.repeat(64)); corrupt.close(); await assert.rejects(new VerdictMergeService(new VerdictProjectionAuthority(), MODE_AUTHORITY, database).onStart(), /STORE_INTEGRITY_FAILED/u); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('refuses startup after immutable request-result corruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-verdict-result-corrupt-')); const database = path.join(root, 'registry.sqlite3');
  try { const service = new VerdictMergeService(new PassingAuthority(), MODE_AUTHORITY, database); await service.onStart(); await service.explain(query()); service.onStop(); const corrupt = new DatabaseSync(database); corrupt.exec('DROP TRIGGER verdict_requests_update'); corrupt.prepare('UPDATE requests SET result_json=?').run(JSON.stringify({ kind: 'completed', safeCode: 'VERDICT_OK', explanation: {}, replay: false })); corrupt.close(); await assert.rejects(new VerdictMergeService(new VerdictProjectionAuthority(), MODE_AUTHORITY, database).onStart(), /STORE_INTEGRITY_FAILED/u); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('migrates the pre-query-record schema and refuses unverifiable legacy requests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-verdict-legacy-')); const database = path.join(root, 'registry.sqlite3');
  try { const legacy = new DatabaseSync(database); legacy.exec("CREATE TABLE requests(request_id TEXT PRIMARY KEY,query_digest TEXT NOT NULL,result_json TEXT NOT NULL); CREATE TABLE explanations(explanation_id TEXT PRIMARY KEY,query_digest TEXT NOT NULL UNIQUE,explanation_digest TEXT NOT NULL UNIQUE,explanation_json TEXT NOT NULL,created_at TEXT NOT NULL); INSERT INTO requests VALUES('10000000-0000-4000-8000-000000000002','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{\"kind\":\"refused\",\"safeCode\":\"VERDICT_UNKNOWN\"}')"); legacy.close(); await assert.rejects(new VerdictMergeService(new VerdictProjectionAuthority(), MODE_AUTHORITY, database).onStart(), /STORE_INTEGRITY_FAILED/u); const inspected = new DatabaseSync(database); assert.equal((inspected.prepare('PRAGMA table_info(requests)').all() as RowForTest[]).some(row => row.name === 'query_json'), true); inspected.close(); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('rejects inconsistent or open authority projections without persisting an explanation', async () => {
  class InvalidAuthority extends PassingAuthority { override async explain(value: VerdictQueryV1, digest: string): Promise<UnsealedVerdictExplanationV1> { return { ...await super.explain(value, digest), ranexDecision: 'fail', extra: true } as UnsealedVerdictExplanationV1; } }
  await withService(new InvalidAuthority(), async service => { const result = await service.explain(query()); assert.equal(result.safeCode, 'PROTOCOL_INVALID'); assert.equal(service.diagnostics().explanationCount, 0); });
});
test('rejects an empty gate set instead of deriving a synthetic PASS', async () => {
  class EmptyAuthority extends PassingAuthority { override async explain(value: VerdictQueryV1, digest: string): Promise<UnsealedVerdictExplanationV1> { return { ...await super.explain(value, digest), gateRows: [], requiredCount: 0, passCount: 0 }; } }
  await withService(new EmptyAuthority(), async service => { const result = await service.explain(query()); assert.equal(result.safeCode, 'PROTOCOL_INVALID'); assert.equal(service.diagnostics().explanationCount, 0); });
});
test('maps one exact production kernel verdict into a nonempty safe explanation', async () => {
  const value = query(); const admission = fixtureAdmission(value);
  const admissions = { resolveAdmission: async () => admission } as TaskAdmissionAuthority;
  const bindings = { resolveAdmission: async () => ({
    taskId:value.taskId,taskRevision:1,specificationDigest:`sha256:${'9'.repeat(64)}`,approvalId:admission.approvalId,approvalDigest:`sha256:${value.approvalDigest}`,
    approvalCreatedAt:'2026-08-27T00:00:00.000Z',projectId:value.projectId,repositoryId:value.repositoryId,bindingRevision:1,runId:admission.runId,
    authorizedAt:admission.authorizedAt,expiresAt:'2099-08-27T00:00:00.000Z',executionProfileId:'restricted',rootUri:'file:///fixture',repositoryIdentityDigest:value.repositoryIdentityDigest
  }) } as TaskKernelBindingAuthority;
  const kernel = { capabilities: async () => ({ adapterArtifactDigest:`sha256:${value.ranexArtifactDigest}`,protocolVersion:2 }) } as unknown as KernelBridge;
  const projection: VerdictReadProjectionV1 = {
    verdictId:value.verdictId,verdictDigest:`sha256:${value.verdictDigest}`,historicalDecision:'pass',currentness:'current',currentDecision:'pass',
    evidenceSetDigest:`sha256:${value.evidenceSetDigest}`,gateCatalogDigest:`sha256:${value.gateCatalogDigest}`,authorityDigest:`sha256:${value.verifierAuthorityDigest}`,
    ranexProvenanceDigest:`sha256:${value.ranexProvenanceDigest}`,journalRootDigest:`sha256:${value.ranexJournalRoot}`,journalSequence:Number(value.ranexJournalSeq),evaluatedAt:'2026-08-27T00:00:00.000Z',
    subjectState:{objectFormat:'sha1',commitObjectId:value.subjectOid,treeObjectId:value.subjectTreeOid,gitCommonDirectoryIdentity:`sha256:${'1'.repeat(64)}`,worktreeIdentity:`sha256:${'2'.repeat(64)}`,indexDigest:`sha256:${'3'.repeat(64)}`,trackedContentDigest:`sha256:${'4'.repeat(64)}`,untrackedPolicyDigest:`sha256:${'5'.repeat(64)}`,isClean:true},
    gateRows:[{claimType:'tests.unit',checkDefinitionDigest:`sha256:${'6'.repeat(64)}`,requiredOutcome:'pass',result:'pass',evidenceDigest:`sha256:${'7'.repeat(64)}`,producerBindingDigest:`sha256:${'8'.repeat(64)}`}]
  };
  const result: KernelResultV2<VerdictReadProjectionV1> = {protocol:'kogg.ranex/v2',requestId:value.requestId,operationId:value.queryId,status:'succeeded',safeCode:'KERNEL_OK',resultDigest:`sha256:${'a'.repeat(64)}`,journal:null,projection};
  const verdicts = { read: async () => result } as unknown as KernelVerdictReadService;
  await withService(new KernelVerdictProjectionAuthority(admissions, bindings, kernel, verdicts), async service => {
    const explained = await service.explain(value); assert.equal(explained.kind, 'completed'); assert.equal(explained.safeCode, 'VERDICT_OK');
    if (explained.kind === 'completed') { assert.equal(explained.explanation.gateRows.length, 1); assert.equal(explained.explanation.gateRows[0]?.gateId, 'tests.unit'); }
  });
});
test('rejects unknown fields, unsafe refs, malformed object ids, and open protocol versions before authority access', async () => { await withService(new VerdictProjectionAuthority(), async service => { assert.equal((await service.explain({ ...query(), extra: true })).safeCode, 'PROTOCOL_INVALID'); assert.equal((await service.explain({ ...query(), destinationRef: 'refs/heads/../main' })).safeCode, 'PROTOCOL_INVALID'); assert.equal((await service.explain({ ...query(), subjectOid: 'a'.repeat(39) })).safeCode, 'PROTOCOL_INVALID'); assert.equal((await service.explain({ ...query(), ranexProtocolVersion: '3' })).safeCode, 'PROTOCOL_INVALID'); }); });

test('refuses current-verdict observation at the mode boundary before Ranex authority access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-verdict-mode-refusal-')); let authorityCalls = 0;
  class CountingAuthority extends PassingAuthority { override async explain(value: VerdictQueryV1, digest: string): Promise<UnsealedVerdictExplanationV1> { authorityCalls++; return super.explain(value, digest); } }
  const modes = { authorizeOperation: async () => ({ allowed: false, safeCode: 'BUILD_VERDICT_REFUSED' }) } as unknown as ModeOperationAuthorizer;
  const service = new VerdictMergeService(new CountingAuthority(), modes, path.join(root, 'registry.sqlite3'));
  try {
    await service.onStart(); assert.deepEqual(await service.explain(query()), { kind: 'refused', safeCode: 'BUILD_VERDICT_REFUSED' });
    assert.equal(authorityCalls, 0); assert.equal(service.diagnostics().explanationCount, 0);
  } finally { service.onStop(); await rm(root, { recursive: true, force: true }); }
});

class PassingAuthority extends VerdictProjectionAuthority { override async explain(value: VerdictQueryV1, queryDigest: string): Promise<UnsealedVerdictExplanationV1> { return { explanationId:'20000000-0000-4000-8000-000000000001',queryDigest,ranexDecision:'pass',currentness:'current',currentnessCode:'VERDICT_OK',gateRows:[{gateId:'tests',gateVersion:'1',required:true,result:'pass',safeReasonCode:'CHECK_PASS',producerRoleDigest:'4'.repeat(64),verifierRoleDigest:'5'.repeat(64),evidenceDigest:'6'.repeat(64),subjectDigest:verdictMergeDigest('query', { oid:value.subjectOid }),journalSeq:value.ranexJournalSeq}],requiredCount:1,passCount:1,failCount:0,blockedCount:0,verifiedAt:'2026-08-27T00:00:00.000Z',expiresAt:'2026-08-27T00:01:00.000Z',ranexProvenanceDigest:'7'.repeat(64),journalRoot:value.ranexJournalRoot,journalSeq:value.ranexJournalSeq }; } }
async function withService(authority: VerdictProjectionAuthority, action: (service: VerdictMergeService) => Promise<void>): Promise<void> { const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-verdict-test-')); const service = new VerdictMergeService(authority, MODE_AUTHORITY, path.join(root,'registry.sqlite3')); try { await service.onStart(); await action(service); } finally { service.onStop(); await rm(root,{recursive:true,force:true}); } }
function query(): VerdictQueryV1 { return { queryId:'10000000-0000-4000-8000-000000000001',requestId:'10000000-0000-4000-8000-000000000002',taskId:'10000000-0000-4000-8000-000000000003',taskRevisionId:'10000000-0000-4000-8000-000000000004',taskAdmissionId:'10000000-0000-4000-8000-000000000007',approvalDigest:'a'.repeat(64),projectId:'10000000-0000-4000-8000-000000000005',repositoryId:'10000000-0000-4000-8000-000000000006',repositoryIdentityDigest:'b'.repeat(64),destinationRef:'refs/heads/main',expectedBaseOid:'c'.repeat(40),subjectOid:'d'.repeat(40),subjectTreeOid:'e'.repeat(40),evidenceSetDigest:'f'.repeat(64),gateCatalogDigest:'1'.repeat(64),ranexArtifactDigest:'2'.repeat(64),verdictId:'10000000-0000-4000-8000-000000000008',verdictDigest:'4'.repeat(64),taskBindingDigest:'5'.repeat(64),subjectStateDigest:'6'.repeat(64),verifierAuthorityDigest:'7'.repeat(64),ranexProvenanceDigest:'8'.repeat(64),ranexProtocolVersion:'2',ranexJournalRoot:'3'.repeat(64),ranexJournalSeq:'1' }; }
interface RowForTest { name?: unknown; }
function fixtureAdmission(value: VerdictQueryV1): TaskAdmissionSnapshot { return {taskAdmissionId:value.taskAdmissionId,taskId:value.taskId,specificationId:'10000000-0000-4000-8000-000000000009',approvalId:'10000000-0000-4000-8000-000000000010',projectId:value.projectId,repositoryId:value.repositoryId,bindingRevision:'1',registryRevision:'1',taskRevision:'1',runId:'10000000-0000-4000-8000-000000000011',authorizedAt:'2026-08-27T00:00:00.000Z',expiresAt:'2099-08-27T00:00:00.000Z'}; }
