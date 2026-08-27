import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModeProjectionV1 } from '../common/interaction-modes-protocol';
import { modeAuthorityLabel, modeBlockedExplanation, modeSelectionAllowed } from '../common/interaction-mode-view-model';

// diagnostic-coverage: interaction-modes.restoration, interaction-modes.accessibility
test('renders degraded restoration as disabled and prevents a misleading transition request', () => {
  const projection: ModeProjectionV1 = {
    schemaVersion: 1, taskId: '10000000-0000-4000-8000-000000000001', projectId: '10000000-0000-4000-8000-000000000002',
    repositoryId: '10000000-0000-4000-8000-000000000003', taskRevision: '2', selectedMode: 'plan', effectiveCapabilities: [],
    sequence: '1', state: 'restore-degraded', activeStage: 'research', safeCode: 'MODE_RESTORE_DEGRADED'
  };
  assert.equal(modeAuthorityLabel(projection), 'disabled: MODE_RESTORE_DEGRADED');
  assert.equal(modeSelectionAllowed(projection), false);
  assert.match(modeBlockedExplanation(projection), /MODE_RESTORE_DEGRADED/u);
});

test('keeps a current ready projection selectable', () => {
  const projection: ModeProjectionV1 = {
    schemaVersion: 1, taskId: '10000000-0000-4000-8000-000000000001', projectId: '10000000-0000-4000-8000-000000000002',
    repositoryId: '10000000-0000-4000-8000-000000000003', taskRevision: '1', selectedMode: 'plan', effectiveCapabilities: ['research.read'],
    sequence: '1', state: 'ready', activeStage: 'research', safeCode: 'MODE_OK'
  };
  assert.equal(modeAuthorityLabel(projection), '1 bounded capabilities');
  assert.equal(modeSelectionAllowed(projection), true);
});
