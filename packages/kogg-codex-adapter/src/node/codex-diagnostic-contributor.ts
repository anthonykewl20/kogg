import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { codexLog, codexLoggingDiagnostics } from './codex-logger';
import { CodexReleaseRegistry } from './codex-release-registry';
import { codexSourceMapDiagnostics } from './codex-source-map-diagnostics';

// Logs through the closed [kogg:agents:codex-release] schema in codex-logger.
// diagnostic-coverage: codex.release, codex.confinement, codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
export const CODEX_CHECKS = [{ id: 'codex.release' }, { id: 'codex.confinement' }, { id: 'codex.protocol' }, { id: 'codex.credentials' }, { id: 'codex.processes' }, { id: 'codex.cleanup' }, { id: 'codex.recovery' }, { id: 'codex.source-maps' }] as const;
@injectable()
export class CodexDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'codex'; constructor(@inject(CodexReleaseRegistry) private readonly releases: CodexReleaseRegistry) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> {
    try {
      await this.releases.onStart(); const value = this.releases.projection(); const logging = codexLoggingDiagnostics(); const sourceMaps = codexSourceMapDiagnostics();
      return [
        check('codex.release', value.qualified && value.releasePresent && value.assetsVerified, 'The exact signed Codex release bundle is qualified.', 'No exact signed Codex release bundle is qualified.', { safeCode: value.safeCode }),
        check('codex.confinement', value.qualified && value.confinementVerified, 'The qualified Linux confinement profile is available.', 'The qualified Linux confinement profile is unavailable.', { safeCode: value.safeCode }),
        check('codex.protocol', value.qualified && value.protocolVerified, 'The exact Codex app-server schema is verified.', 'The exact Codex app-server schema is unverified.', { safeCode: value.safeCode }),
        check('codex.credentials', value.qualified && value.credentialBrokerReady, 'The scoped Codex credential broker is ready.', 'The scoped Codex credential broker is unavailable.', { safeCode: value.safeCode }),
        check('codex.processes', value.processCount === 0 && value.residualCount === 0, 'No hidden or residual Codex process exists.', 'A Codex process is hidden or residual.', { processCount: value.processCount, residualCount: value.residualCount }),
        check('codex.cleanup', value.residualCount === 0, 'Codex resource cleanup has zero residuals.', 'Codex resource cleanup has residuals.', { residualCount: value.residualCount }),
        check('codex.recovery', value.recoveryComplete && value.residualCount === 0, 'Codex recovery is complete.', 'Codex recovery is incomplete or blocked.', { residualCount: value.residualCount }),
        check('codex.source-maps', value.sourceMapsPresent && sourceMaps.missingCount === 0 && logging.schemaCount > 0 && logging.violationCount === 0, 'Every Codex adapter and process-owner failure boundary has a debugger source map and closed logging schema.', 'Codex source-map or logging-schema reachability failed.', { ...sourceMaps, schemaCount: logging.schemaCount, violationCount: logging.violationCount })
      ];
    } catch (error) { // observability-exempt: codexLog emits one sanitized diagnostic failure before returning every fail-closed check.
      codexLog('diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); return CODEX_CHECKS.map(check => ({ id: check.id, status: 'fail' as const, summary: 'Codex adapter diagnostics could not run.' })); }
  }
}
function check(id: typeof CODEX_CHECKS[number]['id'], pass: boolean, success: string, failure: string, details: Record<string, string | number | boolean>): KoggDiagnosticCheck { return { id, status: pass ? 'pass' : 'fail', summary: pass ? success : failure, details }; }
