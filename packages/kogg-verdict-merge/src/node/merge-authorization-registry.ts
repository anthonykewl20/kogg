import { timingSafeEqual } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { canonicalJson, verdictMergeDigest } from '../common/verdict-merge-canonical';
import type {
  MergeAuthorizationProjectionV1, MergeAuthorizationResultV1, MergeAuthorizeRequestV1,
  MergeChallengeProjectionV1, MergeChallengeRequestV1, MergeChallengeResultV1, VerdictMergeSafeCode
} from '../common/verdict-merge-protocol';
import {
  MergeAuthorizationAuthority, type MergeAuthorizationContextV1, mergeAuthorizationScopeDigest, mergeNonceDigest, mergeOpaqueId
} from './merge-authorization-authority';
import { VerdictMergeService } from './verdict-merge-service';

// Stores only closed challenge/authorization records. Session and actor values are opaque digests and never enter logs.
// diagnostic-coverage: merge.authorization, merge.recovery
type Row = Record<string, SQLOutputValue>;
type Actor = { readonly sessionId: string; readonly actorAuthorityDigest: string; readonly authorizerRoleDigest: string };
type ChallengeRecord = MergeChallengeProjectionV1 & { readonly taskId: string; readonly sessionId: string; readonly authorizerRoleDigest: string; readonly nonceDigest: string; readonly exactBindingsDigest: string };
type AuthorizationRecord = MergeAuthorizationProjectionV1 & { readonly actorAuthorityDigest: string; readonly authorizerRoleDigest: string; readonly sessionId: string; readonly authorizationDigest: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u;

@injectable()
export class MergeAuthorizationRegistry implements BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  constructor(
    @inject(VerdictMergeService) private readonly verdicts: VerdictMergeService,
    @inject(MergeAuthorizationAuthority) private readonly authority: MergeAuthorizationAuthority,
    @unmanaged() private readonly databasePath = path.join(stateRoot(), 'verdict-merge', 'authorization.sqlite3'),
    @unmanaged() private readonly clock: () => Date = () => new Date()
  ) {}

  async onStart(): Promise<void> {
    console.info('[kogg:merge:authorization] recovery.started');
    try {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      this.migrate(); this.assertIntegrity(); if (process.platform !== 'win32') await fs.chmod(this.databasePath, 0o600);
      console.info('[kogg:merge:authorization] recovery.completed', { challengeCount: this.count('challenges'), authorizationCount: this.count('authorizations') });
    } catch (error) {
      this.database?.close(); this.database = undefined;
      console.error('[kogg:merge:authorization] recovery.failed', { safeCode: 'STORE_INTEGRITY_FAILED', errorType: errorName(error) });
      throw new MergeAuthorizationError('STORE_INTEGRITY_FAILED');
    }
  }

  onStop(): void { console.info('[kogg:merge:authorization] shutdown.started'); this.database?.close(); this.database = undefined; console.info('[kogg:merge:authorization] shutdown.completed'); }

  async createChallenge(input: unknown, context: MergeAuthorizationContextV1): Promise<MergeChallengeResultV1> {
    let requestId = 'invalid';
    try {
      const request = decodeChallengeRequest(input); requestId = request.requestId; const scope = mergeAuthorizationScopeDigest('challenge', request);
      const actor = this.requireActor(context, scope); const replay = this.replay<MergeChallengeResultV1>(requestId, scope); if (replay) return replay.kind === 'created' ? { ...replay, replay: true } : replay;
      console.info('[kogg:merge:authorization] challenge.requested', { requestId, explanationId: request.explanationId });
      const now = this.clock(); const binding = await this.verdicts.currentAuthorizationBinding(request.explanationId, now);
      if (!binding) return this.refusedChallenge(requestId, 'VERDICT_UNKNOWN');
      if (binding.explanation.gateRows.some(row => prefixed(row.producerRoleDigest) === actor.authorizerRoleDigest || prefixed(row.verifierRoleDigest) === actor.authorizerRoleDigest)) return this.refusedChallenge(requestId, 'IDENTITY_SEPARATION_INVALID');
      const expiresAt = new Date(Math.min(Date.parse(binding.explanation.expiresAt), now.getTime() + 120_000));
      if (expiresAt.getTime() <= now.getTime()) return this.refusedChallenge(requestId, 'AUTHORIZATION_EXPIRED');
      const exactBindingsDigest = prefixed(verdictMergeDigest('authorization', {
        approvalDigest: binding.query.approvalDigest, destinationRef: binding.query.destinationRef,
        evidenceSetDigest: binding.query.evidenceSetDigest, expectedBaseOid: binding.query.expectedBaseOid,
        explanationDigest: binding.explanation.explanationDigest, gateCatalogDigest: binding.query.gateCatalogDigest,
        mergePolicyId: 'local-two-parent-no-ff-v1', repositoryIdentityDigest: binding.query.repositoryIdentityDigest,
        subjectOid: binding.query.subjectOid, subjectTreeOid: binding.query.subjectTreeOid,
        taskRevisionId: binding.query.taskRevisionId
      }));
      const issuedAt = now.toISOString(); const challengeId = mergeOpaqueId(); const nonceDigest = mergeNonceDigest();
      const body = {
        challengeId, explanationDigest: binding.explanation.explanationDigest, taskRevisionId: binding.query.taskRevisionId,
        repositoryIdentityDigest: binding.query.repositoryIdentityDigest, destinationRef: binding.query.destinationRef,
        expectedBaseOid: binding.query.expectedBaseOid, subjectOid: binding.query.subjectOid, subjectTreeOid: binding.query.subjectTreeOid,
        mergePolicyId: 'local-two-parent-no-ff-v1' as const, authorizerRoleDigest: actor.authorizerRoleDigest,
        sessionId: actor.sessionId, nonceDigest, issuedAt, expiresAt: expiresAt.toISOString(), exactBindingsDigest,
        taskId: binding.query.taskId
      };
      const challengeDigest = prefixed(verdictMergeDigest('challenge', body)); const record: ChallengeRecord = { ...body, challengeDigest };
      const projection = projectChallenge(record); const result: MergeChallengeResultV1 = { kind: 'created', safeCode: 'AUTHORIZATION_REQUIRED', challenge: projection, replay: false };
      this.transaction(() => {
        this.db().prepare('INSERT INTO challenges(challenge_id,task_id,explanation_id,record_json) VALUES(?,?,?,?)').run(challengeId, binding.query.taskId, request.explanationId, canonicalJson(record));
        this.appendEvent(challengeId, 'created', issuedAt); this.storeRequest('challenge', request, scope, result);
      });
      console.info('[kogg:merge:authorization] challenge.created', { requestId, challengeId, safeCode: result.safeCode }); return result;
    } catch (error) {
      // observability-exempt: refusal helpers emit one closed failure with the safe request correlation.
      return this.refusedChallenge(requestId, safeCode(error));
    }
  }

  async authorize(input: unknown, context: MergeAuthorizationContextV1): Promise<MergeAuthorizationResultV1> {
    let requestId = 'invalid'; let challengeId = 'invalid';
    try {
      const request = decodeAuthorizeRequest(input); requestId = request.requestId; challengeId = request.challengeId;
      const scope = mergeAuthorizationScopeDigest('authorize', request); const actor = this.requireActor(context, scope);
      const replay = this.replay<MergeAuthorizationResultV1>(requestId, scope); if (replay) return replay.kind === 'authorized' ? { ...replay, replay: true } : replay;
      console.info('[kogg:merge:authorization] authorization.requested', { requestId, challengeId });
      const row = this.db().prepare('SELECT explanation_id,record_json FROM challenges WHERE challenge_id=?').get(challengeId) as Row | undefined;
      if (!row) return this.refusedAuthorization(requestId, challengeId, 'AUTHORIZATION_REQUIRED');
      const record = decodeChallengeRecord(JSON.parse(text(row, 'record_json')) as unknown); const state = this.challengeState(challengeId);
      if (state !== 'created') return this.refusedAuthorization(requestId, challengeId, 'AUTHORIZATION_REPLAY');
      const now = this.clock(); if (Date.parse(record.expiresAt) <= now.getTime()) { this.appendEvent(challengeId, 'expired', now.toISOString()); return this.refusedAuthorization(requestId, challengeId, 'AUTHORIZATION_EXPIRED'); }
      if (record.sessionId !== actor.sessionId || record.authorizerRoleDigest !== actor.authorizerRoleDigest || !equalDigest(record.challengeDigest, request.displayedChallengeDigest)) return this.refusedAuthorization(requestId, challengeId, 'AUTHORIZATION_REQUIRED');
      const binding = await this.verdicts.currentAuthorizationBinding(text(row, 'explanation_id'), now);
      if (!binding || binding.explanation.explanationDigest !== record.explanationDigest) return this.refusedAuthorization(requestId, challengeId, 'VERDICT_UNKNOWN');
      const authorizationId = mergeOpaqueId(); const recordedAt = now.toISOString(); const expiresAt = new Date(Math.min(Date.parse(record.expiresAt), now.getTime() + 60_000)).toISOString();
      const projection: MergeAuthorizationProjectionV1 = { authorizationId, challengeId, explanationDigest: record.explanationDigest, exactBindingsDigest: record.exactBindingsDigest, state: 'authorized', recordedAt, expiresAt };
      const authorizationBody = { ...projection, actorAuthorityDigest: actor.actorAuthorityDigest, authorizerRoleDigest: actor.authorizerRoleDigest, sessionId: actor.sessionId };
      const authorizationDigest = prefixed(verdictMergeDigest('authorization', authorizationBody)); const authorization: AuthorizationRecord = { ...authorizationBody, authorizationDigest };
      const result: MergeAuthorizationResultV1 = { kind: 'authorized', safeCode: 'AUTHORIZATION_OK', authorization: projection, replay: false };
      this.transaction(() => {
        for (const older of this.openChallenges(record.taskId, challengeId)) this.appendEvent(older, 'revoked', recordedAt);
        this.db().prepare('INSERT INTO authorizations(authorization_id,challenge_id,record_json) VALUES(?,?,?)').run(authorizationId, challengeId, canonicalJson(authorization));
        this.appendEvent(challengeId, 'authorized', recordedAt); this.storeRequest('authorize', request, scope, result);
      });
      console.info('[kogg:merge:authorization] authorization.recorded', { requestId, challengeId, authorizationId, safeCode: result.safeCode }); return result;
    } catch (error) {
      // observability-exempt: refusal helpers emit one closed failure with the safe request correlation.
      return this.refusedAuthorization(requestId, challengeId, safeCode(error));
    }
  }

  diagnostics(): { readonly integrity: boolean; readonly challengeCount: number; readonly authorizationCount: number; readonly authorizationReady: boolean; readonly sourceMapsPresent: boolean } {
    this.assertIntegrity(); const challengeCount = this.count('challenges'); const authorizationCount = this.count('authorizations');
    return { integrity: true, challengeCount, authorizationCount, authorizationReady: true, sourceMapsPresent: existsSync(`${__filename}.map`) && existsSync(path.join(__dirname, 'merge-authorization-authority.js.map')) };
  }

  private requireActor(context: MergeAuthorizationContextV1, scope: string): Actor { const actor = this.authority.verify(context, scope); if (!actor) throw new MergeAuthorizationError('AUTHORIZATION_REQUIRED'); return actor; }
  private replay<T extends MergeChallengeResultV1 | MergeAuthorizationResultV1>(requestId: string, scope: string): T | undefined { const row = this.db().prepare('SELECT scope_digest,result_json FROM authorization_requests WHERE request_id=?').get(requestId) as Row | undefined; if (!row) return undefined; if (text(row, 'scope_digest') !== scope) throw new MergeAuthorizationError('REQUEST_CONFLICT'); return JSON.parse(text(row, 'result_json')) as T; }
  private storeRequest(kind: 'challenge' | 'authorize', request: MergeChallengeRequestV1 | MergeAuthorizeRequestV1, scope: string, result: MergeChallengeResultV1 | MergeAuthorizationResultV1): void { this.db().prepare('INSERT INTO authorization_requests(request_id,request_kind,scope_digest,request_json,result_json) VALUES(?,?,?,?,?)').run(request.requestId, kind, scope, canonicalJson(request), canonicalJson(result)); }
  private refusedChallenge(requestId: string, safeCode: VerdictMergeSafeCode): MergeChallengeResultV1 { console.warn('[kogg:merge:authorization] challenge.refused', { requestId, safeCode }); return { kind: 'refused', safeCode }; }
  private refusedAuthorization(requestId: string, challengeId: string, safeCode: VerdictMergeSafeCode): MergeAuthorizationResultV1 { console.warn('[kogg:merge:authorization] authorization.refused', { requestId, challengeId, safeCode }); return { kind: 'refused', safeCode }; }
  private openChallenges(taskId: string, excluding: string): string[] { return (this.db().prepare("SELECT challenge_id FROM challenges WHERE task_id=? AND challenge_id<>? AND (SELECT state FROM challenge_events WHERE challenge_events.challenge_id=challenges.challenge_id ORDER BY sequence DESC LIMIT 1)='created'").all(taskId, excluding) as Row[]).map(row => text(row, 'challenge_id')); }
  private challengeState(challengeId: string): string { const row = this.db().prepare('SELECT state FROM challenge_events WHERE challenge_id=? ORDER BY sequence DESC LIMIT 1').get(challengeId) as Row | undefined; return row ? text(row, 'state') : 'missing'; }
  private appendEvent(challengeId: string, state: 'created' | 'authorized' | 'expired' | 'revoked', recordedAt: string): void { const prior = this.db().prepare('SELECT event_digest FROM challenge_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousEventDigest = prior ? text(prior, 'event_digest') : prefixed('0'.repeat(64)); const body = { challengeId, previousEventDigest, recordedAt, state }; const eventDigest = prefixed(verdictMergeDigest('authorization', body)); this.db().prepare('INSERT INTO challenge_events(challenge_id,state,recorded_at,previous_event_digest,event_digest) VALUES(?,?,?,?,?)').run(challengeId, state, recordedAt, previousEventDigest, eventDigest); }
  private migrate(): void { this.db().exec(`CREATE TABLE IF NOT EXISTS challenges(challenge_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,explanation_id TEXT NOT NULL,record_json TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS challenge_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,challenge_id TEXT NOT NULL REFERENCES challenges(challenge_id),state TEXT NOT NULL CHECK(state IN('created','authorized','expired','revoked')),recorded_at TEXT NOT NULL,previous_event_digest TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE) STRICT; CREATE TABLE IF NOT EXISTS authorizations(authorization_id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(challenge_id),record_json TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS authorization_requests(request_id TEXT PRIMARY KEY,request_kind TEXT NOT NULL CHECK(request_kind IN('challenge','authorize')),scope_digest TEXT NOT NULL,request_json TEXT NOT NULL,result_json TEXT NOT NULL) STRICT; CREATE TRIGGER IF NOT EXISTS merge_challenges_update BEFORE UPDATE ON challenges BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_challenges_delete BEFORE DELETE ON challenges BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_events_update BEFORE UPDATE ON challenge_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_events_delete BEFORE DELETE ON challenge_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_authorizations_update BEFORE UPDATE ON authorizations BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_authorizations_delete BEFORE DELETE ON authorizations BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_requests_update BEFORE UPDATE ON authorization_requests BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_requests_delete BEFORE DELETE ON authorization_requests BEGIN SELECT RAISE(ABORT,'immutable'); END;`); }
  private assertIntegrity(): void { try { this.verifyIntegrity(); } catch { /* observability-exempt: startup and diagnostic callers log or project the closed integrity failure. */ throw new MergeAuthorizationError('STORE_INTEGRITY_FAILED'); } }
  private verifyIntegrity(): void {
    if (text(this.db().prepare('PRAGMA quick_check').get() as Row, 'quick_check') !== 'ok' || this.countTriggers() !== 8) throw new Error('integrity');
    let previous = prefixed('0'.repeat(64));
    for (const row of this.db().prepare('SELECT * FROM challenge_events ORDER BY sequence').all() as Row[]) { const body = { challengeId: text(row, 'challenge_id'), previousEventDigest: text(row, 'previous_event_digest'), recordedAt: text(row, 'recorded_at'), state: text(row, 'state') }; if (body.previousEventDigest !== previous || prefixed(verdictMergeDigest('authorization', body)) !== text(row, 'event_digest')) throw new Error('event-chain'); previous = text(row, 'event_digest'); }
    for (const row of this.db().prepare('SELECT * FROM challenges').all() as Row[]) { const record = decodeChallengeRecord(JSON.parse(text(row, 'record_json')) as unknown); const { challengeDigest, ...body } = record; if (record.challengeId !== text(row, 'challenge_id') || record.taskId !== text(row, 'task_id') || prefixed(verdictMergeDigest('challenge', body)) !== challengeDigest) throw new Error('challenge'); }
    for (const row of this.db().prepare('SELECT * FROM authorizations').all() as Row[]) { const record = decodeAuthorizationRecord(JSON.parse(text(row, 'record_json')) as unknown); const { authorizationDigest, ...body } = record; if (record.authorizationId !== text(row, 'authorization_id') || record.challengeId !== text(row, 'challenge_id') || prefixed(verdictMergeDigest('authorization', body)) !== authorizationDigest) throw new Error('authorization'); }
    for (const row of this.db().prepare('SELECT * FROM authorization_requests').all() as Row[]) {
      const kind = text(row, 'request_kind'); const request = kind === 'challenge' ? decodeChallengeRequest(JSON.parse(text(row, 'request_json')) as unknown) : decodeAuthorizeRequest(JSON.parse(text(row, 'request_json')) as unknown);
      const scope = kind === 'challenge' ? mergeAuthorizationScopeDigest('challenge', request) : mergeAuthorizationScopeDigest('authorize', request);
      if (request.requestId !== text(row, 'request_id') || scope !== text(row, 'scope_digest')) throw new Error('request');
      const result = JSON.parse(text(row, 'result_json')) as MergeChallengeResultV1 | MergeAuthorizationResultV1;
      if (kind === 'challenge') { if (result.kind !== 'created') throw new Error('challenge-result'); const challenge = decodeChallengeProjection(result.challenge); const stored = this.db().prepare('SELECT record_json FROM challenges WHERE challenge_id=?').get(challenge.challengeId) as Row | undefined; if (!stored || canonicalJson(projectChallenge(decodeChallengeRecord(JSON.parse(text(stored, 'record_json')) as unknown))) !== canonicalJson(challenge) || result.replay !== false || result.safeCode !== 'AUTHORIZATION_REQUIRED') throw new Error('challenge-result'); }
      else { if (result.kind !== 'authorized') throw new Error('authorization-result'); const authorization = decodeAuthorizationProjection(result.authorization); const stored = this.db().prepare('SELECT record_json FROM authorizations WHERE authorization_id=?').get(authorization.authorizationId) as Row | undefined; if (!stored || canonicalJson(projectAuthorization(decodeAuthorizationRecord(JSON.parse(text(stored, 'record_json')) as unknown))) !== canonicalJson(authorization) || result.replay !== false || result.safeCode !== 'AUTHORIZATION_OK') throw new Error('authorization-result'); }
    }
  }
  private transaction(action: () => void): void { this.db().exec('BEGIN IMMEDIATE'); try { action(); this.db().exec('COMMIT'); } catch (error) { try { this.db().exec('ROLLBACK'); } catch { /* observability-exempt: original transaction refusal remains authoritative. */ } throw error; } }
  private count(table: 'challenges' | 'authorizations'): number { return Number((this.db().prepare(`SELECT count(*) AS count FROM ${table}`).get() as Row).count); }
  private countTriggers(): number { return Number((this.db().prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'merge_%'").get() as Row).count); }
  private db(): DatabaseSync { if (!this.database) throw new MergeAuthorizationError('STORE_INTEGRITY_FAILED'); return this.database; }
}

export class MergeAuthorizationError extends Error { constructor(readonly safeCode: VerdictMergeSafeCode) { super(safeCode); this.name = 'MergeAuthorizationError'; } }
function decodeChallengeRequest(input: unknown): MergeChallengeRequestV1 { const value = closed(input, ['requestId','explanationId']); if (!UUID.test(String(value.requestId)) || !UUID.test(String(value.explanationId))) throw new MergeAuthorizationError('PROTOCOL_INVALID'); return value as unknown as MergeChallengeRequestV1; }
function decodeAuthorizeRequest(input: unknown): MergeAuthorizeRequestV1 { const value = closed(input, ['requestId','challengeId','displayedChallengeDigest','explicitHumanGesture']); if (!UUID.test(String(value.requestId)) || !UUID.test(String(value.challengeId)) || !DIGEST.test(String(value.displayedChallengeDigest)) || value.explicitHumanGesture !== true) throw new MergeAuthorizationError('PROTOCOL_INVALID'); return value as unknown as MergeAuthorizeRequestV1; }
function decodeChallengeRecord(input: unknown): ChallengeRecord { const value = closed(input, ['challengeId','explanationDigest','taskRevisionId','repositoryIdentityDigest','destinationRef','expectedBaseOid','subjectOid','subjectTreeOid','mergePolicyId','issuedAt','expiresAt','challengeDigest','taskId','sessionId','authorizerRoleDigest','nonceDigest','exactBindingsDigest']); if (!UUID.test(String(value.challengeId)) || !UUID.test(String(value.taskId)) || !DIGEST.test(String(value.challengeDigest))) throw new Error('challenge'); return value as unknown as ChallengeRecord; }
function decodeAuthorizationRecord(input: unknown): AuthorizationRecord { const value = closed(input, ['authorizationId','challengeId','explanationDigest','exactBindingsDigest','state','recordedAt','expiresAt','actorAuthorityDigest','authorizerRoleDigest','sessionId','authorizationDigest']); if (!UUID.test(String(value.authorizationId)) || !UUID.test(String(value.challengeId)) || value.state !== 'authorized' || !DIGEST.test(String(value.authorizationDigest))) throw new Error('authorization'); return value as unknown as AuthorizationRecord; }
function decodeChallengeProjection(input: unknown): MergeChallengeProjectionV1 { const value = closed(input, ['challengeId','explanationDigest','taskRevisionId','repositoryIdentityDigest','destinationRef','expectedBaseOid','subjectOid','subjectTreeOid','mergePolicyId','issuedAt','expiresAt','challengeDigest']); if (!UUID.test(String(value.challengeId)) || !DIGEST.test(String(value.challengeDigest))) throw new Error('challenge-projection'); return value as unknown as MergeChallengeProjectionV1; }
function decodeAuthorizationProjection(input: unknown): MergeAuthorizationProjectionV1 { const value = closed(input, ['authorizationId','challengeId','explanationDigest','exactBindingsDigest','state','recordedAt','expiresAt']); if (!UUID.test(String(value.authorizationId)) || !UUID.test(String(value.challengeId)) || value.state !== 'authorized') throw new Error('authorization-projection'); return value as unknown as MergeAuthorizationProjectionV1; }
function closed(input: unknown, keys: readonly string[]): Record<string, unknown> { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) throw new MergeAuthorizationError('PROTOCOL_INVALID'); return input as Record<string, unknown>; }
function projectChallenge(record: ChallengeRecord): MergeChallengeProjectionV1 { return { challengeId: record.challengeId, explanationDigest: record.explanationDigest, taskRevisionId: record.taskRevisionId, repositoryIdentityDigest: record.repositoryIdentityDigest, destinationRef: record.destinationRef, expectedBaseOid: record.expectedBaseOid, subjectOid: record.subjectOid, subjectTreeOid: record.subjectTreeOid, mergePolicyId: record.mergePolicyId, issuedAt: record.issuedAt, expiresAt: record.expiresAt, challengeDigest: record.challengeDigest }; }
function projectAuthorization(record: AuthorizationRecord): MergeAuthorizationProjectionV1 { return { authorizationId: record.authorizationId, challengeId: record.challengeId, explanationDigest: record.explanationDigest, exactBindingsDigest: record.exactBindingsDigest, state: record.state, recordedAt: record.recordedAt, expiresAt: record.expiresAt }; }
function equalDigest(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function prefixed(value: string): string { return value.startsWith('sha256:') ? value : `sha256:${value}`; }
function text(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new Error('integrity'); return value; }
function safeCode(error: unknown): VerdictMergeSafeCode { return error instanceof MergeAuthorizationError ? error.safeCode : 'INTERNAL_FAILURE'; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state')); }
