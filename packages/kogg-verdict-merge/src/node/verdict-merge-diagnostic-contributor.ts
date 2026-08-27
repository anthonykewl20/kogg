import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable } from '@theia/core/shared/inversify';
import { VerdictMergeService } from './verdict-merge-service';

// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation, merge.authorization, merge.preflight, merge.processes, merge.atomicity, merge.recovery, merge.source-maps
export const VERDICT_MERGE_CHECKS = ['verdict.provenance','verdict.bindings','verdict.currentness','verdict.explanation','merge.authorization','merge.preflight','merge.processes','merge.atomicity','merge.recovery','merge.source-maps'] as const;
const RUNTIME_CHECKS = [
  { id: 'verdict.provenance' }, { id: 'verdict.bindings' }, { id: 'verdict.currentness' }, { id: 'verdict.explanation' },
  { id: 'merge.authorization' }, { id: 'merge.preflight' }, { id: 'merge.processes' }, { id: 'merge.atomicity' }, { id: 'merge.recovery' }, { id: 'merge.source-maps' }
] as const;
@injectable()
export class VerdictMergeDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'verdict-merge'; constructor(@inject(VerdictMergeService) private readonly service: VerdictMergeService) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> { try { const value = this.service.diagnostics(); return RUNTIME_CHECKS.map(({ id }) => ({ id, status: check(id, value) ? 'pass' as const : 'fail' as const, summary: check(id, value) ? 'The verdict or merge runtime check passed.' : 'The verdict or merge authority owner is unavailable.' })); } catch (error) { console.error('[kogg:verdict:service] diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); return VERDICT_MERGE_CHECKS.map(id => ({ id, status: 'fail' as const, summary: 'Verdict and merge diagnostics could not run.' })); } }
}
function check(id: typeof VERDICT_MERGE_CHECKS[number], value: ReturnType<VerdictMergeService['diagnostics']>): boolean { if (id === 'merge.processes') return value.processCount === 0 && value.residualProcessCount === 0; if (id === 'merge.source-maps') return value.sourceMapsPresent; const key = ({ 'verdict.provenance':'provenanceReady','verdict.bindings':'bindingsReady','verdict.currentness':'currentnessReady','verdict.explanation':'explanationReady','merge.authorization':'authorizationReady','merge.preflight':'preflightReady','merge.atomicity':'atomicityReady','merge.recovery':'recoveryReady' } as const)[id]; return key ? value[key] : false; }
