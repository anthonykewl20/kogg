import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLog, agentLoggingDiagnostics } from './agent-logger';

// diagnostic-coverage: agents.logging

test('closed agent log schemas reject undeclared and oversized fields without echoing values', () => {
  const canary = 'KOGG_AGENT_LOG_PRIVATE_CANARY'; const captured: string[] = []; const prior = console.warn;
  console.warn = (...values: unknown[]) => { captured.push(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')); };
  try {
    const undeclared = agentLog('attempt.requested', { requestId: '10000000-0000-4000-8000-000000000001', attemptId: '10000000-0000-4000-8000-000000000002', rootAttemptId: '10000000-0000-4000-8000-000000000002', prompt: canary } as never);
    const oversized = agentLog('mutation.rollback.failed', { errorType: 'x'.repeat(129) });
    assert.equal(undeclared, false); assert.equal(oversized, false); assert.equal(agentLoggingDiagnostics().violationCount, 2); assert.doesNotMatch(captured.join('\n'), new RegExp(canary)); assert.match(captured.join('\n'), /logging\.schema\.refused/u);
  } finally { console.warn = prior; }
});
