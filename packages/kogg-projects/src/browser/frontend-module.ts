import { FrontendApplicationContribution, WebSocketConnectionProvider, WidgetFactory, bindViewContribution } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggProjectsService, KoggProjectsServicePath } from '../common/projects-protocol';
import { ProjectsContribution } from './projects-contribution';
import { ProjectsWidget } from './projects-widget';

export default new ContainerModule(bind => {
  bind(KoggProjectsService).toDynamicValue(context =>
    WebSocketConnectionProvider.createProxy(context.container, KoggProjectsServicePath)
  ).inSingletonScope();
  bind(ProjectsWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({
    id: ProjectsWidget.ID,
    createWidget: () => context.container.get(ProjectsWidget)
  })).inSingletonScope();
  bindViewContribution(bind, ProjectsContribution);
  bind(FrontendApplicationContribution).toService(ProjectsContribution);
});
