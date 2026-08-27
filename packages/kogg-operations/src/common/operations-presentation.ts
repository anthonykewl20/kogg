import type { OperationsProjectionRunV1 } from './operations-read-model-protocol';

// diagnostic-coverage: operations.timeline
// observability-exempt: Pure safe-summary formatting has no lifecycle or failure boundary.

export function runOutcomeSummary(run: Pick<OperationsProjectionRunV1, 'checkSummary' | 'evidenceSummary' | 'verdictSummary' | 'mergeSummary'>): string {
  return [run.checkSummary, run.evidenceSummary, run.verdictSummary, run.mergeSummary].join(' / ');
}
