import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggTasksServicePath, TaskProjectionAuthority, type KoggTasksService } from '../common/tasks-protocol';
import { TaskDiagnosticContributor } from './task-diagnostic-contributor';
import { TaskRegistry } from './task-registry';

export default new ContainerModule(bind => {
  bind(TaskRegistry).toSelf().inSingletonScope();
  bind(TaskProjectionAuthority).toService(TaskRegistry);
  bind(BackendApplicationContribution).toService(TaskRegistry);
  bind(TaskDiagnosticContributor).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(TaskDiagnosticContributor);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggTasksService>(
    KoggTasksServicePath, () => context.container.get(TaskRegistry)
  )).inSingletonScope();
});
