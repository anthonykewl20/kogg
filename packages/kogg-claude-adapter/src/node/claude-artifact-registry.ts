import { verify } from 'node:crypto'; import { existsSync } from 'node:fs'; import { lstat, readFile } from 'node:fs/promises'; import path from 'node:path';
import { BackendApplicationContribution } from '@theia/core/lib/node'; import { injectable, unmanaged } from '@theia/core/shared/inversify';
import type { ClaudeCommercialUseApprovalV1, ClaudeReleaseProjection } from '../common/claude-protocol'; import { claudeLog } from './claude-logger';
// Logs through the closed [kogg:claude:artifact] claudeLog schema.
// diagnostic-coverage: claude.artifact, claude.legal, claude.settings, claude.credentials, claude.processes, claude.cleanup, claude.recovery, claude.source-maps
const FIELDS = ['schema','packageName','packageVersion','npmIntegritySha512','tarballSha1','approvedProduct','approvedUse','approverRef','decidedAt','expiresAt','signingKeyId','signature'] as const; const SAFE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
@injectable()
export class ClaudeArtifactRegistry implements BackendApplicationContribution {
  private started: Promise<void> | undefined; private value: ClaudeReleaseProjection = blocked();
  constructor(@unmanaged() private readonly assetsRoot = path.resolve(__dirname, '../../assets'), @unmanaged() private readonly now = () => Date.now()) {}
  onStart(): Promise<void> { return this.started ??= this.verifyApproval(); }
  projection(): ClaudeReleaseProjection { return { ...this.value, sourceMapsPresent: existsSync(`${__filename}.map`) }; }
  private async verifyApproval(): Promise<void> { try { await trustedDirectory(this.assetsRoot); const approval = await bounded(path.join(this.assetsRoot, 'claude-commercial-use-approval-v1.json'), 16_384); const key = await bounded(path.join(this.assetsRoot, 'claude-commercial-approval-public-key.pem'), 16_384); const record = parse(approval, this.now()); const unsigned = Object.fromEntries(FIELDS.filter(field => field !== 'signature').map(field => [field, record[field]])); let valid = false; try { valid = verify(null, Buffer.from(canonical(unsigned)), key, Buffer.from(record.signature, 'base64')); } catch { /* observability-exempt: outer legal.verify.failure classifies invalid signature material without echoing it. */ valid = false; } if (!valid) throw new Error('invalid'); this.value = { ...blocked(), legalApproved: true, safeCode: 'CLAUDE_ARTIFACT_MISMATCH' }; claudeLog('legal.verify.success', { signingKeyId: record.signingKeyId }); } catch { /* observability-exempt: legal.verify.failure is the sanitized terminal event for absent or invalid approval input. */ this.value = blocked(); claudeLog('legal.verify.failure', { safeCode: 'CLAUDE_LEGAL_APPROVAL_REQUIRED' }); } }
}
function blocked(): ClaudeReleaseProjection { return { legalApproved: false, artifactVerified: false, confinementVerified: false, credentialBrokerReady: false, processCount: 0, residualCount: 0, recoveryComplete: true, sourceMapsPresent: true, safeCode: 'CLAUDE_LEGAL_APPROVAL_REQUIRED' }; }
async function trustedDirectory(directory: string): Promise<void> { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat.uid) || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) throw new Error('invalid'); }
async function bounded(file: string, maximum: number): Promise<Buffer> { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat.uid) || stat.size < 1 || stat.size > maximum || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) throw new Error('invalid'); return readFile(file); }
function owned(uid: number): boolean { return process.platform === 'win32' || typeof process.getuid !== 'function' || uid === process.getuid(); }
function parse(bytes: Buffer, now: number): ClaudeCommercialUseApprovalV1 {
  let value: Record<string, unknown>;
  try { value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
  catch { /* observability-exempt: the sanitized legal.verify.failure event classifies malformed approval JSON. */ throw new Error('invalid'); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',')) throw new Error('invalid');
  const record = value as unknown as ClaudeCommercialUseApprovalV1;
  if (record.schema !== 'kogg.claude-commercial-use-approval/v1' || record.packageName !== '@anthropic-ai/claude-agent-sdk' || record.packageVersion !== '0.3.246' || record.npmIntegritySha512 !== 'FtR0HoHHNqeqJWjZN8qLUAzZVFUI9ztXYNPPwv98Ecmv9qq2QTauI8IzkY26CC0mleWAqb9RQEW2C0OtiUliug==' || record.tarballSha1 !== '0009206e79ee0ae25f68ebb526584031cb5db048' || record.approvedProduct !== 'kogg' || record.approvedUse !== 'governed-agent-adapter' || !SAFE.test(record.approverRef) || record.signingKeyId !== 'kogg-claude-commercial-approval-v1' || !Number.isFinite(Date.parse(record.decidedAt)) || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.decidedAt) > now || Date.parse(record.expiresAt) <= now || !/^[A-Za-z0-9+/]+={0,2}$/u.test(record.signature) || Buffer.from(record.signature, 'base64').length !== 64) throw new Error('invalid');
  return record;
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
