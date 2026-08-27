import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggWorkflowServicePath, type KoggWorkflowService } from '../common/workflow-protocol';
import { WorkflowCompiler } from './workflow-compiler';
import { WorkflowDiagnosticContributor } from './workflow-diagnostic-contributor';
import { WorkflowRegistry } from './workflow-registry';
import { WorkflowNodeCatalog } from './workflow-node-catalog';
import { WorkflowOperationsOwnerWiring } from './workflow-operations-owner-wiring';
import { WorkflowExecutorRegistry } from './workflow-executor-registry';

// diagnostic-coverage: workflow.schema, workflow.catalog, workflow.graph, workflow.anchors, workflow.authority, workflow.scheduler, workflow.processes, workflow.cleanup, workflow.recovery, workflow.accessibility, workflow.source-maps

export default new ContainerModule(bind => {
  bind(WorkflowExecutorRegistry).toSelf().inSingletonScope();
  bind(WorkflowNodeCatalog).toSelf().inSingletonScope();
  bind(WorkflowCompiler).toSelf().inSingletonScope(); bind(WorkflowRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(WorkflowRegistry);
  bind(WorkflowOperationsOwnerWiring).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(WorkflowOperationsOwnerWiring);
  bind(WorkflowDiagnosticContributor).toSelf().inSingletonScope(); bind(KoggDiagnosticContribution).toService(WorkflowDiagnosticContributor);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggWorkflowService>(KoggWorkflowServicePath, () => context.container.get(WorkflowRegistry))).inSingletonScope();
});
