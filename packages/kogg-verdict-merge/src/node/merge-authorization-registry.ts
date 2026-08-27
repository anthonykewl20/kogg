import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import type { ModeOperationAuthorizer, ModeSafeCodeV1 } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import { KoggModeOperationAuthorizer } from '@kogg/interaction-modes/lib/common/interaction-modes-protocol';
import { canonicalJson, verdictMergeDigest } from '../common/verdict-merge-canonical';
import type {
  MergeAuthorizationProjectionV1, MergeAuthorizationResultV1, MergeAuthorizeRequestV1,
  MergeChallengeProjectionV1, MergeChallengeRequestV1, MergeChallengeResultV1, MergeExecuteRequestV1,
  MergeExecuteResultV1, MergeIntentProjectionV1, VerdictMergeSafeCode
} from '../common/verdict-merge-protocol';
import {
  MergeAuthorizationAuthority, type MergeAuthorizationContextV1, mergeAuthorizationScopeDigest, mergeNonceDigest, mergeOpaqueId
} from './merge-authorization-authority';
import { VerdictMergeService } from './verdict-merge-service';
import type { OperationsOwnerSink, OwnerEventV1, SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';

// Stores only closed challenge/authorization records. Session and actor values are opaque digests and never enter logs.
// diagnostic-coverage: merge.authorization, merge.recovery
type Row = Record<string, SQLOutputValue>;
type Actor = { readonly sessionId: string; readonly actorAuthorityDigest: string; readonly authorizerRoleDigest: string };
type ChallengeRecord = MergeChallengeProjectionV1 & { readonly taskId: string; readonly sessionId: string; readonly authorizerRoleDigest: string; readonly nonceDigest: string; readonly exactBindingsDigest: string; readonly projectId?: string; readonly repositoryId?: string };
type AuthorizationRecord = MergeAuthorizationProjectionV1 & { readonly actorAuthorityDigest: string; readonly authorizerRoleDigest: string; readonly sessionId: string; readonly authorizationDigest: string };
export type PrivateMergeIntent = MergeIntentProjectionV1 & { readonly requestId: string; readonly authorizationDigest: string; readonly exactBindingsDigest: string; readonly repositoryIdentityDigest: string; readonly taskId: string; readonly taskRevisionId: string; readonly generation: '1'; readonly explanationId?: string; readonly projectId?: string; readonly repositoryId?: string };
type IntentRecord = PrivateMergeIntent;
export type MergeLifecycleState = 'preflighting' | 'constructing' | 'cas-ready' | 'cas-started' | 'post-verifying' | 'committed' | 'cleaning' | 'completed' | 'refused' | 'failed' | 'recovery-required' | 'quarantined';
export interface MergeRecoveryCandidate { readonly intent: PrivateMergeIntent; readonly state: string; readonly expectedMergeOid?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/u;

@injectable()
export class MergeAuthorizationRegistry implements BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private ownerSink: OperationsOwnerSink | undefined;
  constructor(
    @inject(VerdictMergeService) private readonly verdicts: VerdictMergeService,
    @inject(MergeAuthorizationAuthority) private readonly authority: MergeAuthorizationAuthority,
    @inject(KoggModeOperationAuthorizer) private readonly modes: ModeOperationAuthorizer,
    @unmanaged() private readonly databasePath = path.join(stateRoot(), 'verdict-merge', 'authorization.sqlite3'),
    @unmanaged() private readonly clock: () => Date = () => new Date()
  ) {}

  async onStart(): Promise<void> {
    console.info('[kogg:merge:authorization] recovery.started');
    try {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      this.migrate(); this.assertIntegrity(); this.publishOwnerEvents(); if (process.platform !== 'win32') await fs.chmod(this.databasePath, 0o600);
      console.info('[kogg:merge:authorization] recovery.completed', { challengeCount: this.count('challenges'), authorizationCount: this.count('authorizations') });
    } catch (error) {
      this.database?.close(); this.database = undefined;
      console.error('[kogg:merge:authorization] recovery.failed', { safeCode: 'STORE_INTEGRITY_FAILED', errorType: errorName(error) });
      throw new MergeAuthorizationError('STORE_INTEGRITY_FAILED');
    }
  }

  onStop(): void { console.info('[kogg:merge:authorization] shutdown.started'); this.ownerSink = undefined; this.database?.close(); this.database = undefined; console.info('[kogg:merge:authorization] shutdown.completed'); }
  setOwnerSink(sink?: OperationsOwnerSink): void { this.ownerSink = sink; if (sink && this.database) this.publishOwnerEvents(); }
  publishOwnerEvents(): void {
    if (!this.ownerSink || !this.database) return; const meta = this.db().prepare('SELECT owner_id,owner_epoch_id FROM merge_owner_meta WHERE singleton=1').get() as Row; let previous = '0'.repeat(64);
    for (const row of this.db().prepare('SELECT * FROM merge_owner_events ORDER BY sequence').all() as Row[]) { if (mergeOwnerSourceDigest(row) !== text(row, 'source_digest')) { console.error('[kogg:merge:owners] owner.publish.failed', { ownerKind: 'merge', safeCode: 'STORE_INTEGRITY_FAILED', errorType: 'OwnerEventIntegrityError' }); break; } const mapped = mapMergeOwnerEvent(row, text(meta, 'owner_id'), text(meta, 'owner_epoch_id'), previous); previous = mapped.eventDigest; try { this.ownerSink.ingest(mapped); } catch (error) { // observability-exempt: closed publication failure excludes repository and authorization content.
        console.error('[kogg:merge:owners] owner.publish.failed', { ownerKind: 'merge', ownerSequence: mapped.sequence, safeCode: 'STORE_INTEGRITY_FAILED', errorType: errorName(error) }); break; } }
  }

  async createChallenge(input: unknown, context: MergeAuthorizationContextV1): Promise<MergeChallengeResultV1> {
    let requestId = 'invalid';
    try {
      const request = decodeChallengeRequest(input); requestId = request.requestId; const scope = mergeAuthorizationScopeDigest('challenge', request);
      const actor = this.requireActor(context, scope); const replay = this.replay<MergeChallengeResultV1>(requestId, scope); if (replay) return replay.kind === 'created' ? { ...replay, replay: true } : replay;
      console.info('[kogg:merge:authorization] challenge.requested', { requestId, explanationId: request.explanationId });
      const taskId = this.verdicts.authorizationTaskId(request.explanationId); if (!taskId) return this.refusedChallenge(requestId, 'VERDICT_UNKNOWN');
      const mode = await this.modes.authorizeOperation({ requestId, taskId, operation: 'merge-controlled' });
      if (!mode.allowed) return this.refusedChallenge(requestId, mergeModeRefusal(mode.safeCode));
      const now = this.clock(); const binding = await this.verdicts.currentAuthorizationBinding(request.explanationId, now);
      if (!binding) return this.refusedChallenge(requestId, 'VERDICT_UNKNOWN');
      if (binding.explanation.gateRows.some(row => (row.producerRoleDigest !== null && prefixed(row.producerRoleDigest) === actor.authorizerRoleDigest) || prefixed(row.verifierRoleDigest) === actor.authorizerRoleDigest)) return this.refusedChallenge(requestId, 'IDENTITY_SEPARATION_INVALID');
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
        taskId: binding.query.taskId, projectId: binding.query.projectId, repositoryId: binding.query.repositoryId
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
      const mode = await this.modes.authorizeOperation({ requestId, taskId: record.taskId, operation: 'merge-controlled' });
      if (!mode.allowed) return this.refusedAuthorization(requestId, challengeId, mergeModeRefusal(mode.safeCode));
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
        this.appendEvent(challengeId, 'authorized', recordedAt); this.appendAuthorizationEvent(authorizationId, 'authorized', recordedAt); this.storeRequest('authorize', request, scope, result);
      });
      console.info('[kogg:merge:authorization] authorization.recorded', { requestId, challengeId, authorizationId, safeCode: result.safeCode }); return result;
    } catch (error) {
      // observability-exempt: refusal helpers emit one closed failure with the safe request correlation.
      return this.refusedAuthorization(requestId, challengeId, safeCode(error));
    }
  }

  async createIntent(input: unknown, context: MergeAuthorizationContextV1): Promise<MergeExecuteResultV1> {
    let requestId = 'invalid'; let authorizationId = 'invalid';
    try {
      const request = decodeExecuteRequest(input); requestId = request.requestId; authorizationId = request.authorizationId;
      const scope = mergeAuthorizationScopeDigest('execute', request); const actor = this.requireActor(context, scope);
      const replay = this.replayMerge(requestId, scope); if (replay) return replay.kind === 'accepted' ? { ...replay, replay: true } : replay;
      console.info('[kogg:merge:authorization] consumption.requested', { requestId, authorizationId });
      const row = this.db().prepare(`SELECT a.record_json,c.explanation_id,c.record_json AS challenge_json FROM authorizations a
        JOIN challenges c ON c.challenge_id=a.challenge_id WHERE a.authorization_id=?`).get(authorizationId) as Row | undefined;
      if (!row) return this.refusedExecute(requestId, authorizationId, 'AUTHORIZATION_REQUIRED');
      const authorization = decodeAuthorizationRecord(JSON.parse(text(row, 'record_json')) as unknown);
      if (this.authorizationState(authorizationId) !== 'authorized') return this.refusedExecute(requestId, authorizationId, 'AUTHORIZATION_REPLAY');
      const now = this.clock(); if (Date.parse(authorization.expiresAt) <= now.getTime()) { this.appendAuthorizationEvent(authorizationId, 'expired', now.toISOString()); return this.refusedExecute(requestId, authorizationId, 'AUTHORIZATION_EXPIRED'); }
      if (authorization.sessionId !== actor.sessionId || authorization.actorAuthorityDigest !== actor.actorAuthorityDigest || authorization.authorizerRoleDigest !== actor.authorizerRoleDigest) return this.refusedExecute(requestId, authorizationId, 'AUTHORIZATION_REQUIRED');
      const challenge = decodeChallengeRecord(JSON.parse(text(row, 'challenge_json')) as unknown);
      const mode = await this.modes.authorizeOperation({ requestId, taskId: challenge.taskId, operation: 'merge-controlled' });
      if (!mode.allowed) return this.refusedExecute(requestId, authorizationId, mergeModeRefusal(mode.safeCode));
      const binding = await this.verdicts.currentAuthorizationBinding(text(row, 'explanation_id'), now);
      if (!binding || binding.explanation.explanationDigest !== authorization.explanationDigest
        || challenge.exactBindingsDigest !== authorization.exactBindingsDigest
        || binding.query.destinationRef !== challenge.destinationRef || binding.query.expectedBaseOid !== challenge.expectedBaseOid
        || binding.query.subjectOid !== challenge.subjectOid || binding.query.subjectTreeOid !== challenge.subjectTreeOid
        || binding.query.repositoryIdentityDigest !== challenge.repositoryIdentityDigest || binding.query.taskRevisionId !== challenge.taskRevisionId) return this.refusedExecute(requestId, authorizationId, 'VERDICT_UNKNOWN');
      if (!challenge.projectId || !challenge.repositoryId) return this.refusedExecute(requestId, authorizationId, 'VERDICT_UNKNOWN');
      const mergeId = mergeOpaqueId(); const createdAt = now.toISOString();
      const intent: IntentRecord = {
        mergeId, requestId, authorizationId, authorizationDigest: authorization.authorizationDigest,
        exactBindingsDigest: authorization.exactBindingsDigest, repositoryIdentityDigest: challenge.repositoryIdentityDigest,
        taskId: challenge.taskId, taskRevisionId: challenge.taskRevisionId, destinationRef: challenge.destinationRef,
        expectedOldOid: challenge.expectedBaseOid, subjectOid: challenge.subjectOid, expectedTreeOid: challenge.subjectTreeOid,
        mergePolicyId: challenge.mergePolicyId, state: 'preflight-pending', generation: '1', createdAt,
        explanationId: text(row, 'explanation_id'), projectId: challenge.projectId, repositoryId: challenge.repositoryId
      };
      const result: MergeExecuteResultV1 = { kind: 'accepted', safeCode: 'MERGE_PREFLIGHT_PENDING', intent: projectIntent(intent), replay: false };
      this.transaction(() => {
        this.db().prepare('INSERT INTO merge_intents(merge_id,authorization_id,tuple_digest,record_json) VALUES(?,?,?,?)').run(
          mergeId, authorizationId, prefixed(verdictMergeDigest('intent', { destinationRef: intent.destinationRef, subjectOid: intent.subjectOid, taskRevisionId: intent.taskRevisionId })), canonicalJson(intent));
        this.appendAuthorizationEvent(authorizationId, 'consumed', createdAt, mergeId); this.appendMergeEvent(mergeId, 'preflight-pending', createdAt);
        this.db().prepare('INSERT INTO merge_requests(request_id,scope_digest,request_json,result_json) VALUES(?,?,?,?)').run(requestId, scope, canonicalJson(request), canonicalJson(result));
      });
      console.info('[kogg:merge:authorization] authorization.consumed', { requestId, authorizationId, mergeId, safeCode: result.safeCode }); return result;
    } catch (error) {
      // observability-exempt: refusedExecute emits the closed consumption result without authority or repository contents.
      return this.refusedExecute(requestId, authorizationId, safeCode(error));
    }
  }

  diagnostics(): { readonly integrity: boolean; readonly challengeCount: number; readonly authorizationCount: number; readonly authorizationReady: boolean; readonly sourceMapsPresent: boolean } {
    this.assertIntegrity(); const challengeCount = this.count('challenges'); const authorizationCount = this.count('authorizations');
    return { integrity: true, challengeCount, authorizationCount, authorizationReady: true, sourceMapsPresent: existsSync(`${__filename}.map`) && existsSync(path.join(__dirname, 'merge-authorization-authority.js.map')) };
  }

  pendingIntent(mergeId: string): PrivateMergeIntent | undefined {
    const row = this.db().prepare('SELECT record_json FROM merge_intents WHERE merge_id=?').get(mergeId) as Row | undefined;
    if (!row || this.mergeState(mergeId) !== 'preflight-pending') return undefined;
    return decodeIntentRecord(JSON.parse(text(row, 'record_json')) as unknown);
  }

  async revalidateIntent(intent: PrivateMergeIntent, now = this.clock()): Promise<boolean> {
    if (!intent.explanationId) return false;
    const mode = await this.modes.authorizeOperation({ requestId: randomUUID(), taskId: intent.taskId, operation: 'merge-controlled' });
    if (!mode.allowed) { console.warn('[kogg:merge:authorization] intent.mode-refused', { mergeId: intent.mergeId, safeCode: mergeModeRefusal(mode.safeCode) }); return false; }
    const binding = await this.verdicts.currentAuthorizationBinding(intent.explanationId, now);
    return Boolean(binding && binding.explanation.explanationDigest
      && binding.query.projectId === intent.projectId && binding.query.repositoryId === intent.repositoryId
      && binding.query.repositoryIdentityDigest === intent.repositoryIdentityDigest
      && binding.query.destinationRef === intent.destinationRef && binding.query.expectedBaseOid === intent.expectedOldOid
      && binding.query.subjectOid === intent.subjectOid && binding.query.subjectTreeOid === intent.expectedTreeOid
      && binding.query.taskId === intent.taskId && binding.query.taskRevisionId === intent.taskRevisionId);
  }

  transitionMerge(mergeId: string, state: MergeLifecycleState, expectedFrom: string | readonly string[], expectedMergeOid?: string): void {
    const allowed = typeof expectedFrom === 'string' ? [expectedFrom] : expectedFrom;
    this.transaction(() => {
      const current = this.mergeState(mergeId);
      if (!allowed.includes(current)) throw new MergeAuthorizationError('MERGE_ALREADY_REQUESTED');
      this.appendLifecycleEvent(mergeId, state, this.clock().toISOString(), expectedMergeOid);
    });
  }

  mergeState(mergeId: string): string {
    const lifecycle = this.db().prepare('SELECT state FROM merge_lifecycle_events WHERE merge_id=? ORDER BY sequence DESC LIMIT 1').get(mergeId) as Row | undefined;
    if (lifecycle) return text(lifecycle, 'state');
    const initial = this.db().prepare('SELECT state FROM merge_events WHERE merge_id=? ORDER BY sequence DESC LIMIT 1').get(mergeId) as Row | undefined;
    return initial ? text(initial, 'state') : 'missing';
  }

  recoveryCandidates(): readonly MergeRecoveryCandidate[] {
    const terminal = new Set(['completed', 'refused', 'failed', 'quarantined']);
    const result: MergeRecoveryCandidate[] = [];
    for (const row of this.db().prepare('SELECT merge_id,record_json FROM merge_intents ORDER BY rowid').all() as Row[]) {
      const mergeId = text(row, 'merge_id'); const state = this.mergeState(mergeId); if (terminal.has(state)) continue;
      const oidRow = this.db().prepare('SELECT expected_merge_oid FROM merge_lifecycle_events WHERE merge_id=? AND expected_merge_oid IS NOT NULL ORDER BY sequence DESC LIMIT 1').get(mergeId) as Row | undefined;
      result.push({ intent: decodeIntentRecord(JSON.parse(text(row, 'record_json')) as unknown), state, ...(oidRow ? { expectedMergeOid: text(oidRow, 'expected_merge_oid') } : {}) });
    }
    return result;
  }

  private requireActor(context: MergeAuthorizationContextV1, scope: string): Actor { const actor = this.authority.verify(context, scope); if (!actor) throw new MergeAuthorizationError('AUTHORIZATION_REQUIRED'); return actor; }
  private replay<T extends MergeChallengeResultV1 | MergeAuthorizationResultV1>(requestId: string, scope: string): T | undefined { const row = this.db().prepare('SELECT scope_digest,result_json FROM authorization_requests WHERE request_id=?').get(requestId) as Row | undefined; if (!row) return undefined; if (text(row, 'scope_digest') !== scope) throw new MergeAuthorizationError('REQUEST_CONFLICT'); return JSON.parse(text(row, 'result_json')) as T; }
  private storeRequest(kind: 'challenge' | 'authorize', request: MergeChallengeRequestV1 | MergeAuthorizeRequestV1, scope: string, result: MergeChallengeResultV1 | MergeAuthorizationResultV1): void { this.db().prepare('INSERT INTO authorization_requests(request_id,request_kind,scope_digest,request_json,result_json) VALUES(?,?,?,?,?)').run(request.requestId, kind, scope, canonicalJson(request), canonicalJson(result)); }
  private replayMerge(requestId: string, scope: string): MergeExecuteResultV1 | undefined { const row = this.db().prepare('SELECT scope_digest,result_json FROM merge_requests WHERE request_id=?').get(requestId) as Row | undefined; if (!row) return undefined; if (text(row, 'scope_digest') !== scope) throw new MergeAuthorizationError('REQUEST_CONFLICT'); return JSON.parse(text(row, 'result_json')) as MergeExecuteResultV1; }
  private refusedChallenge(requestId: string, safeCode: VerdictMergeSafeCode): MergeChallengeResultV1 { console.warn('[kogg:merge:authorization] challenge.refused', { requestId, safeCode }); return { kind: 'refused', safeCode }; }
  private refusedAuthorization(requestId: string, challengeId: string, safeCode: VerdictMergeSafeCode): MergeAuthorizationResultV1 { console.warn('[kogg:merge:authorization] authorization.refused', { requestId, challengeId, safeCode }); return { kind: 'refused', safeCode }; }
  private refusedExecute(requestId: string, authorizationId: string, safeCode: VerdictMergeSafeCode): MergeExecuteResultV1 { console.warn('[kogg:merge:authorization] consumption.refused', { requestId, authorizationId, safeCode }); return { kind: 'refused', safeCode }; }
  private openChallenges(taskId: string, excluding: string): string[] { return (this.db().prepare("SELECT challenge_id FROM challenges WHERE task_id=? AND challenge_id<>? AND (SELECT state FROM challenge_events WHERE challenge_events.challenge_id=challenges.challenge_id ORDER BY sequence DESC LIMIT 1)='created'").all(taskId, excluding) as Row[]).map(row => text(row, 'challenge_id')); }
  private challengeState(challengeId: string): string { const row = this.db().prepare('SELECT state FROM challenge_events WHERE challenge_id=? ORDER BY sequence DESC LIMIT 1').get(challengeId) as Row | undefined; return row ? text(row, 'state') : 'missing'; }
  private appendEvent(challengeId: string, state: 'created' | 'authorized' | 'expired' | 'revoked', recordedAt: string): void { const prior = this.db().prepare('SELECT event_digest FROM challenge_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousEventDigest = prior ? text(prior, 'event_digest') : prefixed('0'.repeat(64)); const body = { challengeId, previousEventDigest, recordedAt, state }; const eventDigest = prefixed(verdictMergeDigest('authorization', body)); this.db().prepare('INSERT INTO challenge_events(challenge_id,state,recorded_at,previous_event_digest,event_digest) VALUES(?,?,?,?,?)').run(challengeId, state, recordedAt, previousEventDigest, eventDigest); }
  private authorizationState(authorizationId: string): string { const row = this.db().prepare('SELECT state FROM authorization_events WHERE authorization_id=? ORDER BY sequence DESC LIMIT 1').get(authorizationId) as Row | undefined; return row ? text(row, 'state') : 'missing'; }
  private appendAuthorizationEvent(authorizationId: string, state: 'authorized' | 'consumed' | 'expired', recordedAt: string, mergeId?: string): void { const prior = this.db().prepare('SELECT event_digest FROM authorization_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousEventDigest = prior ? text(prior, 'event_digest') : prefixed('0'.repeat(64)); const body = { authorizationId, mergeId: mergeId ?? null, previousEventDigest, recordedAt, state }; const eventDigest = prefixed(verdictMergeDigest('authorization', body)); this.db().prepare('INSERT INTO authorization_events(authorization_id,state,merge_id,recorded_at,previous_event_digest,event_digest) VALUES(?,?,?,?,?,?)').run(authorizationId, state, mergeId ?? null, recordedAt, previousEventDigest, eventDigest); }
  private appendMergeEvent(mergeId: string, state: 'preflight-pending', recordedAt: string): void { const prior = this.db().prepare('SELECT event_digest FROM merge_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousEventDigest = prior ? text(prior, 'event_digest') : prefixed('0'.repeat(64)); const body = { mergeId, previousEventDigest, recordedAt, state }; const eventDigest = prefixed(verdictMergeDigest('intent', body)); this.db().prepare('INSERT INTO merge_events(merge_id,state,recorded_at,previous_event_digest,event_digest) VALUES(?,?,?,?,?)').run(mergeId, state, recordedAt, previousEventDigest, eventDigest); this.appendOwnerEvent(mergeId, state, recordedAt, eventDigest); }
  private appendLifecycleEvent(mergeId: string, state: MergeLifecycleState, recordedAt: string, expectedMergeOid?: string): void { const prior = this.db().prepare('SELECT event_digest FROM merge_lifecycle_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousEventDigest = prior ? text(prior, 'event_digest') : prefixed('0'.repeat(64)); const body = { expectedMergeOid: expectedMergeOid ?? null, mergeId, previousEventDigest, recordedAt, state }; const eventDigest = prefixed(verdictMergeDigest('intent', body)); this.db().prepare('INSERT INTO merge_lifecycle_events(merge_id,state,expected_merge_oid,recorded_at,previous_event_digest,event_digest) VALUES(?,?,?,?,?,?)').run(mergeId, state, expectedMergeOid ?? null, recordedAt, previousEventDigest, eventDigest); this.appendOwnerEvent(mergeId, state, recordedAt, eventDigest); }
  private migrate(): void { this.db().exec(`CREATE TABLE IF NOT EXISTS challenges(challenge_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,explanation_id TEXT NOT NULL,record_json TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS challenge_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,challenge_id TEXT NOT NULL REFERENCES challenges(challenge_id),state TEXT NOT NULL CHECK(state IN('created','authorized','expired','revoked')),recorded_at TEXT NOT NULL,previous_event_digest TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE) STRICT; CREATE TABLE IF NOT EXISTS authorizations(authorization_id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(challenge_id),record_json TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS authorization_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,authorization_id TEXT NOT NULL REFERENCES authorizations(authorization_id),state TEXT NOT NULL CHECK(state IN('authorized','consumed','expired')),merge_id TEXT,recorded_at TEXT NOT NULL,previous_event_digest TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE) STRICT; CREATE TABLE IF NOT EXISTS merge_intents(merge_id TEXT PRIMARY KEY,authorization_id TEXT NOT NULL UNIQUE REFERENCES authorizations(authorization_id),tuple_digest TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS merge_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,merge_id TEXT NOT NULL REFERENCES merge_intents(merge_id),state TEXT NOT NULL CHECK(state IN('preflight-pending')),recorded_at TEXT NOT NULL,previous_event_digest TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE) STRICT; CREATE TABLE IF NOT EXISTS merge_lifecycle_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,merge_id TEXT NOT NULL REFERENCES merge_intents(merge_id),state TEXT NOT NULL CHECK(state IN('preflighting','constructing','cas-ready','cas-started','post-verifying','committed','cleaning','completed','refused','failed','recovery-required','quarantined')),expected_merge_oid TEXT,recorded_at TEXT NOT NULL,previous_event_digest TEXT NOT NULL,event_digest TEXT NOT NULL UNIQUE) STRICT; CREATE TABLE IF NOT EXISTS authorization_requests(request_id TEXT PRIMARY KEY,request_kind TEXT NOT NULL CHECK(request_kind IN('challenge','authorize')),scope_digest TEXT NOT NULL,request_json TEXT NOT NULL,result_json TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS merge_requests(request_id TEXT PRIMARY KEY,scope_digest TEXT NOT NULL,request_json TEXT NOT NULL,result_json TEXT NOT NULL) STRICT; CREATE TRIGGER IF NOT EXISTS merge_challenges_update BEFORE UPDATE ON challenges BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_challenges_delete BEFORE DELETE ON challenges BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_events_update BEFORE UPDATE ON challenge_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_events_delete BEFORE DELETE ON challenge_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_authorizations_update BEFORE UPDATE ON authorizations BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_authorizations_delete BEFORE DELETE ON authorizations BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_requests_update BEFORE UPDATE ON authorization_requests BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_requests_delete BEFORE DELETE ON authorization_requests BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_authorization_events_update BEFORE UPDATE ON authorization_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_authorization_events_delete BEFORE DELETE ON authorization_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_intents_update BEFORE UPDATE ON merge_intents BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_intents_delete BEFORE DELETE ON merge_intents BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_intent_events_update BEFORE UPDATE ON merge_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_intent_events_delete BEFORE DELETE ON merge_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_lifecycle_events_update BEFORE UPDATE ON merge_lifecycle_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_lifecycle_events_delete BEFORE DELETE ON merge_lifecycle_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_intent_requests_update BEFORE UPDATE ON merge_requests BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_intent_requests_delete BEFORE DELETE ON merge_requests BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    this.db().exec(`CREATE TABLE IF NOT EXISTS merge_owner_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL,owner_epoch_id TEXT NOT NULL,identity_digest TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS merge_owner_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,merge_id TEXT NOT NULL,event_kind TEXT NOT NULL,safe_code TEXT NOT NULL,task_id TEXT NOT NULL,project_id TEXT,recorded_at TEXT NOT NULL,state TEXT NOT NULL,source_event_digest TEXT NOT NULL,previous_source_digest TEXT NOT NULL,source_digest TEXT NOT NULL UNIQUE) STRICT; CREATE TRIGGER IF NOT EXISTS merge_owner_meta_update BEFORE UPDATE ON merge_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_owner_meta_delete BEFORE DELETE ON merge_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_owner_events_update BEFORE UPDATE ON merge_owner_events BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER IF NOT EXISTS merge_owner_events_delete BEFORE DELETE ON merge_owner_events BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    if (!this.db().prepare('SELECT 1 FROM merge_owner_meta').get()) { const ownerId = randomUUID(); const ownerEpochId = randomUUID(); this.db().prepare('INSERT INTO merge_owner_meta VALUES(1,?,?,?)').run(ownerId, ownerEpochId, verdictMergeDigest('owner-identity', { ownerId, ownerEpochId })); }
    if (!this.db().prepare('SELECT 1 FROM merge_owner_events LIMIT 1').get()) for (const row of this.db().prepare(`SELECT merge_id,state,recorded_at,event_digest,source_order,source_sequence FROM (SELECT merge_id,state,recorded_at,event_digest,0 AS source_order,sequence AS source_sequence FROM merge_events UNION ALL SELECT merge_id,state,recorded_at,event_digest,1 AS source_order,sequence AS source_sequence FROM merge_lifecycle_events) ORDER BY recorded_at,source_order,source_sequence`).all() as Row[]) this.appendOwnerEvent(text(row, 'merge_id'), text(row, 'state'), text(row, 'recorded_at'), text(row, 'event_digest'));
  }
  private assertIntegrity(): void { try { this.verifyIntegrity(); } catch { /* observability-exempt: startup and diagnostic callers log or project the closed integrity failure. */ throw new MergeAuthorizationError('STORE_INTEGRITY_FAILED'); } }
  private verifyIntegrity(): void {
    if (text(this.db().prepare('PRAGMA quick_check').get() as Row, 'quick_check') !== 'ok' || this.countTriggers() !== 22 || !this.ownerFactsValid()) throw new Error('integrity');
    let previous = prefixed('0'.repeat(64));
    for (const row of this.db().prepare('SELECT * FROM challenge_events ORDER BY sequence').all() as Row[]) { const body = { challengeId: text(row, 'challenge_id'), previousEventDigest: text(row, 'previous_event_digest'), recordedAt: text(row, 'recorded_at'), state: text(row, 'state') }; if (body.previousEventDigest !== previous || prefixed(verdictMergeDigest('authorization', body)) !== text(row, 'event_digest')) throw new Error('event-chain'); previous = text(row, 'event_digest'); }
    for (const row of this.db().prepare('SELECT * FROM challenges').all() as Row[]) { const record = decodeChallengeRecord(JSON.parse(text(row, 'record_json')) as unknown); const { challengeDigest, ...body } = record; if (record.challengeId !== text(row, 'challenge_id') || record.taskId !== text(row, 'task_id') || prefixed(verdictMergeDigest('challenge', body)) !== challengeDigest) throw new Error('challenge'); }
    for (const row of this.db().prepare('SELECT * FROM authorizations').all() as Row[]) { const record = decodeAuthorizationRecord(JSON.parse(text(row, 'record_json')) as unknown); const { authorizationDigest, ...body } = record; if (record.authorizationId !== text(row, 'authorization_id') || record.challengeId !== text(row, 'challenge_id') || prefixed(verdictMergeDigest('authorization', body)) !== authorizationDigest) throw new Error('authorization'); }
    previous = prefixed('0'.repeat(64));
    for (const row of this.db().prepare('SELECT * FROM authorization_events ORDER BY sequence').all() as Row[]) { const body = { authorizationId: text(row, 'authorization_id'), mergeId: nullableText(row, 'merge_id'), previousEventDigest: text(row, 'previous_event_digest'), recordedAt: text(row, 'recorded_at'), state: text(row, 'state') }; if (body.previousEventDigest !== previous || prefixed(verdictMergeDigest('authorization', body)) !== text(row, 'event_digest')) throw new Error('authorization-event'); previous = text(row, 'event_digest'); }
    for (const row of this.db().prepare('SELECT * FROM merge_intents').all() as Row[]) { const record = decodeIntentRecord(JSON.parse(text(row, 'record_json')) as unknown); if (record.mergeId !== text(row, 'merge_id') || record.authorizationId !== text(row, 'authorization_id')) throw new Error('intent'); }
    previous = prefixed('0'.repeat(64));
    for (const row of this.db().prepare('SELECT * FROM merge_events ORDER BY sequence').all() as Row[]) { const body = { mergeId: text(row, 'merge_id'), previousEventDigest: text(row, 'previous_event_digest'), recordedAt: text(row, 'recorded_at'), state: text(row, 'state') }; if (body.previousEventDigest !== previous || prefixed(verdictMergeDigest('intent', body)) !== text(row, 'event_digest')) throw new Error('intent-event'); previous = text(row, 'event_digest'); }
    previous = prefixed('0'.repeat(64));
    for (const row of this.db().prepare('SELECT * FROM merge_lifecycle_events ORDER BY sequence').all() as Row[]) { const body = { expectedMergeOid: nullableText(row, 'expected_merge_oid'), mergeId: text(row, 'merge_id'), previousEventDigest: text(row, 'previous_event_digest'), recordedAt: text(row, 'recorded_at'), state: text(row, 'state') }; if (body.previousEventDigest !== previous || prefixed(verdictMergeDigest('intent', body)) !== text(row, 'event_digest')) throw new Error('intent-lifecycle-event'); previous = text(row, 'event_digest'); }
    for (const row of this.db().prepare('SELECT * FROM authorization_requests').all() as Row[]) {
      const kind = text(row, 'request_kind'); const request = kind === 'challenge' ? decodeChallengeRequest(JSON.parse(text(row, 'request_json')) as unknown) : decodeAuthorizeRequest(JSON.parse(text(row, 'request_json')) as unknown);
      const scope = kind === 'challenge' ? mergeAuthorizationScopeDigest('challenge', request) : mergeAuthorizationScopeDigest('authorize', request);
      if (request.requestId !== text(row, 'request_id') || scope !== text(row, 'scope_digest')) throw new Error('request');
      const result = JSON.parse(text(row, 'result_json')) as MergeChallengeResultV1 | MergeAuthorizationResultV1;
      if (kind === 'challenge') { if (result.kind !== 'created') throw new Error('challenge-result'); const challenge = decodeChallengeProjection(result.challenge); const stored = this.db().prepare('SELECT record_json FROM challenges WHERE challenge_id=?').get(challenge.challengeId) as Row | undefined; if (!stored || canonicalJson(projectChallenge(decodeChallengeRecord(JSON.parse(text(stored, 'record_json')) as unknown))) !== canonicalJson(challenge) || result.replay !== false || result.safeCode !== 'AUTHORIZATION_REQUIRED') throw new Error('challenge-result'); }
      else { if (result.kind !== 'authorized') throw new Error('authorization-result'); const authorization = decodeAuthorizationProjection(result.authorization); const stored = this.db().prepare('SELECT record_json FROM authorizations WHERE authorization_id=?').get(authorization.authorizationId) as Row | undefined; if (!stored || canonicalJson(projectAuthorization(decodeAuthorizationRecord(JSON.parse(text(stored, 'record_json')) as unknown))) !== canonicalJson(authorization) || result.replay !== false || result.safeCode !== 'AUTHORIZATION_OK') throw new Error('authorization-result'); }
    }
    for (const row of this.db().prepare('SELECT * FROM merge_requests').all() as Row[]) { const request = decodeExecuteRequest(JSON.parse(text(row, 'request_json')) as unknown); if (request.requestId !== text(row, 'request_id') || mergeAuthorizationScopeDigest('execute', request) !== text(row, 'scope_digest')) throw new Error('merge-request'); const result = JSON.parse(text(row, 'result_json')) as MergeExecuteResultV1; if (result.kind !== 'accepted' || result.safeCode !== 'MERGE_PREFLIGHT_PENDING' || result.replay !== false) throw new Error('merge-result'); const stored = this.db().prepare('SELECT record_json FROM merge_intents WHERE merge_id=?').get(result.intent.mergeId) as Row | undefined; if (!stored || canonicalJson(projectIntent(decodeIntentRecord(JSON.parse(text(stored, 'record_json')) as unknown))) !== canonicalJson(result.intent)) throw new Error('merge-result'); }
  }
  private appendOwnerEvent(mergeId: string, state: string, recordedAt: string, sourceEventDigest: string): void { const intentRow = this.db().prepare('SELECT record_json FROM merge_intents WHERE merge_id=?').get(mergeId) as Row; const intent = decodeIntentRecord(JSON.parse(text(intentRow, 'record_json')) as unknown); const prior = this.db().prepare('SELECT source_digest FROM merge_owner_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousSourceDigest = prior ? text(prior, 'source_digest') : '0'.repeat(64); const eventId = randomUUID(); const { eventKind, safeCode } = mergeOwnerOutcome(state); const body = { eventId, mergeId, eventKind, safeCode, taskId: intent.taskId, projectId: intent.projectId ?? null, recordedAt, state, sourceEventDigest, previousSourceDigest }; const sourceDigest = verdictMergeDigest('owner-event', body); this.db().prepare('INSERT INTO merge_owner_events(event_id,merge_id,event_kind,safe_code,task_id,project_id,recorded_at,state,source_event_digest,previous_source_digest,source_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(eventId, mergeId, eventKind, safeCode, intent.taskId, intent.projectId ?? null, recordedAt, state, sourceEventDigest, previousSourceDigest, sourceDigest); }
  private ownerFactsValid(): boolean { const meta = this.db().prepare('SELECT * FROM merge_owner_meta WHERE singleton=1').get() as Row | undefined; if (!meta) return false; const ownerId = text(meta, 'owner_id'); const ownerEpochId = text(meta, 'owner_epoch_id'); if (!UUID.test(ownerId) || !UUID.test(ownerEpochId) || text(meta, 'identity_digest') !== verdictMergeDigest('owner-identity', { ownerId, ownerEpochId })) return false; let previous = '0'.repeat(64); for (const row of this.db().prepare('SELECT * FROM merge_owner_events ORDER BY sequence').all() as Row[]) { if (text(row, 'previous_source_digest') !== previous || mergeOwnerSourceDigest(row) !== text(row, 'source_digest')) return false; previous = text(row, 'source_digest'); } return true; }
  private transaction(action: () => void): void { this.db().exec('BEGIN IMMEDIATE'); try { action(); this.db().exec('COMMIT'); } catch (error) { try { this.db().exec('ROLLBACK'); } catch { /* observability-exempt: original transaction refusal remains authoritative. */ } throw error; } this.publishOwnerEvents(); }
  private count(table: 'challenges' | 'authorizations'): number { return Number((this.db().prepare(`SELECT count(*) AS count FROM ${table}`).get() as Row).count); }
  private countTriggers(): number { return Number((this.db().prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'merge_%'").get() as Row).count); }
  private db(): DatabaseSync { if (!this.database) throw new MergeAuthorizationError('STORE_INTEGRITY_FAILED'); return this.database; }
}
function mergeModeRefusal(code: ModeSafeCodeV1): VerdictMergeSafeCode {
  if (code === 'PLAN_MUTATION_REFUSED' || code === 'BUILD_MERGE_REFUSED') return code;
  return 'MODE_AUTHORITY_REFUSED';
}

export class MergeAuthorizationError extends Error { constructor(readonly safeCode: VerdictMergeSafeCode) { super(safeCode); this.name = 'MergeAuthorizationError'; } }
function decodeChallengeRequest(input: unknown): MergeChallengeRequestV1 { const value = closed(input, ['requestId','explanationId']); if (!UUID.test(String(value.requestId)) || !UUID.test(String(value.explanationId))) throw new MergeAuthorizationError('PROTOCOL_INVALID'); return value as unknown as MergeChallengeRequestV1; }
function decodeAuthorizeRequest(input: unknown): MergeAuthorizeRequestV1 { const value = closed(input, ['requestId','challengeId','displayedChallengeDigest','explicitHumanGesture']); if (!UUID.test(String(value.requestId)) || !UUID.test(String(value.challengeId)) || !DIGEST.test(String(value.displayedChallengeDigest)) || value.explicitHumanGesture !== true) throw new MergeAuthorizationError('PROTOCOL_INVALID'); return value as unknown as MergeAuthorizeRequestV1; }
function decodeExecuteRequest(input: unknown): MergeExecuteRequestV1 { const value = closed(input, ['requestId','authorizationId']); if (!UUID.test(String(value.requestId)) || !UUID.test(String(value.authorizationId))) throw new MergeAuthorizationError('PROTOCOL_INVALID'); return value as unknown as MergeExecuteRequestV1; }
function decodeChallengeRecord(input: unknown): ChallengeRecord { const current = ['challengeId','explanationDigest','taskRevisionId','repositoryIdentityDigest','destinationRef','expectedBaseOid','subjectOid','subjectTreeOid','mergePolicyId','issuedAt','expiresAt','challengeDigest','taskId','sessionId','authorizerRoleDigest','nonceDigest','exactBindingsDigest','projectId','repositoryId']; const legacy = current.filter(key => key !== 'projectId' && key !== 'repositoryId'); const value = closedEither(input, current, legacy); if (!UUID.test(String(value.challengeId)) || !UUID.test(String(value.taskId)) || !DIGEST.test(String(value.challengeDigest)) || (value.projectId !== undefined && (!UUID.test(String(value.projectId)) || !UUID.test(String(value.repositoryId))))) throw new Error('challenge'); return value as unknown as ChallengeRecord; }
function decodeAuthorizationRecord(input: unknown): AuthorizationRecord { const value = closed(input, ['authorizationId','challengeId','explanationDigest','exactBindingsDigest','state','recordedAt','expiresAt','actorAuthorityDigest','authorizerRoleDigest','sessionId','authorizationDigest']); if (!UUID.test(String(value.authorizationId)) || !UUID.test(String(value.challengeId)) || value.state !== 'authorized' || !DIGEST.test(String(value.authorizationDigest))) throw new Error('authorization'); return value as unknown as AuthorizationRecord; }
function decodeChallengeProjection(input: unknown): MergeChallengeProjectionV1 { const value = closed(input, ['challengeId','explanationDigest','taskRevisionId','repositoryIdentityDigest','destinationRef','expectedBaseOid','subjectOid','subjectTreeOid','mergePolicyId','issuedAt','expiresAt','challengeDigest']); if (!UUID.test(String(value.challengeId)) || !DIGEST.test(String(value.challengeDigest))) throw new Error('challenge-projection'); return value as unknown as MergeChallengeProjectionV1; }
function decodeAuthorizationProjection(input: unknown): MergeAuthorizationProjectionV1 { const value = closed(input, ['authorizationId','challengeId','explanationDigest','exactBindingsDigest','state','recordedAt','expiresAt']); if (!UUID.test(String(value.authorizationId)) || !UUID.test(String(value.challengeId)) || value.state !== 'authorized') throw new Error('authorization-projection'); return value as unknown as MergeAuthorizationProjectionV1; }
function decodeIntentRecord(input: unknown): IntentRecord { const current = ['mergeId','requestId','authorizationId','authorizationDigest','exactBindingsDigest','repositoryIdentityDigest','taskId','taskRevisionId','destinationRef','expectedOldOid','subjectOid','expectedTreeOid','mergePolicyId','state','generation','createdAt','explanationId','projectId','repositoryId']; const legacy = current.filter(key => !['explanationId','projectId','repositoryId'].includes(key)); const value = closedEither(input, current, legacy); if (!UUID.test(String(value.mergeId)) || !UUID.test(String(value.requestId)) || !UUID.test(String(value.authorizationId)) || value.state !== 'preflight-pending' || value.generation !== '1' || (value.projectId !== undefined && (!UUID.test(String(value.projectId)) || !UUID.test(String(value.repositoryId)) || !UUID.test(String(value.explanationId))))) throw new Error('intent'); return value as unknown as IntentRecord; }
function closed(input: unknown, keys: readonly string[]): Record<string, unknown> { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) throw new MergeAuthorizationError('PROTOCOL_INVALID'); return input as Record<string, unknown>; }
function closedEither(input: unknown, first: readonly string[], second: readonly string[]): Record<string, unknown> { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MergeAuthorizationError('PROTOCOL_INVALID'); const actual = Object.keys(input).sort().join(','); if (actual !== [...first].sort().join(',') && actual !== [...second].sort().join(',')) throw new MergeAuthorizationError('PROTOCOL_INVALID'); return input as Record<string, unknown>; }
function projectChallenge(record: ChallengeRecord): MergeChallengeProjectionV1 { return { challengeId: record.challengeId, explanationDigest: record.explanationDigest, taskRevisionId: record.taskRevisionId, repositoryIdentityDigest: record.repositoryIdentityDigest, destinationRef: record.destinationRef, expectedBaseOid: record.expectedBaseOid, subjectOid: record.subjectOid, subjectTreeOid: record.subjectTreeOid, mergePolicyId: record.mergePolicyId, issuedAt: record.issuedAt, expiresAt: record.expiresAt, challengeDigest: record.challengeDigest }; }
function projectAuthorization(record: AuthorizationRecord): MergeAuthorizationProjectionV1 { return { authorizationId: record.authorizationId, challengeId: record.challengeId, explanationDigest: record.explanationDigest, exactBindingsDigest: record.exactBindingsDigest, state: record.state, recordedAt: record.recordedAt, expiresAt: record.expiresAt }; }
function projectIntent(record: IntentRecord): MergeIntentProjectionV1 { return { mergeId: record.mergeId, authorizationId: record.authorizationId, destinationRef: record.destinationRef, expectedOldOid: record.expectedOldOid, subjectOid: record.subjectOid, expectedTreeOid: record.expectedTreeOid, mergePolicyId: record.mergePolicyId, state: record.state, createdAt: record.createdAt }; }
function equalDigest(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function prefixed(value: string): string { return value.startsWith('sha256:') ? value : `sha256:${value}`; }
function text(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new Error('integrity'); return value; }
function nullableText(row: Row, key: string): string | null { const value = row[key]; if (value === null) return null; if (typeof value !== 'string') throw new Error('integrity'); return value; }
function safeCode(error: unknown): VerdictMergeSafeCode { return error instanceof MergeAuthorizationError ? error.safeCode : 'INTERNAL_FAILURE'; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state')); }
function mergeOwnerOutcome(state: string): { eventKind: string; safeCode: string } { if (['committed','completed'].includes(state)) return { eventKind: 'merge.committed', safeCode: 'MERGE_COMPLETED' }; if (['refused','failed'].includes(state)) return { eventKind: 'merge.refused', safeCode: 'MERGE_NOT_COMMITTED' }; if (['recovery-required','quarantined'].includes(state)) return { eventKind: 'merge.quarantined', safeCode: state === 'quarantined' ? 'MERGE_QUARANTINED' : 'MERGE_RECOVERY_REQUIRED' }; return { eventKind: 'merge.requested', safeCode: 'MERGE_PREFLIGHT_PENDING' }; }
function mergeOwnerSourceDigest(row: Row): string { return verdictMergeDigest('owner-event', { eventId: text(row, 'event_id'), mergeId: text(row, 'merge_id'), eventKind: text(row, 'event_kind'), safeCode: text(row, 'safe_code'), taskId: text(row, 'task_id'), projectId: nullableText(row, 'project_id'), recordedAt: text(row, 'recorded_at'), state: text(row, 'state'), sourceEventDigest: text(row, 'source_event_digest'), previousSourceDigest: text(row, 'previous_source_digest') }); }
function mapMergeOwnerEvent(row: Row, ownerInstanceId: string, epochId: string, previousEventDigest: string): OwnerEventV1 { const eventKind = text(row, 'event_kind'); const decisionClass: SafeOwnerPayloadV1['decisionClass'] = eventKind === 'merge.committed' ? 'committed' : eventKind === 'merge.refused' ? 'refused' : eventKind === 'merge.quarantined' ? 'quarantined' : 'pending'; const terminalClass: SafeOwnerPayloadV1['terminalClass'] | undefined = eventKind === 'merge.committed' ? 'committed' : eventKind === 'merge.refused' ? 'refused' : eventKind === 'merge.quarantined' ? 'quarantined' : undefined; const safePayload: SafeOwnerPayloadV1 = { decisionClass, safeCode: text(row, 'safe_code'), freshness: 'current', ...(terminalClass ? { terminalClass } : {}) }; const projectId = nullableText(row, 'project_id'); const unsigned: Omit<OwnerEventV1, 'eventDigest'> = { ownerKind: 'merge', ownerInstanceId, ownerSchemaVersion: 1, epochId, sequence: String(Number(row.sequence)), eventId: text(row, 'event_id'), eventKind, factId: text(row, 'merge_id'), factDigest: text(row, 'source_digest'), previousEventDigest, causalParents: [], correlations: { taskId: text(row, 'task_id'), ...(projectId ? { projectId } : {}), mergeId: text(row, 'merge_id') }, observedAt: text(row, 'recorded_at'), safePayload }; return { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) }; }
