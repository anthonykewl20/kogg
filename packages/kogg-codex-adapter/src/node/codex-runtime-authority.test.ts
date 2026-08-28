import assert from 'node:assert/strict'; import test from 'node:test';
import { AdapterRegistry } from '@kogg/agents/lib/node/adapter-registry';
import type { AgentAdapterFactory, AgentAdapterSession } from '@kogg/agents/lib/common/agents-protocol';
import { CodexAdapterFactory } from './codex-adapter-factory';
import type { QualifiedCodexRuntimeV1 } from './codex-release-registry';
import { CodexReleaseRegistry } from './codex-release-registry';
import { CodexRecoveryRegistry } from './codex-recovery-registry';
import { CodexRuntimeAuthorityFault, CodexRuntimeAuthorityRegistry, type QualifiedCodexRuntimeAuthority } from './codex-runtime-authority';

// diagnostic-coverage: codex.release, codex.confinement, codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const release = { manifestVersion: '1', releaseId: 'codex-release-1', codexVersion: '1.2.3', codexCommit: 'a'.repeat(40), target: 'x86_64-unknown-linux-musl', binarySha256: 'b'.repeat(64), binarySize: '10', appServerSchemaVersion: 'v2', appServerSchemaSha256: 'c'.repeat(64), acceptedMethodsSha256: 'd'.repeat(64), linuxHelperSha256: 'e'.repeat(64), adapterVersion: '1.0.0', qualificationProfileId: 'kogg-writable-agent-v1', signedAt: '2026-01-01T00:00:00.000Z', signatureKeyId: 'release-key-1', signature: 'signed' } as const;
const runtime: QualifiedCodexRuntimeV1 = Object.freeze({ release: Object.freeze(release), binary: '/private/release/codex', linuxHelper: '/private/release/helper', acceptedMethods: Object.freeze({ inboundSet: Object.freeze({ size: 1, has: (method: string) => method === 'turn/started' }), responses: Object.freeze([]), inbound: Object.freeze([]), errorDefinition: 'JSONRPCErrorError' }), frameSchema: { validate: () => undefined } });
const releaseRegistry = { onStart: async () => undefined, qualifiedRuntime: () => runtime, projection: () => ({ qualified: true, safeCode: 'CODEX_OK', adapterVersion: '1.0.0', target: release.target, releasePresent: true, assetsVerified: true, protocolVerified: true, confinementVerified: false, credentialBrokerReady: false, sourceMapsPresent: true }) } as CodexReleaseRegistry;
const input = { binding: { schemaVersion: '1', attemptId: 'attempt-1', taskId: 'task-1', projectId: 'project-1', repositoryId: 'repository-1', repositoryBindingRevision: '1', specificationId: 'specification-1', approvalId: 'approval-1', runId: 'run-1', roleRevisionId: 'role-1', deadlinePolicyId: 'interactive-v1', providerId: 'openai', modelId: 'gpt-5', worktreeId: 'worktree-1' }, operation: { id: 'operation-1' }, credentialLease: { leaseId: 'lease-1', expiresAt: '2099-01-01T00:00:00.000Z', consume() {}, dispose() {} }, onObservation: () => undefined } as unknown as Parameters<AgentAdapterFactory['create']>[0];
const session: AgentAdapterSession = { resourceId: 'resource-1', resourceKind: 'provider-host', ownerKind: 'kogg', start: async () => undefined, cancel: async () => undefined, cleanup: async () => ({ residualCount: 0 }) };
function authority(overrides: Partial<QualifiedCodexRuntimeAuthority> = {}): QualifiedCodexRuntimeAuthority { return { qualify: async () => ({ releaseId: release.releaseId, target: release.target, qualificationProfileId: release.qualificationProfileId, confinementVerified: true, credentialBrokerReady: true }), create: () => session, ...overrides }; }

test('fails closed without an installed runtime authority and never creates a session', async () => {
  const registry = new CodexRuntimeAuthorityRegistry(releaseRegistry); await registry.onStart(); assert.equal(registry.projection().ownerReady, false); assert.equal(registry.projection().safeCode, 'CODEX_CONFINEMENT_UNVERIFIED'); assert.throws(() => registry.create(input), error => error instanceof CodexRuntimeAuthorityFault && error.code === 'CODEX_CONFINEMENT_UNVERIFIED');
});
test('rejects an authority projection that does not attest the exact retained release', async () => {
  let creates = 0; const registry = new CodexRuntimeAuthorityRegistry(releaseRegistry, authority({ qualify: async () => ({ releaseId: 'different-release', target: release.target, qualificationProfileId: release.qualificationProfileId, confinementVerified: true, credentialBrokerReady: true }), create: () => { creates++; return session; } })); await registry.onStart(); assert.equal(registry.projection().ownerReady, false); assert.equal(creates, 0); assert.throws(() => registry.create(input), /CODEX_CONFINEMENT_UNVERIFIED/u);
});
test('retains an exact partial authority projection but refuses session creation until the broker is ready', async () => {
  const registry = new CodexRuntimeAuthorityRegistry(releaseRegistry, authority({ qualify: async () => ({ releaseId: release.releaseId, target: release.target, qualificationProfileId: release.qualificationProfileId, confinementVerified: true, credentialBrokerReady: false }) })); await registry.onStart(); assert.equal(registry.projection().ownerReady, true); assert.equal(registry.projection().safeCode, 'CODEX_CREDENTIAL_LEASE_REFUSED'); assert.throws(() => registry.create(input), /CODEX_CREDENTIAL_LEASE_REFUSED/u);
});
test('enables the factory only after exact authority and recovery qualification, then delegates the immutable runtime', async () => {
  let qualified = 0; let captured: QualifiedCodexRuntimeV1 | undefined; const registry = new CodexRuntimeAuthorityRegistry(releaseRegistry, authority({ qualify: async () => { qualified++; return { releaseId: release.releaseId, target: release.target, qualificationProfileId: release.qualificationProfileId, confinementVerified: true, credentialBrokerReady: true }; }, create: value => { captured = value.runtime; return session; } }));
  const recovery = new CodexRecoveryRegistry({ reconcileStartup: async () => ({ processCount: 0, residualCount: 0, cleanupFailureCount: 0, recoveryBacklog: 0, recoveryComplete: true }) }); const adapters = new AdapterRegistry(); const factory = new CodexAdapterFactory(adapters, releaseRegistry, recovery, registry); await Promise.all([factory.onStart(), factory.onStart()]);
  assert.equal(qualified, 1); assert.equal(factory.descriptor.enabled, true); assert.equal(adapters.descriptors().length, 1); assert.equal(factory.create(input), session); assert.equal(captured, runtime);
});
test('normalizes malformed authority sessions without leaking private authority errors', async () => {
  const canary = `private-authority-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
  try { const registry = new CodexRuntimeAuthorityRegistry(releaseRegistry, authority({ create: () => { throw new Error(canary); } })); await registry.onStart(); assert.throws(() => registry.create(input), error => error instanceof CodexRuntimeAuthorityFault && error.code === 'CODEX_INTERNAL_FAILURE'); assert.equal(logs.join('\n').includes(canary), false); }
  finally { console.error = original; }
});
