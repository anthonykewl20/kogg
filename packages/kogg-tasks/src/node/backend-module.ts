import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggTasksServicePath, type KoggTasksService } from '../common/tasks-protocol';
import { InteractionModesServicePath, type InteractionModesService } from '../common/interaction-modes-protocol';
import { InteractionModesPrototype } from './interaction-modes-prototype';
import { InteractionModesDiagnosticPrototype } from './interaction-modes-diagnostic-prototype';
import { TaskDiagnosticContributor } from './task-diagnostic-contributor';
import { TaskRegistry } from './task-registry';

export default new ContainerModule(bind => {
  bind(TaskRegistry).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(TaskRegistry);
  bind(TaskDiagnosticContributor).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(TaskDiagnosticContributor);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggTasksService>(
    KoggTasksServicePath, () => context.container.get(TaskRegistry)
  )).inSingletonScope();
  bind(InteractionModesPrototype).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(InteractionModesPrototype);
  bind(InteractionModesDiagnosticPrototype).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(InteractionModesDiagnosticPrototype);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<InteractionModesService>(
    InteractionModesServicePath, () => context.container.get(InteractionModesPrototype)
  )).inSingletonScope();
});
