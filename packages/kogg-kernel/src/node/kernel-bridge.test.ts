import assert from 'node:assert/strict';
import test from 'node:test';
import { KOGG_RANEX_COMMIT } from '@kogg/contracts';
import { KernelBridgeImpl } from './kernel-bridge';

test('handshakes with the pinned Ranex kernel and fails closed on missing journal', async () => {
  const bridge = new KernelBridgeImpl();
  const capabilities = await bridge.start();
  assert.equal(capabilities.ranexCommit, KOGG_RANEX_COMMIT);
  assert.equal(capabilities.protocolVersion, 1);
  const verification = await bridge.verifyJournal();
  assert.equal(verification.valid, false);
  assert.equal(verification.reason, 'missing');
  await bridge.shutdown();
});
