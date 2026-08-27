import { KoggDiagnosticContribution } from '@kogg/contracts';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KoggVerdictMergeServicePath, type KoggVerdictMergeService } from '../common/verdict-merge-protocol';
import { VerdictMergeDiagnosticContributor } from './verdict-merge-diagnostic-contributor';
import { VerdictMergeService } from './verdict-merge-service';
import { KernelVerdictProjectionAuthority, VerdictProjectionAuthority } from './verdict-projection-authority';
import { MergeAuthorizationAuthority } from './merge-authorization-authority';
import { MergeAuthorizationRegistry } from './merge-authorization-registry';
import { MergeAuthorizationHttpController } from './merge-authorization-http-controller';
import { NativeGitMergeService } from './native-git-merge-service';
import { VerdictOperationsOwnerWiring } from './verdict-operations-owner-wiring';
import { MergeOperationsOwnerWiring } from './merge-operations-owner-wiring';

// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation, merge.authorization, merge.preflight, merge.processes, merge.atomicity, merge.recovery, merge.source-maps
export default new ContainerModule(bind => { bind(KernelVerdictProjectionAuthority).toSelf().inSingletonScope(); bind(VerdictProjectionAuthority).toService(KernelVerdictProjectionAuthority); bind(VerdictMergeService).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(VerdictMergeService); bind(VerdictOperationsOwnerWiring).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(VerdictOperationsOwnerWiring); bind(MergeAuthorizationAuthority).toSelf().inSingletonScope(); bind(MergeAuthorizationRegistry).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(MergeAuthorizationRegistry); bind(MergeOperationsOwnerWiring).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(MergeOperationsOwnerWiring); bind(NativeGitMergeService).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(NativeGitMergeService); bind(MergeAuthorizationHttpController).toSelf().inSingletonScope(); bind(BackendApplicationContribution).toService(MergeAuthorizationHttpController); bind(VerdictMergeDiagnosticContributor).toSelf().inSingletonScope(); bind(KoggDiagnosticContribution).toService(VerdictMergeDiagnosticContributor); bind(ConnectionHandler).toDynamicValue(context => new JsonRpcConnectionHandler<KoggVerdictMergeService>(KoggVerdictMergeServicePath, () => context.container.get(VerdictMergeService))).inSingletonScope(); });
