import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { VerdictQueryV1 } from '../common/verdict-merge-protocol';
import { verdictMergeDigest } from '../common/verdict-merge-canonical';
import { MergeAuthorizationAuthority, mergeAuthorizationScopeDigest } from './merge-authorization-authority';
import { MergeAuthorizationRegistry } from './merge-authorization-registry';
import { VerdictMergeService } from './verdict-merge-service';
import { VerdictMergeDiagnosticContributor } from './verdict-merge-diagnostic-contributor';
import { VerdictProjectionAuthority, type UnsealedVerdictExplanationV1 } from './verdict-projection-authority';

// diagnostic-coverage: merge.authorization, merge.recovery
test('creates one short-lived human challenge and records one allow-once authorization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-merge-authorization-')); const now = new Date('2026-08-27T00:00:10.000Z');
  const verdicts = new VerdictMergeService(new PassingAuthority(), path.join(root, 'verdict.sqlite3'));
  const authority = new MergeAuthorizationAuthority(); const registry = new MergeAuthorizationRegistry(verdicts, authority, path.join(root, 'authorization.sqlite3'), () => now);
  try {
    await verdicts.onStart(); await registry.onStart(); const explained = await verdicts.explain(query()); assert.equal(explained.kind, 'completed'); if (explained.kind !== 'completed') throw new Error('expected explanation');
    const challengeRequest = { requestId: '30000000-0000-4000-8000-000000000001', explanationId: explained.explanation.explanationId };
    const challenge = await registry.createChallenge(challengeRequest, authority.mint(actor(), mergeAuthorizationScopeDigest('challenge', challengeRequest)));
    assert.equal(challenge.kind, 'created'); if (challenge.kind !== 'created') throw new Error('expected challenge'); assert.equal(challenge.challenge.expiresAt, '2026-08-27T00:01:00.000Z'); assert.equal(challenge.replay, false);
    const replay = await registry.createChallenge(challengeRequest, authority.mint(actor(), mergeAuthorizationScopeDigest('challenge', challengeRequest))); assert.equal(replay.kind, 'created'); if (replay.kind === 'created') assert.equal(replay.replay, true);
    const authorizationRequest = { requestId: '30000000-0000-4000-8000-000000000002', challengeId: challenge.challenge.challengeId, displayedChallengeDigest: challenge.challenge.challengeDigest, explicitHumanGesture: true as const };
    const authorized = await registry.authorize(authorizationRequest, authority.mint(actor(), mergeAuthorizationScopeDigest('authorize', authorizationRequest)));
    assert.equal(authorized.kind, 'authorized'); if (authorized.kind !== 'authorized') throw new Error('expected authorization'); assert.equal(authorized.authorization.expiresAt, challenge.challenge.expiresAt); assert.equal(authorized.replay, false);
    const authorizedReplay = await registry.authorize(authorizationRequest, authority.mint(actor(), mergeAuthorizationScopeDigest('authorize', authorizationRequest))); assert.equal(authorizedReplay.kind, 'authorized'); if (authorizedReplay.kind === 'authorized') assert.equal(authorizedReplay.replay, true);
    const second = { ...authorizationRequest, requestId: '30000000-0000-4000-8000-000000000003' }; const refused = await registry.authorize(second, authority.mint(actor(), mergeAuthorizationScopeDigest('authorize', second))); assert.equal(refused.safeCode, 'AUTHORIZATION_REPLAY');
    const executeRequest = { requestId: '30000000-0000-4000-8000-000000000004', authorizationId: authorized.authorization.authorizationId };
    const accepted = await registry.createIntent(executeRequest, authority.mint(actor(), mergeAuthorizationScopeDigest('execute', executeRequest)));
    assert.equal(accepted.kind, 'accepted'); if (accepted.kind !== 'accepted') throw new Error('expected merge intent'); assert.equal(accepted.intent.state, 'preflight-pending'); assert.equal(accepted.intent.expectedOldOid, query().expectedBaseOid);
    const executeReplay = await registry.createIntent(executeRequest, authority.mint(actor(), mergeAuthorizationScopeDigest('execute', executeRequest))); assert.equal(executeReplay.kind, 'accepted'); if (executeReplay.kind === 'accepted') assert.equal(executeReplay.replay, true);
    const reused = { ...executeRequest, requestId: '30000000-0000-4000-8000-000000000005' }; assert.equal((await registry.createIntent(reused, authority.mint(actor(), mergeAuthorizationScopeDigest('execute', reused)))).safeCode, 'AUTHORIZATION_REPLAY');
    const diagnostics = registry.diagnostics(); assert.equal(diagnostics.integrity, true); assert.equal(diagnostics.challengeCount, 1); assert.equal(diagnostics.authorizationCount, 1); assert.equal(diagnostics.authorizationReady, true); assert.equal(diagnostics.sourceMapsPresent, true);
    const runtimeChecks = await new VerdictMergeDiagnosticContributor(verdicts, registry).diagnose(); assert.equal(runtimeChecks.find(check => check.id === 'merge.authorization')?.status, 'pass'); assert.equal(runtimeChecks.find(check => check.id === 'merge.recovery')?.status, 'pass'); assert.equal(runtimeChecks.find(check => check.id === 'merge.source-maps')?.status, 'pass');
  } finally { registry.onStop(); verdicts.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('refuses wrong digest, changed session, missing gesture, expiry, and corrupted challenge storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-merge-authorization-refusal-')); let now = new Date('2026-08-27T00:00:10.000Z');
  const verdicts = new VerdictMergeService(new PassingAuthority(), path.join(root, 'verdict.sqlite3')); const authority = new MergeAuthorizationAuthority(); const database = path.join(root, 'authorization.sqlite3'); const registry = new MergeAuthorizationRegistry(verdicts, authority, database, () => now);
  try {
    await verdicts.onStart(); await registry.onStart(); const explained = await verdicts.explain(query()); if (explained.kind !== 'completed') throw new Error('expected explanation');
    const challengeRequest = { requestId: '40000000-0000-4000-8000-000000000001', explanationId: explained.explanation.explanationId }; const challenge = await registry.createChallenge(challengeRequest, authority.mint(actor(), mergeAuthorizationScopeDigest('challenge', challengeRequest))); if (challenge.kind !== 'created') throw new Error('expected challenge');
    const wrong = { requestId: '40000000-0000-4000-8000-000000000002', challengeId: challenge.challenge.challengeId, displayedChallengeDigest: `sha256:${'f'.repeat(64)}`, explicitHumanGesture: true as const }; assert.equal((await registry.authorize(wrong, authority.mint(actor(), mergeAuthorizationScopeDigest('authorize', wrong)))).safeCode, 'AUTHORIZATION_REQUIRED');
    const changedSession = { ...actor(), sessionId: 'different-session' }; const correct = { ...wrong, requestId: '40000000-0000-4000-8000-000000000003', displayedChallengeDigest: challenge.challenge.challengeDigest }; assert.equal((await registry.authorize(correct, authority.mint(changedSession, mergeAuthorizationScopeDigest('authorize', correct)))).safeCode, 'AUTHORIZATION_REQUIRED');
    const missingGesture = { ...correct, requestId: '40000000-0000-4000-8000-000000000004', explicitHumanGesture: false }; assert.equal((await registry.authorize(missingGesture, authority.mint(actor(), mergeAuthorizationScopeDigest('authorize', missingGesture)))).safeCode, 'PROTOCOL_INVALID');
    now = new Date('2026-08-27T00:01:00.001Z'); const expired = { ...correct, requestId: '40000000-0000-4000-8000-000000000005' }; assert.equal((await registry.authorize(expired, authority.mint(actor(), mergeAuthorizationScopeDigest('authorize', expired)))).safeCode, 'AUTHORIZATION_EXPIRED');
    registry.onStop(); const corrupt = new DatabaseSync(database); corrupt.exec('DROP TRIGGER merge_challenges_update'); corrupt.prepare('UPDATE challenges SET task_id=?').run('50000000-0000-4000-8000-000000000001'); corrupt.close(); await assert.rejects(new MergeAuthorizationRegistry(verdicts, authority, database, () => now).onStart(), /STORE_INTEGRITY_FAILED/u);
  } finally { registry.onStop(); verdicts.onStop(); await rm(root, { recursive: true, force: true }); }
});

test('refuses startup after immutable authorization request-result corruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-merge-request-corrupt-')); const now = new Date('2026-08-27T00:00:10.000Z'); const database = path.join(root, 'authorization.sqlite3');
  const verdicts = new VerdictMergeService(new PassingAuthority(), path.join(root, 'verdict.sqlite3')); const authority = new MergeAuthorizationAuthority(); const registry = new MergeAuthorizationRegistry(verdicts, authority, database, () => now);
  try {
    await verdicts.onStart(); await registry.onStart(); const explained = await verdicts.explain(query()); if (explained.kind !== 'completed') throw new Error('expected explanation'); const request = { requestId: '70000000-0000-4000-8000-000000000001', explanationId: explained.explanation.explanationId }; await registry.createChallenge(request, authority.mint(actor(), mergeAuthorizationScopeDigest('challenge', request))); registry.onStop();
    const corrupt = new DatabaseSync(database); corrupt.exec('DROP TRIGGER merge_requests_update'); corrupt.prepare('UPDATE authorization_requests SET result_json=?').run('{}'); corrupt.close(); await assert.rejects(new MergeAuthorizationRegistry(verdicts, authority, database, () => now).onStart(), /STORE_INTEGRITY_FAILED/u);
  } finally { registry.onStop(); verdicts.onStop(); await rm(root, { recursive: true, force: true }); }
});

class PassingAuthority extends VerdictProjectionAuthority { override async explain(value: VerdictQueryV1, queryDigest: string): Promise<UnsealedVerdictExplanationV1> { return { explanationId:'20000000-0000-4000-8000-000000000001',queryDigest,ranexDecision:'pass',currentness:'current',currentnessCode:'VERDICT_OK',gateRows:[{gateId:'tests',gateVersion:'1',required:true,result:'pass',safeReasonCode:'CHECK_PASS',producerRoleDigest:'4'.repeat(64),verifierRoleDigest:'5'.repeat(64),evidenceDigest:'6'.repeat(64),subjectDigest:verdictMergeDigest('query', { oid:value.subjectOid }),journalSeq:value.ranexJournalSeq}],requiredCount:1,passCount:1,failCount:0,blockedCount:0,verifiedAt:'2026-08-27T00:00:00.000Z',expiresAt:'2026-08-27T00:01:00.000Z',ranexProvenanceDigest:'7'.repeat(64),journalRoot:value.ranexJournalRoot,journalSeq:value.ranexJournalSeq }; } }
function actor() { return { sessionId: 'browser-session', actorAuthorityDigest: `sha256:${'8'.repeat(64)}`, role: 'owner' as const, originVerified: true as const, csrfVerified: true as const }; }
function query(): VerdictQueryV1 { return { queryId:'10000000-0000-4000-8000-000000000001',requestId:'10000000-0000-4000-8000-000000000002',taskId:'10000000-0000-4000-8000-000000000003',taskRevisionId:'10000000-0000-4000-8000-000000000004',approvalDigest:'a'.repeat(64),projectId:'10000000-0000-4000-8000-000000000005',repositoryId:'10000000-0000-4000-8000-000000000006',repositoryIdentityDigest:'b'.repeat(64),destinationRef:'refs/heads/main',expectedBaseOid:'c'.repeat(40),subjectOid:'d'.repeat(40),subjectTreeOid:'e'.repeat(40),evidenceSetDigest:'f'.repeat(64),gateCatalogDigest:'1'.repeat(64),ranexArtifactDigest:'2'.repeat(64),ranexProtocolVersion:'2',ranexJournalRoot:'3'.repeat(64),ranexJournalSeq:'1' }; }
