import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import type { OperationsSupportExportContentV1, OperationsSupportExportReceiptV1, OperationsSupportExportRequestV1 } from '../common/operations-read-model-protocol';
import { OperationsReadModel, ProjectionFault } from './operations-read-model';

// diagnostic-coverage: operations.support, operations.projection, operations.metrics, operations.processes

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_BYTES = 10 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60_000;
const PROHIBITED_KEYS = new Set(['prompt', 'code', 'source', 'diff', 'path', 'command', 'arguments', 'argv', 'environment', 'env', 'credential', 'authorization', 'cookie', 'personalData', 'rawBody', 'requestBody', 'responseBody']);

@injectable()
export class OperationsSupportExporter {
  private readonly directory: string;
  constructor(@inject(OperationsReadModel) private readonly projection: OperationsReadModel,
    @unmanaged() directory = path.join(process.env.KOGG_STATE_DIR ?? path.join(process.cwd(), '.kogg-state'), 'operations', 'support')) { this.directory = directory; }

  async export(request: OperationsSupportExportRequestV1): Promise<OperationsSupportExportReceiptV1> {
    validateRequest(request); console.info('[kogg:operations:support] export.requested', { requestId: request.requestId, runId: request.runId });
    try {
      await this.expire();
      const snapshot = this.projection.snapshot();
      const runs = request.runId ? snapshot.runs.filter(run => run.runId === request.runId) : snapshot.runs;
      if (request.runId && !runs.length) throw new ProjectionFault('SUPPORT_SCOPE_UNKNOWN');
      const createdAt = new Date(); const expiresAt = new Date(createdAt.getTime() + RETENTION_MS).toISOString(); const exportId = randomUUID();
      const document = { schemaVersion: 1, exportId, createdAt: createdAt.toISOString(), expiresAt, projection: { schemaVersion: 1, projectionEpoch: snapshot.projectionEpoch, changeSequence: snapshot.changeSequence, lifecycle: snapshot.lifecycle, faultCount: snapshot.faultCount, runs }, timelines: Object.fromEntries(runs.map(run => [run.runId, this.projection.timeline(run.runId, 200)])), metrics: this.projection.metrics(), diagnostics: this.projection.diagnostics() };
      assertSafe(document); const content = JSON.stringify(document); const byteLength = Buffer.byteLength(content, 'utf8');
      if (byteLength > MAX_BYTES) throw new ProjectionFault('SUPPORT_EXPORT_TOO_LARGE');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const target = this.file(exportId); const temporary = `${target}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temporary, target); }
      catch (error) { await rm(temporary, { force: true }).catch(cleanupError => console.warn('[kogg:operations:support] export.refused', { safeCode: 'SUPPORT_TEMP_CLEANUP_FAILED', errorType: errorType(cleanupError) })); throw error; }
      const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
      console.info('[kogg:operations:support] export.completed', { exportId, byteLength, expiresAt });
      return { exportId, byteLength, sha256, expiresAt };
    } catch (error) {
      console.error('[kogg:operations:support] export.failed', { requestId: request.requestId, safeCode: error instanceof ProjectionFault ? error.safeCode : 'SUPPORT_EXPORT_FAILED', errorType: errorType(error) });
      throw error;
    }
  }

  async read(exportId: string): Promise<OperationsSupportExportContentV1> {
    if (!UUID.test(exportId)) throw new ProjectionFault('SUPPORT_EXPORT_ID_INVALID'); await this.expire();
    let content: string; try { content = await readFile(this.file(exportId), 'utf8'); } catch (error) { console.warn('[kogg:operations:support] export.refused', { exportId, safeCode: 'SUPPORT_EXPORT_UNAVAILABLE', errorType: errorType(error) }); throw new ProjectionFault('SUPPORT_EXPORT_UNAVAILABLE'); }
    const parsed = JSON.parse(content) as { expiresAt?: unknown }; const byteLength = Buffer.byteLength(content, 'utf8');
    if (typeof parsed.expiresAt !== 'string' || !Number.isFinite(Date.parse(parsed.expiresAt)) || byteLength > MAX_BYTES) throw new ProjectionFault('SUPPORT_EXPORT_INVALID');
    return { exportId, content, byteLength, sha256: createHash('sha256').update(content, 'utf8').digest('hex'), expiresAt: parsed.expiresAt };
  }

  async expire(now = Date.now()): Promise<void> {
    let entries: string[]; try { entries = await readdir(this.directory); } catch (error) { if (errorCode(error) === 'ENOENT') return; console.error('[kogg:operations:support] export.failed', { safeCode: 'SUPPORT_RETENTION_FAILED', errorType: errorType(error) }); throw error; }
    let expiredCount = 0;
    for (const entry of entries) {
      if (!/^kogg-operations-support-[0-9a-f-]{36}\.json$/u.test(entry)) continue;
      const target = path.join(this.directory, entry); const metadata = await stat(target);
      if (now - metadata.mtimeMs <= RETENTION_MS) continue;
      await rm(target, { force: true }); expiredCount++;
    }
    if (expiredCount) console.info('[kogg:operations:support] expired', { expiredCount });
  }

  async diagnostics(): Promise<{ permissions: boolean; expired: boolean }> {
    console.info('[kogg:operations:support] diagnostics.started');
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.expire(); const metadata = await stat(this.directory);
      const result = { permissions: process.platform === 'win32' || (metadata.mode & 0o077) === 0, expired: true };
      console.info('[kogg:operations:support] diagnostics.completed', result); return result;
    } catch (error) { console.error('[kogg:operations:support] diagnostics.failed', { safeCode: 'SUPPORT_DIAGNOSTICS_FAILED', errorType: errorType(error) }); throw error; }
  }

  private file(exportId: string): string { return path.join(this.directory, `kogg-operations-support-${exportId}.json`); }
}

function validateRequest(request: OperationsSupportExportRequestV1): void { if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['requestId', 'runId'].includes(key)) || !UUID.test(request.requestId) || (request.runId !== undefined && !UUID.test(request.runId))) throw new ProjectionFault('SUPPORT_REQUEST_INVALID'); }
function assertSafe(value: unknown): void { if (Array.isArray(value)) { for (const item of value) assertSafe(item); return; } if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { if (PROHIBITED_KEYS.has(key)) throw new ProjectionFault('SUPPORT_CONTENT_PROHIBITED'); assertSafe(child); } }
function errorType(error: unknown): string { return error instanceof Error ? error.name : 'UnknownError'; }
function errorCode(error: unknown): string | undefined { return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined; }
