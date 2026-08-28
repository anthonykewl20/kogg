import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { QualifiedCodexReleaseV1 } from '../common/codex-protocol';
import { AdapterRegistry } from '@kogg/agents/lib/node/adapter-registry';
import { CodexAdapterFactory } from './codex-adapter-factory';
import { CODEX_CHECKS, CodexDiagnosticContributor } from './codex-diagnostic-contributor';
import { codexLog, codexLoggingDiagnostics } from './codex-logger';
import { CodexReleaseRegistry } from './codex-release-registry';

// diagnostic-coverage: codex.release, codex.confinement, codex.protocol, codex.credentials, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
test('refuses unsupported platforms without bundle access, process start, or ambient fallback', async () => {
  let starts = 0; const root = path.join(os.tmpdir(), `codex-path-canary-${Date.now()}`); const logs: string[] = []; const original = { info: console.info, error: console.error }; console.info = (...values: unknown[]) => { logs.push(JSON.stringify(values)); }; console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  const registry = new CodexReleaseRegistry({ startOperation: async () => { starts++; throw new Error('unexpected'); } } as unknown as OperationRegistryApi, root, { platform: 'darwin', arch: 'arm64' });
  try { await registry.onStart(); assert.equal(registry.projection().qualified, false); assert.equal(registry.projection().safeCode, 'CODEX_PLATFORM_UNSUPPORTED'); assert.equal(starts, 0); assert.equal(logs.join('\n').includes(root), false); }
  finally { console.info = original.info; console.error = original.error; }
});

test('classifies missing and malformed Linux release manifests without spawning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-codex-release-')); let starts = 0; const operations = { startOperation: async () => { starts++; throw new Error('unexpected'); } } as unknown as OperationRegistryApi;
  try {
    const missing = new CodexReleaseRegistry(operations, root, { platform: 'linux', arch: 'x64' }); await missing.onStart(); assert.equal(missing.projection().safeCode, 'CODEX_RELEASE_UNQUALIFIED');
    await writeFile(path.join(root, 'codex-qualification-v1.json'), '{'); await writeFile(path.join(root, 'codex-release-public-key.pem'), 'not-a-key');
    const malformed = new CodexReleaseRegistry(operations, root, { platform: 'linux', arch: 'x64' }); await malformed.onStart(); assert.equal(malformed.projection().safeCode, 'CODEX_MANIFEST_INVALID'); assert.equal(starts, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verifies a signed exact bundle through a registered real version subprocess', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-codex-release-')); const releaseId = 'codex-test-release'; const releaseRoot = path.join(root, 'releases', releaseId); await mkdir(releaseRoot, { recursive: true }); const events: string[] = [];
  const binary = Buffer.from("#!/bin/sh\nprintf 'codex-cli 1.2.3\\n'\n"); const schema = schemaBundle(); const accepted = acceptedMethods(); const helper = Buffer.from('#!/bin/sh\nexit 0\n');
  const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(releaseRoot, 'codex'), binary); await chmod(path.join(releaseRoot, 'codex'), 0o755); await writeFile(path.join(releaseRoot, 'app-server-schema-v2.json'), schema); await writeFile(path.join(releaseRoot, 'accepted-methods.json'), accepted); await writeFile(path.join(releaseRoot, 'linux-helper'), helper); await chmod(path.join(releaseRoot, 'linux-helper'), 0o755);
  const unsigned = { manifestVersion: '1', releaseId, codexVersion: '1.2.3', codexCommit: 'a'.repeat(40), target: 'x86_64-unknown-linux-musl', binarySha256: digest(binary), binarySize: String(binary.length), appServerSchemaVersion: 'v2', appServerSchemaSha256: digest(schema), acceptedMethodsSha256: digest(accepted), linuxHelperSha256: digest(helper), adapterVersion: '1.0.0', qualificationProfileId: 'kogg-writable-agent-v1', signedAt: new Date().toISOString(), signatureKeyId: 'kogg-codex-release-v1' } as const;
  const keys = generateKeyPairSync('ed25519'); await writeFile(path.join(root, 'codex-release-public-key.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const operations = { startOperation: async () => { const operationId = randomUUID(); const processId = randomUUID(); events.push('operation.registered'); return { id: operationId, cancellable: true, start: () => events.push('operation.started'), active: () => undefined, waiting: () => undefined, activity: () => undefined, refuse: () => undefined, complete: () => events.push('operation.completed'), fail: () => events.push('operation.failed'), timeout: () => undefined, cancel: async () => undefined, cleanup: async (run?: () => Promise<void>) => { await run?.(); events.push('operation.cleaned'); }, registerProcess: () => ({ id: processId, spawning: () => events.push('process.spawning'), started: () => events.push('process.started'), ready: () => undefined, activity: () => undefined, failed: () => events.push('process.failed'), exited: () => events.push('process.exited'), cleanup: () => events.push('process.cleaned') }) }; } } as unknown as OperationRegistryApi;
  try {
    const invalidAccepted = Buffer.from('[]\n'); await writeFile(path.join(releaseRoot, 'accepted-methods.json'), invalidAccepted); const invalidUnsigned = { ...unsigned, acceptedMethodsSha256: digest(invalidAccepted) }; const invalidManifest = { ...invalidUnsigned, signature: sign(null, Buffer.from(canonical(invalidUnsigned)), keys.privateKey).toString('base64') }; await writeFile(path.join(root, 'codex-qualification-v1.json'), `${JSON.stringify(invalidManifest)}\n`);
    const refused = new CodexReleaseRegistry(operations, root, { platform: 'linux', arch: 'x64' }); await refused.onStart(); assert.equal(refused.projection().safeCode, 'CODEX_SCHEMA_MISMATCH'); assert.equal(events.length, 0);
    await writeFile(path.join(releaseRoot, 'accepted-methods.json'), accepted); const manifest: QualifiedCodexReleaseV1 = { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), keys.privateKey).toString('base64') }; await writeFile(path.join(root, 'codex-qualification-v1.json'), `${JSON.stringify(manifest)}\n`);
    const registry = new CodexReleaseRegistry(operations, root, { platform: 'linux', arch: 'x64' }); await registry.onStart(); assert.equal(registry.projection().qualified, true); assert.equal(registry.projection().safeCode, 'CODEX_OK'); assert(events.indexOf('operation.registered') < events.indexOf('process.spawning')); assert(events.indexOf('process.spawning') < events.indexOf('process.started')); assert(events.indexOf('process.exited') < events.indexOf('process.cleaned')); assert(events.indexOf('process.cleaned') < events.indexOf('operation.completed'));
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('kills and confirms cleanup when the registered version subprocess exceeds its local bound', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-codex-release-')); const releaseId = 'codex-timeout-release'; const releaseRoot = path.join(root, 'releases', releaseId); await mkdir(releaseRoot, { recursive: true }); const events: string[] = [];
  const binary = Buffer.from('#!/bin/sh\nsleep 30\n'); const schema = schemaBundle(); const accepted = acceptedMethods(); const helper = Buffer.from('#!/bin/sh\nexit 0\n'); const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(releaseRoot, 'codex'), binary); await chmod(path.join(releaseRoot, 'codex'), 0o755); await writeFile(path.join(releaseRoot, 'app-server-schema-v2.json'), schema); await writeFile(path.join(releaseRoot, 'accepted-methods.json'), accepted); await writeFile(path.join(releaseRoot, 'linux-helper'), helper); await chmod(path.join(releaseRoot, 'linux-helper'), 0o755);
  const unsigned = { manifestVersion: '1', releaseId, codexVersion: '1.2.3', codexCommit: 'a'.repeat(40), target: 'x86_64-unknown-linux-musl', binarySha256: digest(binary), binarySize: String(binary.length), appServerSchemaVersion: 'v2', appServerSchemaSha256: digest(schema), acceptedMethodsSha256: digest(accepted), linuxHelperSha256: digest(helper), adapterVersion: '1.0.0', qualificationProfileId: 'kogg-writable-agent-v1', signedAt: new Date().toISOString(), signatureKeyId: 'kogg-codex-release-v1' } as const;
  const keys = generateKeyPairSync('ed25519'); const manifest: QualifiedCodexReleaseV1 = { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), keys.privateKey).toString('base64') }; await writeFile(path.join(root, 'codex-qualification-v1.json'), `${JSON.stringify(manifest)}\n`); await writeFile(path.join(root, 'codex-release-public-key.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const operations = { startOperation: async () => { const operationId = randomUUID(); const processId = randomUUID(); return { id: operationId, cancellable: true, start: () => undefined, active: () => undefined, waiting: () => undefined, activity: () => undefined, refuse: () => undefined, complete: () => events.push('operation.completed'), fail: () => events.push('operation.failed'), timeout: () => undefined, cancel: async () => undefined, cleanup: async (run?: () => Promise<void>) => { await run?.(); events.push('operation.cleaned'); }, registerProcess: () => ({ id: processId, spawning: () => undefined, started: () => events.push('process.started'), ready: () => undefined, activity: () => undefined, failed: () => events.push('process.failed'), exited: () => events.push('process.exited'), cleanup: () => events.push('process.cleaned') }) }; } } as unknown as OperationRegistryApi;
  try { const registry = new CodexReleaseRegistry(operations, root, { platform: 'linux', arch: 'x64' }, 50); await registry.onStart(); assert.equal(registry.projection().qualified, false); assert.equal(registry.projection().safeCode, 'CODEX_PROCESS_START_FAILED'); assert.deepEqual(events, ['process.started', 'process.failed', 'process.exited', 'process.cleaned', 'operation.cleaned', 'operation.failed']); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('registers Codex as disabled and reports all eight diagnostics without fallback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kogg-codex-release-')); const release = new CodexReleaseRegistry({} as OperationRegistryApi, root, { platform: 'linux', arch: 'x64' }); const adapters = new AdapterRegistry(); const factory = new CodexAdapterFactory(adapters, release);
  try {
    await factory.onStart(); assert.equal(adapters.descriptors().length, 1); assert.equal(adapters.descriptors()[0]?.enabled, false); assert.throws(() => adapters.resolveExact({ adapterKey: 'codex-app-server', adapterVersion: '1.0.0', providerId: 'openai', modelId: 'gpt-5', requiredCapabilities: ['provider-turn'] }), error => error instanceof Error && error.message === 'ADAPTER_DISABLED');
    const checks = await new CodexDiagnosticContributor(release).diagnose(); assert.deepEqual(checks.map(check => check.id), CODEX_CHECKS.map(check => check.id)); assert.equal(checks.find(check => check.id === 'codex.release')?.status, 'fail'); assert.equal(checks.find(check => check.id === 'codex.processes')?.status, 'pass'); assert.equal(checks.find(check => check.id === 'codex.cleanup')?.status, 'pass'); const sourceMaps = checks.find(check => check.id === 'codex.source-maps'); assert.equal(sourceMaps?.status, 'pass'); assert.equal(sourceMaps?.details?.expectedCount, 15); assert.equal(sourceMaps?.details?.missingCount, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closed Codex logging rejects hostile fields and field types without echoing their values', () => {
  const canary = `codex-secret-${Date.now()}`; const logs: string[] = []; const original = console.error; console.error = (...values: unknown[]) => { logs.push(JSON.stringify(values)); };
  try { const before = codexLoggingDiagnostics().violationCount; codexLog('release.verification.failed', { adapterVersion: '1.0.0', safeCode: 'CODEX_RELEASE_UNQUALIFIED', credential: canary } as never); codexLog('protocol.authority.denied', { attemptId: 'attempt-1', pendingCount: canary } as never); codexLog('cleanup.failed', { attemptId: 'attempt-1', operationId: 'operation-1', processId: 'process-1', resourceCount: 1, residualCount: 0, safeCode: 'CODEX_CLEANUP_FAILED', rawError: canary } as never); assert.equal(logs.join('\n').includes(canary), false); assert.equal(codexLoggingDiagnostics().violationCount, before + 3); }
  finally { console.error = original; }
});

function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
function acceptedMethods(): Buffer { return Buffer.from(`${JSON.stringify({ schemaVersion: '1', protocolId: 'codex.app-server-v2', protocolVersion: '1.0.0', outboundRequests: ['initialize', 'thread/start', 'turn/start', 'turn/interrupt', 'shutdown'], outboundNotifications: ['initialized'], errorDefinition: 'JSONRPCErrorError', responses: [{ requestMethod: 'initialize', schemaDefinition: 'InitializeResponse' }, { requestMethod: 'thread/start', schemaDefinition: 'ThreadStartResponse' }, { requestMethod: 'turn/start', schemaDefinition: 'TurnStartResponse' }, { requestMethod: 'turn/interrupt', schemaDefinition: 'TurnInterruptResponse' }, { requestMethod: 'shutdown', schemaDefinition: 'ShutdownResponse' }], inbound: [{ method: 'item/completed', kind: 'notification', lifecycle: 'activity', content: 'routed', schemaDefinition: 'ItemCompletedNotification' }, { method: 'item/requestApproval', kind: 'server-request', lifecycle: 'authority-request', content: 'none', schemaDefinition: 'RequestApprovalParams' }, { method: 'turn/completed', kind: 'notification', lifecycle: 'turn-completed', content: 'none', schemaDefinition: 'TurnCompletedNotification' }, { method: 'turn/started', kind: 'notification', lifecycle: 'turn-started', content: 'none', schemaDefinition: 'TurnStartedNotification' }] })}\n`); }
function schemaBundle(): Buffer { const definitions = Object.fromEntries(['JSONRPCErrorError', 'InitializeResponse', 'ThreadStartResponse', 'TurnStartResponse', 'TurnInterruptResponse', 'ShutdownResponse', 'ItemCompletedNotification', 'RequestApprovalParams', 'TurnCompletedNotification', 'TurnStartedNotification'].map(name => [name, { type: 'object' }])); return Buffer.from(`${JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', definitions, title: 'CodexAppServerProtocolV2', type: 'object' })}\n`); }
