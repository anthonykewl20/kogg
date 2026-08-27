import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { DiagnosticStatus } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggOperationsOwnerSink, type OperationsOwnerSink, type OwnerEventV1, type SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';

// diagnostic-coverage: core.runtime, operations.owners, operations.projection

type Row = Record<string, SQLOutputValue>;

@injectable()
export class DiagnosticOwnerJournal implements BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private readonly databasePath = path.join(stateRoot(), 'diagnostics', 'owner.sqlite3');

  constructor(@inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink) {}

  async onStart(): Promise<void> {
    console.info('[kogg:core:diagnostic-owner] journal.start.requested');
    try {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, allowExtension: false });
      this.database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
      this.migrate();
      this.assertIntegrity();
      await fs.chmod(this.databasePath, 0o600).catch(error => { if (process.platform !== 'win32') throw error; });
      this.sink.registerOwner('diagnostic');
      this.publish();
      console.info('[kogg:core:diagnostic-owner] journal.start.completed', { schemaVersion: 1 });
    } catch (error) {
      console.error('[kogg:core:diagnostic-owner] journal.start.failed', { errorType: errorName(error) });
      this.database?.close(); this.database = undefined; throw error;
    }
  }

  onStop(): void {
    console.info('[kogg:core:diagnostic-owner] journal.stop.started');
    this.database?.close(); this.database = undefined;
    console.info('[kogg:core:diagnostic-owner] journal.stop.completed');
  }

  started(reportId: string, observedAt: string): void {
    this.append('diagnostic.started', reportId, observedAt, { resultClass: 'pending' });
  }

  completed(reportId: string, status: DiagnosticStatus, count: number, observedAt: string): void {
    const eventKind = status === 'pass' ? 'diagnostic.passed' : 'diagnostic.failed';
    this.append(eventKind, reportId, observedAt, {
      resultClass: status === 'pass' ? 'passed' : 'failed', count,
      ...(status === 'warn' ? { safeCode: 'DIAGNOSTIC_WARNING' } : status === 'fail' ? { safeCode: 'DIAGNOSTIC_FAILED' } : {})
    });
  }

  private append(eventKind: string, reportId: string, observedAt: string, safePayload: SafeOwnerPayloadV1): void {
    const database = this.db();
    database.exec('BEGIN IMMEDIATE');
    try {
      const prior = database.prepare('SELECT fact_digest FROM diagnostic_events ORDER BY event_sequence DESC LIMIT 1').get() as Row | undefined;
      const previous = prior ? string(prior, 'fact_digest') : '';
      const eventId = randomUUID();
      const payload = JSON.stringify(safePayload);
      const factDigest = createHash('sha256').update(JSON.stringify([eventId, eventKind, reportId, observedAt, payload, previous])).digest('hex');
      database.prepare('INSERT INTO diagnostic_events(event_id,event_kind,report_id,observed_at,safe_payload,previous_fact_digest,fact_digest) VALUES(?,?,?,?,?,?,?)')
        .run(eventId, eventKind, reportId, observedAt, payload, previous, factDigest);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      console.error('[kogg:core:diagnostic-owner] journal.append.failed', { eventKind, errorType: errorName(error) });
      throw error;
    }
    this.publish();
  }

  private publish(): void {
    const database = this.db();
    const meta = database.prepare('SELECT owner_id,epoch_id FROM diagnostic_meta WHERE singleton=1').get() as Row;
    let previous = '0'.repeat(64);
    for (const row of database.prepare('SELECT * FROM diagnostic_events ORDER BY event_sequence').all() as Row[]) {
      const unsigned: Omit<OwnerEventV1, 'eventDigest'> = {
        ownerKind: 'diagnostic', ownerInstanceId: string(meta, 'owner_id'), ownerSchemaVersion: 1, epochId: string(meta, 'epoch_id'),
        sequence: String(number(row, 'event_sequence')), eventId: string(row, 'event_id'), eventKind: string(row, 'event_kind'),
        factId: string(row, 'report_id'), factDigest: string(row, 'fact_digest'), previousEventDigest: previous,
        causalParents: [], correlations: {}, observedAt: string(row, 'observed_at'), safePayload: JSON.parse(string(row, 'safe_payload')) as SafeOwnerPayloadV1
      };
      const event = { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) };
      previous = event.eventDigest;
      try { this.sink.ingest(event); }
      catch (error) {
        console.warn('[kogg:core:diagnostic-owner] owner.publish.failed', { ownerKind: 'diagnostic', ownerSequence: event.sequence, safeCode: 'OWNER_PUBLISH_FAILED', errorType: errorName(error) });
        break;
      }
    }
  }

  private migrate(): void {
    const database = this.db();
    const version = number(database.prepare('PRAGMA user_version').get() as Row, 'user_version');
    if (version > 1) throw new Error('Diagnostic owner schema is newer than this Kogg build');
    if (version === 1) return;
    console.info('[kogg:core:diagnostic-owner] journal.migration.started', { fromVersion: version, toVersion: 1 });
    database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE diagnostic_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL,epoch_id TEXT NOT NULL);
      CREATE TABLE diagnostic_events(event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,event_kind TEXT NOT NULL,report_id TEXT NOT NULL,observed_at TEXT NOT NULL,safe_payload TEXT NOT NULL,previous_fact_digest TEXT NOT NULL,fact_digest TEXT NOT NULL UNIQUE);
      CREATE TRIGGER diagnostic_events_immutable_update BEFORE UPDATE ON diagnostic_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
      CREATE TRIGGER diagnostic_events_immutable_delete BEFORE DELETE ON diagnostic_events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
      INSERT INTO diagnostic_meta VALUES(1,'${randomUUID()}','${randomUUID()}');
      PRAGMA user_version=1; COMMIT;`);
    console.info('[kogg:core:diagnostic-owner] journal.migration.completed', { schemaVersion: 1 });
  }

  private assertIntegrity(): void {
    const database = this.db(); let previous = '';
    const rows = database.prepare('SELECT * FROM diagnostic_events ORDER BY event_sequence').all() as Row[];
    for (const row of rows) {
      const payload = string(row, 'safe_payload');
      const digest = createHash('sha256').update(JSON.stringify([string(row, 'event_id'), string(row, 'event_kind'), string(row, 'report_id'), string(row, 'observed_at'), payload, previous])).digest('hex');
      if (string(row, 'previous_fact_digest') !== previous || string(row, 'fact_digest') !== digest) throw new Error('Diagnostic owner fact chain failed integrity verification');
      previous = digest;
    }
    const quick = string(database.prepare('PRAGMA integrity_check').get() as Row, 'integrity_check');
    const triggerCount = number(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('diagnostic_events_immutable_update','diagnostic_events_immutable_delete')").get() as Row, 'count');
    if (quick !== 'ok' || triggerCount !== 2) throw new Error('Diagnostic owner journal failed integrity verification');
    console.info('[kogg:core:diagnostic-owner] journal.integrity.completed', { eventCount: rows.length });
  }

  private db(): DatabaseSync { if (!this.database) throw new Error('Diagnostic owner journal is unavailable'); return this.database; }
}

function stateRoot(): string { const root = process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(); return path.resolve(process.env.KOGG_STATE_DIR ?? path.join(root, '.kogg', 'state')); }
function string(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new Error('Diagnostic owner journal contains an invalid value'); return value; }
function number(row: Row, key: string): number { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Diagnostic owner journal contains an invalid number'); return value; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
