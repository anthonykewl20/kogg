import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { claudeLog } from './claude-logger';

// The qualified execution owner exposes only aggregate safe inventory. PIDs, paths, argv, environment, credentials, and provider data never cross this seam.
// diagnostic-coverage: claude.processes, claude.cleanup, claude.recovery, claude.source-maps
export const QualifiedClaudeRecoveryOwner = Symbol('QualifiedClaudeRecoveryOwner');
export interface QualifiedClaudeRecoveryProjection { readonly processCount: number; readonly residualCount: number; readonly cleanupFailureCount: number; readonly recoveryBacklog: number; readonly recoveryComplete: boolean; }
export interface QualifiedClaudeRecoveryOwner { reconcileStartup(): Promise<QualifiedClaudeRecoveryProjection>; }
export interface ClaudeRecoveryProjection extends QualifiedClaudeRecoveryProjection { readonly ownerReady: boolean; readonly safeCode: 'CLAUDE_OK' | 'CLAUDE_RECOVERY_REQUIRED' | 'CLAUDE_UNVERIFIED_RESIDUAL'; }
const BLOCKED: ClaudeRecoveryProjection = { ownerReady: false, processCount: 0, residualCount: 0, cleanupFailureCount: 0, recoveryBacklog: 1, recoveryComplete: false, safeCode: 'CLAUDE_RECOVERY_REQUIRED' };

@injectable()
export class ClaudeRecoveryRegistry implements BackendApplicationContribution {
  private started: Promise<void> | undefined; private value: ClaudeRecoveryProjection = BLOCKED;
  constructor(@inject(QualifiedClaudeRecoveryOwner) @optional() private readonly owner?: QualifiedClaudeRecoveryOwner) {}
  onStart(): Promise<void> { return this.started ??= this.reconcile(); }
  projection(): ClaudeRecoveryProjection { return this.value; }
  private async reconcile(): Promise<void> {
    claudeLog('recovery.started', { recoveryBacklog: 1 });
    if (!this.owner) { claudeLog('recovery.failed', { recoveryBacklog: 1, residualCount: 0, safeCode: 'CLAUDE_RECOVERY_REQUIRED' }); return; }
    try {
      const inspected = await this.owner.reconcileStartup(); validate(inspected); const complete = inspected.recoveryComplete && inspected.recoveryBacklog === 0 && inspected.residualCount === 0 && inspected.cleanupFailureCount === 0;
      this.value = { ...inspected, ownerReady: true, recoveryComplete: complete, safeCode: complete ? 'CLAUDE_OK' : inspected.residualCount > 0 ? 'CLAUDE_UNVERIFIED_RESIDUAL' : 'CLAUDE_RECOVERY_REQUIRED' };
      if (complete) claudeLog('recovery.completed', { processCount: inspected.processCount, residualCount: inspected.residualCount, recoveryBacklog: inspected.recoveryBacklog }); else claudeLog('recovery.failed', { recoveryBacklog: inspected.recoveryBacklog, residualCount: inspected.residualCount, safeCode: this.value.safeCode });
    } catch { // observability-exempt: The closed recovery failure discards owner errors and preserves fail-closed admission.
      this.value = BLOCKED; claudeLog('recovery.failed', { recoveryBacklog: 1, residualCount: 0, safeCode: 'CLAUDE_RECOVERY_REQUIRED' });
    }
  }
}
function validate(value: QualifiedClaudeRecoveryProjection): void { for (const count of [value.processCount, value.residualCount, value.cleanupFailureCount, value.recoveryBacklog]) if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid recovery projection'); if (typeof value.recoveryComplete !== 'boolean') throw new Error('Invalid recovery projection'); }
