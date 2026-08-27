import assert from 'node:assert/strict';
import test from 'node:test';
import { executionStartGate, executionStateLabel } from '../common/execution-view-model';

// diagnostic-exempt: Pure presentation-policy tests have no independent runtime state.
test('keeps run start closed for unqualified and not-yet-wired qualified targets', () => {
  assert.deepEqual(executionStartGate({ qualified: false, targetId: 'local-qualified-linux', profileId: 'kogg-writable-agent-v1', safeCode: 'QUALIFICATION_PROFILE_UNAVAILABLE', sourceMapsPresent: true }),
    { enabled: false, safeCode: 'QUALIFICATION_PROFILE_UNAVAILABLE', summary: 'Run start unavailable: QUALIFICATION_PROFILE_UNAVAILABLE.' });
  assert.deepEqual(executionStartGate({ qualified: true, targetId: 'local-qualified-linux', profileId: 'kogg-writable-agent-v1', safeCode: 'EXECUTION_OK', qualificationId: '10000000-0000-4000-8000-000000000001', expiresAt: '2026-08-27T03:00:00.000Z', sourceMapsPresent: true }),
    { enabled: false, safeCode: 'EXECUTION_INTERNAL_FAILED', summary: 'Run start unavailable: governed workflow start owner is not connected.' });
  assert.equal(executionStateLabel('candidate-imported'), 'Candidate Imported');
});
