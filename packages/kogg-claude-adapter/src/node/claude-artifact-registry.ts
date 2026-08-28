import { createHash, createPublicKey, verify } from 'node:crypto'; import { constants } from 'node:fs'; import { lstat, open, readdir } from 'node:fs/promises'; import path from 'node:path';
import { BackendApplicationContribution } from '@theia/core/lib/node'; import { injectable, unmanaged } from '@theia/core/shared/inversify';
import type { ClaudeArtifactManifestV1, ClaudeCommercialUseApprovalV1, ClaudeReleaseProjection } from '../common/claude-protocol'; import { claudeLog } from './claude-logger';
import { claudeSourceMapDiagnostics } from './claude-source-map-diagnostics';
// Logs through the closed [kogg:claude:artifact] claudeLog schema.
// diagnostic-coverage: claude.artifact, claude.legal, claude.settings, claude.credentials, claude.source-maps
const APPROVAL_FIELDS = ['schema','packageName','packageVersion','npmIntegritySha512','tarballSha1','approvedProduct','approvedUse','approverRef','decidedAt','expiresAt','signingKeyId','signature'] as const;
const ARTIFACT_FIELDS = ['schema','packageName','packageVersion','npmIntegritySha512','tarballSha1','fileDigests','bundledCliVersion','typeProjectionSha256','adapterSchemaSha256','createdAt','signingKeyId','signature'] as const;
const REQUIRED_FILES = ['yarn.lock','package.tgz','package/package.json','package/sdk.d.ts','package/sdk-tools.d.ts','package/bridge.d.ts','package/manifest.json','generated/type-projection.json','generated/adapter-schema.json'] as const;
const SAFE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u; const SHA256 = /^[0-9a-f]{64}$/u; const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const MAX_ARTIFACT_FILES = 64; const MAX_ARTIFACT_FILE_BYTES = 128 * 1024 * 1024; const MAX_ARTIFACT_TOTAL_BYTES = 512 * 1024 * 1024;
const APPROVED_IDENTITY = Object.freeze({ npmIntegritySha512: 'FtR0HoHHNqeqJWjZN8qLUAzZVFUI9ztXYNPPwv98Ecmv9qq2QTauI8IzkY26CC0mleWAqb9RQEW2C0OtiUliug==', tarballSha1: '0009206e79ee0ae25f68ebb526584031cb5db048' });
interface ClaudeArtifactIdentity { readonly npmIntegritySha512: string; readonly tarballSha1: string; }
export interface AttestedClaudeArtifactV1 { readonly manifest: ClaudeArtifactManifestV1; readonly manifestDigest: string; readonly approvalDigest: string; readonly root: string; readonly files: Readonly<Record<string, string>>; }
@injectable()
export class ClaudeArtifactRegistry implements BackendApplicationContribution {
  private started: Promise<void> | undefined; private value: ClaudeReleaseProjection = blocked(); private approvalValue: ClaudeCommercialUseApprovalV1 | undefined; private artifactValue: AttestedClaudeArtifactV1 | undefined; private readonly artifactRoot: string;
  constructor(@unmanaged() private readonly assetsRoot = path.resolve(__dirname, '../../assets'), @unmanaged() private readonly now = () => Date.now(), @unmanaged() artifactRoot?: string, @unmanaged() private readonly approvedIdentity: ClaudeArtifactIdentity = APPROVED_IDENTITY) { this.artifactRoot = artifactRoot ?? path.join(assetsRoot, 'claude-artifact-v1'); }
  onStart(): Promise<void> { return this.started ??= this.verifyRelease(); }
  projection(): ClaudeReleaseProjection { return { ...this.value, sourceMapsPresent: claudeSourceMapDiagnostics().missingCount === 0 }; }
  qualifiedApproval(): ClaudeCommercialUseApprovalV1 { if (!this.approvalValue) throw new ClaudeArtifactFault(this.value.safeCode); return this.approvalValue; }
  attestedArtifact(): AttestedClaudeArtifactV1 { if (!this.artifactValue) throw new ClaudeArtifactFault(this.value.safeCode); return this.artifactValue; }
  private async verifyRelease(): Promise<void> {
    this.approvalValue = undefined; this.artifactValue = undefined;
    try { await trustedDirectory(this.assetsRoot); const approval = await bounded(path.join(this.assetsRoot, 'claude-commercial-use-approval-v1.json'), 16_384); const keyBytes = await bounded(path.join(this.assetsRoot, 'claude-commercial-approval-public-key.pem'), 16_384); const record = parseApproval(approval, this.now(), this.approvedIdentity); const unsigned = Object.fromEntries(APPROVAL_FIELDS.filter(field => field !== 'signature').map(field => [field, record[field]])); if (!validSignature(keyBytes, unsigned, record.signature)) throw new Error('invalid'); this.approvalValue = Object.freeze({ ...record }); this.value = { ...blocked(), legalApproved: true, safeCode: 'CLAUDE_ARTIFACT_MISMATCH' }; claudeLog('legal.verify.success', { signingKeyId: record.signingKeyId }); }
    catch { /* observability-exempt: legal.verify.failure is the sanitized terminal event for absent or invalid approval input. */ this.approvalValue = undefined; this.value = blocked(); claudeLog('legal.verify.failure', { safeCode: 'CLAUDE_LEGAL_APPROVAL_REQUIRED' }); return; }
    await this.verifyArtifact();
  }
  private async verifyArtifact(): Promise<void> {
    claudeLog('artifact.verify.started', { signingKeyId: 'kogg-claude-artifact-v1' });
    try {
      const approval = this.qualifiedApproval(); const manifestBytes = await bounded(path.join(this.assetsRoot, 'claude-artifact-manifest-v1.json'), 65_536); const keyBytes = await bounded(path.join(this.assetsRoot, 'claude-artifact-public-key.pem'), 16_384); const manifest = parseArtifactManifest(manifestBytes, approval, this.now()); const unsigned = Object.fromEntries(ARTIFACT_FIELDS.filter(field => field !== 'signature').map(field => [field, manifest[field]])); if (!validSignature(keyBytes, unsigned, manifest.signature)) throw new Error('invalid');
      const files = await attestFiles(this.artifactRoot, manifest); const frozenManifest = Object.freeze({ ...manifest, fileDigests: Object.freeze({ ...manifest.fileDigests }) }); this.artifactValue = Object.freeze({ manifest: frozenManifest, manifestDigest: digestCanonical(manifest), approvalDigest: digestCanonical(approval), root: this.artifactRoot, files: Object.freeze(files) });
      // The signed bytes are retained, but artifactVerified stays false until the bundled CLI version probe runs inside a qualified empty Linux execution scope.
      claudeLog('artifact.verify.completed', { signingKeyId: manifest.signingKeyId, fileCount: Object.keys(files).length });
    } catch { /* observability-exempt: artifact.verify.failed is the sanitized terminal event for absent, malformed, or mismatched commercial artifact bytes. */ this.artifactValue = undefined; claudeLog('artifact.verify.failed', { safeCode: 'CLAUDE_ARTIFACT_MISMATCH' }); }
  }
}
export class ClaudeArtifactFault extends Error { constructor(readonly code: ClaudeReleaseProjection['safeCode']) { super(code); } }
function blocked(): ClaudeReleaseProjection { return { legalApproved: false, artifactVerified: false, confinementVerified: false, credentialBrokerReady: false, sourceMapsPresent: true, safeCode: 'CLAUDE_LEGAL_APPROVAL_REQUIRED' }; }
async function trustedDirectory(directory: string): Promise<void> { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat.uid) || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) throw new Error('invalid'); }
async function bounded(file: string, maximum: number): Promise<Buffer> { const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await handle.stat(); if (!stat.isFile() || !owned(stat.uid) || stat.size < 1 || stat.size > maximum || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) throw new Error('invalid'); const value = await handle.readFile(); if (value.length !== stat.size || value.length > maximum) throw new Error('invalid'); return value; } finally { await handle.close(); } }
function owned(uid: number): boolean { return process.platform === 'win32' || typeof process.getuid !== 'function' || uid === process.getuid(); }
function parseApproval(bytes: Buffer, now: number, approvedIdentity: ClaudeArtifactIdentity): ClaudeCommercialUseApprovalV1 {
  let value: Record<string, unknown>;
  try { value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
  catch { /* observability-exempt: the sanitized legal.verify.failure event classifies malformed approval JSON. */ throw new Error('invalid'); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...APPROVAL_FIELDS].sort().join(',')) throw new Error('invalid');
  const record = value as unknown as ClaudeCommercialUseApprovalV1;
  const decidedAt = timestamp(record.decidedAt); const expiresAt = timestamp(record.expiresAt);
  if (record.schema !== 'kogg.claude-commercial-use-approval/v1' || record.packageName !== '@anthropic-ai/claude-agent-sdk' || record.packageVersion !== '0.3.246' || record.npmIntegritySha512 !== approvedIdentity.npmIntegritySha512 || record.tarballSha1 !== approvedIdentity.tarballSha1 || record.approvedProduct !== 'kogg' || record.approvedUse !== 'governed-agent-adapter' || !SAFE.test(record.approverRef) || record.signingKeyId !== 'kogg-claude-commercial-approval-v1' || decidedAt > now || expiresAt <= now || expiresAt <= decidedAt) throw new Error('invalid');
  return record;
}
function parseArtifactManifest(bytes: Buffer, approval: ClaudeCommercialUseApprovalV1, now: number): ClaudeArtifactManifestV1 {
  let value: Record<string, unknown>;
  try { value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
  catch { /* observability-exempt: artifact.verify.failed classifies malformed signed manifest JSON without echoing it. */ throw new Error('invalid'); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...ARTIFACT_FIELDS].sort().join(',')) throw new Error('invalid');
  const record = value as unknown as ClaudeArtifactManifestV1; const digests = record.fileDigests;
  if (record.schema !== 'kogg.claude-artifact/v1' || record.packageName !== approval.packageName || record.packageVersion !== approval.packageVersion || record.npmIntegritySha512 !== approval.npmIntegritySha512 || record.tarballSha1 !== approval.tarballSha1 || record.signingKeyId !== 'kogg-claude-artifact-v1' || !SEMVER.test(record.bundledCliVersion) || !SHA256.test(record.typeProjectionSha256) || !SHA256.test(record.adapterSchemaSha256) || timestamp(record.createdAt) > now || !digests || Array.isArray(digests) || Object.getPrototypeOf(digests) !== Object.prototype) throw new Error('invalid');
  const names = Object.keys(digests); if (names.length < REQUIRED_FILES.length || names.length > MAX_ARTIFACT_FILES || names.join(',') !== [...names].sort().join(',')) throw new Error('invalid');
  for (const required of REQUIRED_FILES) if (!names.includes(required)) throw new Error('invalid');
  for (const name of names) if (!safeRelativePath(name) || !SHA256.test(digests[name]!)) throw new Error('invalid');
  if (digests['generated/type-projection.json'] !== record.typeProjectionSha256 || digests['generated/adapter-schema.json'] !== record.adapterSchemaSha256) throw new Error('invalid');
  return record;
}
async function attestFiles(root: string, manifest: ClaudeArtifactManifestV1): Promise<Record<string, string>> {
  await trustedDirectory(root); const present = await inventory(root); const expected = Object.keys(manifest.fileDigests); if (present.join(',') !== expected.join(',')) throw new Error('invalid');
  const paths: Record<string, string> = {}; const bytesByName = new Map<string, Buffer>(); let total = 0;
  for (const name of expected) { const absolute = path.join(root, ...name.split('/')); const bytes = await bounded(absolute, MAX_ARTIFACT_FILE_BYTES); total += bytes.length; if (total > MAX_ARTIFACT_TOTAL_BYTES || createHash('sha256').update(bytes).digest('hex') !== manifest.fileDigests[name]) throw new Error('invalid'); paths[name] = absolute; bytesByName.set(name, bytes); }
  const archive = bytesByName.get('package.tgz')!; if (createHash('sha1').update(archive).digest('hex') !== manifest.tarballSha1 || createHash('sha512').update(archive).digest('base64') !== manifest.npmIntegritySha512) throw new Error('invalid');
  let packageJson: Record<string, unknown>; try { packageJson = JSON.parse(bytesByName.get('package/package.json')!.toString('utf8')) as Record<string, unknown>; } catch { throw new Error('invalid'); }
  if (!packageJson || Array.isArray(packageJson) || packageJson.name !== manifest.packageName || packageJson.version !== manifest.packageVersion) throw new Error('invalid');
  return paths;
}
async function inventory(root: string, relative = ''): Promise<string[]> {
  const directory = relative ? path.join(root, ...relative.split('/')) : root; if (relative) await trustedDirectory(directory); const entries = await readdir(directory, { withFileTypes: true }); const files: string[] = [];
  for (const entry of entries) { const name = relative ? `${relative}/${entry.name}` : entry.name; if (!safeRelativePath(name) || entry.isSymbolicLink()) throw new Error('invalid'); if (entry.isDirectory()) files.push(...await inventory(root, name)); else if (entry.isFile()) files.push(name); else throw new Error('invalid'); }
  return files.sort();
}
function safeRelativePath(value: string): boolean { return value.length > 0 && value.length <= 240 && !value.startsWith('.') && !value.includes('\\') && path.posix.normalize(value) === value && value.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment)); }
function validSignature(keyBytes: Buffer, unsigned: Record<string, unknown>, signature: string): boolean { try { const key = createPublicKey(keyBytes); return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonical(unsigned)), key, decodeSignature(signature)); } catch { /* observability-exempt: caller emits the closed legal or artifact verification failure without key/signature material. */ return false; } }
function timestamp(value: string): number { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new Error('invalid'); const parsed = Date.parse(value); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error('invalid'); return parsed; }
function decodeSignature(value: string): Buffer { if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error('invalid'); const decoded = Buffer.from(value, 'base64'); if (decoded.length !== 64 || decoded.toString('base64') !== value) throw new Error('invalid'); return decoded; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
function digestCanonical(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
