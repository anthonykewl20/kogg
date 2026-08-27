import type { CandidateBindingV1, ImportedCandidateV1, ImportCandidateV1, SealCandidateV1 } from '../common/execution-protocol';
import type { CandidateImporter } from './candidate-importer';
import { ImportError } from './candidate-importer';
import type { CandidateSealer } from './candidate-sealer';
import type { ExecutionAllocationRegistry } from './execution-allocation-registry';
import { executionLog } from './execution-logger';

// This controller orders durable lifecycle commits around candidate inspection and the quarantine CAS; service events route through [kogg:execution:service], and a replayed ambiguous intent never repeats the external action.
// diagnostic-coverage: execution.source-integrity, execution.worktree-registry, execution.recovery
export interface GovernedSealRequest {
  readonly requestId: string; readonly expectedRevision: string; readonly bindingDigest: string; readonly seal: SealCandidateV1;
}
export interface GovernedImportRequest {
  readonly intentRequestId: string; readonly completionRequestId: string; readonly expectedRevision: string;
  readonly bindingDigest: string; readonly expectedSourceIdentityDigest: string; readonly candidateImport: ImportCandidateV1;
}

export class CandidateLifecycleController {
  constructor(private readonly registry: Pick<ExecutionAllocationRegistry, 'recordSeal' | 'prepareCandidateImport' | 'completeCandidateImport'>,
    private readonly sealer: Pick<CandidateSealer, 'seal'>, private readonly importer: Pick<CandidateImporter, 'import'>) {}

  async seal(request: GovernedSealRequest): Promise<CandidateBindingV1> {
    validateSeal(request); executionLog('service.seal.requested', { eventVersion: 1, requestId: request.requestId, worktreeId: request.seal.worktreeId });
    try {
      const candidate = await this.sealer.seal(request.seal); const result = await this.registry.recordSeal({ requestId: request.requestId, worktreeId: request.seal.worktreeId, expectedRevision: request.expectedRevision, bindingDigest: request.bindingDigest, candidate });
      executionLog('service.seal.completed', { eventVersion: 1, requestId: request.requestId, worktreeId: request.seal.worktreeId }); return result;
    } catch (error) {
      executionLog('service.seal.failed', { eventVersion: 1, requestId: request.requestId, worktreeId: request.seal.worktreeId, safeCode: safeCode(error, 'SEAL_FAILED'), errorType: error instanceof Error ? error.name : 'UnknownError' }); throw error;
    }
  }

  async import(request: GovernedImportRequest): Promise<ImportedCandidateV1> {
    validateImport(request); const candidate = request.candidateImport.candidate;
    executionLog('service.import.requested', { eventVersion: 1, requestId: request.intentRequestId, worktreeId: candidate.worktreeId });
    try {
      const intent = await this.registry.prepareCandidateImport({ requestId: request.intentRequestId, worktreeId: candidate.worktreeId, expectedRevision: request.expectedRevision, bindingDigest: request.bindingDigest, candidateId: candidate.candidateId, expectedSourceIdentityDigest: request.expectedSourceIdentityDigest });
      if (intent.replay) throw new ImportError('IMPORT_FAILED');
      const imported = await this.importer.import(request.candidateImport);
      const result = await this.registry.completeCandidateImport({ requestId: request.completionRequestId, intentId: intent.intentId, worktreeId: candidate.worktreeId, expectedRevision: request.expectedRevision, bindingDigest: request.bindingDigest, candidateId: candidate.candidateId, fencingToken: intent.fencingToken, candidateCommit: imported.candidateCommit, candidateTree: imported.candidateTree, quarantineRefDigest: imported.quarantineRefDigest });
      executionLog('service.import.completed', { eventVersion: 1, requestId: request.intentRequestId, worktreeId: candidate.worktreeId }); return result;
    } catch (error) {
      executionLog('service.import.failed', { eventVersion: 1, requestId: request.intentRequestId, worktreeId: candidate.worktreeId, safeCode: safeCode(error, 'IMPORT_FAILED'), errorType: error instanceof Error ? error.name : 'UnknownError' }); throw error;
    }
  }
}

function validateSeal(value: GovernedSealRequest): void { if (!value || Object.keys(value).sort().join(',') !== 'bindingDigest,expectedRevision,requestId,seal') throw new Error('Candidate lifecycle seal request is invalid'); }
function validateImport(value: GovernedImportRequest): void { if (!value || Object.keys(value).sort().join(',') !== 'bindingDigest,candidateImport,completionRequestId,expectedRevision,expectedSourceIdentityDigest,intentRequestId') throw new Error('Candidate lifecycle import request is invalid'); }
function safeCode(error: unknown, fallback: string): string { const value = (error as { readonly code?: unknown })?.code; return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : fallback; }
