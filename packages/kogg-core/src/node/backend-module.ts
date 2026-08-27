import { BackendApplicationContribution } from '@theia/core/lib/node';
import { bindRootContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { SocketWriteBuffer } from '@theia/core/lib/common/messaging/socket-write-buffer';
import { ContainerModule } from '@theia/core/shared/inversify';
import {
  KoggDiagnosticContribution,
  KoggDiagnosticsServicePath,
  type KoggDiagnosticsService
} from '@kogg/contracts';
import { BrowserAuthContribution } from './browser-auth-contribution';
import { CoreDiagnosticContributor } from './core-diagnostic-contributor';
import { KoggDiagnosticsServiceImpl } from './diagnostics-service-impl';
import { DiagnosticOwnerJournal } from './diagnostic-owner-journal';

class KoggSocketWriteBuffer extends SocketWriteBuffer {
  protected override get maxBufferSize(): number {
    return 4 * 1024 * 1024;
  }
}

export default new ContainerModule((bind, unbind, isBound) => {
  bindRootContributionProvider(bind, KoggDiagnosticContribution);
  if (isBound(SocketWriteBuffer)) unbind(SocketWriteBuffer);
  bind(SocketWriteBuffer).to(KoggSocketWriteBuffer);
  bind(BrowserAuthContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(BrowserAuthContribution);
  bind(CoreDiagnosticContributor).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(CoreDiagnosticContributor);
  bind(DiagnosticOwnerJournal).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(DiagnosticOwnerJournal);
  bind(KoggDiagnosticsServiceImpl).toSelf().inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggDiagnosticsService>(
    KoggDiagnosticsServicePath,
    () => context.container.get(KoggDiagnosticsServiceImpl)
  )).inSingletonScope();
});
