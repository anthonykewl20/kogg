import { KoggDiagnosticContribution } from '@kogg/contracts';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggProjectsServicePath, ProjectBindingAuthority, type KoggProjectsService } from '../common/projects-protocol';
import { ProjectDiagnosticContributor } from './project-diagnostic-contributor';
import { ProjectRegistry } from './project-registry';
import { ProjectRepositoryProbe } from './project-repository-probe';
import { ProjectWorkspaceProjection } from './project-workspace-projection';

export default new ContainerModule(bind => {
  bind(ProjectRepositoryProbe).toSelf().inSingletonScope();
  bind(ProjectWorkspaceProjection).toSelf().inSingletonScope();
  bind(ProjectRegistry).toSelf().inSingletonScope();
  bind(ProjectBindingAuthority).toService(ProjectRegistry);
  bind(BackendApplicationContribution).toService(ProjectRegistry);
  bind(ProjectDiagnosticContributor).toSelf().inSingletonScope();
  bind(KoggDiagnosticContribution).toService(ProjectDiagnosticContributor);
  bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggProjectsService>(
    KoggProjectsServicePath,
    () => context.container.get(ProjectRegistry)
  )).inSingletonScope();
});
