import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { KoggOperationsOwnerSink, type OperationsOwnerSink, type OwnerEventV1, type SafeOwnerPayloadV1 } from '@kogg/operations/lib/common/operations-read-model-protocol';
import { OperationsReadModel } from '@kogg/operations/lib/node/operations-read-model';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import { RanexOwnerIntegrityError, readVerifiedRanexJournal, type RanexSourceRecord } from './ranex-operations-owner';

// diagnostic-coverage: kernel.checks, operations.owners, operations.check-owner, operations.projection, operations.correlations

type Row = Record<string, SQLOutputValue>;

@injectable()
export class CheckOperationsOwner implements BackendApplicationContribution {
  private metadata: DatabaseSync | undefined;
  private readonly stateRoot = path.resolve(process.env.KOGG_STATE_DIR ?? path.join(process.env.KOGG_ROOT ? path.resolve(process.env.KOGG_ROOT) : process.cwd(), '.kogg', 'state'));
  private readonly journalPath = path.resolve(process.env.KOGG_RANEX_JOURNAL ?? path.join(this.stateRoot, 'ranex', 'journal.sqlite3'));

  constructor(@inject(KoggOperationsOwnerSink) private readonly sink: OperationsOwnerSink) {}

  onStart(): void {
    console.info('[kogg:kernel:check-owner] owner.start.requested');
    try {
      const metadataPath = path.join(this.stateRoot, 'ranex', 'check-operations-owner.sqlite3');
      mkdirSync(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
      this.metadata = new DatabaseSync(metadataPath, { enableForeignKeyConstraints: true, allowExtension: false });
      this.metadata.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
      this.migrate(); this.assertMetadataIntegrity(); this.sink.registerOwner('check'); this.refresh();
      console.info('[kogg:kernel:check-owner] owner.start.completed');
    } catch (error) {
      this.metadata?.close(); this.metadata = undefined;
      console.error('[kogg:kernel:check-owner] owner.start.failed', { safeCode: 'KERNEL_JOURNAL_INTEGRITY', errorType: errorName(error) });
      throw error;
    }
  }

  onStop(): void {
    console.info('[kogg:kernel:check-owner] owner.stop.started');
    this.metadata?.close(); this.metadata = undefined;
    console.info('[kogg:kernel:check-owner] owner.stop.completed');
  }

  refresh(): void {
    if (!this.metadata) return;
    console.debug('[kogg:kernel:check-owner] owner.replay.started');
    try {
      const records = readVerifiedRanexJournal(this.journalPath); const events = this.mapEvents(records);
      for (const event of events) this.sink.ingest(event);
      console.debug('[kogg:kernel:check-owner] owner.replay.completed', { sourceEventCount: records.length, projectedEventCount: events.length });
    } catch (error) {
      console.error('[kogg:kernel:check-owner] owner.replay.failed', { safeCode: 'KERNEL_JOURNAL_INTEGRITY', errorType: errorName(error) });
      throw new RanexOwnerIntegrityError(error);
    }
  }

  diagnostics(): { readonly integrity: true; readonly sourceEventCount: number; readonly projectedEventCount: number } {
    if (!this.metadata) throw new Error('Check owner metadata is unavailable');
    const records = readVerifiedRanexJournal(this.journalPath);
    return { integrity: true, sourceEventCount: records.length, projectedEventCount: this.mapEvents(records).length };
  }

  private mapEvents(records: readonly RanexSourceRecord[]): OwnerEventV1[] {
    const metadata = this.db().prepare('SELECT owner_id,epoch_id FROM check_owner_meta WHERE singleton=1').get() as Row;
    const bindings = new Map<string, RanexSourceRecord>();
    for (const record of records) if (record.kind === 'kogg.task-binding.v1') {
      const digest = stringValue(record.bindingDigest);
      if (!object(record.binding) || bindings.has(digest)) throw new Error('Check owner source contains an invalid or ambiguous task binding');
      bindings.set(digest, record.binding);
    }
    const suites = new Map<string, RanexSourceRecord>();
    for (const record of records) if (record.kind === 'kogg.frozen-suite.v1') {
      const digest = stringValue(record.suiteDigest);
      if (!object(record.suite) || suites.has(digest)) throw new Error('Check owner source contains an invalid or ambiguous frozen suite');
      suites.set(digest, record.suite);
    }
    const events: OwnerEventV1[] = []; let previousEventDigest = '0'.repeat(64);
    const factIds = new Set<string>();
    for (const record of records) {
      if (record.kind !== 'kogg.check-execution.v1') continue;
      if (!object(record.execution)) throw new Error('Check owner source contains an invalid check execution');
      const execution = record.execution; const suite = suites.get(stringValue(execution.suiteDigest));
      const binding = suite ? bindings.get(stringValue(suite.taskBindingDigest)) : undefined;
      if (!suite || !binding) throw new Error('Check fact has no exact suite and task binding');
      const outcome = checkOutcome(execution.outcome); const factId = stringValue(execution.executionId);
      if (factIds.has(factId)) throw new Error('Check owner source contains an ambiguous check execution');
      factIds.add(factId);
      const unsigned: Omit<OwnerEventV1, 'eventDigest'> = {
        ownerKind: 'check', ownerInstanceId: text(metadata, 'owner_id'), ownerSchemaVersion: 1, epochId: text(metadata, 'epoch_id'),
        sequence: String(events.length + 1), eventId: factId, eventKind: outcome.eventKind, factId,
        factDigest: stripDigest(stringValue(record.executionDigest)), previousEventDigest, causalParents: [],
        correlations: { taskId: stringValue(binding.taskId), projectId: stringValue(binding.projectId), runId: stringValue(binding.runId), checkId: factId },
        observedAt: stringValue(execution.finishedAt),
        safePayload: { lifecycle: outcome.eventKind === 'check.passed' ? 'completed' : 'failed', resultClass: outcome.eventKind === 'check.passed' ? 'passed' : 'failed', safeCode: outcome.safeCode, freshness: 'current' } satisfies SafeOwnerPayloadV1
      };
      const event = { ...unsigned, eventDigest: OperationsReadModel.digest(unsigned) }; events.push(event); previousEventDigest = event.eventDigest;
    }
    return events;
  }

  private migrate(): void {
    const database = this.db(); const version = number(database.prepare('PRAGMA user_version').get() as Row, 'user_version');
    if (version > 1) throw new Error('Check owner schema is newer than this Kogg build');
    if (version === 1) return;
    console.info('[kogg:kernel:check-owner] owner.migration.started', { fromVersion: version, toVersion: 1 });
    database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE check_owner_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL,epoch_id TEXT NOT NULL);
      CREATE TRIGGER check_owner_meta_no_update BEFORE UPDATE ON check_owner_meta BEGIN SELECT RAISE(ABORT,'immutable owner metadata'); END;
      CREATE TRIGGER check_owner_meta_no_delete BEFORE DELETE ON check_owner_meta BEGIN SELECT RAISE(ABORT,'immutable owner metadata'); END;
      INSERT INTO check_owner_meta VALUES(1,'${randomUUID()}','${randomUUID()}');
      PRAGMA user_version=1; COMMIT;`);
    console.info('[kogg:kernel:check-owner] owner.migration.completed', { schemaVersion: 1 });
  }

  private assertMetadataIntegrity(): void {
    const database = this.db(); const quick = text(database.prepare('PRAGMA integrity_check').get() as Row, 'integrity_check');
    const metaCount = number(database.prepare('SELECT count(*) AS count FROM check_owner_meta').get() as Row, 'count');
    const triggerCount = number(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('check_owner_meta_no_update','check_owner_meta_no_delete')").get() as Row, 'count');
    if (quick !== 'ok' || metaCount !== 1 || triggerCount !== 2) throw new Error('Check owner metadata failed integrity verification');
  }

  private db(): DatabaseSync { if (!this.metadata) throw new Error('Check owner metadata is unavailable'); return this.metadata; }
}

function object(value: unknown): value is RanexSourceRecord { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stringValue(value: unknown): string { if (typeof value !== 'string' || value.length === 0) throw new Error('Check owner source contains an invalid string'); return value; }
function stripDigest(value: string): string { const digest = value.startsWith('sha256:') ? value.slice(7) : value; if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error('Check owner source contains an invalid digest'); return digest; }
function checkOutcome(value: unknown): { readonly eventKind: 'check.passed' | 'check.failed'; readonly safeCode: 'KERNEL_OK' | 'KERNEL_CHECK_FAILED' | 'KERNEL_CHECK_TIMEOUT' | 'KERNEL_CHECK_INFRASTRUCTURE' } {
  if (value === 'pass') return { eventKind: 'check.passed', safeCode: 'KERNEL_OK' };
  if (value === 'fail') return { eventKind: 'check.failed', safeCode: 'KERNEL_CHECK_FAILED' };
  if (value === 'timeout') return { eventKind: 'check.failed', safeCode: 'KERNEL_CHECK_TIMEOUT' };
  if (value === 'cancelled' || value === 'infrastructure') return { eventKind: 'check.failed', safeCode: 'KERNEL_CHECK_INFRASTRUCTURE' };
  throw new Error('Check owner source contains an invalid outcome');
}
function text(row: Row, key: string): string { const value = row[key]; if (typeof value !== 'string') throw new Error('Check owner storage contains an invalid string'); return value; }
function number(row: Row, key: string): number { const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Check owner storage contains an invalid number'); return value; }
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
