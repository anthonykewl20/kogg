import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { canonicalKernelJson, type KernelJson } from '@kogg/contracts';
import { KoggOperationsOwnerSink, type OperationsOwnerSink, type OwnerEventV1, type SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';

// diagnostic-coverage: kernel.protocol, operations.owners, operations.ranex-owner, operations.projection, operations.correlations

type Row = Record<string, SQLOutputValue>;
type SourceRecord = Record<string, unknown>;
const GENESIS = `sha256:${'0'.repeat(64)}`;

@injectable()
export class RanexOperationsOwner implements BackendApplicationContribution {
  private metadata: DatabaseSync | undefined;
  private readonly stateRoot = path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state'));
  private readonly journalPath = path.resolve(process.env.KOGG_RANEX_JOURNAL ?? path.join(this.stateRoot, 'ranex', 'journal.sqlite3'));

  constructor(@inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink) {}

  onStart(): void {
    console.info('[kogg:kernel:ranex-owner] owner.start.requested');
    try {
      const metadataPath = path.join(this.stateRoot, 'ranex', 'operations-owner.sqlite3');
      mkdirSync(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
      this.metadata = new DatabaseSync(metadataPath, { enableForeignKeyConstraints: true, allowExtension: false });
      this.metadata.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
      this.migrate(); this.assertMetadataIntegrity(); this.sink.registerOwner('ranex'); this.refresh();
      console.info('[kogg:kernel:ranex-owner] owner.start.completed');
    } catch (error) {
      this.metadata?.close(); this.metadata = undefined;
      console.error('[kogg:kernel:ranex-owner] owner.start.failed', { safeCode: 'KERNEL_JOURNAL_INTEGRITY', errorType: errorName(error) });
      throw error;
    }
  }

  onStop(): void {
    console.info('[kogg:kernel:ranex-owner] owner.stop.started');
    this.metadata?.close(); this.metadata = undefined;
    console.info('[kogg:kernel:ranex-owner] owner.stop.completed');
  }

  refresh(): void {
    if (!this.metadata) return;
    console.debug('[kogg:kernel:ranex-owner] owner.replay.started');
    try {
      const records = this.sourceRecords();
      const events = this.mapEvents(records);
      for (const event of events) this.sink.ingest(event);
      console.debug('[kogg:kernel:ranex-owner] owner.replay.completed', { sourceEventCount: records.length, projectedEventCount: events.length });
    } catch (error) {
      console.error('[kogg:kernel:ranex-owner] owner.replay.failed', { safeCode: 'KERNEL_JOURNAL_INTEGRITY', errorType: errorName(error) });
      throw new RanexOwnerIntegrityError(error);
    }
  }

  diagnostics(): { readonly integrity: true; readonly sourceEventCount: number; readonly projectedEventCount: number } {
    if (!this.metadata) throw new Error('Ranex owner metadata is unavailable');
    const records = this.sourceRecords();
    return { integrity: true, sourceEventCount: records.length, projectedEventCount: this.mapEvents(records).length };
  }

  private sourceRecords(): SourceRecord[] {
    if (!existsSync(this.journalPath)) return [];
    const source = new DatabaseSync(this.journalPath, { readOnly: true, allowExtension: false });
    try { return verifySource(source.prepare('SELECT seq,record,prev_link,link FROM evaluations ORDER BY seq').all() as Row[]); }
    finally { source.close(); }
  }

  private mapEvents(records: readonly SourceRecord[]): OwnerEventV1[] {
    const metadata = this.db().prepare('SELECT owner_id,epoch_id FROM ranex_owner_meta WHERE singleton=1').get() as Row;
    const bindings = new Map<string, SourceRecord>();
    for (const record of records) if (record.kind === 'kogg.task-binding.v1' && typeof record.bindingDigest === 'string' && object(record.binding)) bindings.set(record.bindingDigest, record.binding);
    const events: OwnerEventV1[] = []; let previousEventDigest = '0'.repeat(64);
    for (const record of records) {
      const mapped = this.mapRecord(record, bindings, events.length + 1, previousEventDigest, text(metadata, 'owner_id'), text(metadata, 'epoch_id'));
      if (mapped) { events.push(mapped); previousEventDigest = mapped.eventDigest; }
    }
    return events;
  }

  private mapRecord(record: SourceRecord, bindings: ReadonlyMap<string, SourceRecord>, sequence: number, previousEventDigest: string, ownerInstanceId: string, epochId: string): OwnerEventV1 | undefined {
    const evidence = record.kind === 'kogg.evidence.v1' && object(record.evidence) ? record.evidence : undefined;
    const verdict = record.kind === 'kogg.verdict.v1' && object(record.verdict) ? record.verdict : undefined;
    if (!evidence && !verdict) return undefined;
    const bindingDigest = stringValue((evidence ?? verdict)?.taskBindingDigest);
    const binding = bindings.get(bindingDigest); if (!binding) throw new Error('Ranex fact has no exact task binding');
    const eventKind = evidence ? 'evidence.admitted' : 'gate.decided';
    const factId = stringValue(evidence?.evidenceId ?? verdict?.verdictId);
    const factDigest = stripDigest(stringValue(evidence ? record.evidenceDigest : record.verdictDigest));
    const observedAt = stringValue(evidence?.createdAt ?? verdict?.evaluatedAt);
    const safePayload: SafeOwnerPayloadV1 = evidence
      ? { lifecycle: 'admitted', resultClass: 'passed', safeCode: 'KERNEL_OK', freshness: 'current' }
      : { decisionClass: decisionClass(verdict?.decision), safeCode: 'KERNEL_OK', freshness: 'current' };
    const unsigned: Omit<OwnerEventV1, 'eventDigest'> = {
      ownerKind: 'ranex', ownerInstanceId, ownerSchemaVersion: 1, epochId, sequence: String(sequence),
      eventId: factId, eventKind, factId, factDigest, previousEventDigest, causalParents: [],
      correlations: {
        taskId: stringValue(binding.taskId), projectId: stringValue(binding.projectId), runId: stringValue(binding.runId),
        ...(evidence ? { evidenceId: factId } : { verdictId: factId })
      },
      observedAt, safePayload
    };
    return { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) };
  }

  private migrate(): void {
    const database = this.db(); const version = number(database.prepare('PRAGMA user_version').get() as Row, 'user_version');
    if (version > 1) throw new Error('Ranex owner schema is newer than this Kogg build');
    if (version === 1) return;
    console.info('[kogg:kernel:ranex-owner] owner.migration.started', { fromVersion: version, toVersion: 1 });
    database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE ranex_owner_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL,epoch_id TEXT NOT NULL);
      CREATE TRIGGER ranex_owner_meta_no_update BEFORE UPDATE ON ranex_owner_meta BEGIN SELECT RAISE(ABORT,'immutable owner metadata'); END;
      CREATE TRIGGER ranex_owner_meta_no_delete BEFORE DELETE ON ranex_owner_meta BEGIN SELECT RAISE(ABORT,'immutable owner metadata'); END;
      INSERT INTO ranex_owner_meta VALUES(1,'${randomUUID()}','${randomUUID()}');
      PRAGMA user_version=1; COMMIT;`);
    console.info('[kogg:kernel:ranex-owner] owner.migration.completed', { schemaVersion: 1 });
  }

  private assertMetadataIntegrity(): void {
    const database = this.db(); const quick = text(database.prepare('PRAGMA integrity_check').get() as Row, 'integrity_check');
    const metaCount = number(database.prepare('SELECT count(*) AS count FROM ranex_owner_meta').get() as Row, 'count');
    const triggerCount = number(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('ranex_owner_meta_no_update','ranex_owner_meta_no_delete')").get() as Row, 'count');
    if (quick !== 'ok' || metaCount !== 1 || triggerCount !== 2) throw new Error('Ranex owner metadata failed integrity verification');
  }

  private db(): DatabaseSync { if (!this.metadata) throw new Error('Ranex owner metadata is unavailable'); return this.metadata; }
}

export class RanexOwnerIntegrityError extends Error {
  constructor(cause: unknown) { super('KERNEL_JOURNAL_INTEGRITY', { cause }); this.name = 'RanexOwnerIntegrityError'; }
}

function verifySource(rows: readonly Row[]): SourceRecord[] {
  let previous = GENESIS; const records: SourceRecord[] = [];
  for (let index = 0; index < rows.length; index++) {
    if (number(rows[index]!, 'seq') !== index + 1 || text(rows[index]!, 'prev_link') !== previous) throw new Error('Ranex journal sequence failed integrity verification');
    const parsed = JSON.parse(text(rows[index]!, 'record')) as unknown;
    if (!object(parsed) || canonicalKernelJson(parsed as KernelJson) !== text(rows[index]!, 'record')) throw new Error('Ranex journal record is not canonical');
    const link = `sha256:${createHash('sha256').update(canonicalKernelJson({ prev_link: previous, record: parsed } as KernelJson), 'utf8').digest('hex')}`;
    if (text(rows[index]!, 'link') !== link) throw new Error('Ranex journal link failed integrity verification');
    previous = link; records.push(parsed);
  }
  return records;
}

function object(value: unknown): value is SourceRecord { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stringValue(value: unknown): string { if (typeof value !== 'string' || value.length === 0) throw new Error('Ranex owner source contains an invalid string'); return value; }
function stripDigest(value: string): string { const digest = value.startsWith('sha256:') ? value.slice(7) : value; if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error('Ranex owner source contains an invalid digest'); return digest; }
function decisionClass(value: unknown): 'accepted' | 'rejected' | 'refused' { return value === 'pass' ? 'accepted' : value === 'fail' ? 'rejected' : value === 'blocked' ? 'refused' : (() => { throw new Error('Ranex owner source contains an invalid decision'); })(); }
function text(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new Error('Ranex owner storage contains an invalid string'); return value; }
function number(row: Row, key: string): number { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Ranex owner storage contains an invalid number'); return value; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
