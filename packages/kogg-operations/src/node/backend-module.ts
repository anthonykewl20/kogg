import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggOperationRegistry, KoggOperationsServicePath, type KoggOperationsClient } from '../common/operations-protocol';
import { OperationDiagnosticContributor } from './operation-diagnostic-contributor';
import { OperationRegistry } from './operation-registry';
import { OperationsReadModel } from './operations-read-model';
import { OperationsReadModelDiagnosticContributor } from './operations-read-model-diagnostic-contributor';
import { KoggOperationsReadModelServicePath, type KoggOperationsReadModelClient } from '../common/operations-read-model-protocol';

export default new ContainerModule(bind => {
  bind(OperationRegistry).toSelf().inSingletonScope();
  bind(KoggOperationRegistry).toService(OperationRegistry);
  bind(BackendApplicationContribution).toService(OperationRegistry);
  bind(OperationDiagnosticContributor).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(OperationDiagnosticContributor);
  bind(OperationsReadModel).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(OperationsReadModel);
  bind(OperationsReadModelDiagnosticContributor).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(OperationsReadModelDiagnosticContributor);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggOperationsReadModelClient>(
    KoggOperationsReadModelServicePath, client => { const model = context.container.get(OperationsReadModel); model.setClient(client); return model; }
  )).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggOperationsClient>(
    KoggOperationsServicePath,
    client => { const registry = context.container.get(OperationRegistry); registry.setClient(client); return registry; }
  )).inSingletonScope();
});
