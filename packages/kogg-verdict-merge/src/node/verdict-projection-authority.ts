import { randomUUID } from 'node:crypto';
import { KernelBridgeToken, type KernelBridge, type VerdictReadExpectationV1 } from '@kogg/contracts';
import { KernelVerdictReadService } from '@kogg/kernel/lib/node/kernel-verdict-read-service';
import { TaskAdmissionAuthority, TaskKernelBindingAuthority, type TaskAdmissionAuthority as AdmissionAuthority, type TaskKernelBindingAuthority as BindingAuthority } from '@kogg/tasks/lib/common/tasks-protocol';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { VerdictExplanationV1, VerdictQueryV1 } from '../common/verdict-merge-protocol';

// The concrete Ranex projection owner replaces this binding only after exact protocol and journal qualification.
// observability-exempt: The unavailable owner performs no external call and retains no query data.
// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation
export type UnsealedVerdictExplanationV1 = Omit<VerdictExplanationV1, 'explanationDigest'>;
@injectable()
export class VerdictProjectionAuthority {
  async explain(_query: VerdictQueryV1, _queryDigest: string): Promise<UnsealedVerdictExplanationV1 | undefined> { return undefined; }
}

@injectable()
export class KernelVerdictProjectionAuthority extends VerdictProjectionAuthority {
  constructor(
    @inject(TaskAdmissionAuthority) private readonly admissions: AdmissionAuthority,
    @inject(TaskKernelBindingAuthority) private readonly bindings: BindingAuthority,
    @inject(KernelBridgeToken) private readonly kernel: KernelBridge,
    @inject(KernelVerdictReadService) private readonly verdicts: KernelVerdictReadService
  ) { super(); }

  override async explain(query: VerdictQueryV1, queryDigest: string): Promise<UnsealedVerdictExplanationV1 | undefined> {
    console.info('[kogg:verdict:projection] verdict.read.started', { queryId: query.queryId, taskId: query.taskId });
    try {
      const admission = await this.admissions.resolveAdmission(query.taskAdmissionId);
      if (!admission || admission.taskId !== query.taskId || admission.projectId !== query.projectId || admission.repositoryId !== query.repositoryId) return this.refused(query, 'BINDING_MISMATCH');
      const binding = await this.bindings.resolveAdmission(admission);
      const capabilities = await this.kernel.capabilities();
      if (strip(binding.approvalDigest) !== query.approvalDigest || binding.repositoryIdentityDigest !== query.repositoryIdentityDigest
        || strip(capabilities.adapterArtifactDigest) !== query.ranexArtifactDigest || String(capabilities.protocolVersion) !== query.ranexProtocolVersion) return this.refused(query, 'BINDING_MISMATCH');
      const expectation: VerdictReadExpectationV1 = {
        verdictId: query.verdictId, verdictDigest: prefixed(query.verdictDigest), taskBindingDigest: prefixed(query.taskBindingDigest),
        subjectStateDigest: prefixed(query.subjectStateDigest), gateCatalogDigest: prefixed(query.gateCatalogDigest),
        authorityDigest: prefixed(query.verifierAuthorityDigest), ranexProvenanceDigest: prefixed(query.ranexProvenanceDigest)
      };
      const result = await this.verdicts.read(admission, expectation);
      const projection = result.status === 'succeeded' ? result.projection : null;
      if (!projection || strip(projection.evidenceSetDigest) !== query.evidenceSetDigest || strip(projection.gateCatalogDigest) !== query.gateCatalogDigest
        || strip(projection.authorityDigest) !== query.verifierAuthorityDigest || strip(projection.ranexProvenanceDigest) !== query.ranexProvenanceDigest
        || strip(projection.journalRootDigest) !== query.ranexJournalRoot || String(projection.journalSequence) !== query.ranexJournalSeq
        || projection.subjectState.commitObjectId !== query.subjectOid || projection.subjectState.treeObjectId !== query.subjectTreeOid) return this.refused(query, 'BINDING_MISMATCH');
      const now = new Date(); const expiresAt = new Date(Math.min(now.getTime() + 30_000, Date.parse(binding.expiresAt)));
      if (expiresAt <= now) return this.refused(query, 'VERDICT_STALE');
      const gateRows = projection.gateRows.map(row => ({
        gateId: row.claimType, gateVersion: '1', required: true, result: row.result,
        safeReasonCode: row.result === 'pass' ? 'CHECK_PASS' : row.result === 'fail' ? 'CHECK_FAIL' : 'EVIDENCE_MISSING',
        producerRoleDigest: row.producerBindingDigest ? strip(row.producerBindingDigest) : null,
        verifierRoleDigest: strip(projection.authorityDigest), evidenceDigest: row.evidenceDigest ? strip(row.evidenceDigest) : null,
        subjectDigest: strip(query.subjectStateDigest), journalSeq: String(projection.journalSequence)
      }));
      const passCount = gateRows.filter(row => row.result === 'pass').length;
      const failCount = gateRows.filter(row => row.result === 'fail').length;
      const blockedCount = gateRows.filter(row => row.result === 'blocked').length;
      console.info('[kogg:verdict:projection] verdict.read.completed', { queryId: query.queryId, taskId: query.taskId, currentness: projection.currentness, decision: projection.historicalDecision, gateCount: gateRows.length });
      return {
        explanationId: randomUUID(), queryDigest, ranexDecision: projection.historicalDecision, currentness: projection.currentness,
        currentnessCode: projection.currentness === 'stale' ? 'VERDICT_STALE' : projection.historicalDecision === 'pass' ? 'VERDICT_OK' : projection.historicalDecision === 'fail' ? 'VERDICT_FAIL' : 'VERDICT_BLOCKED',
        gateRows, requiredCount: gateRows.length, passCount, failCount, blockedCount,
        verifiedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), ranexProvenanceDigest: strip(projection.ranexProvenanceDigest),
        journalRoot: strip(projection.journalRootDigest), journalSeq: String(projection.journalSequence)
      };
    } catch (error) {
      console.warn('[kogg:verdict:projection] verdict.read.failed', { queryId: query.queryId, taskId: query.taskId, safeCode: 'VERDICT_UNKNOWN', errorType: error instanceof Error ? error.name : 'UnknownError' });
      return undefined;
    }
  }

  private refused(query: VerdictQueryV1, safeCode: 'BINDING_MISMATCH' | 'VERDICT_STALE'): undefined {
    console.warn('[kogg:verdict:projection] verdict.read.refused', { queryId: query.queryId, taskId: query.taskId, safeCode });
    return undefined;
  }
}

function strip(value: string): string { return value.startsWith('sha256:') ? value.slice(7) : value; }
function prefixed(value: string): `sha256:${string}` { return `sha256:${strip(value)}`; }
