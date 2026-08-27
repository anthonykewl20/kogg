import { KoggDiagnosticContribution } from '@kogg/contracts';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggVerdictMergeServicePath, type KoggVerdictMergeService } from '../common/verdict-merge-protocol';
import { VerdictMergeDiagnosticContributor } from './verdict-merge-diagnostic-contributor';
import { VerdictMergeService } from './verdict-merge-service';

// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation, merge.authorization, merge.preflight, merge.processes, merge.atomicity, merge.recovery, merge.source-maps
export default new ContainerModule(bind => { bind(VerdictMergeService).toSelf().inSingletonScope(); bind(VerdictMergeDiagnosticContributor).toSelf().inSingletonScope(); bind(KoggDiagnosticContribution).toService(VerdictMergeDiagnosticContributor); bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggVerdictMergeService>(KoggVerdictMergeServicePath, () => context.container.get(VerdictMergeService))).inSingletonScope(); });
