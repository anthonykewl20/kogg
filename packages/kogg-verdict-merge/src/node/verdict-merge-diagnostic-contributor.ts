import type { KoggDiagnosticCheck, KoggDiagnosticContributor } from '@kogg/contracts';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { VerdictMergeService } from './verdict-merge-service';
import { MergeAuthorizationRegistry } from './merge-authorization-registry';
import { NativeGitMergeService } from './native-git-merge-service';

// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation, merge.authorization, merge.preflight, merge.processes, merge.atomicity, merge.recovery, merge.source-maps
export const VERDICT_MERGE_CHECKS = ['verdict.provenance','verdict.bindings','verdict.currentness','verdict.explanation','merge.authorization','merge.preflight','merge.processes','merge.atomicity','merge.recovery','merge.source-maps'] as const;
const RUNTIME_CHECKS = [
  { id: 'verdict.provenance' }, { id: 'verdict.bindings' }, { id: 'verdict.currentness' }, { id: 'verdict.explanation' },
  { id: 'merge.authorization' }, { id: 'merge.preflight' }, { id: 'merge.processes' }, { id: 'merge.atomicity' }, { id: 'merge.recovery' }, { id: 'merge.source-maps' }
] as const;
@injectable()
export class VerdictMergeDiagnosticContributor implements KoggDiagnosticContributor {
  readonly id = 'verdict-merge'; constructor(@inject(VerdictMergeService) private readonly service: VerdictMergeService, @inject(MergeAuthorizationRegistry) @optional() private readonly authorization?: MergeAuthorizationRegistry, @inject(NativeGitMergeService) @optional() private readonly nativeGit?: NativeGitMergeService) {}
  async diagnose(): Promise<readonly KoggDiagnosticCheck[]> { try { const value = this.service.diagnostics(); const authorization = this.authorization?.diagnostics(); const nativeGit = this.nativeGit?.diagnostics(); return RUNTIME_CHECKS.map(({ id }) => ({ id, status: check(id, value, authorization, nativeGit) ? 'pass' as const : 'fail' as const, summary: check(id, value, authorization, nativeGit) ? 'The verdict or merge runtime check passed.' : 'The verdict or merge authority owner is unavailable.' })); } catch (error) { console.error('[kogg:verdict:service] diagnostics.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' }); return VERDICT_MERGE_CHECKS.map(id => ({ id, status: 'fail' as const, summary: 'Verdict and merge diagnostics could not run.' })); } }
}
function check(id: typeof VERDICT_MERGE_CHECKS[number], value: ReturnType<VerdictMergeService['diagnostics']>, authorization?: ReturnType<MergeAuthorizationRegistry['diagnostics']>, nativeGit?: ReturnType<NativeGitMergeService['diagnostics']>): boolean { if (id === 'merge.authorization') return authorization?.authorizationReady === true; if (id === 'merge.processes') return value.processCount === 0 && value.residualProcessCount === 0 && (nativeGit?.activeCount ?? 0) === 0; if (id === 'merge.source-maps') return value.sourceMapsPresent && authorization?.sourceMapsPresent === true && (nativeGit?.sourceMapsPresent ?? true); if (id === 'merge.recovery') return value.recoveryReady && authorization?.integrity === true; const key = ({ 'verdict.provenance':'provenanceReady','verdict.bindings':'bindingsReady','verdict.currentness':'currentnessReady','verdict.explanation':'explanationReady','merge.preflight':'preflightReady','merge.atomicity':'atomicityReady' } as const)[id]; return key ? value[key] : false; }
