import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserAuthContribution } from '@kogg/core/lib/node/browser-auth-contribution';
import express from '@theia/core/shared/express';
import type { VerdictQueryV1 } from '../common/verdict-merge-protocol';
import { verdictMergeDigest } from '../common/verdict-merge-canonical';
import { MergeAuthorizationAuthority } from './merge-authorization-authority';
import { MergeAuthorizationHttpController } from './merge-authorization-http-controller';
import { MergeAuthorizationRegistry } from './merge-authorization-registry';
import { VerdictMergeService } from './verdict-merge-service';
import { VerdictProjectionAuthority, type UnsealedVerdictExplanationV1 } from './verdict-projection-authority';

// diagnostic-coverage: merge.authorization
test('admits human merge authority only through authenticated same-origin CSRF-protected HTTP', { timeout: 20_000 }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-merge-http-')); const prior = { runtime: process.env.KOGG_RUNTIME, token: process.env.KOGG_AUTH_TOKEN, state: process.env.KOGG_STATE_DIR, origin: process.env.KOGG_PUBLIC_ORIGIN };
  process.env.KOGG_RUNTIME = 'browser'; process.env.KOGG_AUTH_TOKEN = 'merge-http-token'; process.env.KOGG_STATE_DIR = root; delete process.env.KOGG_PUBLIC_ORIGIN;
  const verdicts = new VerdictMergeService(new PassingAuthority(), path.join(root, 'verdict.sqlite3')); const authority = new MergeAuthorizationAuthority(); const registry = new MergeAuthorizationRegistry(verdicts, authority, path.join(root, 'authorization.sqlite3'), () => new Date('2026-08-27T00:00:10.000Z'));
  const browserAuth = new BrowserAuthContribution(); const controller = new MergeAuthorizationHttpController(browserAuth, authority, registry); const app = express(); browserAuth.configure(app); controller.configure(app); const server = createServer(app);
  context.after(async () => { await close(server); registry.onStop(); verdicts.onStop(); restore('KOGG_RUNTIME', prior.runtime); restore('KOGG_AUTH_TOKEN', prior.token); restore('KOGG_STATE_DIR', prior.state); restore('KOGG_PUBLIC_ORIGIN', prior.origin); await rm(root, { recursive: true, force: true }); });
  await verdicts.onStart(); await registry.onStart(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const explained = await verdicts.explain(query()); if (explained.kind !== 'completed') throw new Error('expected explanation');
  const login = await fetch(`${base}/kogg/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=merge-http-token' }); const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]; assert(cookie);
  const csrfResponse = await fetch(`${base}/kogg/auth/csrf`, { headers: { cookie } }); const csrf = String((await csrfResponse.json() as { csrfToken?: unknown }).csrfToken ?? ''); assert(csrf);
  const challengeBody = { requestId: '60000000-0000-4000-8000-000000000001', explanationId: explained.explanation.explanationId };
  assert.equal((await mutation(`${base}/kogg/merge/authorization/challenge`, challengeBody, cookie, base, 'wrong')).status, 403);
  assert.equal((await fetch(`${base}/kogg/merge/authorization/challenge`, { method: 'POST', headers: { authorization: 'Bearer merge-http-token', origin: base, 'x-kogg-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify(challengeBody) })).status, 401);
  const challengeResponse = await mutation(`${base}/kogg/merge/authorization/challenge`, challengeBody, cookie, base, csrf); assert.equal(challengeResponse.status, 200); const challengeResult = await challengeResponse.json() as { kind?: string; challenge?: { challengeId?: string; challengeDigest?: string } }; assert.equal(challengeResult.kind, 'created'); assert(challengeResult.challenge?.challengeId); assert(challengeResult.challenge.challengeDigest);
  const authorizeBody = { requestId: '60000000-0000-4000-8000-000000000002', challengeId: challengeResult.challenge.challengeId, displayedChallengeDigest: challengeResult.challenge.challengeDigest, explicitHumanGesture: true };
  const authorized = await mutation(`${base}/kogg/merge/authorization/authorize`, authorizeBody, cookie, base, csrf); assert.equal(authorized.status, 200); assert.equal((await authorized.json() as { kind?: string }).kind, 'authorized');
});

async function mutation(url: string, body: unknown, cookie: string, origin: string, csrf: string): Promise<Response> { return fetch(url, { method: 'POST', headers: { cookie, origin, 'x-kogg-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
async function close(server: Server): Promise<void> { if (!server.listening) return; const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server.closeIdleConnections(); server.closeAllConnections(); await closed; }
function restore(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
class PassingAuthority extends VerdictProjectionAuthority { override async explain(value: VerdictQueryV1, queryDigest: string): Promise<UnsealedVerdictExplanationV1> { return { explanationId:'20000000-0000-4000-8000-000000000001',queryDigest,ranexDecision:'pass',currentness:'current',currentnessCode:'VERDICT_OK',gateRows:[{gateId:'tests',gateVersion:'1',required:true,result:'pass',safeReasonCode:'CHECK_PASS',producerRoleDigest:'4'.repeat(64),verifierRoleDigest:'5'.repeat(64),evidenceDigest:'6'.repeat(64),subjectDigest:verdictMergeDigest('query', { oid:value.subjectOid }),journalSeq:value.ranexJournalSeq}],requiredCount:1,passCount:1,failCount:0,blockedCount:0,verifiedAt:'2026-08-27T00:00:00.000Z',expiresAt:'2026-08-27T00:01:00.000Z',ranexProvenanceDigest:'7'.repeat(64),journalRoot:value.ranexJournalRoot,journalSeq:value.ranexJournalSeq }; } }
function query(): VerdictQueryV1 { return { queryId:'10000000-0000-4000-8000-000000000001',requestId:'10000000-0000-4000-8000-000000000002',taskId:'10000000-0000-4000-8000-000000000003',taskRevisionId:'10000000-0000-4000-8000-000000000004',approvalDigest:'a'.repeat(64),projectId:'10000000-0000-4000-8000-000000000005',repositoryId:'10000000-0000-4000-8000-000000000006',repositoryIdentityDigest:'b'.repeat(64),destinationRef:'refs/heads/main',expectedBaseOid:'c'.repeat(40),subjectOid:'d'.repeat(40),subjectTreeOid:'e'.repeat(40),evidenceSetDigest:'f'.repeat(64),gateCatalogDigest:'1'.repeat(64),ranexArtifactDigest:'2'.repeat(64),ranexProtocolVersion:'2',ranexJournalRoot:'3'.repeat(64),ranexJournalSeq:'1' }; }
