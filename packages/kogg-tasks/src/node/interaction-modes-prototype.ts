import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { InteractionMode, InteractionModesService, ModeOperation, ModeProjection, ModeResult } from '../common/interaction-modes-protocol';
import { TaskRegistry } from './task-registry';

// diagnostic-exempt: Disposable issue #121 Theia boundary probe retained only on its experimental branch.
@injectable()
export class InteractionModesPrototype implements InteractionModesService, BackendApplicationContribution {
  private database: DatabaseSync | undefined;
  private readonly databasePath = path.join(process.env.KOGG_STATE_DIR ?? path.join(os.homedir(), '.kogg'), 'prototypes', 'interaction-modes.sqlite3');
  constructor(@inject(TaskRegistry) private readonly tasks: TaskRegistry) {}

  async onStart(): Promise<void> {
    console.info('[kogg:interaction-modes:prototype] registry.start.requested');
    await fs.mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS modes(task_id TEXT PRIMARY KEY,selected TEXT NOT NULL CHECK(selected IN ('plan','build','kogg')),sequence INTEGER NOT NULL,stage TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,result_json TEXT NOT NULL);");
    console.info('[kogg:interaction-modes:prototype] restoration.completed', { modeCount: this.database.prepare('SELECT COUNT(*) AS count FROM modes').get()?.count ?? 0 });
  }
  async onStop(): Promise<void> { console.info('[kogg:interaction-modes:prototype] registry.stop.started'); this.database?.close(); this.database = undefined; console.info('[kogg:interaction-modes:prototype] registry.stop.completed'); }
  async get(taskId: string): Promise<ModeProjection> { await this.tasks.get(taskId); return this.read(taskId); }
  async transition(input: { requestId: string; taskId: string; expectedSequence: number; requested: InteractionMode; confirmed: boolean }): Promise<ModeResult> {
    console.info('[kogg:interaction-modes:prototype] transition.requested', { requestId: input.requestId, taskId: input.taskId, requestedMode: input.requested });
    await this.tasks.get(input.taskId); const current = this.read(input.taskId);
    if (current.sequence !== input.expectedSequence) return this.result('conflict', 'MODE_SEQUENCE_CONFLICT', current, input.requestId);
    if (rank(input.requested) > rank(current.selected) && !input.confirmed) return this.result('refused', 'MODE_CONFIRMATION_REQUIRED', current, input.requestId);
    if (input.requested === current.selected) return this.result('completed', 'MODE_UNCHANGED', current, input.requestId);
    const next: ModeProjection = { taskId: input.taskId, selected: input.requested, effective: input.requested, sequence: current.sequence + 1, stage: input.requested === 'kogg' ? 'governed-entry-ready' : input.requested === 'build' ? 'private-worktree-only' : 'research-only' };
    this.db().prepare('INSERT OR REPLACE INTO modes VALUES(?,?,?,?)').run(next.taskId, next.selected, next.sequence, next.stage);
    console.info('[kogg:interaction-modes:prototype] transition.completed', { requestId: input.requestId, taskId: input.taskId, oldMode: current.selected, newMode: next.selected, sequence: next.sequence });
    return this.result('completed', 'MODE_CHANGED', next, input.requestId);
  }
  async authorize(input: { requestId: string; taskId: string; operation: ModeOperation }): Promise<ModeResult> {
    const projection = await this.get(input.taskId); const allowed = ceilings[projection.selected].includes(input.operation);
    const code = allowed ? 'MODE_OPERATION_ALLOWED' : input.operation === 'production-mutation' ? 'PLAN_MUTATION_REFUSED' : input.operation === 'merge' ? 'BUILD_MERGE_REFUSED' : 'BUILD_GOVERNED_RESULT_REFUSED';
    if (allowed) console.info('[kogg:interaction-modes:prototype] operation.allowed', { requestId: input.requestId, taskId: input.taskId, selectedMode: projection.selected, operation: input.operation, safeCode: code });
    else console.info('[kogg:interaction-modes:prototype] operation.refused', { requestId: input.requestId, taskId: input.taskId, selectedMode: projection.selected, operation: input.operation, safeCode: code });
    return { kind: allowed ? 'completed' : 'refused', code, projection, allowed };
  }
  diagnostics(): { integrity: boolean; invalidModeCount: number; modeCount: number; requestCount: number } {
    const integrity = this.db().prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    const count = (sql: string): number => Number((this.db().prepare(sql).get() as { count: number }).count);
    return { integrity: integrity?.integrity_check === 'ok', invalidModeCount: count("SELECT COUNT(*) AS count FROM modes WHERE selected NOT IN ('plan','build','kogg')"), modeCount: count('SELECT COUNT(*) AS count FROM modes'), requestCount: count('SELECT COUNT(*) AS count FROM requests') };
  }
  private read(taskId: string): ModeProjection { const row = this.db().prepare('SELECT * FROM modes WHERE task_id=?').get(taskId) as Record<string, string | number> | undefined; return row ? { taskId, selected: row.selected as InteractionMode, effective: row.selected as InteractionMode, sequence: Number(row.sequence), stage: String(row.stage) } : { taskId, selected: 'plan', effective: 'plan', sequence: 0, stage: 'research-only' }; }
  private result(kind: ModeResult['kind'], code: string, projection: ModeProjection, requestId: string): ModeResult { const result = { kind, code, projection }; this.db().prepare('INSERT OR IGNORE INTO requests VALUES(?,?,?)').run(requestId, `${projection.taskId}:${projection.sequence}:${code}`, JSON.stringify(result)); if (kind !== 'completed') console.warn('[kogg:interaction-modes:prototype] transition.refused', { requestId, taskId: projection.taskId, safeCode: code }); return result; }
  private db(): DatabaseSync { if (!this.database) throw new Error('MODE_REGISTRY_UNAVAILABLE'); return this.database; }
}
const ceilings: Record<InteractionMode, readonly ModeOperation[]> = { plan: [], build: ['production-mutation'], kogg: ['governed-entry'] };
function rank(mode: InteractionMode): number { return mode === 'plan' ? 0 : mode === 'build' ? 1 : 2; }
