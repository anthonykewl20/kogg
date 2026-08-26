import { createHash, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { KoggOperationRegistry, type OperationRegistryApi } from '@kogg/operations/lib/common/operations-protocol';
import type { CodexReleaseProjection, CodexSafeCode, QualifiedCodexReleaseV1 } from '../common/codex-protocol';
import { parseAcceptedCodexMethods, validateCodexSchemaBundle } from './codex-accepted-methods';
import { compileCodexFrameSchema } from './codex-generated-schema';
import { codexLog } from './codex-logger';

// Logs through the closed [kogg:agents:codex-release] schema in codex-logger.
// diagnostic-coverage: codex.release, codex.protocol, codex.processes, codex.cleanup, codex.recovery, codex.source-maps
const ADAPTER_VERSION = '1.0.0'; const MAX_MANIFEST_BYTES = 64 * 1024; const MAX_VERSION_BYTES = 256; const MAX_BINARY_BYTES = 512 * 1024 * 1024; const MAX_SCHEMA_BYTES = 32 * 1024 * 1024; const MAX_METHOD_BYTES = 1024 * 1024; const MAX_HELPER_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u; const SYMBOLIC = /^[a-z0-9][a-z0-9._:-]{0,127}$/u; const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u; const COMMIT = /^[0-9a-f]{40}$/u; const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const FIELDS = ['manifestVersion', 'releaseId', 'codexVersion', 'codexCommit', 'target', 'binarySha256', 'binarySize', 'appServerSchemaVersion', 'appServerSchemaSha256', 'acceptedMethodsSha256', 'linuxHelperSha256', 'adapterVersion', 'qualificationProfileId', 'signedAt', 'signatureKeyId', 'signature'] as const;

@injectable()
export class CodexReleaseRegistry implements BackendApplicationContribution {
  private startup: Promise<void> | undefined; private projectionValue: CodexReleaseProjection;
  constructor(@inject(KoggOperationRegistry) private readonly operations: OperationRegistryApi,
    @unmanaged() private readonly bundleRoot = path.resolve(__dirname, '../../assets'),
    @unmanaged() private readonly runtime: { readonly platform: NodeJS.Platform; readonly arch: string } = { platform: process.platform, arch: process.arch },
    @unmanaged() private readonly versionTimeoutMs = 8_000) { this.projectionValue = unqualified(platformCode(runtime)); }
  onStart(): Promise<void> { return this.startup ??= this.verifyBundle(); }
  projection(): CodexReleaseProjection { return { ...this.projectionValue, sourceMapsPresent: existsSync(`${__filename}.map`) }; }

  private async verifyBundle(): Promise<void> {
    codexLog('release.verification.started', { adapterVersion: ADAPTER_VERSION });
    if (this.runtime.platform !== 'linux' || !['x64', 'arm64'].includes(this.runtime.arch)) return this.fail('CODEX_PLATFORM_UNSUPPORTED');
    try {
      await trustedDirectory(this.bundleRoot);
      const manifestPath = path.join(this.bundleRoot, 'codex-qualification-v1.json'); const publicKeyPath = path.join(this.bundleRoot, 'codex-release-public-key.pem');
      const manifestBytes = await boundedFile(manifestPath, MAX_MANIFEST_BYTES, false); const publicKey = await boundedFile(publicKeyPath, 16 * 1024, false);
      const manifest = parseManifest(manifestBytes); const target = this.runtime.arch === 'x64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-musl';
      if (manifest.target !== target || manifest.adapterVersion !== ADAPTER_VERSION || manifest.signatureKeyId !== 'kogg-codex-release-v1' || Date.parse(manifest.signedAt) > Date.now()) throw new ReleaseError('CODEX_RELEASE_UNQUALIFIED');
      const unsigned = Object.fromEntries(FIELDS.filter(field => field !== 'signature').map(field => [field, manifest[field]]));
      let signatureValid = false; try { signatureValid = verify(null, Buffer.from(canonical(unsigned)), publicKey, Buffer.from(manifest.signature, 'base64')); } catch { // observability-exempt: The closed release failure emitted by the caller classifies invalid key/signature material without echoing it.
        throw new ReleaseError('CODEX_MANIFEST_INVALID'); }
      if (!signatureValid) throw new ReleaseError('CODEX_MANIFEST_INVALID');
      const releasesRoot = path.join(this.bundleRoot, 'releases'); const releaseRoot = path.join(releasesRoot, manifest.releaseId); const binary = path.join(releaseRoot, 'codex');
      await trustedDirectory(releasesRoot); await trustedDirectory(releaseRoot);
      await exactAsset(binary, manifest.binarySha256, Number(manifest.binarySize), MAX_BINARY_BYTES, true, 'CODEX_BINARY_MISMATCH');
      const schema = await exactAsset(path.join(releaseRoot, 'app-server-schema-v2.json'), manifest.appServerSchemaSha256, undefined, MAX_SCHEMA_BYTES, false, 'CODEX_SCHEMA_MISMATCH');
      const acceptedMethods = await exactAsset(path.join(releaseRoot, 'accepted-methods.json'), manifest.acceptedMethodsSha256, undefined, MAX_METHOD_BYTES, false, 'CODEX_SCHEMA_MISMATCH');
      try { const accepted = parseAcceptedCodexMethods(acceptedMethods); validateCodexSchemaBundle(schema, accepted); compileCodexFrameSchema(schema, accepted); } catch { // observability-exempt: The outer release failure emits CODEX_SCHEMA_MISMATCH without exposing signed asset content.
        throw new ReleaseError('CODEX_SCHEMA_MISMATCH'); }
      await exactAsset(path.join(releaseRoot, 'linux-helper'), manifest.linuxHelperSha256, undefined, MAX_HELPER_BYTES, true, 'CODEX_BINARY_MISMATCH');
      await this.inspectVersion(binary, manifest.codexVersion);
      this.projectionValue = { qualified: true, safeCode: 'CODEX_OK', adapterVersion: ADAPTER_VERSION, target: manifest.target, releasePresent: true, assetsVerified: true, protocolVerified: true, confinementVerified: false, credentialBrokerReady: false, processCount: 0, residualCount: 0, recoveryComplete: true, sourceMapsPresent: true };
      codexLog('release.verification.completed', { releaseId: manifest.releaseId, target: manifest.target, adapterVersion: ADAPTER_VERSION });
    } catch (error) { // observability-exempt: fail emits the single closed release-verification failure for this classified boundary.
      this.fail(error instanceof ReleaseError ? error.code : 'CODEX_RELEASE_UNQUALIFIED'); }
  }

  private async inspectVersion(binary: string, expected: string): Promise<void> {
    const operation = await this.operations.startOperation({ kind: 'provider-connection', cancellable: true, absoluteTimeoutMs: 10_000 }); operation.start();
    let child: ReturnType<typeof spawn> | undefined; let processTerminal = false; let exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    const processLease = operation.registerProcess({ kind: 'provider-cli', owner: 'kogg-supervisor', cancel: async () => { killProcessTree(child); if (exitPromise) await within(exitPromise, 1_000); } }); codexLog('process.start.requested', { operationId: operation.id, processId: processLease.id });
    try {
      processLease.spawning(); child = spawn(binary, ['--version'], { cwd: this.bundleRoot, env: {}, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); if (!child.pid) throw new ReleaseError('CODEX_PROCESS_START_FAILED'); processLease.started(child.pid); codexLog('process.started', { operationId: operation.id, processId: processLease.id });
      let stdout = Buffer.alloc(0); child.stdout?.on('data', chunk => { stdout = Buffer.concat([stdout, Buffer.from(chunk)]).subarray(0, MAX_VERSION_BYTES + 1); }); child.stderr?.resume();
      exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child!.once('exit', (code, signal) => resolve({ code, signal })); child!.once('error', reject); });
      const exit = await within(exitPromise, this.versionTimeoutMs); processLease.exited(exit.signal ? 'signal' : exit.code === 0 ? 'zero' : 'nonzero'); processTerminal = true;
      if (exit.code !== 0 || stdout.length > MAX_VERSION_BYTES || stdout.toString('utf8').trim() !== `codex-cli ${expected}`) throw new ReleaseError('CODEX_VERSION_MISMATCH'); processLease.cleanup(); await operation.cleanup(); operation.complete();
    } catch (error) {
      if (!processTerminal) processLease.failed('PROCESS_READINESS_FAILED', error instanceof Error ? error.name : 'UnknownError');
      await operation.cleanup(async () => { killProcessTree(child); if (exitPromise) { const exit = await within(exitPromise, 1_000); if (!processTerminal) { processLease.exited(exit.signal ? 'signal' : exit.code === 0 ? 'zero' : 'nonzero'); processTerminal = true; } } processLease.cleanup(); }).catch(() => undefined);
      operation.fail('PROCESS_READINESS_FAILED', error instanceof Error ? error.name : 'UnknownError'); codexLog('process.failed', { operationId: operation.id, processId: processLease.id, safeCode: error instanceof ReleaseError ? error.code : 'CODEX_PROCESS_START_FAILED' }); throw error;
    }
  }
  private fail(code: CodexSafeCode): void { this.projectionValue = unqualified(code); codexLog('release.verification.failed', { adapterVersion: ADAPTER_VERSION, safeCode: code }); }
}

class ReleaseError extends Error { constructor(readonly code: CodexSafeCode) { super(code); } }
function platformCode(runtime: { readonly platform: NodeJS.Platform; readonly arch: string }): CodexSafeCode { return runtime.platform === 'linux' && ['x64', 'arm64'].includes(runtime.arch) ? 'CODEX_RELEASE_UNQUALIFIED' : 'CODEX_PLATFORM_UNSUPPORTED'; }
function unqualified(safeCode: CodexSafeCode): CodexReleaseProjection { return { qualified: false, safeCode, adapterVersion: ADAPTER_VERSION, releasePresent: false, assetsVerified: false, protocolVerified: false, confinementVerified: false, credentialBrokerReady: false, processCount: 0, residualCount: 0, recoveryComplete: true, sourceMapsPresent: true }; }
async function boundedFile(file: string, maximum: number, executable: boolean): Promise<Buffer> { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximum || !owned(stat.uid) || (stat.mode & 0o022) !== 0 || (executable && (stat.mode & 0o111) === 0)) throw new ReleaseError('CODEX_RELEASE_UNQUALIFIED'); return readFile(file); }
async function trustedDirectory(directory: string): Promise<void> { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat.uid) || (stat.mode & 0o022) !== 0) throw new ReleaseError('CODEX_RELEASE_UNQUALIFIED'); }
async function exactAsset(file: string, digest: string, size: number | undefined, maximum: number, executable: boolean, code: CodexSafeCode): Promise<Buffer> { try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximum || !owned(stat.uid) || (stat.mode & 0o022) !== 0 || (executable && (stat.mode & 0o111) === 0) || (size !== undefined && stat.size !== size)) throw new Error(); const bytes = await readFile(file); if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(); return bytes; } catch { throw new ReleaseError(code); } }
function killProcessTree(child: ReturnType<typeof spawn> | undefined): void { if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return; try { process.kill(-child.pid, 'SIGKILL'); } catch { // observability-exempt: A missing process group is intentionally handled by the direct-child kill; the subsequent bounded exit proof determines cleanup success.
    child.kill('SIGKILL'); } }
async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ReleaseError('CODEX_PROCESS_START_FAILED')), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
function owned(uid: number): boolean { const current = process.getuid?.(); return current === undefined || uid === current; }
function parseManifest(bytes: Buffer): QualifiedCodexReleaseV1 { let value: Record<string, unknown>; try { value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; } catch { throw new ReleaseError('CODEX_MANIFEST_INVALID'); } if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',')) throw new ReleaseError('CODEX_MANIFEST_INVALID'); const manifest = value as unknown as QualifiedCodexReleaseV1; if (manifest.manifestVersion !== '1' || manifest.appServerSchemaVersion !== 'v2' || !SYMBOLIC.test(manifest.releaseId) || !SEMVER.test(manifest.codexVersion) || !COMMIT.test(manifest.codexCommit) || !['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl'].includes(manifest.target) || ![manifest.binarySha256, manifest.appServerSchemaSha256, manifest.acceptedMethodsSha256, manifest.linuxHelperSha256].every(value => SHA256.test(value)) || !DECIMAL.test(manifest.binarySize) || Number(manifest.binarySize) > MAX_BINARY_BYTES || !SEMVER.test(manifest.adapterVersion) || !SYMBOLIC.test(manifest.qualificationProfileId) || !SYMBOLIC.test(manifest.signatureKeyId) || !Number.isFinite(Date.parse(manifest.signedAt)) || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/u.test(manifest.signature) || Buffer.from(manifest.signature, 'base64').length !== 64) throw new ReleaseError('CODEX_MANIFEST_INVALID'); return manifest; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
