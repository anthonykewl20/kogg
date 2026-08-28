import assert from 'node:assert/strict'; import test from 'node:test'; import { createHash } from 'node:crypto';
import type { AgentAdapterFactory } from '@kogg/agents/lib/common/agents-protocol';
import type { GovernedCodexAttemptV1 } from '../common/codex-protocol';
import { CodexAttemptAuthorityFault, CodexAttemptAuthorityRegistry, type QualifiedCodexAttemptAuthority } from './codex-attempt-authority';
import type { QualifiedCodexRuntimeV1 } from './codex-release-registry';
import type { CodexRuntimeAuthorityProjection } from './codex-runtime-authority';

// diagnostic-coverage: codex.confinement, codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const binding = { schemaVersion: '1', attemptId: '10000000-0000-4000-8000-000000000001', taskId: 'task-1', projectId: 'project-1', repositoryId: 'repository-1', repositoryBindingRevision: '7', specificationId: 'specification-1', approvalId: 'approval-1', runId: 'run-1', roleRevisionId: 'role-1', deadlinePolicyId: 'interactive-v1', providerId: 'openai', modelId: 'gpt-5', worktreeId: '20000000-0000-4000-8000-000000000001' } as Parameters<AgentAdapterFactory['create']>[0]['binding'];
const release = { manifestVersion: '1', releaseId: 'codex-release-1', codexVersion: '1.2.3', codexCommit: 'a'.repeat(40), target: 'x86_64-unknown-linux-musl', binarySha256: 'b'.repeat(64), binarySize: '10', appServerSchemaVersion: 'v2', appServerSchemaSha256: 'c'.repeat(64), acceptedMethodsSha256: 'd'.repeat(64), linuxHelperSha256: 'e'.repeat(64), adapterVersion: '1.0.0', qualificationProfileId: 'kogg-writable-agent-v1', signedAt: '2026-01-01T00:00:00.000Z', signatureKeyId: 'release-key-1', signature: 'signed' } as const;
const runtime = { release, binary: '/private/codex', linuxHelper: '/private/helper', acceptedMethods: {}, frameSchema: {} } as QualifiedCodexRuntimeV1;
const authorityProjection: CodexRuntimeAuthorityProjection = { releaseId: release.releaseId, target: release.target, qualificationProfileId: release.qualificationProfileId, confinementVerified: true, credentialBrokerReady: true, ownerReady: true, safeCode: 'CODEX_OK' };
function attempt(overrides: Partial<GovernedCodexAttemptV1> = {}): GovernedCodexAttemptV1 {
  const unsigned = { schemaVersion: '1' as const, attemptId: binding.attemptId, taskRevisionDigest: '1'.repeat(64), repositoryBindingDigest: '2'.repeat(64), privateRepoObjectId: binding.worktreeId!, baseCommit: '3'.repeat(40), worktreePolicy: 'private-writable' as const, roleRevisionId: binding.roleRevisionId, provider: 'openai' as const, model: binding.modelId, releaseId: release.releaseId, target: release.target, qualificationProfileId: release.qualificationProfileId, deadlinePolicyId: binding.deadlinePolicyId, budgets: { inputTokens: '1000', outputTokens: '2000', toolCalls: '10', bytesIn: '100000', bytesOut: '200000' }, deadlines: { spawnMs: 20000 as const, initializeMs: 30000 as const, threadStartMs: 30000 as const, firstActivityMs: 60000 as const, idleMs: 120000 as const, providerRequestMs: 120000 as const, interruptMs: 10000 as const, cleanupMs: 10000 as const, absoluteMs: 600000 }, ...overrides };
  const { authorityDigest: _authorityDigest, ...withoutDigest } = unsigned as GovernedCodexAttemptV1; return { ...unsigned, authorityDigest: overrides.authorityDigest ?? createHash('sha256').update(canonical(withoutDigest)).digest('hex') } as GovernedCodexAttemptV1;
}
function registry(owner: QualifiedCodexAttemptAuthority = { authorize: () => attempt() }) { return new CodexAttemptAuthorityRegistry(owner); }

test('fails closed without a trusted attempt owner', () => {
  const value = new CodexAttemptAuthorityRegistry(); assert.deepEqual(value.projection(), { ownerReady: false, safeCode: 'CODEX_ATTEMPT_INVALID' }); assert.throws(() => value.authorize({ binding, runtime, authority: authorityProjection }), error => error instanceof CodexAttemptAuthorityFault && error.code === 'CODEX_ATTEMPT_INVALID');
});

test('returns one deeply frozen exact authority fact', () => {
  const value = registry().authorize({ binding, runtime, authority: authorityProjection }); assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.budgets), true); assert.equal(Object.isFrozen(value.deadlines), true); assert.equal(value.privateRepoObjectId, binding.worktreeId); assert.match(value.authorityDigest, /^[0-9a-f]{64}$/u);
});

test('refuses every substituted binding, release, policy, budget, deadline, and digest', () => {
  const mutations: readonly Partial<GovernedCodexAttemptV1>[] = [
    { attemptId: '10000000-0000-4000-8000-000000000099' }, { privateRepoObjectId: '20000000-0000-4000-8000-000000000099' }, { worktreePolicy: 'read-only-snapshot' }, { roleRevisionId: 'role-2' }, { provider: 'openai', model: 'gpt-4' }, { releaseId: 'codex-release-2' }, { target: 'aarch64-unknown-linux-musl' }, { qualificationProfileId: 'other-profile' }, { deadlinePolicyId: 'other-deadline' }, { taskRevisionDigest: 'x'.repeat(64) }, { repositoryBindingDigest: 'x'.repeat(64) }, { baseCommit: 'x'.repeat(40) }, { budgets: { inputTokens: '0', outputTokens: '2000', toolCalls: '10', bytesIn: '100000', bytesOut: '200000' } }, { deadlines: { ...attempt().deadlines, spawnMs: 19999 } as unknown as GovernedCodexAttemptV1['deadlines'] }, { authorityDigest: '0'.repeat(64) }
  ];
  for (const mutation of mutations) assert.throws(() => registry({ authorize: () => attempt(mutation) }).authorize({ binding, runtime, authority: authorityProjection }), /CODEX_ATTEMPT_INVALID/u);
});

test('supports an exact read-only attempt and hides private authority failures', () => {
  const { worktreeId: _worktreeId, ...readOnlyBinding } = binding; const readOnly = attempt({ privateRepoObjectId: null, worktreePolicy: 'read-only-snapshot' }); const { authorityDigest: _digest, ...unsigned } = readOnly; const signed = { ...readOnly, authorityDigest: createHash('sha256').update(canonical(unsigned)).digest('hex') }; assert.equal(registry({ authorize: () => signed }).authorize({ binding: readOnlyBinding, runtime, authority: authorityProjection }).privateRepoObjectId, null);
  const canary = `private-attempt-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => logs.push(JSON.stringify(values)); try { assert.throws(() => registry({ authorize: () => { throw new Error(canary); } }).authorize({ binding, runtime, authority: authorityProjection }), /CODEX_ATTEMPT_INVALID/u); assert.equal(logs.join('\n').includes(canary), false); } finally { console.error = original; }
});
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
