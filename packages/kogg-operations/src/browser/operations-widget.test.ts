import assert from 'node:assert/strict';
import test from 'node:test';
import { runOutcomeSummary } from '../common/operations-presentation';

test('keeps check state visible beside evidence, verdict, and merge state', () => {
  assert.equal(runOutcomeSummary({ checkSummary: 'passed', evidenceSummary: 'admitted', verdictSummary: 'accepted', mergeSummary: 'committed' }), 'passed / admitted / accepted / committed');
});
