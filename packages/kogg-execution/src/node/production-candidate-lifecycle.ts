import { inject, injectable } from '@theia/core/shared/inversify';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { CandidateBindingV1, ImportedCandidateV1 } from '../common/execution-protocol';
import { CandidateImporter } from './candidate-importer';
import { CandidateLifecycleController, type GovernedImportRequest, type GovernedSealRequest } from './candidate-lifecycle-controller';
import { CandidateSealer } from './candidate-sealer';
import { ExecutionAllocationRegistry } from './execution-allocation-registry';
import { productionControllerGitRunner } from './production-private-git-seeder';
import { SeedError } from './private-git-seeder';

// The production candidate lifecycle stays lazy so unsupported hosts never initialize controller Git state or spawn Git.
// diagnostic-coverage: execution.git-independence, execution.source-integrity, execution.process-cleanup, execution.worktree-registry, execution.retention
@injectable()
export class ProductionCandidateLifecycle {
  private delegate: CandidateLifecycleController | undefined;
  constructor(@inject(ExecutionAllocationRegistry) private readonly allocations: ExecutionAllocationRegistry,
    @inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi) {}

  seal(request: GovernedSealRequest): Promise<CandidateBindingV1> { return this.controller().seal(request); }
  import(request: GovernedImportRequest): Promise<ImportedCandidateV1> { return this.controller().import(request); }

  private controller(): CandidateLifecycleController {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      console.error('[kogg:execution:candidate] lifecycle.initialization.refused', { platform: process.platform, architecture: process.arch, safeCode: 'GIT_SEED_FAILED' });
      throw new SeedError('GIT_SEED_FAILED');
    }
    if (!this.delegate) {
      try {
        const runner = productionControllerGitRunner();
        this.delegate = new CandidateLifecycleController(this.allocations, new CandidateSealer(this.operations, runner), new CandidateImporter(this.operations, runner));
        console.info('[kogg:execution:candidate] lifecycle.initialization.completed', { platform: process.platform, architecture: process.arch });
      } catch (error) {
        console.error('[kogg:execution:candidate] lifecycle.initialization.failed', { platform: process.platform, architecture: process.arch,
          safeCode: 'GIT_SEED_FAILED', errorType: error instanceof Error ? error.name : 'UnknownError' });
        throw error;
      }
    }
    return this.delegate;
  }
}
