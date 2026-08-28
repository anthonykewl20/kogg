import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ContainerModule } from '@theia/core/shared/inversify';
import { CodexAdapterFactory } from './codex-adapter-factory';
import { CodexDiagnosticContributor } from './codex-diagnostic-contributor';
import { CodexReleaseRegistry } from './codex-release-registry';
import { CodexRecoveryRegistry } from './codex-recovery-registry';

// diagnostic-coverage: codex.release, codex.confinement, codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
export default new ContainerModule(bind => {
  bind(CodexReleaseRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(CodexReleaseRegistry);
  bind(CodexRecoveryRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(CodexRecoveryRegistry);
  bind(CodexAdapterFactory).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(CodexAdapterFactory);
  bind(CodexDiagnosticContributor).toSelf().inSingletonScope(); bind(KoggDiagnosticContribution).toService(CodexDiagnosticContributor);
});
