import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionModesDiagnosticContributor } from './interaction-modes-diagnostic-contributor';
import type { InteractionModeRegistry } from './interaction-mode-registry';
import type { ModeTransitionCoordinator } from './mode-transition-coordinator';

// diagnostic-coverage: interaction-modes.transitions, interaction-modes.worktrees, interaction-modes.anchors
test('reports transition boundaries healthy only when every required owner is connected', async () => {
  const registry = { diagnostics: () => ({ integrity: true, eventChain: true, modeStateConsistent: true, immutableRequestLedgers: true, loggingViolationCount: 0, degradedCount: 0, pendingTransitionCount: 0, admission: 'enabled' }) } as unknown as InteractionModeRegistry;
  const complete = new InteractionModesDiagnosticContributor(registry, { ownerIds: () => ['operations', 'agent-binding', 'execution-target', 'workflow-anchors'] } as unknown as ModeTransitionCoordinator);
  const completeChecks = await complete.diagnose();
  assert.equal(completeChecks.find(check => check.id === 'interaction-modes.transitions')?.status, 'pass');
  assert.equal(completeChecks.find(check => check.id === 'interaction-modes.worktrees')?.status, 'pass');
  assert.equal(completeChecks.find(check => check.id === 'interaction-modes.anchors')?.status, 'pass');

  const incomplete = new InteractionModesDiagnosticContributor(registry, { ownerIds: () => ['operations'] } as unknown as ModeTransitionCoordinator);
  const incompleteChecks = await incomplete.diagnose();
  assert.equal(incompleteChecks.find(check => check.id === 'interaction-modes.transitions')?.status, 'fail');
  assert.equal(incompleteChecks.find(check => check.id === 'interaction-modes.worktrees')?.status, 'fail');
  assert.equal(incompleteChecks.find(check => check.id === 'interaction-modes.anchors')?.status, 'fail');
});

test('fails every interaction-mode diagnostic closed when registry inspection throws', async () => {
  const registry = { diagnostics: () => { throw new Error('registry unavailable'); } } as unknown as InteractionModeRegistry;
  const contributor = new InteractionModesDiagnosticContributor(registry, { ownerIds: () => [] } as unknown as ModeTransitionCoordinator);
  assert.ok((await contributor.diagnose()).every(check => check.status === 'fail'));
});
