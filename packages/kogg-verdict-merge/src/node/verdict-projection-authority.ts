import { injectable } from '@theia/core/shared/inversify';
import type { VerdictExplanationV1, VerdictQueryV1 } from '../common/verdict-merge-protocol';

// The concrete Ranex projection owner replaces this binding only after exact protocol and journal qualification.
// observability-exempt: The unavailable owner performs no external call and retains no query data.
// diagnostic-coverage: verdict.provenance, verdict.bindings, verdict.currentness, verdict.explanation
export type UnsealedVerdictExplanationV1 = Omit<VerdictExplanationV1, 'explanationDigest'>;
@injectable()
export class VerdictProjectionAuthority {
  async explain(_query: VerdictQueryV1, _queryDigest: string): Promise<UnsealedVerdictExplanationV1 | undefined> { return undefined; }
}
