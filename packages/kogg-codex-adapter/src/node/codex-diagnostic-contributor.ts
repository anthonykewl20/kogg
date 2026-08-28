import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { codexLog, codexLoggingDiagnostics } from './codex-logger';
import { CodexReleaseRegistry } from './codex-release-registry';
import { CodexRecoveryRegistry } from './codex-recovery-registry';
import { CodexRuntimeAuthorityRegistry } from './codex-runtime-authority';
import { codexSourceMapDiagnostics } from './codex-source-map-diagnostics';

// Logs through the closed [kogg:agents:codex-release] schema in codex-logger.
// diagnostic-coverage: codex.release, codex.confinement, codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
export const CODEX_CHECKS = [{ id: 'codex.release' }, { id: 'codex.confinement' }, { id: 'codex.protocol' }, { id: 'codex.credentials' }, { id: 'codex.processes' }, { id: 'codex.cleanup' }, { id: 'codex.recovery' }, { id: 'codex.source-maps' }] as const;
@injectable()
export class CodexDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'codex'; constructor(@inject(CodexReleaseRegistry) private readonly releases: CodexReleaseRegistry,
    @inject(CodexRecoveryRegistry) private readonly recovery: CodexRecoveryRegistry,
    @inject(CodexRuntimeAuthorityRegistry) private readonly runtimeAuthority: CodexRuntimeAuthorityRegistry) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      await Promise.all([this.runtimeAuthority.onStart(), this.recovery.onStart()]); const value = this.releases.projection(); const authority = this.runtimeAuthority.projection(); const attempt = this.runtimeAuthority.attemptProjection(); const runtime = this.recovery.projection(); const logging = codexLoggingDiagnostics(); const sourceMaps = codexSourceMapDiagnostics();
      return [
        check('codex.release', value.qualified && value.releasePresent && value.assetsVerified, 'The exact signed Codex release bundle is qualified.', 'No exact signed Codex release bundle is qualified.', { safeCode: value.safeCode }),
        check('codex.confinement', value.qualified && authority.ownerReady && authority.confinementVerified && attempt.ownerReady, 'The qualified Linux confinement and exact attempt authority are available.', 'The qualified Linux confinement or exact attempt authority is unavailable.', { ownerReady: authority.ownerReady, attemptOwnerReady: attempt.ownerReady, safeCode: attempt.ownerReady ? authority.safeCode : attempt.safeCode }),
        check('codex.protocol', value.qualified && value.protocolVerified && attempt.ownerReady, 'The exact Codex app-server schema and attempt binding are verified.', 'The exact Codex app-server schema or attempt binding is unverified.', { attemptOwnerReady: attempt.ownerReady, safeCode: attempt.ownerReady ? value.safeCode : attempt.safeCode }),
        check('codex.credentials', value.qualified && authority.ownerReady && authority.credentialBrokerReady && attempt.ownerReady, 'The scoped Codex credential broker and exact attempt binding are ready.', 'The scoped Codex credential broker or exact attempt binding is unavailable.', { ownerReady: authority.ownerReady, attemptOwnerReady: attempt.ownerReady, safeCode: attempt.ownerReady ? authority.safeCode : attempt.safeCode }),
        check('codex.processes', runtime.ownerReady && runtime.residualCount === 0, 'The qualified Codex owner reports no hidden or residual process.', 'The qualified Codex process inventory is unavailable or residual.', { ownerReady: runtime.ownerReady, processCount: runtime.processCount, residualCount: runtime.residualCount, safeCode: runtime.safeCode }),
        check('codex.cleanup', runtime.ownerReady && runtime.residualCount === 0 && runtime.cleanupFailureCount === 0, 'Codex resource cleanup has zero residuals or failures.', 'Codex cleanup authority is unavailable or reports residuals/failures.', { ownerReady: runtime.ownerReady, residualCount: runtime.residualCount, cleanupFailureCount: runtime.cleanupFailureCount, safeCode: runtime.safeCode }),
        check('codex.recovery', runtime.ownerReady && runtime.recoveryComplete && runtime.recoveryBacklog === 0 && runtime.residualCount === 0, 'Codex startup reconciliation is complete.', 'Codex startup reconciliation is unavailable, incomplete, or blocked.', { ownerReady: runtime.ownerReady, recoveryBacklog: runtime.recoveryBacklog, residualCount: runtime.residualCount, safeCode: runtime.safeCode }),
        check('codex.source-maps', value.sourceMapsPresent && sourceMaps.missingCount === 0 && logging.schemaCount > 0 && logging.violationCount === 0, 'Every Codex adapter and process-owner failure boundary has a debugger source map and closed logging schema.', 'Codex source-map or logging-schema reachability failed.', { ...sourceMaps, schemaCount: logging.schemaCount, violationCount: logging.violationCount })
      ];
    } catch (error) { // observability-exempt: codexLog emits one sanitized diagnostic failure before returning every fail-closed check.
      codexLog('diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); return CODEX_CHECKS.map(check => ({ id: check.id, status: 'fail' as const, summary: 'Codex adapter diagnostics could not run.' })); }
  }
}
function check(id: typeof CODEX_CHECKS[number]['id'], pass: boolean, success: string, failure: string, details: Record<string, string | number | boolean>): KoggDiagnosticCheck { return { id, status: pass ? 'pass' : 'fail', summary: pass ? success : failure, details }; }
