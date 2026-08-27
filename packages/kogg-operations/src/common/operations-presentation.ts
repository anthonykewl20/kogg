import type { OperationsProjectionRunV1, OperationsTimelineEntryV1 } from './operations-read-model-protocol';

// diagnostic-coverage: operations.timeline
// observability-exempt: Pure safe-summary formatting has no lifecycle or failure boundary.

export function runOutcomeSummary(run: Pick<OperationsProjectionRunV1, 'checkSummary' | 'evidenceSummary' | 'verdictSummary' | 'mergeSummary'>): string {
  return [run.checkSummary, run.evidenceSummary, run.verdictSummary, run.mergeSummary].join(' / ');
}

export const RUN_DETAIL_TABS = ['timeline', 'files', 'checks', 'evidence-verdict', 'merge', 'usage', 'processes'] as const;
export type RunDetailTab = typeof RUN_DETAIL_TABS[number];

export function entriesForRunDetail(entries: readonly OperationsTimelineEntryV1[], tab: RunDetailTab): readonly OperationsTimelineEntryV1[] {
  if (tab === 'timeline') return entries;
  if (tab === 'files') return entries.filter(entry => entry.ownerKind === 'execution');
  if (tab === 'checks') return entries.filter(entry => entry.ownerKind === 'check');
  if (tab === 'evidence-verdict') return entries.filter(entry => entry.ownerKind === 'ranex' || entry.ownerKind === 'verdict');
  if (tab === 'merge') return entries.filter(entry => entry.ownerKind === 'merge');
  if (tab === 'usage') return entries.filter(entry => entry.eventKind === 'usage.observed');
  return entries.filter(entry => entry.processId !== undefined);
}

export function timelineObservedSummary(entry: OperationsTimelineEntryV1): string {
  return entry.count === undefined ? entry.displayTime : `${entry.firstDisplayTime} – ${entry.lastDisplayTime}`;
}

export function timelineEventSummary(entry: OperationsTimelineEntryV1): string {
  return entry.count === undefined ? entry.eventKind : `${entry.eventKind} × ${entry.count}`;
}
