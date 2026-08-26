import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { WorkflowPrototypeServicePath, type WorkflowPrototypeService } from '../common/workflow-prototype-protocol';
import { WorkflowPrototypeRegistry } from './workflow-prototype-service';

// diagnostic-exempt: Disposable issue #100 prototype wiring, never merged to production.
export default new ContainerModule(bind => {
  bind(WorkflowPrototypeRegistry).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(WorkflowPrototypeRegistry);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<WorkflowPrototypeService>(WorkflowPrototypeServicePath, () => context.container.get(WorkflowPrototypeRegistry))).inSingletonScope();
});
