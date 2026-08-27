import assert from 'node:assert/strict';
import test from 'node:test';
import type { KernelBridge, KernelCapabilities } from '@kogg/contracts';
import { KERNEL_MAX_FRAME_BYTES, KERNEL_MAX_PENDING_REQUESTS, KERNEL_MAX_PENDING_RESPONSE_BYTES, KERNEL_SCHEMA_SET_DIGEST, KOGG_RANEX_COMMIT, KOGG_RANEX_PROTOCOL, KOGG_RANEX_PROTOCOL_VERSION, KOGG_RANEX_TREE } from '@kogg/contracts';
import { KernelDiagnosticContributor } from './kernel-diagnostic-contributor';

test('reports unfinished evidence capabilities explicitly instead of inferring health from the bridge', async () => {
  const checks = await new KernelDiagnosticContributor(bridge(async () => ({ status: 'degraded', journal: 'missing', capabilities: CAPABILITIES }))).diagnose();
  assert.equal(checks.length, 11);
  assert.equal(checks.find(check => check.id === 'kernel.protocol')?.status, 'pass');
  assert.equal(checks.find(check => check.id === 'kernel.bridge')?.status, 'warn');
  assert.equal(checks.find(check => check.id === 'kernel.bindings')?.status, 'pass');
  assert.equal(checks.find(check => check.id === 'kernel.producers')?.status, 'pass');
  assert.equal(checks.find(check => check.id === 'kernel.suites')?.status, 'pass');
  for (const id of ['kernel.checks', 'kernel.evidence', 'kernel.verdicts', 'kernel.cleanup', 'kernel.recovery']) {
    const check = checks.find(candidate => candidate.id === id); assert.equal(check?.status, 'fail'); assert.equal(check?.details?.safeCode, 'KERNEL_CAPABILITY_UNAVAILABLE');
  }
});

test('fails all kernel diagnostics safely when the bridge throws', async () => {
  const checks = await new KernelDiagnosticContributor(bridge(async () => { throw new Error('content-bearing canary'); })).diagnose();
  assert.equal(checks.length, 11);
  assert(checks.every(check => check.status === 'fail'));
  assert(checks.every(check => JSON.stringify(check).includes('content-bearing canary') === false));
});

function bridge(health: KernelBridge['health']): KernelBridge { return { health } as KernelBridge; }
const CAPABILITIES: KernelCapabilities = {
  protocol: KOGG_RANEX_PROTOCOL, protocolVersion: KOGG_RANEX_PROTOCOL_VERSION, ranexCommit: KOGG_RANEX_COMMIT, ranexTree: KOGG_RANEX_TREE,
  adapterArtifactDigest: `sha256:${'1'.repeat(64)}`, schemaSetDigest: KERNEL_SCHEMA_SET_DIGEST,
  operations: [
    { operation: 'task.bind', version: 1, requestSchemaDigest: `sha256:${'2'.repeat(64)}`, resultSchemaDigest: `sha256:${'3'.repeat(64)}` },
    { operation: 'producer.dispatch', version: 1, requestSchemaDigest: `sha256:${'4'.repeat(64)}`, resultSchemaDigest: `sha256:${'5'.repeat(64)}` },
    { operation: 'suite.freeze', version: 1, requestSchemaDigest: `sha256:${'6'.repeat(64)}`, resultSchemaDigest: `sha256:${'7'.repeat(64)}` }
  ],
  maxFrameBytes: KERNEL_MAX_FRAME_BYTES, maxPendingRequests: KERNEL_MAX_PENDING_REQUESTS, maxPendingResponseBytes: KERNEL_MAX_PENDING_RESPONSE_BYTES,
  confinement: 'degraded', degradationCodes: ['KERNEL_HOST_UNQUALIFIED', 'KERNEL_JOURNAL_MISSING']
};
