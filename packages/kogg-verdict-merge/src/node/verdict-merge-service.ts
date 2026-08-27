import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import type { KoggVerdictMergeService, MergeCandidateProjectionV1, VerdictExplanationResultV1, VerdictExplanationV1, VerdictMergeSafeCode } from '../common/verdict-merge-protocol';
import { canonicalJson, decodeVerdictQuery, validateExplanation, VerdictMergeProtocolError, verdictMergeDigest } from '../common/verdict-merge-canonical';
import { VerdictProjectionAuthority } from './verdict-projection-authority';
import type { OperationsOwnerSink, OwnerEventV1, SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';

// Persists only closed safe query/explanation projections. Raw Ranex evidence, journal bodies, paths, refs, object ids, and identities never enter logs.
// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation, merge.authorization, merge.preflight, merge.processes, merge.atomicity, merge.recovery, merge.source-maps
type Row = Record<string, SQLOutputValue>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
@injectable()
export class VerdictMergeService implements KoggVerdictMergeService, BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private ownerSink: OperationsOwnerSink | undefined;
  constructor(@inject(VerdictProjectionAuthority) private readonly authority: VerdictProjectionAuthority, @unmanaged() private readonly databasePath = path.join(stateRoot(), 'verdict-merge', 'registry.sqlite3')) {}
  async onStart(): Promise<void> { console.info('[kogg:verdict:service] recovery.started'); try { await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 }); this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false }); this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;'); this.migrate(); this.assertIntegrity(); this.publishOwnerEvents(); if (process.platform !== 'win32') await fs.chmod(this.databasePath, 0o600); console.info('[kogg:verdict:service] recovery.completed', { explanationCount: this.count() }); } catch (error) { this.database?.close(); this.database = undefined; console.error('[kogg:verdict:service] recovery.failed', { errorType: error instanceof Error ? error.name : 'UnknownError', safeCode: 'STORE_INTEGRITY_FAILED' }); throw new Error('STORE_INTEGRITY_FAILED'); } }
  onStop(): void { console.info('[kogg:verdict:service] shutdown.started'); this.ownerSink = undefined; this.database?.close(); this.database = undefined; console.info('[kogg:verdict:service] shutdown.completed'); }
  setOwnerSink(sink?: OperationsOwnerSink): void { this.ownerSink = sink; if (sink && this.database) this.publishOwnerEvents(); }
  publishOwnerEvents(): void {
    if (!this.ownerSink || !this.database) return; const meta = this.db().prepare('SELECT owner_id,owner_epoch_id FROM verdict_owner_meta WHERE singleton=1').get() as Row; let previous = '0'.repeat(64);
    for (const row of this.db().prepare('SELECT * FROM verdict_owner_events ORDER BY sequence').all() as Row[]) {
      if (text(row, 'previous_source_digest') !== sourcePrevious(this.db(), Number(row.sequence)) || ownerSourceDigest(row) !== text(row, 'source_digest')) { console.error('[kogg:verdict:owners] owner.publish.failed', { ownerKind: 'verdict', safeCode: 'STORE_INTEGRITY_FAILED', errorType: 'OwnerEventIntegrityError' }); break; }
      const mapped = mapOwnerEvent(row, text(meta, 'owner_id'), text(meta, 'owner_epoch_id'), previous); previous = mapped.eventDigest;
      try { this.ownerSink.ingest(mapped); }
      catch (error) { // observability-exempt: closed publication failure includes only owner kind, sequence, safe code, and normalized error type.
        console.error('[kogg:verdict:owners] owner.publish.failed', { ownerKind: 'verdict', ownerSequence: mapped.sequence, safeCode: 'STORE_INTEGRITY_FAILED', errorType: error instanceof Error ? error.name : 'UnknownError' }); break;
      }
    }
  }
  async explain(input: unknown): Promise<VerdictExplanationResultV1> {
    let requestId = 'invalid'; let queryId = 'invalid';
    try { const query = decodeVerdictQuery(input); requestId = query.requestId; queryId = query.queryId; const queryDigest = verdictMergeDigest('query', query); console.info('[kogg:verdict:service] explanation.requested', { requestId, queryId });
      const replay = this.db().prepare('SELECT query_digest,result_json FROM requests WHERE request_id=?').get(requestId) as Row | undefined; if (replay) { if (text(replay,'query_digest') !== queryDigest) return this.refused(requestId, queryId, 'REQUEST_CONFLICT'); const result = JSON.parse(text(replay,'result_json')) as VerdictExplanationResultV1; return result.kind === 'completed' ? { ...result, replay: true } : result; }
      console.info('[kogg:verdict:service] verification.started', { requestId, queryId }); const projection = await this.authority.explain(query, queryDigest);
      if (!projection) { const result = this.refused(requestId, queryId, 'VERDICT_UNKNOWN'); this.storeRequest(requestId, queryDigest, canonicalJson(query), result, query); return result; }
      const explanation = validateExplanation(projection, query, queryDigest); const safeCode = outcome(explanation); const result: VerdictExplanationResultV1 = { kind: 'completed', safeCode, explanation, replay: false };
      this.transaction(() => { this.db().prepare('INSERT INTO explanations(explanation_id,query_digest,explanation_digest,explanation_json,created_at) VALUES(?,?,?,?,?)').run(explanation.explanationId, queryDigest, explanation.explanationDigest, canonicalJson(explanation), explanation.verifiedAt); this.db().prepare('INSERT INTO requests(request_id,query_digest,query_json,result_json) VALUES(?,?,?,?)').run(requestId, queryDigest, canonicalJson(query), JSON.stringify(result)); this.appendOwnerEvent(query, result, explanation.verifiedAt); });
      console.info('[kogg:verdict:currentness]', explanation.currentness, { requestId, queryId, safeCode }); console.info('[kogg:verdict:service] explanation.completed', { requestId, queryId, safeCode, gateCount: explanation.gateRows.length }); return result;
    } catch (error) { /* observability-exempt: refused logs the closed failure code and safe request identifiers for this path. */ const safeCode: VerdictMergeSafeCode = error instanceof VerdictMergeProtocolError ? 'PROTOCOL_INVALID' : error instanceof Error && error.message === 'STORE_INTEGRITY_FAILED' ? 'STORE_INTEGRITY_FAILED' : 'INTERNAL_FAILURE'; return this.refused(requestId, queryId, safeCode); }
  }
  async mergeCandidates(): Promise<readonly MergeCandidateProjectionV1[]> {
    console.info('[kogg:verdict:service] candidates.requested');
    try {
      this.assertIntegrity(); const candidates: MergeCandidateProjectionV1[] = [];
      for (const row of this.db().prepare('SELECT e.explanation_json,r.query_json FROM explanations e JOIN requests r ON r.query_digest=e.query_digest ORDER BY e.created_at DESC LIMIT 100').all() as Row[]) {
        const explanation = JSON.parse(text(row, 'explanation_json')) as VerdictExplanationV1; const query = decodeVerdictQuery(JSON.parse(text(row, 'query_json')) as unknown);
        candidates.push({ explanationId: explanation.explanationId, ranexDecision: explanation.ranexDecision, currentness: explanation.currentness, destinationRef: query.destinationRef, expectedBaseOid: query.expectedBaseOid, subjectOid: query.subjectOid, subjectTreeOid: query.subjectTreeOid, mergePolicyId: 'local-two-parent-no-ff-v1', requiredCount: explanation.requiredCount, passCount: explanation.passCount, failCount: explanation.failCount, blockedCount: explanation.blockedCount, expiresAt: explanation.expiresAt });
      }
      console.info('[kogg:verdict:service] candidates.completed', { candidateCount: candidates.length }); return candidates;
    } catch (error) { console.error('[kogg:verdict:service] candidates.failed', { errorType: error instanceof Error ? error.name : 'UnknownError', safeCode: 'STORE_INTEGRITY_FAILED' }); return []; }
  }
  diagnostics() { this.assertIntegrity(); const explanationCount = this.count(); const sourceMapsPresent = existsSync(`${__filename}.map`) && existsSync(path.join(__dirname, 'verdict-projection-authority.js.map')); return { integrity: true, explanationCount, provenanceReady: explanationCount > 0, bindingsReady: explanationCount > 0, currentnessReady: explanationCount > 0, explanationReady: explanationCount > 0, authorizationReady: false, preflightReady: false, processCount: 0, residualProcessCount: 0, atomicityReady: false, recoveryReady: true, sourceMapsPresent }; }
  async currentAuthorizationBinding(explanationId: string, now: Date): Promise<{ readonly query: ReturnType<typeof decodeVerdictQuery>; readonly explanation: VerdictExplanationV1 } | undefined> {
    this.assertIntegrity();
    const row = this.db().prepare('SELECT r.query_json,e.query_digest,e.explanation_json FROM explanations e JOIN requests r ON r.query_digest=e.query_digest WHERE e.explanation_id=?').get(explanationId) as Row | undefined;
    if (!row) { console.warn('[kogg:verdict:service] authorization-currentness.refused', { explanationId, safeCode: 'VERDICT_UNKNOWN' }); return undefined; }
    const query = decodeVerdictQuery(JSON.parse(text(row, 'query_json')) as unknown); const digest = text(row, 'query_digest');
    const stored = JSON.parse(text(row, 'explanation_json')) as VerdictExplanationV1;
    if (stored.ranexDecision !== 'pass' || stored.currentness !== 'current' || Date.parse(stored.expiresAt) <= now.getTime()) { const safeCode = Date.parse(stored.expiresAt) <= now.getTime() ? 'AUTHORIZATION_EXPIRED' : outcome(stored); console.warn('[kogg:verdict:service] authorization-currentness.refused', { explanationId: stored.explanationId, queryId: query.queryId, safeCode }); return undefined; }
    console.info('[kogg:verdict:service] authorization-currentness.started', { explanationId: stored.explanationId, queryId: query.queryId });
    const projection = await this.authority.explain(query, digest); if (!projection) { console.warn('[kogg:verdict:service] authorization-currentness.refused', { explanationId: stored.explanationId, queryId: query.queryId, safeCode: 'VERDICT_UNKNOWN' }); return undefined; }
    const refreshed = validateExplanation(projection, query, digest);
    if (refreshed.explanationDigest !== stored.explanationDigest || refreshed.ranexDecision !== 'pass' || refreshed.currentness !== 'current' || Date.parse(refreshed.expiresAt) <= now.getTime()) { console.warn('[kogg:verdict:service] authorization-currentness.refused', { explanationId: stored.explanationId, queryId: query.queryId, safeCode: 'VERDICT_UNKNOWN' }); return undefined; }
    console.info('[kogg:verdict:service] authorization-currentness.completed', { explanationId: stored.explanationId, queryId: query.queryId, safeCode: 'VERDICT_OK' });
    return { query, explanation: stored };
  }
  private refused(requestId: string, queryId: string, safeCode: VerdictMergeSafeCode): VerdictExplanationResultV1 { console.warn('[kogg:verdict:currentness] unknown', { requestId, queryId, safeCode }); console.warn('[kogg:verdict:service] explanation.refused', { requestId, queryId, safeCode }); return { kind: 'refused', safeCode }; }
  private storeRequest(requestId: string, queryDigest: string, queryJson: string, result: VerdictExplanationResultV1, query: ReturnType<typeof decodeVerdictQuery>): void { this.transaction(() => { this.db().prepare('INSERT INTO requests(request_id,query_digest,query_json,result_json) VALUES(?,?,?,?)').run(requestId, queryDigest, queryJson, JSON.stringify(result)); this.appendOwnerEvent(query, result, new Date().toISOString()); }); }
  private migrate(): void {
    this.db().exec('CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY,query_digest TEXT NOT NULL,query_json TEXT NOT NULL,result_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS explanations(explanation_id TEXT PRIMARY KEY,query_digest TEXT NOT NULL UNIQUE,explanation_digest TEXT NOT NULL UNIQUE,explanation_json TEXT NOT NULL,created_at TEXT NOT NULL);');
    const requestColumns = new Set((this.db().prepare('PRAGMA table_info(requests)').all() as Row[]).map(row => text(row, 'name'))); if (!requestColumns.has('query_json')) this.db().exec("ALTER TABLE requests ADD COLUMN query_json TEXT NOT NULL DEFAULT ''");
    this.db().exec(`CREATE TABLE IF NOT EXISTS verdict_owner_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL,owner_epoch_id TEXT NOT NULL,identity_digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verdict_owner_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,event_kind TEXT NOT NULL,fact_id TEXT NOT NULL,safe_code TEXT NOT NULL,task_id TEXT NOT NULL,project_id TEXT NOT NULL,observed_at TEXT NOT NULL,source_fact_digest TEXT NOT NULL,previous_source_digest TEXT NOT NULL,source_digest TEXT NOT NULL UNIQUE);
      CREATE TRIGGER IF NOT EXISTS verdict_requests_update BEFORE UPDATE ON requests BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS verdict_requests_delete BEFORE DELETE ON requests BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS verdict_explanations_update BEFORE UPDATE ON explanations BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS verdict_explanations_delete BEFORE DELETE ON explanations BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS verdict_owner_meta_update BEFORE UPDATE ON verdict_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS verdict_owner_meta_delete BEFORE DELETE ON verdict_owner_meta BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS verdict_owner_events_update BEFORE UPDATE ON verdict_owner_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS verdict_owner_events_delete BEFORE DELETE ON verdict_owner_events BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    if (!this.db().prepare('SELECT 1 FROM verdict_owner_meta WHERE singleton=1').get()) { const ownerId = randomUUID(); const ownerEpochId = randomUUID(); this.db().prepare('INSERT INTO verdict_owner_meta VALUES(1,?,?,?)').run(ownerId, ownerEpochId, verdictMergeDigest('owner-identity', { ownerId, ownerEpochId })); }
    if (!this.db().prepare('SELECT 1 FROM verdict_owner_events LIMIT 1').get()) {
      for (const row of this.db().prepare('SELECT e.explanation_json,r.query_json FROM explanations e JOIN requests r ON r.query_digest=e.query_digest ORDER BY e.created_at,e.explanation_id').all() as Row[]) { const query = decodeVerdictQuery(JSON.parse(text(row, 'query_json')) as unknown); const explanation = JSON.parse(text(row, 'explanation_json')) as VerdictExplanationV1; this.appendOwnerEvent(query, { kind: 'completed', safeCode: outcome(explanation), explanation, replay: false }, explanation.verifiedAt); }
    }
  }
  private assertIntegrity(): void { try { this.verifyIntegrity(); } catch { /* observability-exempt: Normalize closed parser and storage failures; startup and request callers log the safe refusal. */ throw new Error('STORE_INTEGRITY_FAILED'); } }
  private verifyIntegrity(): void {
    if (text(this.db().prepare('PRAGMA quick_check').get() as Row,'quick_check') !== 'ok' || Number((this.db().prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'verdict_%'").get() as Row).count) !== 8 || !this.ownerFactsValid()) throw new Error('integrity');
    const queries = new Map<string, ReturnType<typeof decodeVerdictQuery>>(); const results = new Map<string, VerdictExplanationResultV1>();
    for (const row of this.db().prepare('SELECT * FROM requests').all() as Row[]) { const query = decodeVerdictQuery(JSON.parse(text(row,'query_json')) as unknown); const digest = verdictMergeDigest('query', query); if (digest !== text(row,'query_digest') || query.requestId !== text(row,'request_id')) throw new Error('query'); queries.set(digest, query); results.set(digest, decodeStoredResult(JSON.parse(text(row, 'result_json')) as unknown)); }
    const explanations = new Map<string, VerdictExplanationV1>();
    for (const row of this.db().prepare('SELECT * FROM explanations').all() as Row[]) { const stored = JSON.parse(text(row,'explanation_json')) as VerdictExplanationV1; const digest = text(row,'query_digest'); const query = queries.get(digest); if (!query) throw new Error('orphan'); const { explanationDigest: _storedDigest, ...body } = stored; const validated = validateExplanation(body, query, digest); if (validated.explanationDigest !== text(row,'explanation_digest') || validated.explanationId !== text(row,'explanation_id') || canonicalJson(validated) !== canonicalJson(stored)) throw new Error('explanation'); explanations.set(digest, validated); }
    for (const [digest, result] of results) { if (result.kind === 'completed') { const explanation = explanations.get(digest); if (!explanation || result.replay || result.safeCode !== outcome(explanation) || canonicalJson(result.explanation) !== canonicalJson(explanation)) throw new Error('result'); } else if (result.kind !== 'refused' || result.safeCode !== 'VERDICT_UNKNOWN') throw new Error('refusal'); }
    if (explanations.size !== [...results.values()].filter(result => result.kind === 'completed').length) throw new Error('unreferenced');
  }
  private appendOwnerEvent(query: ReturnType<typeof decodeVerdictQuery>, result: VerdictExplanationResultV1, observedAt: string): void {
    const prior = this.db().prepare('SELECT source_digest FROM verdict_owner_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined; const previousSourceDigest = prior ? text(prior, 'source_digest') : '0'.repeat(64); const eventId = randomUUID();
    const completed = result.kind === 'completed'; const eventKind = completed ? result.safeCode === 'VERDICT_OK' ? 'verdict.accepted' : result.safeCode === 'VERDICT_FAIL' ? 'verdict.rejected' : 'verdict.unknown' : 'verdict.unknown'; const factId = completed ? result.explanation.explanationId : query.queryId; const sourceFactDigest = completed ? result.explanation.explanationDigest : verdictMergeDigest('query', query); const safeCode = result.safeCode;
    const body = { eventId, eventKind, factId, safeCode, taskId: query.taskId, projectId: query.projectId, observedAt, sourceFactDigest, previousSourceDigest }; const sourceDigest = verdictMergeDigest('owner-event', body);
    this.db().prepare('INSERT INTO verdict_owner_events(event_id,event_kind,fact_id,safe_code,task_id,project_id,observed_at,source_fact_digest,previous_source_digest,source_digest) VALUES(?,?,?,?,?,?,?,?,?,?)').run(eventId, eventKind, factId, safeCode, query.taskId, query.projectId, observedAt, sourceFactDigest, previousSourceDigest, sourceDigest);
  }
  private ownerFactsValid(): boolean {
    const meta = this.db().prepare('SELECT * FROM verdict_owner_meta WHERE singleton=1').get() as Row | undefined; if (!meta) return false; const ownerId = text(meta, 'owner_id'); const ownerEpochId = text(meta, 'owner_epoch_id'); if (!UUID.test(ownerId) || !UUID.test(ownerEpochId) || text(meta, 'identity_digest') !== verdictMergeDigest('owner-identity', { ownerId, ownerEpochId })) return false;
    let previous = '0'.repeat(64); for (const row of this.db().prepare('SELECT * FROM verdict_owner_events ORDER BY sequence').all() as Row[]) { if (text(row, 'previous_source_digest') !== previous || ownerSourceDigest(row) !== text(row, 'source_digest')) return false; previous = text(row, 'source_digest'); } return true;
  }
  private transaction(action: () => void): void { this.db().exec('BEGIN IMMEDIATE'); try { action(); this.db().exec('COMMIT'); } catch (error) { try { this.db().exec('ROLLBACK'); } catch { /* observability-exempt: original closed refusal remains authoritative. */ } throw error; } this.publishOwnerEvents(); }
  private count(): number { return Number((this.db().prepare('SELECT count(*) AS count FROM explanations').get() as Row).count); }
  private db(): DatabaseSync { if (!this.database) throw new Error('STORE_INTEGRITY_FAILED'); return this.database; }
}
function text(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new Error('STORE_INTEGRITY_FAILED'); return value; }
function decodeStoredResult(input: unknown): VerdictExplanationResultV1 { if (!input || typeof input !== 'object') throw new Error('result'); const value = input as Record<string, unknown>; const keys = Object.keys(value).sort().join(','); if (value.kind === 'refused' && keys === 'kind,safeCode' && value.safeCode === 'VERDICT_UNKNOWN') return value as unknown as VerdictExplanationResultV1; if (value.kind === 'completed' && keys === 'explanation,kind,replay,safeCode' && value.replay === false && ['VERDICT_OK','VERDICT_FAIL','VERDICT_BLOCKED','VERDICT_STALE','VERDICT_UNKNOWN'].includes(String(value.safeCode))) return value as unknown as VerdictExplanationResultV1; throw new Error('result'); }
function outcome(value: VerdictExplanationV1): 'VERDICT_OK'|'VERDICT_FAIL'|'VERDICT_BLOCKED'|'VERDICT_STALE'|'VERDICT_UNKNOWN' { if (value.currentness === 'stale') return 'VERDICT_STALE'; if (value.currentness === 'unknown') return 'VERDICT_UNKNOWN'; return value.ranexDecision === 'pass' ? 'VERDICT_OK' : value.ranexDecision === 'fail' ? 'VERDICT_FAIL' : 'VERDICT_BLOCKED'; }
function stateRoot(): string { return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg', 'state')); }
function sourcePrevious(database: DatabaseSync, sequence: number): string { const row = database.prepare('SELECT source_digest FROM verdict_owner_events WHERE sequence<? ORDER BY sequence DESC LIMIT 1').get(sequence) as Row | undefined; return row ? text(row, 'source_digest') : '0'.repeat(64); }
function ownerSourceDigest(row: Row): string { return verdictMergeDigest('owner-event', { eventId: text(row, 'event_id'), eventKind: text(row, 'event_kind'), factId: text(row, 'fact_id'), safeCode: text(row, 'safe_code'), taskId: text(row, 'task_id'), projectId: text(row, 'project_id'), observedAt: text(row, 'observed_at'), sourceFactDigest: text(row, 'source_fact_digest'), previousSourceDigest: text(row, 'previous_source_digest') }); }
function mapOwnerEvent(row: Row, ownerInstanceId: string, epochId: string, previousEventDigest: string): OwnerEventV1 {
  const eventKind = text(row, 'event_kind'); const decisionClass: SafeOwnerPayloadV1['decisionClass'] = eventKind === 'verdict.accepted' ? 'accepted' : eventKind === 'verdict.rejected' ? 'rejected' : 'unknown'; const safePayload: SafeOwnerPayloadV1 = { decisionClass, safeCode: text(row, 'safe_code'), freshness: 'current' };
  const unsigned: Omit<OwnerEventV1, 'eventDigest'> = { ownerKind: 'verdict', ownerInstanceId, ownerSchemaVersion: 1, epochId, sequence: String(Number(row.sequence)), eventId: text(row, 'event_id'), eventKind, factId: text(row, 'fact_id'), factDigest: text(row, 'source_digest'), previousEventDigest, causalParents: [], correlations: { taskId: text(row, 'task_id'), projectId: text(row, 'project_id') }, observedAt: text(row, 'observed_at'), safePayload };
  return { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) };
}
