import { existsSync } from 'node:fs';
import { injectable } from '@theia/core/shared/inversify';
import type { KoggVerdictMergeService, VerdictExplanationResultV1 } from '../common/verdict-merge-protocol';
import { decodeVerdictQuery, VerdictMergeProtocolError } from '../common/verdict-merge-canonical';

// Default production boundary refuses before calling Ranex or persisting an explanation until the exact provenance/currentness owner is connected.
// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation, merge.authorization, merge.preflight, merge.processes, merge.atomicity, merge.recovery, merge.source-maps
@injectable()
export class VerdictMergeService implements KoggVerdictMergeService {
  async explain(input: unknown): Promise<VerdictExplanationResultV1> {
    let requestId = 'invalid'; let queryId = 'invalid';
    try { const query = decodeVerdictQuery(input); requestId = query.requestId; queryId = query.queryId;
      console.info('[kogg:verdict:service] explanation.requested', { requestId, queryId });
      console.warn('[kogg:verdict:currentness] unknown', { requestId, queryId, safeCode: 'VERDICT_UNKNOWN' });
      console.warn('[kogg:verdict:service] explanation.refused', { requestId, queryId, safeCode: 'VERDICT_UNKNOWN' });
      return { kind: 'refused', safeCode: 'VERDICT_UNKNOWN' };
    } catch (error) {
      const safeCode = error instanceof VerdictMergeProtocolError ? 'PROTOCOL_INVALID' : 'INTERNAL_FAILURE';
      console.warn('[kogg:verdict:service] explanation.refused', { requestId, queryId, safeCode }); return { kind: 'refused', safeCode };
    }
  }
  diagnostics() { const sourceMapsPresent = existsSync(`${__filename}.map`); return { provenanceReady: false, bindingsReady: false, currentnessReady: false, explanationReady: false, authorizationReady: false, preflightReady: false, processCount: 0, residualProcessCount: 0, atomicityReady: false, recoveryReady: false, sourceMapsPresent }; }
}
