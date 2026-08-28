import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { codexLog } from './codex-logger';

// The qualified Linux owner is the authority for cgroup/process inventory. This seam carries only aggregate safe state; it never exposes PIDs, paths, argv, environment, or provider data.
// diagnostic-coverage: codex.processes, codex.cleanup, codex.recovery, codex.source-maps
export const QualifiedCodexRecoveryOwner = Symbol('QualifiedCodexRecoveryOwner');
export interface QualifiedCodexRecoveryProjection {
  readonly processCount: number; readonly residualCount: number; readonly cleanupFailureCount: number; readonly recoveryBacklog: number; readonly recoveryComplete: boolean;
}
export interface QualifiedCodexRecoveryOwner {
  reconcileStartup(): Promise<QualifiedCodexRecoveryProjection>;
}
export interface CodexRecoveryProjection extends QualifiedCodexRecoveryProjection {
  readonly ownerReady: boolean; readonly safeCode: 'CODEX_OK' | 'CODEX_RECOVERY_REQUIRED' | 'CODEX_UNVERIFIED_RESIDUAL';
}

const BLOCKED: CodexRecoveryProjection = { ownerReady: false, processCount: 0, residualCount: 0, cleanupFailureCount: 0, recoveryBacklog: 1, recoveryComplete: false, safeCode: 'CODEX_RECOVERY_REQUIRED' };

@injectable()
export class CodexRecoveryRegistry implements BackendApplicationContribution {
  private startup: Promise<void> | undefined; private value: CodexRecoveryProjection = BLOCKED;
  constructor(@inject(QualifiedCodexRecoveryOwner) @optional() private readonly owner?: QualifiedCodexRecoveryOwner) {}
  onStart(): Promise<void> { return this.startup ??= this.reconcile(); }
  projection(): CodexRecoveryProjection { return this.value; }

  private async reconcile(): Promise<void> {
    codexLog('recovery.started', { recoveryBacklog: 1 });
    if (!this.owner) { codexLog('recovery.failed', { recoveryBacklog: 1, residualCount: 0, safeCode: 'CODEX_RECOVERY_REQUIRED' }); return; }
    try {
      const inspected = await this.owner.reconcileStartup(); validate(inspected);
      const complete = inspected.recoveryComplete && inspected.recoveryBacklog === 0 && inspected.residualCount === 0 && inspected.cleanupFailureCount === 0;
      this.value = { ...inspected, ownerReady: true, recoveryComplete: complete, safeCode: complete ? 'CODEX_OK' : inspected.residualCount > 0 ? 'CODEX_UNVERIFIED_RESIDUAL' : 'CODEX_RECOVERY_REQUIRED' };
      if (complete) codexLog('recovery.completed', { processCount: inspected.processCount, residualCount: inspected.residualCount, recoveryBacklog: inspected.recoveryBacklog });
      else codexLog('recovery.failed', { recoveryBacklog: inspected.recoveryBacklog, residualCount: inspected.residualCount, safeCode: this.value.safeCode });
    } catch { // observability-exempt: The closed recovery failure discards owner errors and keeps admission fail-closed.
      this.value = BLOCKED; codexLog('recovery.failed', { recoveryBacklog: 1, residualCount: 0, safeCode: 'CODEX_RECOVERY_REQUIRED' });
    }
  }
}

function validate(value: QualifiedCodexRecoveryProjection): void {
  for (const count of [value.processCount, value.residualCount, value.cleanupFailureCount, value.recoveryBacklog]) if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid recovery projection');
  if (typeof value.recoveryComplete !== 'boolean') throw new Error('Invalid recovery projection');
}
