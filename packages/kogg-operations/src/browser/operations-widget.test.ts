import assert from 'node:assert/strict';
import test from 'node:test';
import { entriesForRunDetail, runOutcomeSummary, timelineEventSummary, timelineObservedSummary } from '../common/operations-presentation';

test('keeps check state visible beside evidence, verdict, and merge state', () => {
  assert.equal(runOutcomeSummary({ checkSummary: 'passed', evidenceSummary: 'admitted', verdictSummary: 'accepted', mergeSummary: 'committed' }), 'passed / admitted / accepted / committed');
});

test('derives content-free detail tabs from the correlated owner timeline', () => {
  const entries = [
    entry('execution', 'execution.completed'), entry('check', 'check.passed'), entry('ranex', 'evidence.admitted'),
    entry('verdict', 'verdict.accepted'), entry('merge', 'merge.committed'), entry('adapter', 'usage.observed'), entry('operation', 'process.cleaned', 'process-1')
  ];
  assert.deepEqual(entriesForRunDetail(entries, 'files').map(value => value.eventKind), ['execution.completed']);
  assert.deepEqual(entriesForRunDetail(entries, 'checks').map(value => value.eventKind), ['check.passed']);
  assert.deepEqual(entriesForRunDetail(entries, 'evidence-verdict').map(value => value.eventKind), ['evidence.admitted', 'verdict.accepted']);
  assert.deepEqual(entriesForRunDetail(entries, 'merge').map(value => value.eventKind), ['merge.committed']);
  assert.deepEqual(entriesForRunDetail(entries, 'usage').map(value => value.eventKind), ['usage.observed']);
  assert.deepEqual(entriesForRunDetail(entries, 'processes').map(value => value.eventKind), ['process.cleaned']);
});

test('renders exact activity counts and their bounded observed interval', () => {
  const activity = { ...entry('operation', 'process.activity'), count: 7, firstDisplayTime: '2026-08-28T00:00:01.000Z', lastDisplayTime: '2026-08-28T00:00:49.000Z' };
  assert.equal(timelineEventSummary(activity), 'process.activity × 7');
  assert.equal(timelineObservedSummary(activity), '2026-08-28T00:00:01.000Z – 2026-08-28T00:00:49.000Z');
});

function entry(ownerKind: Parameters<typeof entriesForRunDetail>[0][number]['ownerKind'], eventKind: string, processId?: string): Parameters<typeof entriesForRunDetail>[0][number] {
  return { entryId: crypto.randomUUID(), runId: crypto.randomUUID(), ownerKind, ownerSequence: '1', eventKind, ...(processId ? { processId } : {}), displayTime: new Date(0).toISOString() };
}
