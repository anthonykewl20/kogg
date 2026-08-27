import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalKernelJson, KERNEL_OPERATIONS } from './kernel-evidence-protocol';

test('canonical kernel JSON fixes key order, integer encoding, and Unicode bytes', () => {
  assert.equal(canonicalKernelJson({ z: 0, a: ['café', true, null], m: -12 }), '{"a":["café",true,null],"m":-12,"z":0}');
  assert.deepEqual(Object.keys(KERNEL_OPERATIONS), [
    'kernel.handshake', 'kernel.health', 'task.bind', 'producer.dispatch', 'suite.freeze', 'suite.execute',
    'evidence.admit', 'gate.evaluate', 'verdict.read', 'operation.reconcile', 'operation.cancel'
  ]);
});

test('canonical kernel JSON rejects floats, non-NFC text, unpaired Unicode, depth, and member overflow', () => {
  assert.throws(() => canonicalKernelJson(1.5), /KERNEL_PROTOCOL_INVALID/u);
  assert.throws(() => canonicalKernelJson('e\u0301'), /KERNEL_PROTOCOL_INVALID/u);
  assert.throws(() => canonicalKernelJson('\ud800'), /KERNEL_PROTOCOL_INVALID/u);
  let deep: unknown = true; for (let index = 0; index < 34; index++) deep = [deep];
  assert.throws(() => canonicalKernelJson(deep as never), /KERNEL_PROTOCOL_OVERFLOW/u);
  assert.throws(() => canonicalKernelJson(new Array(4097).fill(true)), /KERNEL_PROTOCOL_OVERFLOW/u);
});
